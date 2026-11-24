import { asyncTransaction, defineModel, type Model } from "@weft-framework/data";
import { markdownToText, renderMarkdown } from "./markdown.ts";

export interface BlockSpec {
  title: string;
  description?: string;
  default?: string;
  max?: number;
}

export interface ContentRow {
  id: string;
  tenant: string;
  kind: "block" | "page";
  key: string;
  locale: string;
  title: string;
  body: string;
  published: boolean;
  position: number;
  updated: number;
  by: string | null;
}

export interface RenderedContent {
  key: string;
  title: string;
  html: string;
  text: string;
  tenant: string | null;
  locale: string;
}

export type App = "admin" | "client";
export type Level = "info" | "success" | "warning" | "critical";

export interface AnnouncementRow {
  id: string;
  tenant: string;
  app: App | "both";
  level: Level;
  title: string;
  body: string;
  permission: string | null;
  starts: number;
  ends: number | null;
  dismissible: boolean;
  cascade: boolean;
  created: number;
  by: string | null;
}

export interface DismissalRow {
  id: string;
  owner: string;
  announcement: string;
  at: number;
}

export interface ShownAnnouncement {
  id: string;
  level: Level;
  title: string;
  html: string;
  dismissible: boolean;
  tenant: string;
}

export interface ContentOptions<V> {
  blocks: Readonly<Record<string, BlockSpec>>;
  defaultLocale: string;
  locales: readonly string[];
  userId(viewer: V): string | null;
  parentTenant(tenant: string): string | null;
  canManage(viewer: V, tenant: string): boolean;
  can?(viewer: V, permission: string, tenant: string): boolean;
  name?: string;
  now?(): number;
}

export class ContentError extends Error {}

const BLOCK_KEY = /^[a-z][a-z0-9-]{0,40}(\.[a-z0-9-]{1,40}){0,3}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const RESERVED = new Set(["admin", "api", "login", "logout", "account", "servers", "billing", "plugins", "_weft", "static", "assets"]);
const MAX_DEPTH = 8;
const SYSTEM = Object.freeze({ kit: "content" });

export const COMMON_BLOCKS: Readonly<Record<string, BlockSpec>> = Object.freeze({
  "login.notice": { title: "Login notice", max: 2000 },
  "site.footer": { title: "Footer", max: 2000 },
  "legal.terms": { title: "Terms of service", max: 200_000 },
  "legal.privacy": { title: "Privacy policy", max: 200_000 },
  "legal.imprint": { title: "Imprint", max: 20_000 },
  "signup.notice": { title: "Sign-up notice", max: 2000 },
});

function text(v: unknown, max: number, field: string, allowEmpty = false): string {
  if (typeof v !== "string" || v.length > max || (!allowEmpty && v.trim() === "")) throw new ContentError(`${field}: ${allowEmpty ? 0 : 1}–${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw new ContentError(`${field}: control characters`);
  return v;
}

export class Content<V> {
  readonly model: Model<ContentRow>;
  readonly announcements: Model<AnnouncementRow>;
  readonly dismissals: Model<DismissalRow>;
  readonly #o: ContentOptions<V>;
  readonly #blocks = new Map<string, BlockSpec & { plugin?: string }>();

  constructor(o: ContentOptions<V>) {
    if (!o.locales.includes(o.defaultLocale)) throw new ContentError("defaultLocale must be one of locales");
    this.#o = o;
    for (const [k, s] of Object.entries(o.blocks)) this.defineBlock(k, s);
    const sys = (a: unknown) => a === SYSTEM;
    const manages = (a: unknown, t: string) => {
      try {
        return o.userId(a as V) !== null && o.canManage(a as V, t) === true;
      } catch {
        return false;
      }
    };
    const base = o.name ?? "Kit";
    this.model = defineModel<ContentRow>(`${base}Content`, {
      fields: { id: "string", tenant: "string", kind: '"block" | "page"', key: "string", locale: "string", title: "string", body: "string", published: "boolean", position: "number", updated: "number", by: "string | null" },
      attrs: { tenant: { index: true } },
      read: (a, r) => sys(a) || r.published || manages(a, r.tenant),
      write: (a, r) => manages(a, r.tenant),
    });
    this.announcements = defineModel<AnnouncementRow>(`${base}Announcement`, {
      fields: {
        id: "string",
        tenant: "string",
        app: '"admin" | "client" | "both"',
        level: '"info" | "success" | "warning" | "critical"',
        title: "string",
        body: "string",
        permission: "string | null",
        starts: "number",
        ends: "number | null",
        dismissible: "boolean",
        cascade: "boolean",
        created: "number",
        by: "string | null",
      },
      attrs: { tenant: { index: true } },
      read: (a, r) => sys(a) || manages(a, r.tenant),
      write: (a, r) => manages(a, r.tenant),
    });
    this.dismissals = defineModel<DismissalRow>(`${base}Dismissal`, {
      fields: { id: "string", owner: "string", announcement: "string", at: "number" },
      attrs: { owner: { index: true } },
      read: (a, r) => sys(a) || o.userId(a as V) === r.owner,
      write: (a, r) => o.userId(a as V) === r.owner,
    });
  }

  get models(): Model<any, any>[] {
    return [this.model, this.announcements, this.dismissals];
  }

  defineBlock(key: string, spec: BlockSpec & { plugin?: string }): () => void {
    if (!BLOCK_KEY.test(key)) throw new ContentError(`block key \`${key}\``);
    if (this.#blocks.has(key)) throw new ContentError(`block \`${key}\` exists`);
    const s = Object.freeze({ ...spec });
    this.#blocks.set(key, s);
    return () => {
      if (this.#blocks.get(key) === s) this.#blocks.delete(key);
    };
  }

  removePlugin(plugin: string): number {
    let n = 0;
    for (const [k, s] of this.#blocks) if (s.plugin === plugin && this.#blocks.delete(k)) n++;
    return n;
  }

  blocks(): { key: string; spec: BlockSpec }[] {
    return [...this.#blocks].map(([key, spec]) => ({ key, spec })).sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  async block(tenant: string, key: string, locale: string): Promise<RenderedContent | null> {
    const spec = this.#blocks.get(key);
    if (!spec) throw new ContentError(`no block \`${key}\``);
    const hit = await this.#nearest("block", tenant, key, locale);
    if (hit) return this.#render(hit);
    if (!spec.default) return null;
    return { key, title: spec.title, html: renderMarkdown(spec.default), text: markdownToText(spec.default), tenant: null, locale: this.#o.defaultLocale };
  }

  async saveBlock(viewer: V, tenant: string, key: string, locale: string, body: string | null): Promise<boolean> {
    const spec = this.#blocks.get(key);
    if (!spec) throw new ContentError(`no block \`${key}\``);
    if (body === null) return this.#remove(viewer, tenant, "block", key, locale);
    return this.#put(viewer, tenant, { kind: "block", key, locale, title: spec.title, body: text(body, spec.max ?? 20_000, key, true), published: true, position: 0 });
  }

  async page(viewer: V | null, tenant: string, slug: string, locale: string): Promise<RenderedContent | null> {
    if (!SLUG.test(slug)) return null;
    const hit = await this.#nearest("page", tenant, slug, locale, viewer);
    return hit ? this.#render(hit) : null;
  }

  async pages(viewer: V | null, tenant: string, locale: string): Promise<{ slug: string; title: string; published: boolean; tenant: string; order: number }[]> {
    const chain = this.#chain(tenant);
    const rows = await this.#rows(viewer, "page", chain, [locale, this.#o.defaultLocale]);
    const seen = new Map<string, ContentRow>();
    for (const t of chain)
      for (const l of [locale, this.#o.defaultLocale])
        for (const r of rows) if (r.tenant === t && r.locale === l && !seen.has(r.key)) seen.set(r.key, r);
    return [...seen.values()].map((r) => ({ slug: r.key, title: r.title, published: r.published, tenant: r.tenant, order: r.position })).sort((a, b) => a.order - b.order || (a.slug < b.slug ? -1 : 1));
  }

  async savePage(viewer: V, tenant: string, slug: string, locale: string, p: { title: string; body: string; published: boolean; order?: number }): Promise<boolean> {
    if (!SLUG.test(slug) || RESERVED.has(slug)) throw new ContentError(`page slug \`${slug}\``);
    return this.#put(viewer, tenant, { kind: "page", key: slug, locale, title: text(p.title, 120, "title").trim(), body: text(p.body, 200_000, "body", true), published: p.published === true, position: Number.isInteger(p.order) ? p.order! : 0 });
  }

  async deletePage(viewer: V, tenant: string, slug: string, locale: string): Promise<boolean> {
    return this.#remove(viewer, tenant, "page", slug, locale);
  }

  async announce(viewer: V, tenant: string, a: Partial<Omit<AnnouncementRow, "id" | "tenant" | "created" | "by">> & { id?: string }): Promise<AnnouncementRow> {
    const me = this.#o.userId(viewer);
    if (me === null || !this.#o.canManage(viewer, tenant)) throw new ContentError("not allowed");
    const now = (this.#o.now ?? Date.now)();
    const app = a.app ?? "both";
    const level = a.level ?? "info";
    if (!["admin", "client", "both"].includes(app)) throw new ContentError("app: admin, client or both");
    if (!["info", "success", "warning", "critical"].includes(level)) throw new ContentError("level: info, success, warning or critical");
    const starts = a.starts ?? now;
    const ends = a.ends ?? null;
    if (!Number.isFinite(starts) || (ends !== null && (!Number.isFinite(ends) || ends <= starts))) throw new ContentError("ends must be after starts");
    if (a.permission != null && !/^[a-z0-9._-]{1,120}$/.test(a.permission)) throw new ContentError("permission");
    const row = {
      tenant,
      app,
      level,
      title: text(a.title, 120, "title").trim(),
      body: text(a.body ?? "", 5000, "body", true),
      permission: a.permission ?? null,
      starts,
      ends,
      dismissible: a.dismissible ?? level !== "critical",
      cascade: a.cascade ?? true,
    } satisfies Partial<AnnouncementRow>;
    const scoped = this.announcements.as(viewer as never);
    if (a.id) {
      const old = await scoped.get(a.id);
      if (!old || old.tenant !== tenant) throw new ContentError("no such announcement");
      await scoped.update((r) => r.id === a.id, row);
      return (await scoped.get(a.id))!;
    }
    const made = await scoped.create({ ...row, id: `${tenant}:${now.toString(36)}:${Math.random().toString(36).slice(2, 10)}`, created: now, by: me });
    if (!made) throw new ContentError("not allowed");
    return made;
  }

  async withdraw(viewer: V, tenant: string, id: string): Promise<boolean> {
    if (!this.#o.canManage(viewer, tenant)) return false;
    return (await this.announcements.as(viewer as never).delete((r) => r.id === id && r.tenant === tenant)) === 1;
  }

  async manageable(viewer: V, tenant: string): Promise<AnnouncementRow[]> {
    if (!this.#o.canManage(viewer, tenant)) return [];
    return (await this.announcements.as(viewer as never).query().where({ tenant }).all()).sort((a, b) => b.created - a.created);
  }

  async active(viewer: V | null, tenant: string, app: App): Promise<ShownAnnouncement[]> {
    const now = (this.#o.now ?? Date.now)();
    const chain = this.#chain(tenant);
    const rows = await this.announcements.as(SYSTEM as never).query().where({ tenant: { in: chain } }).all();
    const me = viewer === null ? null : this.#o.userId(viewer);
    const gone = me === null ? new Set<string>() : new Set((await this.dismissals.as(SYSTEM as never).query().where({ owner: me }).all()).map((d) => d.announcement));
    const rank: Record<Level, number> = { critical: 0, warning: 1, info: 2, success: 3 };
    return rows
      .filter((r) => (r.app === "both" || r.app === app) && r.starts <= now && (r.ends === null || r.ends > now))
      .filter((r) => r.tenant === tenant || r.cascade)
      .filter((r) => !(r.dismissible && gone.has(r.id)))
      .filter((r) => {
        if (r.permission === null) return true;
        if (viewer === null || !this.#o.can) return false;
        try {
          return this.#o.can(viewer, r.permission, tenant) === true;
        } catch {
          return false;
        }
      })
      .sort((a, b) => rank[a.level] - rank[b.level] || b.starts - a.starts)
      .map((r) => ({ id: r.id, level: r.level, title: r.title, html: renderMarkdown(r.body), dismissible: r.dismissible, tenant: r.tenant }));
  }

  async dismiss(viewer: V, id: string): Promise<boolean> {
    const me = this.#o.userId(viewer);
    if (me === null) return false;
    const a = await this.announcements.as(SYSTEM as never).get(id);
    if (!a || !a.dismissible) return false;
    const key = JSON.stringify([me, id]);
    const scoped = this.dismissals.as(viewer as never);
    if (await scoped.get(key)) return true;
    return (await scoped.create({ id: key, owner: me, announcement: id, at: (this.#o.now ?? Date.now)() })) !== undefined;
  }

  static id(tenant: string, kind: string, key: string, locale: string): string {
    return JSON.stringify([tenant, kind, key, locale]);
  }

  #chain(tenant: string): string[] {
    const chain: string[] = [];
    for (let t: string | null = tenant, d = 0; t !== null && d < MAX_DEPTH; d++, t = this.#o.parentTenant(t)) chain.push(t);
    return chain;
  }

  async #rows(viewer: V | null, kind: "block" | "page", chain: string[], locales: string[], key?: string): Promise<ContentRow[]> {
    const where = { kind, tenant: { in: chain }, locale: { in: [...new Set(locales)] }, ...(key ? { key } : {}) };
    const pub = await this.model.as(SYSTEM as never).query().where(where).all();
    if (viewer === null) return pub.filter((r) => r.published);
    return pub.filter((r) => r.published || this.#safeManage(viewer, r.tenant));
  }

  #safeManage(viewer: V, tenant: string): boolean {
    try {
      return this.#o.canManage(viewer, tenant) === true;
    } catch {
      return false;
    }
  }

  async #nearest(kind: "block" | "page", tenant: string, key: string, locale: string, viewer: V | null = null): Promise<ContentRow | null> {
    const chain = this.#chain(tenant);
    const locales = locale === this.#o.defaultLocale ? [locale] : [locale, this.#o.defaultLocale];
    const rows = await this.#rows(viewer, kind, chain, locales, key);
    for (const l of locales) for (const t of chain) {
      const r = rows.find((x) => x.tenant === t && x.locale === l);
      if (r) return r;
    }
    return null;
  }

  #render(r: ContentRow): RenderedContent {
    return { key: r.key, title: r.title, html: renderMarkdown(r.body), text: markdownToText(r.body), tenant: r.tenant, locale: r.locale };
  }

  async #put(viewer: V, tenant: string, v: Pick<ContentRow, "kind" | "key" | "locale" | "title" | "body" | "published" | "position">): Promise<boolean> {
    const me = this.#o.userId(viewer);
    if (me === null || !this.#o.canManage(viewer, tenant)) return false;
    if (!this.#o.locales.includes(v.locale)) throw new ContentError(`locale \`${v.locale}\` is not enabled`);
    const id = Content.id(tenant, v.kind, v.key, v.locale);
    const scoped = this.model.as(viewer as never);
    const updated = (this.#o.now ?? Date.now)();
    const run = async () => {
      if (await scoped.get(id)) return (await scoped.update((r) => r.id === id, { ...v, updated, by: me })) === 1;
      return (await scoped.create({ ...v, id, tenant, updated, by: me })) !== undefined;
    };
    return this.model.isAsync ? asyncTransaction(run) : run();
  }

  async #remove(viewer: V, tenant: string, kind: "block" | "page", key: string, locale: string): Promise<boolean> {
    if (!this.#o.canManage(viewer, tenant)) return false;
    const id = Content.id(tenant, kind, key, locale);
    return (await this.model.as(viewer as never).delete((r) => r.id === id)) === 1;
  }
}

export function defineContent<V>(o: ContentOptions<V>): Content<V> {
  return new Content<V>(o);
}
