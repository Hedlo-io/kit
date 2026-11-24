import { createHash } from "node:crypto";
import { defineModel, type AuditEvent, type Model } from "@weft-framework/data";

export interface ActivityRow {
  id: string;
  seq: number;
  scope: string;
  path: string;
  actor: string | null;
  impersonator: string | null;
  action: string;
  target: string | null;
  summary: string;
  meta: Record<string, string | number | boolean | null>;
  ip: string | null;
  at: number;
  prev: string;
  hash: string;
}

export interface ActivityInput {
  scope: string;
  actor: string | null;
  impersonator?: string | null;
  action: string;
  target?: string | null;
  summary?: string;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

export interface ActivityQuery {
  actor?: string;
  action?: string;
  target?: string;
  since?: number;
  until?: number;
  before?: number;
  limit?: number;
}

export interface ActivityOptions<V> {
  parentTenant(scope: string): string | null;
  canRead(viewer: V, scope: string): boolean;
  redact?: readonly (string | RegExp)[];
  onAppend?(row: ActivityRow): void;
  name?: string;
  now?(): number;
}

export class ActivityError extends Error {}

const ACTION = /^[a-z][a-z0-9_-]{0,40}(\.[a-z0-9_-]{1,40}){1,4}$/;
const SECRET = [/pass(word)?/i, /secret/i, /token/i, /api[-_]?key/i, /authorization/i, /cookie/i, /private/i, /otp|totp/i];
const GENESIS = "0".repeat(64);
const SYSTEM = Object.freeze({ kit: "activity" });
const MAX_DEPTH = 8;

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export function activityHash(row: Omit<ActivityRow, "hash">): string {
  const { id: _id, ...rest } = row;
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

export function verifyChain(rows: readonly ActivityRow[]): { ok: boolean; checked: number; brokenAt: number | null } {
  let prev = GENESIS;
  let expect = 1;
  for (const r of rows) {
    const { hash, ...rest } = r;
    if (r.seq !== expect || r.prev !== prev || activityHash(rest) !== hash) return { ok: false, checked: expect - 1, brokenAt: r.seq };
    prev = hash;
    expect++;
  }
  return { ok: true, checked: rows.length, brokenAt: null };
}

export class Activity<V> {
  readonly model: Model<ActivityRow>;
  readonly #o: ActivityOptions<V>;
  #tail: Promise<unknown> = Promise.resolve();
  #last: { seq: number; hash: string } | null = null;

  constructor(o: ActivityOptions<V>) {
    this.#o = o;
    this.model = defineModel<ActivityRow>(o.name ?? "KitActivity", {
      fields: {
        id: "string",
        seq: "number",
        scope: "string",
        path: "string",
        actor: "string | null",
        impersonator: "string | null",
        action: "string",
        target: "string | null",
        summary: "string",
        meta: "Record<string, string | number | boolean | null>",
        ip: "string | null",
        at: "number",
        prev: "string",
        hash: "string",
      },
      attrs: { path: { index: true }, at: { index: true } },
      read: (a) => a === SYSTEM,
      write: (a) => a === SYSTEM,
    });
  }

  pathOf(scope: string): string {
    const chain: string[] = [];
    for (let s: string | null = scope, d = 0; s !== null && d < MAX_DEPTH; d++, s = this.#o.parentTenant(s)) chain.unshift(s);
    return `/${chain.join("/")}/`;
  }

  log(input: ActivityInput): Promise<ActivityRow> {
    const run = this.#tail.then(() => this.#append(input));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async list(viewer: V, scope: string, q: ActivityQuery = {}): Promise<ActivityRow[]> {
    if (!this.#safeRead(viewer, scope)) throw new ActivityError("not allowed");
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? 50), 1), 500);
    const where: Record<string, unknown> = { path: { startsWith: this.pathOf(scope) } };
    if (q.actor) where.actor = q.actor;
    if (q.target) where.target = q.target;
    if (q.action) where.action = q.action.endsWith(".") ? { startsWith: q.action } : q.action;
    const at: Record<string, number> = {};
    if (q.since !== undefined) at.gte = q.since;
    if (q.until !== undefined) at.lt = q.until;
    if (Object.keys(at).length) where.at = at;
    const seq = q.before !== undefined ? { seq: { lt: q.before } } : {};
    return this.model
      .as(SYSTEM as never)
      .query()
      .where({ ...where, ...seq } as never)
      .orderBy("seq", "desc")
      .limit(limit)
      .all();
  }

  async verify(): Promise<{ ok: boolean; checked: number; brokenAt: number | null }> {
    return verifyChain(await this.model.as(SYSTEM as never).query().orderBy("seq", "asc").all());
  }

  async export(viewer: V, scope: string, q: ActivityQuery = {}): Promise<string> {
    const rows = await this.list(viewer, scope, { ...q, limit: q.limit ?? 500 });
    return rows
      .reverse()
      .map((r) => JSON.stringify(r))
      .join("\n");
  }

  dataSink(scopeOf: (e: AuditEvent) => string | null): (e: AuditEvent) => void {
    return (e) => {
      if (e.outcome !== "denied") return;
      const scope = scopeOf(e);
      if (!scope) return;
      const actor = typeof e.actor === "object" && e.actor && "id" in e.actor ? String((e.actor as { id: unknown }).id) : typeof e.actor === "string" ? e.actor : null;
      void this.log({ scope, actor, action: "data.denied", target: e.model, summary: `${e.action} on ${e.model} denied`, meta: { action: e.action, count: e.count, reason: e.reason ?? null } }).catch(() => {});
    };
  }

  #safeRead(viewer: V, scope: string): boolean {
    try {
      return this.#o.canRead(viewer, scope) === true;
    } catch {
      return false;
    }
  }

  #clean(meta: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
    const out: Record<string, string | number | boolean | null> = {};
    const rules = [...SECRET, ...(this.#o.redact ?? [])];
    for (const [k, v] of Object.entries(meta ?? {}).slice(0, 40)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,60}$/.test(k)) continue;
      if (rules.some((r) => (typeof r === "string" ? r === k : r.test(k)))) {
        out[k] = "[redacted]";
        continue;
      }
      if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v as never;
      else if (typeof v === "string") out[k] = v.slice(0, 500);
      else if (v !== undefined) out[k] = JSON.stringify(v)?.slice(0, 500) ?? null;
    }
    return out;
  }

  async #append(input: ActivityInput): Promise<ActivityRow> {
    if (!ACTION.test(input.action)) throw new ActivityError(`action \`${input.action}\` is like \`server.started\``);
    if (typeof input.scope !== "string" || input.scope === "") throw new ActivityError("scope");
    const scoped = this.model.as(SYSTEM as never);
    if (!this.#last) {
      const top = await scoped.query().orderBy("seq", "desc").limit(1).all();
      this.#last = top[0] ? { seq: top[0].seq, hash: top[0].hash } : { seq: 0, hash: GENESIS };
    }
    const seq = this.#last.seq + 1;
    const base: Omit<ActivityRow, "hash"> = {
      id: `a${seq.toString().padStart(12, "0")}`,
      seq,
      scope: input.scope,
      path: this.pathOf(input.scope),
      actor: input.actor ?? null,
      impersonator: input.impersonator ?? null,
      action: input.action,
      target: input.target ?? null,
      summary: (input.summary ?? input.action).slice(0, 300),
      meta: this.#clean(input.meta),
      ip: typeof input.ip === "string" && input.ip.length <= 64 ? input.ip : null,
      at: (this.#o.now ?? Date.now)(),
      prev: this.#last.hash,
    };
    const row = { ...base, hash: activityHash(base) };
    try {
      const made = await scoped.create(row);
      if (!made) throw new ActivityError("could not write the activity log");
    } catch (err) {
      this.#last = null;
      throw err;
    }
    this.#last = { seq, hash: row.hash };
    try {
      this.#o.onAppend?.(row);
    } catch {
      return row;
    }
    return row;
  }
}

export function defineActivity<V>(o: ActivityOptions<V>): Activity<V> {
  return new Activity<V>(o);
}
