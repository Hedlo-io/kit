import { asyncTransaction, defineModel, type Model } from "@weft-framework/data";
import type { Branding } from "./branding.ts";
import { checkTemplate, escapeHtml, inlineTemplate, renderMarkdown, renderTemplate, sampleValues, type VarSpec } from "./markdown.ts";

export interface EmailDef {
  key: string;
  title: string;
  description?: string;
  variables: Readonly<Record<string, VarSpec>>;
  subject: string;
  body: string;
  locales?: Readonly<Record<string, { subject: string; body: string }>>;
  plugin?: string;
}

export interface EmailRow {
  id: string;
  tenant: string;
  key: string;
  locale: string;
  subject: string;
  body: string;
  updated: number;
  by: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  source: "tenant" | "built-in";
}

export interface EmailOptions<V> {
  defaultLocale: string;
  locales: readonly string[];
  branding?: Branding<V>;
  fileUrl?(fileId: string): string;
  userId(viewer: V): string | null;
  parentTenant(tenant: string): string | null;
  canManage(viewer: V, tenant: string): boolean;
  name?: string;
  now?(): number;
}

export class EmailError extends Error {}

const KEY = /^[a-z][a-z0-9_-]{0,40}(\.[a-z0-9_-]{1,40}){1,4}$/;
const VAR = /^[a-zA-Z][a-zA-Z0-9_]{0,60}$/;
const KINDS = new Set(["string", "number", "url", "boolean", "date"]);
const MAX_DEPTH = 8;
const COLOR = /^#[0-9a-fA-F]{3,8}$/;

export class Emails<V> {
  readonly model: Model<EmailRow>;
  readonly #o: EmailOptions<V>;
  readonly #defs = new Map<string, EmailDef>();

  constructor(o: EmailOptions<V>) {
    if (!o.locales.includes(o.defaultLocale)) throw new EmailError("defaultLocale must be one of locales");
    this.#o = o;
    const manages = (a: unknown, t: string) => {
      try {
        return o.userId(a as V) !== null && o.canManage(a as V, t) === true;
      } catch {
        return false;
      }
    };
    this.model = defineModel<EmailRow>(o.name ?? "KitEmailTemplate", {
      fields: { id: "string", tenant: "string", key: "string", locale: "string", subject: "string", body: "string", updated: "number", by: "string | null" },
      attrs: { tenant: { index: true } },
      read: (a, r) => manages(a, r.tenant) || (a as { kit?: string })?.kit === "emails",
      write: (a, r) => manages(a, r.tenant),
    });
  }

  register(def: EmailDef): () => void {
    if (!KEY.test(def.key)) throw new EmailError(`email key \`${def.key}\``);
    if (this.#defs.has(def.key)) throw new EmailError(`email \`${def.key}\` exists`);
    for (const [k, s] of Object.entries(def.variables)) if (!VAR.test(k) || !KINDS.has(s?.kind)) throw new EmailError(`${def.key}: variable \`${k}\``);
    for (const [loc, t] of [[this.#o.defaultLocale, { subject: def.subject, body: def.body }] as const, ...Object.entries(def.locales ?? {})]) {
      const p = this.#problem(def, t.subject, t.body);
      if (p) throw new EmailError(`${def.key} (${loc}): ${p}`);
    }
    const frozen = Object.freeze({ ...def });
    this.#defs.set(def.key, frozen);
    return () => {
      if (this.#defs.get(def.key) === frozen) this.#defs.delete(def.key);
    };
  }

  removePlugin(plugin: string): number {
    let n = 0;
    for (const [k, d] of this.#defs) if (d.plugin === plugin && this.#defs.delete(k)) n++;
    return n;
  }

  definitions(): EmailDef[] {
    return [...this.#defs.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  async render(tenant: string, key: string, locale: string, values: Readonly<Record<string, unknown>>): Promise<RenderedEmail> {
    const def = this.#def(key);
    const t = await this.#template(def, tenant, locale);
    return this.#compose(tenant, def, t.subject, t.body, this.#locale(locale), values, t.source);
  }

  async preview(viewer: V, tenant: string, key: string, locale: string, draft?: { subject: string; body: string }): Promise<RenderedEmail> {
    if (!this.#o.canManage(viewer, tenant)) throw new EmailError("not allowed");
    const def = this.#def(key);
    if (draft) {
      const p = this.#problem(def, draft.subject, draft.body);
      if (p) throw new EmailError(p);
    }
    const t = draft ? { ...draft, source: "tenant" as const } : await this.#template(def, tenant, locale);
    return this.#compose(tenant, def, t.subject, t.body, this.#locale(locale), sampleValues(def.variables), t.source);
  }

  async editable(viewer: V, tenant: string, key: string, locale: string): Promise<{ subject: string; body: string; overridden: boolean; variables: Readonly<Record<string, VarSpec>> }> {
    if (!this.#o.canManage(viewer, tenant)) throw new EmailError("not allowed");
    const def = this.#def(key);
    const own = await this.model.as(viewer as never).get(Emails.id(tenant, key, locale));
    const t = own ?? (await this.#template(def, tenant, locale));
    return { subject: t.subject, body: t.body, overridden: own !== undefined, variables: def.variables };
  }

  async save(viewer: V, tenant: string, key: string, locale: string, t: { subject: string; body: string }): Promise<boolean> {
    const me = this.#o.userId(viewer);
    if (me === null || !this.#o.canManage(viewer, tenant)) return false;
    if (!this.#o.locales.includes(locale)) throw new EmailError(`locale \`${locale}\` is not enabled`);
    const def = this.#def(key);
    const p = this.#problem(def, t?.subject, t?.body);
    if (p) throw new EmailError(p);
    const scoped = this.model.as(viewer as never);
    const id = Emails.id(tenant, key, locale);
    const updated = (this.#o.now ?? Date.now)();
    const run = async () => {
      if (await scoped.get(id)) return (await scoped.update((r) => r.id === id, { subject: t.subject, body: t.body, updated, by: me })) === 1;
      return (await scoped.create({ id, tenant, key, locale, subject: t.subject, body: t.body, updated, by: me })) !== undefined;
    };
    return this.model.isAsync ? asyncTransaction(run) : run();
  }

  async reset(viewer: V, tenant: string, key: string, locale: string): Promise<boolean> {
    if (!this.#o.canManage(viewer, tenant)) return false;
    const id = Emails.id(tenant, key, locale);
    return (await this.model.as(viewer as never).delete((r) => r.id === id)) === 1;
  }

  static id(tenant: string, key: string, locale: string): string {
    return JSON.stringify([tenant, key, locale]);
  }

  #def(key: string): EmailDef {
    const d = this.#defs.get(key);
    if (!d) throw new EmailError(`no email \`${key}\``);
    return d;
  }

  #locale(locale: string): string {
    return this.#o.locales.includes(locale) ? locale : this.#o.defaultLocale;
  }

  #problem(def: EmailDef, subject: unknown, body: unknown): string | null {
    if (typeof subject !== "string" || subject.trim() === "" || subject.length > 300) return "subject: 1–300 characters";
    if (typeof body !== "string" || body.trim() === "" || body.length > 50_000) return "body: 1–50000 characters";
    const vars = { productName: { kind: "string" as const }, ...def.variables };
    return checkTemplate(subject, vars) ?? checkTemplate(body, vars);
  }

  async #template(def: EmailDef, tenant: string, locale: string): Promise<{ subject: string; body: string; source: "tenant" | "built-in" }> {
    const loc = this.#locale(locale);
    const chain: string[] = [];
    for (let t: string | null = tenant, d = 0; t !== null && d < MAX_DEPTH; d++, t = this.#o.parentTenant(t)) chain.push(t);
    const locales = loc === this.#o.defaultLocale ? [loc] : [loc, this.#o.defaultLocale];
    const rows = await this.model
      .as({ kit: "emails" } as never)
      .query()
      .where({ key: def.key, tenant: { in: chain }, locale: { in: locales } })
      .all();
    for (const l of locales) {
      for (const t of chain) {
        const r = rows.find((x) => x.tenant === t && x.locale === l);
        if (r) return { subject: r.subject, body: r.body, source: "tenant" };
      }
      const builtIn = l === this.#o.defaultLocale ? { subject: def.subject, body: def.body } : def.locales?.[l];
      if (builtIn) return { ...builtIn, source: "built-in" };
    }
    return { subject: def.subject, body: def.body, source: "built-in" };
  }

  async #compose(tenant: string, def: EmailDef, subject: string, body: string, locale: string, values: Readonly<Record<string, unknown>>, source: "tenant" | "built-in"): Promise<RenderedEmail> {
    const brand = this.#o.branding ? await this.#o.branding.effective(tenant) : null;
    const product = brand?.productName ?? "Loom";
    const vals = { productName: product, ...values };
    const vars = { productName: { kind: "string" as const }, ...def.variables };
    const main = renderTemplate(body, vals, vars, locale);
    const accent = brand && COLOR.test(brand.light.primary ?? "") ? brand.light.primary! : "#18181b";
    const logo = brand?.logo && this.#o.fileUrl ? this.#o.fileUrl(brand.logo) : null;
    const header = brand?.emailHeader ? renderMarkdown(brand.emailHeader) : "";
    const footer = brand?.emailFooter ? renderMarkdown(brand.emailFooter) : "";
    const top = logo ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(product)}" height="32" style="height:32px;border:0">` : `<strong style="font-size:18px">${escapeHtml(product)}</strong>`;
    const html = [
      `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(inlineTemplate(subject, vals, vars, locale))}</title></head>`,
      `<body style="margin:0;padding:24px;background:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#18181b">`,
      `<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border-top:4px solid ${accent}">`,
      `<div style="padding:24px 24px 0">${top}${header ? `<div style="margin-top:12px;color:#52525b">${header}</div>` : ""}</div>`,
      `<div style="padding:16px 24px 24px;line-height:1.6">${main.html}</div>`,
      footer ? `<div style="padding:16px 24px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px">${footer}</div>` : "",
      `</div></body></html>`,
    ].join("");
    const text = [main.text, brand?.emailFooter ? `--\n${brand.emailFooter}` : ""].filter(Boolean).join("\n\n");
    return { subject: inlineTemplate(subject, vals, vars, locale), html, text, source };
  }
}

export function defineEmails<V>(o: EmailOptions<V>): Emails<V> {
  return new Emails<V>(o);
}
