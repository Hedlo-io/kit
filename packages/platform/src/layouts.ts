import { asyncTransaction, defineModel, type Model } from "@weft-framework/data";
import type { WidgetRegistry, WidgetSize } from "./widgets.ts";

export interface LayoutItem {
  i: string;
  widget: string;
  x: number;
  y: number;
  w: number;
  h: number;
  settings?: Record<string, unknown>;
}

export type LayoutScope = "user" | "role" | "tenant";

export interface LayoutRow {
  id: string;
  dashboard: string;
  scope: LayoutScope;
  owner: string;
  tenant: string;
  items: LayoutItem[];
  updated: number;
  by: string | null;
}

export interface DashboardDef {
  id: string;
  columns?: number;
  maxRows?: number;
  defaults: readonly LayoutItem[];
}

export type LayoutTarget = { scope: "user" } | { scope: "role"; role: string } | { scope: "tenant" };

export interface ResolvedItem extends LayoutItem {
  size: WidgetSize;
  settings: Record<string, boolean | number | string>;
}

export interface ResolvedLayout {
  dashboard: string;
  columns: number;
  items: ResolvedItem[];
  source: { scope: LayoutScope | "default"; tenant: string | null; owner: string | null };
}

export interface LayoutsOptions<V> {
  widgets: WidgetRegistry<V>;
  dashboards: readonly DashboardDef[];
  userId(viewer: V): string | null;
  tenantOf(viewer: V): string | null;
  rolesOf(viewer: V, tenant: string): readonly string[];
  parentTenant(tenant: string): string | null;
  canManage(viewer: V, tenant: string): boolean;
  name?: string;
  now?(): number;
}

export class LayoutError extends Error {}

const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ROLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ITEMS = 60;
const MAX_DEPTH = 8;

export class Layouts<V> {
  readonly model: Model<LayoutRow>;
  readonly #o: LayoutsOptions<V>;
  readonly #dashboards = new Map<string, Required<DashboardDef>>();

  constructor(o: LayoutsOptions<V>) {
    this.#o = o;
    for (const d of o.dashboards) {
      if (!/^[a-z][a-z0-9.-]{0,63}$/.test(d.id)) throw new LayoutError(`dashboard id \`${d.id}\``);
      if (this.#dashboards.has(d.id)) throw new LayoutError(`dashboard \`${d.id}\` twice`);
      const columns = d.columns ?? 12;
      const maxRows = d.maxRows ?? 200;
      if (!Number.isInteger(columns) || columns < 1 || columns > 24) throw new LayoutError(`dashboard \`${d.id}\`: columns 1–24`);
      this.#dashboards.set(d.id, { id: d.id, columns, maxRows, defaults: d.defaults });
    }
    const uid = (a: unknown) => {
      try {
        return o.userId(a as V);
      } catch {
        return null;
      }
    };
    const manages = (a: unknown, t: string) => {
      try {
        return o.canManage(a as V, t) === true;
      } catch {
        return false;
      }
    };
    this.model = defineModel<LayoutRow>(o.name ?? "KitLayout", {
      fields: {
        id: "string",
        dashboard: "string",
        scope: '"user" | "role" | "tenant"',
        owner: "string",
        tenant: "string",
        items: "LayoutItem[]",
        updated: "number",
        by: "string | null",
      },
      attrs: { dashboard: { index: true }, tenant: { index: true } },
      read: (a, r) => {
        const me = uid(a);
        if (me === null) return false;
        return r.scope !== "user" || r.owner === me || manages(a, r.tenant);
      },
      write: (a, r) => {
        const me = uid(a);
        if (me === null) return false;
        if (r.scope === "user") return r.owner === me;
        return manages(a, r.tenant);
      },
    });
  }

  dashboard(id: string): Required<DashboardDef> {
    const d = this.#dashboards.get(id);
    if (!d) throw new LayoutError(`no dashboard \`${id}\``);
    return d;
  }

  static key(dashboard: string, scope: LayoutScope, tenant: string, owner: string): string {
    return JSON.stringify([dashboard, scope, tenant, owner]);
  }

  validate(dashboardId: string, items: unknown, viewer: V | null, context: Record<string, unknown> = {}): LayoutItem[] {
    const d = this.dashboard(dashboardId);
    if (!Array.isArray(items)) throw new LayoutError("a layout is a list of items");
    if (items.length > MAX_ITEMS) throw new LayoutError(`at most ${MAX_ITEMS} widgets`);
    const seen = new Set<string>();
    const taken: LayoutItem[] = [];
    const clean: LayoutItem[] = [];
    for (const raw of items as unknown[]) {
      if (!raw || typeof raw !== "object") throw new LayoutError("each item is an object");
      const it = raw as Record<string, unknown>;
      const i = it.i;
      if (typeof i !== "string" || !ITEM_ID.test(i) || seen.has(i)) throw new LayoutError(`item id \`${String(i)}\` is missing, malformed or repeated`);
      seen.add(i);
      const def = typeof it.widget === "string" ? this.#o.widgets.get(it.widget) : undefined;
      if (!def) throw new LayoutError(`item \`${i}\`: unknown widget \`${String(it.widget)}\``);
      if (viewer !== null && !this.#o.widgets.allowed(def, viewer, d.id, context)) throw new LayoutError(`item \`${i}\`: widget \`${def.id}\` is not available here`);
      if (def.dashboards && !def.dashboards.includes(d.id)) throw new LayoutError(`item \`${i}\`: widget \`${def.id}\` is not for this dashboard`);
      const [x, y, w, h] = [it.x, it.y, it.w, it.h];
      if (![x, y, w, h].every((n) => Number.isInteger(n))) throw new LayoutError(`item \`${i}\`: x, y, w, h are whole numbers`);
      const box = { x: x as number, y: y as number, w: w as number, h: h as number };
      if (!this.#o.widgets.fits(def, box)) throw new LayoutError(`item \`${i}\`: ${box.w}×${box.h} is not a size of \`${def.id}\``);
      if (box.x < 0 || box.y < 0 || box.x + box.w > d.columns || box.y + box.h > d.maxRows) throw new LayoutError(`item \`${i}\`: outside the grid`);
      const clash = taken.find((t) => box.x < t.x + t.w && t.x < box.x + box.w && box.y < t.y + t.h && t.y < box.y + box.h);
      if (clash) throw new LayoutError(`item \`${i}\` overlaps \`${clash.i}\``);
      const settings = it.settings === undefined ? undefined : this.#o.widgets.settings(def, it.settings as Record<string, unknown>);
      const item: LayoutItem = { i, widget: def.id, ...box, ...(settings ? { settings } : {}) };
      taken.push(item);
      clean.push(item);
    }
    return clean;
  }

  async resolve(viewer: V, dashboardId: string, context: Record<string, unknown> = {}): Promise<ResolvedLayout> {
    const d = this.dashboard(dashboardId);
    const me = this.#o.userId(viewer);
    const home = this.#o.tenantOf(viewer);
    const scoped = this.model.as(viewer as never);
    const candidates: [LayoutScope, string, string][] = [];
    if (home !== null) {
      if (me !== null) candidates.push(["user", home, me]);
      for (const role of this.#o.rolesOf(viewer, home)) candidates.push(["role", home, role]);
      let t: string | null = home;
      for (let depth = 0; t !== null && depth < MAX_DEPTH; depth++) {
        candidates.push(["tenant", t, ""]);
        t = this.#o.parentTenant(t);
      }
    }
    for (const [scope, tenant, owner] of candidates) {
      const row = await scoped.get(Layouts.key(d.id, scope, tenant, owner));
      if (row) return { dashboard: d.id, columns: d.columns, items: this.#visible(row.items, viewer, d.id, context), source: { scope, tenant, owner: owner || null } };
    }
    return { dashboard: d.id, columns: d.columns, items: this.#visible([...d.defaults], viewer, d.id, context), source: { scope: "default", tenant: null, owner: null } };
  }

  async save(viewer: V, dashboardId: string, items: unknown, target: LayoutTarget = { scope: "user" }, context: Record<string, unknown> = {}): Promise<boolean> {
    const d = this.dashboard(dashboardId);
    const me = this.#o.userId(viewer);
    const tenant = this.#o.tenantOf(viewer);
    if (me === null || tenant === null) return false;
    const owner = this.#owner(target, me);
    const clean = this.validate(d.id, items, target.scope === "user" ? viewer : null, context);
    const id = Layouts.key(d.id, target.scope, tenant, owner);
    const scoped = this.model.as(viewer as never);
    const row: LayoutRow = { id, dashboard: d.id, scope: target.scope, owner, tenant, items: clean, updated: (this.#o.now ?? Date.now)(), by: me };
    return this.#tx(async () => {
      const old = await scoped.get(id);
      if (old) return (await scoped.update((r) => r.id === id, { items: row.items, updated: row.updated, by: me })) === 1;
      return (await scoped.create(row)) !== undefined;
    });
  }

  async reset(viewer: V, dashboardId: string, target: LayoutTarget = { scope: "user" }): Promise<boolean> {
    const d = this.dashboard(dashboardId);
    const me = this.#o.userId(viewer);
    const tenant = this.#o.tenantOf(viewer);
    if (me === null || tenant === null) return false;
    const id = Layouts.key(d.id, target.scope, tenant, this.#owner(target, me));
    return (await this.model.as(viewer as never).delete((r) => r.id === id)) === 1;
  }

  #owner(target: LayoutTarget, me: string): string {
    if (target.scope === "user") return me;
    if (target.scope === "role") {
      if (!ROLE.test(target.role ?? "")) throw new LayoutError(`role \`${String(target.role)}\``);
      return target.role;
    }
    return "";
  }

  #visible(items: readonly LayoutItem[], viewer: V, dashboard: string, context: Record<string, unknown>): ResolvedItem[] {
    const out: ResolvedItem[] = [];
    for (const it of items) {
      const def = this.#o.widgets.get(it.widget);
      if (!def || !this.#o.widgets.allowed(def, viewer, dashboard, context)) continue;
      let settings: Record<string, boolean | number | string>;
      try {
        settings = this.#o.widgets.settings(def, it.settings);
      } catch {
        settings = this.#o.widgets.settings(def, undefined);
      }
      const size = this.#o.widgets.fits(def, it) ? { w: it.w, h: it.h } : { ...def.sizes[0]! };
      out.push({ ...it, w: size.w, h: size.h, size, settings });
    }
    return out;
  }

  #tx<R>(fn: () => Promise<R>): Promise<R> {
    return this.model.isAsync ? asyncTransaction(fn) : fn();
  }
}

export function defineLayouts<V>(o: LayoutsOptions<V>): Layouts<V> {
  return new Layouts<V>(o);
}
