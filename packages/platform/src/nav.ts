import { asyncTransaction, defineModel, type Model } from "@weft-framework/data";
import type { SlotRegistry } from "./slots.ts";

export interface NavTweak {
  id: string;
  hidden?: boolean;
  title?: string;
  icon?: string;
  order?: number;
}

export interface NavLink {
  id: string;
  title: string;
  href: string;
  icon?: string;
  order?: number;
  newTab?: boolean;
}

export interface NavRow {
  id: string;
  nav: string;
  tenant: string;
  owner: string;
  tweaks: NavTweak[];
  links: NavLink[];
  pins: string[];
  updated: number;
}

export interface NavItem {
  id: string;
  title: string;
  href: string;
  icon: string | null;
  order: number;
  custom: boolean;
  pinned: boolean;
  newTab: boolean;
}

export interface NavOptions<V> {
  slots: SlotRegistry<V>;
  userId(viewer: V): string | null;
  tenantOf(viewer: V): string | null;
  parentTenant(tenant: string): string | null;
  canManage(viewer: V, tenant: string): boolean;
  name?: string;
  now?(): number;
  maxLinks?: number;
  maxPins?: number;
}

export class NavError extends Error {}

const ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const ICON = /^[a-z0-9-]{1,64}$/;
const MAX_DEPTH = 8;

export function safeHref(href: unknown): string | null {
  if (typeof href !== "string" || href.length === 0 || href.length > 2000) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(href)) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "mailto:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t.length >= 1 && t.length <= max && !/[\u0000-\u001f\u007f]/.test(t) ? t : null;
}

export class Navigation<V> {
  readonly model: Model<NavRow>;
  readonly #o: NavOptions<V>;

  constructor(o: NavOptions<V>) {
    this.#o = o;
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
    this.model = defineModel<NavRow>(o.name ?? "KitNav", {
      fields: { id: "string", nav: "string", tenant: "string", owner: "string", tweaks: "NavTweak[]", links: "NavLink[]", pins: "string[]", updated: "number" },
      attrs: { tenant: { index: true } },
      read: (a, r) => {
        const me = uid(a);
        return me !== null && (r.owner === "" || r.owner === me);
      },
      write: (a, r) => {
        const me = uid(a);
        if (me === null) return false;
        return r.owner === "" ? manages(a, r.tenant) : r.owner === me;
      },
    });
  }

  static key(nav: string, tenant: string, owner: string): string {
    return JSON.stringify([nav, tenant, owner]);
  }

  async items(viewer: V, nav: string, props: object = {}): Promise<NavItem[]> {
    const base = this.#o.slots.entries(nav, viewer, props);
    const tenant = this.#o.tenantOf(viewer);
    const me = this.#o.userId(viewer);
    const scoped = this.model.as(viewer as never);
    let site: NavRow | undefined;
    for (let t = tenant, depth = 0; t !== null && depth < MAX_DEPTH && !site; depth++) {
      site = await scoped.get(Navigation.key(nav, t, ""));
      t = this.#o.parentTenant(t);
    }
    const mine = tenant !== null && me !== null ? await scoped.get(Navigation.key(nav, tenant, me)) : undefined;
    const tweaks = new Map((site?.tweaks ?? []).map((t) => [t.id, t]));
    const pins = new Set(mine?.pins ?? []);
    const out: NavItem[] = [];
    for (const e of base) {
      if (e.link === null) continue;
      const t = tweaks.get(e.id);
      if (t?.hidden) continue;
      out.push({
        id: e.id,
        title: t?.title ?? e.title ?? e.id,
        href: e.link,
        icon: t?.icon ?? e.icon ?? null,
        order: t?.order ?? e.order,
        custom: false,
        pinned: pins.has(e.id),
        newTab: false,
      });
    }
    for (const l of site?.links ?? []) {
      out.push({ id: l.id, title: l.title, href: l.href, icon: l.icon ?? null, order: l.order ?? 1000, custom: true, pinned: pins.has(l.id), newTab: l.newTab === true });
    }
    return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order || (a.id < b.id ? -1 : 1));
  }

  async configure(viewer: V, nav: string, patch: { tweaks?: unknown; links?: unknown }): Promise<boolean> {
    const tenant = this.#o.tenantOf(viewer);
    if (tenant === null || !this.#o.slots.spec(nav)) return false;
    const tweaks = patch.tweaks === undefined ? undefined : this.#tweaks(patch.tweaks);
    const links = patch.links === undefined ? undefined : this.#links(patch.links);
    return this.#upsert(viewer, nav, tenant, "", { ...(tweaks ? { tweaks } : {}), ...(links ? { links } : {}) });
  }

  async pin(viewer: V, nav: string, ids: unknown): Promise<boolean> {
    const tenant = this.#o.tenantOf(viewer);
    const me = this.#o.userId(viewer);
    if (tenant === null || me === null || !this.#o.slots.spec(nav)) return false;
    if (!Array.isArray(ids) || ids.length > (this.#o.maxPins ?? 20) || !ids.every((i) => typeof i === "string" && ID.test(i))) throw new NavError("pins are a short list of item ids");
    return this.#upsert(viewer, nav, tenant, me, { pins: [...new Set(ids as string[])] });
  }

  async reset(viewer: V, nav: string, which: "site" | "mine"): Promise<boolean> {
    const tenant = this.#o.tenantOf(viewer);
    const me = this.#o.userId(viewer);
    if (tenant === null || me === null) return false;
    const id = Navigation.key(nav, tenant, which === "site" ? "" : me);
    return (await this.model.as(viewer as never).delete((r) => r.id === id)) === 1;
  }

  #tweaks(raw: unknown): NavTweak[] {
    if (!Array.isArray(raw) || raw.length > 200) throw new NavError("tweaks are a list");
    const seen = new Set<string>();
    return raw.map((r: Record<string, unknown>) => {
      if (!r || typeof r.id !== "string" || !ID.test(r.id) || seen.has(r.id)) throw new NavError(`tweak id \`${String(r?.id)}\``);
      seen.add(r.id);
      const t: NavTweak = { id: r.id };
      if (r.hidden !== undefined) t.hidden = r.hidden === true;
      if (r.title !== undefined) t.title = text(r.title, 80) ?? (() => { throw new NavError(`tweak \`${r.id}\`: title`); })();
      if (r.icon !== undefined) {
        if (typeof r.icon !== "string" || !ICON.test(r.icon)) throw new NavError(`tweak \`${r.id}\`: icon`);
        t.icon = r.icon;
      }
      if (r.order !== undefined) {
        if (!Number.isInteger(r.order) || Math.abs(r.order as number) > 100_000) throw new NavError(`tweak \`${r.id}\`: order`);
        t.order = r.order as number;
      }
      return t;
    });
  }

  #links(raw: unknown): NavLink[] {
    if (!Array.isArray(raw) || raw.length > (this.#o.maxLinks ?? 30)) throw new NavError("links are a short list");
    const seen = new Set<string>();
    return raw.map((r: Record<string, unknown>) => {
      if (!r || typeof r.id !== "string" || !/^custom-[a-z0-9-]{1,40}$/.test(r.id) || seen.has(r.id)) throw new NavError(`link id \`${String(r?.id)}\` (custom-…)`);
      seen.add(r.id);
      const title = text(r.title, 80);
      const href = safeHref(r.href);
      if (title === null) throw new NavError(`link \`${r.id}\`: title`);
      if (href === null) throw new NavError(`link \`${r.id}\`: href is a site path or an https/mailto URL`);
      const l: NavLink = { id: r.id, title, href };
      if (r.icon !== undefined) {
        if (typeof r.icon !== "string" || !ICON.test(r.icon)) throw new NavError(`link \`${r.id}\`: icon`);
        l.icon = r.icon;
      }
      if (r.order !== undefined) {
        if (!Number.isInteger(r.order)) throw new NavError(`link \`${r.id}\`: order`);
        l.order = r.order as number;
      }
      if (r.newTab === true) l.newTab = true;
      return l;
    });
  }

  async #upsert(viewer: V, nav: string, tenant: string, owner: string, patch: Partial<NavRow>): Promise<boolean> {
    const id = Navigation.key(nav, tenant, owner);
    const scoped = this.model.as(viewer as never);
    const updated = (this.#o.now ?? Date.now)();
    const run = async () => {
      const old = await scoped.get(id);
      if (old) return (await scoped.update((r) => r.id === id, { ...patch, updated })) === 1;
      return (await scoped.create({ id, nav, tenant, owner, tweaks: [], links: [], pins: [], ...patch, updated })) !== undefined;
    };
    return this.model.isAsync ? asyncTransaction(run) : run();
  }
}

export function defineNavigation<V>(o: NavOptions<V>): Navigation<V> {
  return new Navigation<V>(o);
}
