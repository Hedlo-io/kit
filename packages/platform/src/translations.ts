import { asyncTransaction, defineModel, type Model } from "@weft-framework/data";
import { argumentsOf, catalogEntries, format, MessageSyntaxError, type Catalog, type I18n, type Translator } from "@weft-framework/i18n";

export interface TranslationRow {
  id: string;
  tenant: string;
  locale: string;
  key: string;
  message: string;
  updated: number;
  by: string | null;
}

export interface TranslationOptions<V> {
  i18n: I18n<string, Catalog>;
  base: Catalog;
  userId(viewer: V): string | null;
  parentTenant(tenant: string): string | null;
  canManage(viewer: V, tenant: string): boolean;
  name?: string;
  now?(): number;
}

export interface KeyInfo {
  key: string;
  base: string;
  current: string;
  overridden: boolean;
  inherited: boolean;
  plugin: string | null;
  args: string[];
}

export class TranslationError extends Error {}

const MAX_DEPTH = 8;
const KEY = /^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,8}$/;

export class Translations<V> {
  readonly model: Model<TranslationRow>;
  readonly #o: TranslationOptions<V>;
  readonly #base: Map<string, string>;
  readonly #plugins = new Map<string, { plugin: string; byLocale: Map<string, Record<string, string>> }>();
  readonly #cache = new Map<string, Record<string, string>>();

  constructor(o: TranslationOptions<V>) {
    this.#o = o;
    this.#base = new Map(catalogEntries(o.base));
    const manages = (a: unknown, t: string) => {
      try {
        return o.userId(a as V) !== null && o.canManage(a as V, t) === true;
      } catch {
        return false;
      }
    };
    this.model = defineModel<TranslationRow>(o.name ?? "KitTranslation", {
      fields: { id: "string", tenant: "string", locale: "string", key: "string", message: "string", updated: "number", by: "string | null" },
      attrs: { tenant: { index: true } },
      read: () => true,
      write: (a, r) => manages(a, r.tenant),
    });
    this.model.feed.subscribe((c) => {
      if (c.model === this.model.name) this.#cache.clear();
    });
    this.model.feed.onGap(() => this.#cache.clear());
  }

  registerCatalog(plugin: string, locale: string, catalog: Record<string, string>): () => void {
    const added: string[] = [];
    for (const [key, msg] of Object.entries(catalog)) {
      if (!KEY.test(key) || this.#base.has(key)) throw new TranslationError(`${plugin}: key \`${key}\``);
      const owner = this.#plugins.get(key);
      if (owner && owner.plugin !== plugin) throw new TranslationError(`${plugin}: \`${key}\` belongs to ${owner.plugin}`);
      this.#parse(key, msg);
    }
    for (const [key, msg] of Object.entries(catalog)) {
      let entry = this.#plugins.get(key);
      if (!entry) this.#plugins.set(key, (entry = { plugin, byLocale: new Map() }));
      entry.byLocale.set(locale, { ...(entry.byLocale.get(locale) ?? {}), [key]: msg });
      added.push(key);
    }
    this.#cache.clear();
    return () => {
      for (const key of added) {
        const entry = this.#plugins.get(key);
        if (!entry || entry.plugin !== plugin) continue;
        entry.byLocale.delete(locale);
        if (entry.byLocale.size === 0) this.#plugins.delete(key);
      }
      this.#cache.clear();
    };
  }

  removePlugin(plugin: string): number {
    let n = 0;
    for (const [key, e] of this.#plugins) if (e.plugin === plugin && this.#plugins.delete(key)) n++;
    this.#cache.clear();
    return n;
  }

  baseMessage(key: string, locale?: string): string | undefined {
    const plugin = this.#plugins.get(key);
    if (plugin) return plugin.byLocale.get(locale ?? this.#o.i18n.defaultLocale)?.[key] ?? plugin.byLocale.get(this.#o.i18n.defaultLocale)?.[key];
    return this.#base.get(key);
  }

  keys(): string[] {
    return [...this.#base.keys(), ...this.#plugins.keys()].sort();
  }

  async overrides(tenant: string, locale: string): Promise<Record<string, string>> {
    const ck = `${tenant}\u0000${locale}`;
    const hit = this.#cache.get(ck);
    if (hit) return hit;
    const chain: string[] = [];
    for (let t: string | null = tenant, d = 0; t !== null && d < MAX_DEPTH; d++, t = this.#o.parentTenant(t)) chain.unshift(t);
    const rows = await this.model
      .as({ kit: "translations" } as never)
      .query()
      .where({ locale, tenant: { in: chain } })
      .all();
    const out: Record<string, string> = {};
    const plugins: Record<string, string> = {};
    for (const [key, e] of this.#plugins) {
      const m = e.byLocale.get(locale);
      if (m?.[key] !== undefined) plugins[key] = m[key]!;
    }
    Object.assign(out, plugins);
    for (const t of chain) for (const r of rows) if (r.tenant === t && this.#known(r.key)) out[r.key] = r.message;
    this.#cache.set(ck, out);
    return out;
  }

  async translator(tenant: string, locale: string): Promise<Translator<Catalog>> {
    const base = (await this.#o.i18n.translator(locale)) as Translator<Catalog>;
    const own = await this.overrides(tenant, base.locale);
    const fallback = base.locale === this.#o.i18n.defaultLocale ? own : await this.overrides(tenant, this.#o.i18n.defaultLocale);
    const t = ((key: string, params: Record<string, unknown> = {}) => {
      const msg = own[key] ?? (this.#plugins.has(key) ? fallback[key] : undefined);
      if (msg === undefined) return (base as unknown as (k: string, p: unknown) => string)(key, params);
      try {
        return format(msg, params, base.locale);
      } catch {
        return (base as unknown as (k: string, p: unknown) => string)(key, params);
      }
    }) as unknown as Translator<Catalog>;
    return Object.defineProperties(t, {
      locale: { value: base.locale },
      dir: { value: base.dir },
      has: { value: (k: string) => own[k] !== undefined || fallback[k] !== undefined || base.has(k) },
      number: { value: base.number.bind(base) },
      date: { value: base.date.bind(base) },
      time: { value: base.time.bind(base) },
      relative: { value: base.relative.bind(base) },
      list: { value: base.list.bind(base) },
    });
  }

  async list(tenant: string, locale: string, filter = ""): Promise<KeyInfo[]> {
    const merged = await this.overrides(tenant, locale);
    const mine = new Set(
      (await this.model
        .as({ kit: "translations" } as never)
        .query()
        .where({ tenant, locale })
        .all()).map((r) => r.key),
    );
    const base = locale === this.#o.i18n.defaultLocale ? null : ((await this.#o.i18n.translator(locale)) as Translator<Catalog>);
    const q = filter.toLowerCase();
    return this.keys()
      .map((key): KeyInfo => {
        const def = this.baseMessage(key) ?? "";
        const plugin = this.#plugins.get(key)?.plugin ?? null;
        const translated = base && !plugin && base.has(key) ? ((base as unknown as (k: string) => string)(key) ?? def) : def;
        const current = merged[key] ?? translated;
        return { key, base: def, current, overridden: mine.has(key), inherited: !mine.has(key) && merged[key] !== undefined && !plugin, plugin, args: [...argumentsOf(def).keys()].sort() };
      })
      .filter((k) => !q || k.key.toLowerCase().includes(q) || k.current.toLowerCase().includes(q));
  }

  validate(key: string, message: string): string | null {
    if (!this.#known(key)) return `unknown key \`${key}\``;
    if (typeof message !== "string" || message.length > 10_000) return "message: text up to 10000 characters";
    try {
      this.#parse(key, message);
    } catch (err) {
      return err instanceof TranslationError ? err.message : String(err);
    }
    const want = [...argumentsOf(this.baseMessage(key)!).keys()].sort();
    const got = [...argumentsOf(message).keys()].sort();
    const extra = got.filter((a) => !want.includes(a));
    if (extra.length) return `\`${key}\` has no argument ${extra.map((a) => `{${a}}`).join(", ")}; use ${want.map((a) => `{${a}}`).join(", ") || "none"}`;
    return null;
  }

  async set(viewer: V, tenant: string, locale: string, entries: Record<string, string | null>): Promise<number> {
    const me = this.#o.userId(viewer);
    if (me === null || !this.#o.canManage(viewer, tenant)) throw new TranslationError("not allowed");
    if (!this.#o.i18n.locales.includes(locale)) throw new TranslationError(`locale \`${locale}\` is not enabled`);
    const list = Object.entries(entries ?? {});
    if (list.length > 5000) throw new TranslationError("at most 5000 entries at once");
    for (const [k, m] of list) {
      if (m === null) continue;
      const p = this.validate(k, m);
      if (p) throw new TranslationError(p);
    }
    const scoped = this.model.as(viewer as never);
    const updated = (this.#o.now ?? Date.now)();
    const run = async () => {
      let n = 0;
      for (const [key, message] of list) {
        const id = JSON.stringify([tenant, locale, key]);
        const old = await scoped.get(id);
        if (message === null) {
          if (old) n += await scoped.delete((r) => r.id === id);
        } else if (old) n += await scoped.update((r) => r.id === id, { message, updated, by: me });
        else if (await scoped.create({ id, tenant, locale, key, message, updated, by: me })) n++;
      }
      return n;
    };
    return this.model.isAsync ? asyncTransaction(run) : run();
  }

  async exportOverrides(tenant: string, locale: string): Promise<string> {
    const rows = await this.model
      .as({ kit: "translations" } as never)
      .query()
      .where({ tenant, locale })
      .all();
    const messages = Object.fromEntries(rows.map((r) => [r.key, r.message]).sort(([a], [b]) => (a! < b! ? -1 : 1)));
    return JSON.stringify({ format: "kit-translations", version: 1, locale, messages }, null, 2);
  }

  async importOverrides(viewer: V, tenant: string, json: string): Promise<{ saved: number; skipped: string[] }> {
    let doc: { format?: unknown; version?: unknown; locale?: unknown; messages?: unknown };
    try {
      doc = JSON.parse(json);
    } catch {
      throw new TranslationError("import: not JSON");
    }
    if (doc?.format !== "kit-translations" || doc.version !== 1 || typeof doc.locale !== "string" || !doc.messages || typeof doc.messages !== "object") throw new TranslationError("import: not a translations export");
    const good: Record<string, string> = {};
    const skipped: string[] = [];
    for (const [k, v] of Object.entries(doc.messages as Record<string, unknown>)) {
      if (typeof v === "string" && this.validate(k, v) === null) good[k] = v;
      else skipped.push(k);
    }
    return { saved: await this.set(viewer, tenant, doc.locale, good), skipped };
  }

  #known(key: string): boolean {
    return this.#base.has(key) || this.#plugins.has(key);
  }

  #parse(key: string, msg: string): void {
    try {
      format(msg, Object.fromEntries([...argumentsOf(msg).keys()].map((a) => [a, 1])), "en");
    } catch (err) {
      throw new TranslationError(`\`${key}\`: ${err instanceof MessageSyntaxError ? err.message : "not a valid message"}`);
    }
  }
}

export function defineTranslations<V>(o: TranslationOptions<V>): Translations<V> {
  return new Translations<V>(o);
}
