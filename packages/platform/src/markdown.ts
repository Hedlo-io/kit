import { safeHref } from "./nav.ts";

export class TemplateError extends Error {}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const SLOT = /^\d{1,4}$/;

function inline(src: string): string {
  const parts: string[] = [];
  let rest = src;
  const re = /`([^`]{1,500})`|\*\*([^*]{1,500})\*\*|\*([^*]{1,500})\*|\[([^\]]{1,300})\]\(([^)\s]{1,2000})\)|!\[([^\]]{0,300})\]\((\/(?!\/)[A-Za-z0-9._~\/?=&%-]{1,500})\)/;
  while (rest.length) {
    const m = re.exec(rest);
    if (!m) {
      parts.push(escapeHtml(rest));
      break;
    }
    parts.push(escapeHtml(rest.slice(0, m.index)));
    if (m[1] !== undefined) parts.push(`<code>${escapeHtml(m[1])}</code>`);
    else if (m[2] !== undefined) parts.push(`<strong>${inline(m[2])}</strong>`);
    else if (m[3] !== undefined) parts.push(`<em>${inline(m[3])}</em>`);
    else if (m[7] !== undefined) parts.push(`<img src="${escapeHtml(m[7])}" alt="${escapeHtml(m[6] ?? "")}" loading="lazy" decoding="async">`);
    else {
      const href = SLOT.test(m[5]!) ? m[5]! : safeHref(m[5]);
      const external = href !== null && !href.startsWith("/");
      parts.push(href ? `<a href="${escapeHtml(href)}"${external ? ' rel="noopener noreferrer nofollow" target="_blank"' : ""}>${inline(m[4]!)}</a>` : escapeHtml(m[0]));
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return parts.join("");
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    const ul = /^\s*[-*]\s+(.+)$/.exec(line);
    const ol = /^\s*\d{1,3}[.)]\s+(.+)$/.exec(line);
    if (line.trim() === "") {
      flushPara();
      flushList();
    } else if (h) {
      flushPara();
      flushList();
      const level = h[1]!.length + 1;
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
    } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push("<hr>");
    } else if (ul || ol) {
      flushPara();
      const tag = ul ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((ul ?? ol)![1]!);
    } else if (/^>\s?/.test(line)) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out.join("\n");
}

export function markdownToText(src: string): string {
  return src
    .replace(/\r\n?/g, "\n")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type VarKind = "string" | "number" | "url" | "boolean" | "date";

export interface VarSpec {
  kind: VarKind;
  description?: string;
  example?: string | number | boolean;
}

type Tok = { t: "text"; v: string } | { t: "var"; v: string } | { t: "if"; v: string; neg: boolean } | { t: "else" } | { t: "end" };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\{\{\s*(#if|#unless|else|\/if|\/unless)?\s*([a-zA-Z][a-zA-Z0-9_.]{0,60})?\s*\}\}/g;
  let at = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > at) out.push({ t: "text", v: src.slice(at, m.index) });
    at = m.index + m[0].length;
    const kw = m[1];
    const name = m[2];
    if (kw === "#if" || kw === "#unless") {
      if (!name) throw new TemplateError(`${kw} needs a variable`);
      out.push({ t: "if", v: name, neg: kw === "#unless" });
    } else if (kw === "else") out.push({ t: "else" });
    else if (kw === "/if" || kw === "/unless") out.push({ t: "end" });
    else if (name) out.push({ t: "var", v: name });
    else throw new TemplateError(`bad tag ${m[0]}`);
  }
  if (at < src.length) out.push({ t: "text", v: src.slice(at) });
  for (const tok of out) if (tok.t === "text" && /\{\{|\}\}/.test(tok.v)) throw new TemplateError(`unclosed or bad tag near ${JSON.stringify(tok.v.slice(0, 40))}`);
  return out;
}

export function templateVariables(src: string): Set<string> {
  const names = new Set<string>();
  let depth = 0;
  for (const tok of lex(src)) {
    if (tok.t === "var" || tok.t === "if") names.add(tok.v);
    if (tok.t === "if") depth++;
    if (tok.t === "end" && --depth < 0) throw new TemplateError("{{/if}} without {{#if}}");
  }
  if (depth !== 0) throw new TemplateError("{{#if}} is not closed");
  return names;
}

export function checkTemplate(src: string, vars: Readonly<Record<string, VarSpec>>): string | null {
  try {
    for (const n of templateVariables(src)) if (!Object.hasOwn(vars, n)) return `unknown variable \`${n}\``;
    return null;
  } catch (err) {
    return err instanceof TemplateError ? err.message : String(err);
  }
}

function show(v: unknown, kind: VarKind | undefined, locale: string): string {
  if (v === null || v === undefined) return "";
  if (kind === "url") return safeHref(String(v)) ?? "";
  if (kind === "date" && (typeof v === "number" || v instanceof Date || typeof v === "string")) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
  }
  if (kind === "number" && typeof v === "number") return new Intl.NumberFormat(locale).format(v);
  return String(v);
}

export function fillTemplate(src: string, values: Readonly<Record<string, unknown>>, vars: Readonly<Record<string, VarSpec>>, locale = "en", escape: (s: string) => string = (s) => s): string {
  const toks = lex(src);
  const out: string[] = [];
  const stack: boolean[] = [];
  const on = () => stack.every(Boolean);
  for (const tok of toks) {
    if (tok.t === "if") stack.push(Boolean(values[tok.v]) !== tok.neg);
    else if (tok.t === "else") {
      if (!stack.length) throw new TemplateError("{{else}} outside {{#if}}");
      stack.push(!stack.pop());
    } else if (tok.t === "end") stack.pop();
    else if (!on()) continue;
    else if (tok.t === "text") out.push(tok.v);
    else out.push(escape(show(values[tok.v], vars[tok.v]?.kind, locale)));
  }
  return out.join("");
}

export function renderTemplate(src: string, values: Readonly<Record<string, unknown>>, vars: Readonly<Record<string, VarSpec>>, locale = "en"): { html: string; text: string } {
  const clean = src.replace(/[]/g, "");
  const shown: string[] = [];
  const marked = fillTemplate(clean, values, vars, locale, (s) => {
    shown.push(s);
    return `${shown.length - 1}`;
  });
  const html = renderMarkdown(marked).replace(/(\d{1,4})/g, (_m, i: string) => escapeHtml(shown[Number(i)] ?? ""));
  const text = markdownToText(fillTemplate(clean, values, vars, locale));
  return { html, text };
}

export function inlineTemplate(src: string, values: Readonly<Record<string, unknown>>, vars: Readonly<Record<string, VarSpec>>, locale = "en"): string {
  return fillTemplate(src, values, vars, locale).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export function sampleValues(vars: Readonly<Record<string, VarSpec>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(vars)) {
    out[k] = s.example ?? (s.kind === "number" ? 42 : s.kind === "boolean" ? true : s.kind === "url" ? "https://example.com/" : s.kind === "date" ? Date.UTC(2026, 0, 1, 12) : k);
  }
  return out;
}
