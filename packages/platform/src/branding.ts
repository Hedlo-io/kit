import { asyncTransaction, defineModel, type Model } from "@weft-framework/data";
import { defineTheme, shadcnTokens, ThemeError, type Theme } from "@weft-framework/theme";

export type Mode = "light" | "dark" | "system";

export interface BrandingValues {
  productName: string | null;
  logo: string | null;
  logoDark: string | null;
  favicon: string | null;
  loginBackground: string | null;
  emailHeader: string | null;
  emailFooter: string | null;
  mode: Mode | null;
  light: Record<string, string>;
  dark: Record<string, string>;
  shared: Record<string, string>;
  customCss: string | null;
  head: HeadTag[];
}

export interface HeadTag {
  tag: "meta" | "link";
  attrs: Record<string, string>;
}

export interface BrandingRow extends BrandingValues {
  id: string;
  tenant: string;
  updated: number;
  by: string | null;
}

export interface Effective extends Omit<BrandingValues, "mode"> {
  mode: Mode;
  productName: string;
}

export interface ThemePreset {
  id: string;
  title: string;
  light?: Record<string, string>;
  dark?: Record<string, string>;
  shared?: Record<string, string>;
  plugin?: string;
}

export interface BrandingOptions<V> {
  userId(viewer: V): string | null;
  parentTenant(tenant: string): string | null;
  canManage(viewer: V, tenant: string): boolean;
  canEditCode?(viewer: V, tenant: string): boolean;
  defaults?: Partial<Effective>;
  name?: string;
  now?(): number;
}

export class BrandingError extends Error {}

const COLOR_TOKENS = new Set(Object.keys(shadcnTokens.light));
const SHARED_TOKEN = /^(radius|spacing|container|font-(sans|mono|heading)|shadow-(sm|md|lg))$/;
const COLOR_VALUE = /^(#[0-9a-fA-F]{3,8}|(oklch|oklab|rgb|rgba|hsl|hsla|lab|lch|color-mix)\([0-9a-zA-Z.,%\s/+\-]*\)|transparent|currentColor|var\(--[a-z0-9-]+\))$/;
const SHARED_VALUE = /^[0-9a-zA-Z.,%\s"'\-()/+]*$/;
const FILE_ID = /^[A-Za-z0-9._-]{1,200}$/;
const MAX_CSS = 50_000;
const MAX_DEPTH = 8;
const BLOCKED_CSS = [/@import/i, /@charset/i, /@namespace/i, /url\s*\(/i, /expression\s*\(/i, /javascript:/i, /behavior\s*:/i, /-moz-binding/i, /<\/?\s*style/i, /<!--|-->/, /\\/];
const META_NAMES = /^(description|keywords|author|robots|theme-color|color-scheme|application-name|apple-mobile-web-app-title|format-detection|google-site-verification|msvalidate\.01|facebook-domain-verification)$/;
const META_PROPS = /^(og|twitter):[a-z:_]{1,40}$/;
const LINK_RELS = new Set(["icon", "apple-touch-icon", "manifest", "mask-icon"]);

const EMPTY: BrandingValues = {
  productName: null,
  logo: null,
  logoDark: null,
  favicon: null,
  loginBackground: null,
  emailHeader: null,
  emailFooter: null,
  mode: null,
  light: {},
  dark: {},
  shared: {},
  customCss: null,
  head: [],
};

function cleanText(v: unknown, max: number, field: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw new BrandingError(`${field}: text up to ${max} characters`);
  return v.trim() || null;
}

function cleanFile(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !FILE_ID.test(v)) throw new BrandingError(`${field}: an uploaded file id`);
  return v;
}

export function cleanTokens(raw: unknown, kind: "color" | "shared", field: string): Record<string, string> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new BrandingError(`${field}: an object of tokens`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const known = kind === "color" ? COLOR_TOKENS.has(k) : SHARED_TOKEN.test(k);
    if (!known) throw new BrandingError(`${field}: unknown token \`${k}\``);
    if (typeof v !== "string" || v.length > 200) throw new BrandingError(`${field}.${k}: a CSS value`);
    const value = v.trim();
    const ok = kind === "color" ? COLOR_VALUE.test(value) : SHARED_VALUE.test(value) && value.length > 0;
    if (!ok) throw new BrandingError(`${field}.${k}: ${JSON.stringify(value).slice(0, 60)} is not an allowed value`);
    out[k] = value;
  }
  return out;
}

export function sanitizeCss(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") throw new BrandingError("customCss: text");
  if (raw.length > MAX_CSS) throw new BrandingError(`customCss: at most ${MAX_CSS} characters`);
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\r\n?/g, "\n").trim();
  for (const re of BLOCKED_CSS) if (re.test(css)) throw new BrandingError(`customCss: ${re.source.replace(/\\/g, "")} is not allowed`);
  let depth = 0;
  for (const ch of css) {
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) throw new BrandingError("customCss: unbalanced braces");
  }
  if (depth !== 0) throw new BrandingError("customCss: unbalanced braces");
  return css || null;
}

function safeLinkHref(v: string): boolean {
  if (v.startsWith("/") && !v.startsWith("//")) return !/[\s"'<>\\]/.test(v);
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

export function cleanHead(raw: unknown): HeadTag[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 30) throw new BrandingError("head: a short list of tags");
  return raw.map((t: Record<string, unknown>, n) => {
    const attrs = t?.attrs as Record<string, unknown> | undefined;
    if (!t || (t.tag !== "meta" && t.tag !== "link") || !attrs || typeof attrs !== "object") throw new BrandingError(`head[${n}]: { tag: "meta" | "link", attrs }`);
    const str = (k: string, max = 500) => {
      const v = attrs[k];
      if (v === undefined) return undefined;
      if (typeof v !== "string" || v.length > max || /[\u0000-\u001f<>"]/.test(v)) throw new BrandingError(`head[${n}].${k}`);
      return v;
    };
    const allowedKeys = t.tag === "meta" ? ["name", "property", "content"] : ["rel", "href", "sizes", "type", "color"];
    for (const k of Object.keys(attrs)) if (!allowedKeys.includes(k)) throw new BrandingError(`head[${n}]: attribute \`${k}\` is not allowed`);
    if (t.tag === "meta") {
      const name = str("name", 80);
      const property = str("property", 80);
      const content = str("content");
      if (content === undefined || (name === undefined) === (property === undefined)) throw new BrandingError(`head[${n}]: meta needs content and one of name/property`);
      if (name !== undefined && !META_NAMES.test(name)) throw new BrandingError(`head[${n}]: meta name \`${name}\` is not allowed`);
      if (property !== undefined && !META_PROPS.test(property)) throw new BrandingError(`head[${n}]: meta property \`${property}\` is not allowed`);
      return { tag: "meta" as const, attrs: { ...(name ? { name } : { property: property! }), content } };
    }
    const rel = str("rel", 40);
    const href = str("href", 2000);
    if (!rel || !LINK_RELS.has(rel)) throw new BrandingError(`head[${n}]: link rel is one of ${[...LINK_RELS].join(", ")}`);
    if (!href || !safeLinkHref(href)) throw new BrandingError(`head[${n}]: link href is a site path or https URL`);
    const out: Record<string, string> = { rel, href };
    for (const k of ["sizes", "type", "color"]) {
      const v = str(k, 80);
      if (v !== undefined) out[k] = v;
    }
    return { tag: "link" as const, attrs: out };
  });
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderHead(tags: readonly HeadTag[]): string {
  return tags
    .map((t) => `<${t.tag} ${Object.entries(t.attrs).map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ")}>`)
    .join("\n");
}

export class Branding<V> {
  readonly model: Model<BrandingRow>;
  readonly #o: BrandingOptions<V>;
  readonly #presets = new Map<string, ThemePreset>();
  readonly #cache = new Map<string, Effective>();

  constructor(o: BrandingOptions<V>) {
    this.#o = o;
    const manages = (a: unknown, t: string) => {
      try {
        return o.userId(a as V) !== null && o.canManage(a as V, t) === true;
      } catch {
        return false;
      }
    };
    this.model = defineModel<BrandingRow>(o.name ?? "KitBranding", {
      fields: {
        id: "string",
        tenant: "string",
        productName: "string | null",
        logo: "string | null",
        logoDark: "string | null",
        favicon: "string | null",
        loginBackground: "string | null",
        emailHeader: "string | null",
        emailFooter: "string | null",
        mode: '"light" | "dark" | "system" | null',
        light: "Record<string, string>",
        dark: "Record<string, string>",
        shared: "Record<string, string>",
        customCss: "string | null",
        head: "HeadTag[]",
        updated: "number",
        by: "string | null",
      },
      read: () => true,
      write: (a, r) => manages(a, r.tenant),
    });
    this.model.feed.subscribe((c) => {
      if (c.model === this.model.name) this.#cache.clear();
    });
    this.model.feed.onGap(() => this.#cache.clear());
  }

  registerPreset(p: ThemePreset): () => void {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(p.id)) throw new BrandingError(`preset id \`${p.id}\``);
    if (this.#presets.has(p.id)) throw new BrandingError(`preset \`${p.id}\` exists`);
    const preset = Object.freeze({
      ...p,
      light: cleanTokens(p.light, "color", `preset ${p.id} light`),
      dark: cleanTokens(p.dark, "color", `preset ${p.id} dark`),
      shared: cleanTokens(p.shared, "shared", `preset ${p.id} shared`),
    });
    this.#presets.set(p.id, preset);
    return () => {
      if (this.#presets.get(p.id) === preset) this.#presets.delete(p.id);
    };
  }

  removePlugin(plugin: string): number {
    let n = 0;
    for (const [id, p] of this.#presets) if (p.plugin === plugin && this.#presets.delete(id)) n++;
    return n;
  }

  presets(): ThemePreset[] {
    return [...this.#presets.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  validate(raw: Record<string, unknown>, mayEditCode: boolean): Partial<BrandingValues> {
    const out: Partial<BrandingValues> = {};
    const has = (k: string) => Object.hasOwn(raw, k);
    if (has("productName")) out.productName = cleanText(raw.productName, 80, "productName");
    for (const k of ["logo", "logoDark", "favicon", "loginBackground"] as const) if (has(k)) out[k] = cleanFile(raw[k], k);
    if (has("emailHeader")) out.emailHeader = cleanText(raw.emailHeader, 2000, "emailHeader");
    if (has("emailFooter")) out.emailFooter = cleanText(raw.emailFooter, 2000, "emailFooter");
    if (has("mode")) {
      if (raw.mode !== null && raw.mode !== "light" && raw.mode !== "dark" && raw.mode !== "system") throw new BrandingError("mode: light, dark or system");
      out.mode = raw.mode as Mode | null;
    }
    if (has("light")) out.light = cleanTokens(raw.light, "color", "light");
    if (has("dark")) out.dark = cleanTokens(raw.dark, "color", "dark");
    if (has("shared")) out.shared = cleanTokens(raw.shared, "shared", "shared");
    if ((has("customCss") || has("head")) && !mayEditCode) throw new BrandingError("custom CSS and head tags need the code permission");
    if (has("customCss")) out.customCss = sanitizeCss(raw.customCss);
    if (has("head")) out.head = cleanHead(raw.head);
    const probe = { ...EMPTY, ...out };
    this.#build(probe.light, probe.dark, probe.shared, "system");
    return out;
  }

  async effective(tenant: string): Promise<Effective> {
    const hit = this.#cache.get(tenant);
    if (hit) return hit;
    const chain: BrandingRow[] = [];
    const reader = this.model.as({ kit: "branding" } as never);
    for (let t: string | null = tenant, depth = 0; t !== null && depth < MAX_DEPTH; depth++) {
      const row = await reader.get(t);
      if (row) chain.unshift(row);
      t = this.#o.parentTenant(t);
    }
    const d = this.#o.defaults ?? {};
    const merged: Effective = {
      ...EMPTY,
      head: [],
      ...d,
      productName: d.productName ?? "Loom",
      mode: d.mode ?? "system",
      light: { ...(d.light ?? {}) },
      dark: { ...(d.dark ?? {}) },
      shared: { ...(d.shared ?? {}) },
    };
    const css: string[] = merged.customCss ? [merged.customCss] : [];
    for (const r of chain) {
      for (const k of ["productName", "logo", "logoDark", "favicon", "loginBackground", "emailHeader", "emailFooter"] as const) {
        if (r[k] !== null) (merged as unknown as Record<string, unknown>)[k] = r[k];
      }
      if (r.mode !== null) merged.mode = r.mode;
      Object.assign(merged.light, r.light);
      Object.assign(merged.dark, r.dark);
      Object.assign(merged.shared, r.shared);
      if (r.customCss) css.push(r.customCss);
      if (r.head.length) merged.head = [...merged.head, ...r.head];
    }
    merged.customCss = css.length ? css.join("\n") : null;
    this.#cache.set(tenant, merged);
    return merged;
  }

  async theme(tenant: string): Promise<Theme<"light" | "dark">> {
    const e = await this.effective(tenant);
    return this.#build(e.light, e.dark, e.shared, e.mode);
  }

  async css(tenant: string): Promise<string> {
    const e = await this.effective(tenant);
    const base = this.#build(e.light, e.dark, e.shared, e.mode).css();
    return e.customCss ? `${base}\n@layer kit-custom {\n${e.customCss}\n}\n` : base;
  }

  async head(tenant: string): Promise<string> {
    return renderHead((await this.effective(tenant)).head);
  }

  async preview(viewer: V, tenant: string, draft: Record<string, unknown>): Promise<string> {
    if (!this.#o.canManage(viewer, tenant)) throw new BrandingError("not allowed");
    const clean = this.validate(draft, this.#mayCode(viewer, tenant));
    const e = await this.effective(tenant);
    const light = { ...e.light, ...(clean.light ?? {}) };
    const dark = { ...e.dark, ...(clean.dark ?? {}) };
    const shared = { ...e.shared, ...(clean.shared ?? {}) };
    const base = this.#build(light, dark, shared, clean.mode ?? e.mode).css();
    const custom = clean.customCss ?? null;
    return custom ? `${base}\n@layer kit-custom {\n${custom}\n}\n` : base;
  }

  async save(viewer: V, tenant: string, raw: Record<string, unknown>): Promise<boolean> {
    const me = this.#o.userId(viewer);
    if (me === null || !this.#o.canManage(viewer, tenant)) return false;
    const clean = this.validate(raw, this.#mayCode(viewer, tenant));
    const scoped = this.model.as(viewer as never);
    const updated = (this.#o.now ?? Date.now)();
    const run = async () => {
      const old = await scoped.get(tenant);
      if (old) return (await scoped.update((r) => r.id === tenant, { ...clean, updated, by: me })) === 1;
      return (await scoped.create({ ...EMPTY, ...clean, id: tenant, tenant, updated, by: me })) !== undefined;
    };
    return this.model.isAsync ? asyncTransaction(run) : run();
  }

  async applyPreset(viewer: V, tenant: string, presetId: string): Promise<boolean> {
    const p = this.#presets.get(presetId);
    if (!p) throw new BrandingError(`no preset \`${presetId}\``);
    return this.save(viewer, tenant, { light: p.light ?? {}, dark: p.dark ?? {}, shared: p.shared ?? {} });
  }

  async reset(viewer: V, tenant: string): Promise<boolean> {
    if (!this.#o.canManage(viewer, tenant)) return false;
    return (await this.model.as(viewer as never).delete((r) => r.id === tenant)) === 1;
  }

  async exportTheme(tenant: string): Promise<string> {
    const row = await this.model.as({ kit: "branding" } as never).get(tenant);
    const { id: _i, tenant: _t, updated: _u, by: _b, ...values } = row ?? { ...EMPTY, id: "", tenant: "", updated: 0, by: null };
    return JSON.stringify({ format: "kit-branding", version: 1, values }, null, 2);
  }

  async importTheme(viewer: V, tenant: string, json: string): Promise<boolean> {
    if (typeof json !== "string" || json.length > 200_000) throw new BrandingError("import: a JSON export");
    let doc: { format?: unknown; version?: unknown; values?: unknown };
    try {
      doc = JSON.parse(json);
    } catch {
      throw new BrandingError("import: not JSON");
    }
    if (doc?.format !== "kit-branding" || doc.version !== 1 || !doc.values || typeof doc.values !== "object") throw new BrandingError("import: not a branding export");
    const values = { ...(doc.values as Record<string, unknown>) };
    if (!this.#mayCode(viewer, tenant)) {
      delete values.customCss;
      delete values.head;
    }
    return this.save(viewer, tenant, values);
  }

  #mayCode(viewer: V, tenant: string): boolean {
    try {
      return this.#o.canEditCode ? this.#o.canEditCode(viewer, tenant) === true : false;
    } catch {
      return false;
    }
  }

  #build(light: Record<string, string>, dark: Record<string, string>, shared: Record<string, string>, mode: Mode): Theme<"light" | "dark"> {
    try {
      return defineTheme<"light" | "dark">({
        shared: { ...shadcnTokens.shared, ...shared },
        themes: {
          light: { scheme: "light", tokens: { ...shadcnTokens.light, ...light } },
          dark: { scheme: "dark", tokens: { ...shadcnTokens.dark, ...dark } },
        },
        light: "light",
        dark: "dark",
        default: mode,
      });
    } catch (err) {
      throw err instanceof ThemeError ? new BrandingError(err.message) : err;
    }
  }
}

export function defineBranding<V>(o: BrandingOptions<V>): Branding<V> {
  return new Branding<V>(o);
}
