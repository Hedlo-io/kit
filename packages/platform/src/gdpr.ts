import { eraseData, personalData, defineModel, type ErasePlan, type Model } from "@weft-framework/data";
import type { Activity } from "./activity.ts";

export type RequestKind = "export" | "erase";
export type RequestStatus = "pending" | "approved" | "done" | "rejected" | "cancelled";

export interface GdprRequestRow {
  id: string;
  subject: string;
  kind: RequestKind;
  status: RequestStatus;
  scope: string;
  requested: number;
  due: number;
  decided: number | null;
  decidedBy: string | null;
  note: string | null;
  result: string | null;
}

export interface GdprOptions<V> {
  models(): readonly Model<any, any>[];
  subject: Model<any, any>;
  plan?: Record<string, ErasePlan>;
  userId(viewer: V): string | null;
  canHandle(viewer: V, scope: string): boolean;
  activity?: Activity<V>;
  dueDays?: number;
  name?: string;
  now?(): number;
}

export class GdprError extends Error {}

const SYSTEM = Object.freeze({ kit: "gdpr" });
const DAY = 86_400_000;

export class Gdpr<V> {
  readonly model: Model<GdprRequestRow>;
  readonly #o: GdprOptions<V>;

  constructor(o: GdprOptions<V>) {
    this.#o = o;
    this.model = defineModel<GdprRequestRow>(o.name ?? "KitGdprRequest", {
      fields: {
        id: "string",
        subject: "string",
        kind: '"export" | "erase"',
        status: '"pending" | "approved" | "done" | "rejected" | "cancelled"',
        scope: "string",
        requested: "number",
        due: "number",
        decided: "number | null",
        decidedBy: "string | null",
        note: "string | null",
        result: "string | null",
      },
      attrs: { subject: { index: true } },
      read: (a, r) => a === SYSTEM || o.userId(a as V) === r.subject,
      write: (a) => a === SYSTEM,
    });
  }

  async request(viewer: V, kind: RequestKind, scope: string): Promise<GdprRequestRow> {
    const me = this.#o.userId(viewer);
    if (me === null) throw new GdprError("sign in first");
    if (kind !== "export" && kind !== "erase") throw new GdprError("kind: export or erase");
    const open = await this.model.as(SYSTEM as never).query().where({ subject: me, kind, status: { in: ["pending", "approved"] } } as never).all();
    if (open.length) return open[0]!;
    const now = this.#now();
    const row: GdprRequestRow = { id: `${kind}:${me}:${now.toString(36)}`, subject: me, kind, status: "pending", scope, requested: now, due: now + (this.#o.dueDays ?? 30) * DAY, decided: null, decidedBy: null, note: null, result: null };
    await this.model.as(SYSTEM as never).create(row);
    await this.#log(scope, me, `gdpr.${kind}.requested`, row.id);
    if (kind === "export") return this.#export(row, me);
    return row;
  }

  async mine(viewer: V): Promise<GdprRequestRow[]> {
    const me = this.#o.userId(viewer);
    if (me === null) return [];
    return (await this.model.as(SYSTEM as never).query().where({ subject: me }).all()).sort((a, b) => b.requested - a.requested);
  }

  async queue(viewer: V, scope: string): Promise<GdprRequestRow[]> {
    if (!this.#handles(viewer, scope)) throw new GdprError("not allowed");
    return (await this.model.as(SYSTEM as never).query().where({ status: { in: ["pending", "approved"] } } as never).all()).sort((a, b) => a.due - b.due);
  }

  async cancel(viewer: V, id: string): Promise<boolean> {
    const me = this.#o.userId(viewer);
    const r = await this.model.as(SYSTEM as never).get(id);
    if (!r || r.subject !== me || r.status !== "pending") return false;
    await this.#set(id, { status: "cancelled", decided: this.#now(), decidedBy: me });
    await this.#log(r.scope, me, `gdpr.${r.kind}.cancelled`, id);
    return true;
  }

  async decide(viewer: V, id: string, approve: boolean, note?: string): Promise<GdprRequestRow> {
    const r = await this.model.as(SYSTEM as never).get(id);
    if (!r) throw new GdprError("no such request");
    if (!this.#handles(viewer, r.scope)) throw new GdprError("not allowed");
    const me = this.#o.userId(viewer)!;
    if (me === r.subject) throw new GdprError("you cannot decide your own request");
    if (r.status !== "pending") throw new GdprError(`request is ${r.status}`);
    const clean = typeof note === "string" ? note.slice(0, 1000) : null;
    if (!approve) {
      await this.#set(id, { status: "rejected", decided: this.#now(), decidedBy: me, note: clean });
      await this.#log(r.scope, me, `gdpr.${r.kind}.rejected`, id, { subject: r.subject });
      return (await this.model.as(SYSTEM as never).get(id))!;
    }
    await this.#set(id, { status: "approved", decided: this.#now(), decidedBy: me, note: clean });
    if (r.kind === "erase") {
      const data = await personalData(this.#o.models(), this.#o.subject, r.subject, { plan: this.#o.plan ?? {} });
      const done = await eraseData(data);
      await this.#set(id, { status: "done", result: JSON.stringify(done) });
      await this.#log(r.scope, me, "gdpr.erase.done", id, { subject: r.subject, removed: Object.values(done.removed).reduce((a, b) => a + b, 0) });
    }
    return (await this.model.as(SYSTEM as never).get(id))!;
  }

  async download(viewer: V, id: string): Promise<string> {
    const me = this.#o.userId(viewer);
    const r = await this.model.as(SYSTEM as never).get(id);
    if (!r || r.kind !== "export" || r.status !== "done" || r.result === null) throw new GdprError("no such export");
    if (r.subject !== me) throw new GdprError("not allowed");
    return r.result;
  }

  async #export(row: GdprRequestRow, me: string): Promise<GdprRequestRow> {
    const data = await personalData(this.#o.models(), this.#o.subject, me, { plan: this.#o.plan ?? {} });
    const body = JSON.stringify({ format: "kit-personal-data", version: 1, generated: this.#now(), subject: data.subject, rows: data.rows, files: data.files }, null, 2);
    await this.#set(row.id, { status: "done", decided: this.#now(), decidedBy: null, result: body });
    await this.#log(row.scope, me, "gdpr.export.done", row.id);
    return (await this.model.as(SYSTEM as never).get(row.id))!;
  }

  #handles(viewer: V, scope: string): boolean {
    try {
      return this.#o.userId(viewer) !== null && this.#o.canHandle(viewer, scope) === true;
    } catch {
      return false;
    }
  }

  async #set(id: string, patch: Partial<GdprRequestRow>): Promise<void> {
    await this.model.as(SYSTEM as never).update((r) => r.id === id, patch);
  }

  async #log(scope: string, actor: string | null, action: string, target: string, meta?: Record<string, unknown>): Promise<void> {
    await this.#o.activity?.log({ scope, actor, action, target, ...(meta ? { meta } : {}) });
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }
}

export function defineGdpr<V>(o: GdprOptions<V>): Gdpr<V> {
  return new Gdpr<V>(o);
}
