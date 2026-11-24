import { defineJob, parseCron, type Cron, type Job } from "@weft-framework/server";
import type { PluginEvent, PluginJob, PluginPage, PluginRegistrars, PluginRoute } from "./plugins.ts";

export class PluginMarkup {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function part(value: unknown): string {
  if (value instanceof PluginMarkup) return value.value;
  if (Array.isArray(value)) return value.map(part).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(value);
}

export function pluginHtml(strings: TemplateStringsArray, ...values: unknown[]): PluginMarkup {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += part(v) + (strings[i + 1] ?? "");
  });
  return new PluginMarkup(out);
}

export const PLUGIN_FORM_ACTION = "pluginSubmit";
export const PLUGIN_FORM_MAX_FIELDS = 100;

const ROUTE = /^\/api\/plugins\/[a-z0-9][a-z0-9.-]{0,100}(\/[A-Za-z0-9._~%:@!$&'()*+,;=-]*)*$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const ATTR = /^[a-z][a-z0-9-]{0,40}$/;
const RESERVED_ATTRS = new Set(["name", "form", "formaction", "formmethod", "disabled", "type"]);
const INPUT_TYPES = new Set(["text", "number", "email", "url", "password", "search", "tel", "date", "time", "datetime-local", "color", "range"]);

export type PluginAttrs = Record<string, string | number | boolean | null | undefined>;

export class PluginFormError extends Error {}

function attrs(a: PluginAttrs = {}, extra: string[] = []): string {
  const out: string[] = [...extra];
  for (const [k, v] of Object.entries(a)) {
    if (!ATTR.test(k) || k.startsWith("on") || RESERVED_ATTRS.has(k)) throw new PluginFormError(`attribute ${k} is not allowed here`);
    if (v === false || v === null || v === undefined) continue;
    out.push(v === true ? k : `${k}="${escapeHtml(v)}"`);
  }
  return out.length ? ` ${out.join(" ")}` : "";
}

function fieldName(name: string): string {
  if (!FIELD.test(name)) throw new PluginFormError(`field name ${name} is not allowed`);
  return `<input type="hidden" name="n" value="${escapeHtml(name)}">`;
}

export const pluginForms = {
  form(route: string, body: unknown, a: PluginAttrs = {}): PluginMarkup {
    if (!ROUTE.test(route)) throw new PluginFormError(`form route must be one of your /api/plugins/… routes, got ${route}`);
    return new PluginMarkup(`<form method="post" action="?/${PLUGIN_FORM_ACTION}"${attrs(a)}><input type="hidden" name="route" value="${escapeHtml(route)}">${part(body)}</form>`);
  },
  input(name: string, a: PluginAttrs & { kind?: string } = {}): PluginMarkup {
    const { kind = "text", ...rest } = a;
    if (!INPUT_TYPES.has(String(kind))) throw new PluginFormError(`input kind ${kind} is not supported; use select for yes/no`);
    return new PluginMarkup(`${fieldName(name)}<input${attrs(rest, [`type="${escapeHtml(kind)}"`, `name="v"`])}>`);
  },
  textarea(name: string, value = "", a: PluginAttrs = {}): PluginMarkup {
    return new PluginMarkup(`${fieldName(name)}<textarea${attrs(a, [`name="v"`])}>${escapeHtml(value)}</textarea>`);
  },
  select(name: string, options: { value: string; label: string; selected?: boolean }[], a: PluginAttrs = {}): PluginMarkup {
    const opts = options.map((o) => `<option value="${escapeHtml(o.value)}"${o.selected ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
    return new PluginMarkup(`${fieldName(name)}<select${attrs(a, [`name="v"`])}>${opts}</select>`);
  },
  hidden(name: string, value: unknown): PluginMarkup {
    return new PluginMarkup(`${fieldName(name)}<input type="hidden" name="v" value="${escapeHtml(value)}">`);
  },
};

export type PluginForms = typeof pluginForms;

export interface MatchedPluginPage<V> {
  plugin: string;
  page: PluginPage<V>;
  params: Record<string, string>;
}

function split(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function match(pattern: string[], path: string[]): Record<string, string> | null {
  if (pattern.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const s = path[i]!;
    if (p.startsWith(":")) {
      try {
        params[p.slice(1)] = decodeURIComponent(s);
      } catch {
        return null;
      }
    } else if (p !== s) return null;
  }
  return params;
}

export interface PluginRuntimeOptions<V> {
  name: string;
  can(viewer: V, permission: string): boolean;
  extension?(plugin: string, kind: string, value: unknown): () => void;
  onError(err: unknown, plugin: string): void;
  now?(): number;
}

export function definePluginRuntime<V>(o: PluginRuntimeOptions<V>) {
  const now = o.now ?? Date.now;
  const routes: { plugin: string; route: PluginRoute<V>; parts: string[] }[] = [];
  const pages: { plugin: string; page: PluginPage<V>; parts: string[] }[] = [];
  const jobs: { plugin: string; job: PluginJob; cron: Cron | null; next: number }[] = [];
  const events: { plugin: string; sub: PluginEvent }[] = [];

  function remover<T>(list: T[], item: T): () => void {
    list.push(item);
    return () => {
      const i = list.indexOf(item);
      if (i >= 0) list.splice(i, 1);
    };
  }

  const registrars: Omit<PluginRegistrars<V>, "translations"> = {
    route: (plugin, route) => remover(routes, { plugin, route, parts: split(route.path) }),
    page: (plugin, page) => remover(pages, { plugin, page, parts: split(page.path) }),
    job: (plugin, job) => {
      const cron = job.cron ? parseCron(job.cron) : null;
      return remover(jobs, { plugin, job, cron, next: cron ? cron.next(now()) : Infinity });
    },
    on: (plugin, sub) => remover(events, { plugin, sub }),
    ...(o.extension ? { extension: o.extension } : {}),
  };

  function problem(status: number, title: string): Response {
    return Response.json({ type: "about:blank", title, status }, { status, headers: { "content-type": "application/problem+json", "cache-control": "no-store" } });
  }

  async function runDue(): Promise<number> {
    const at = now();
    let ran = 0;
    for (const e of [...jobs]) {
      if (!e.cron || e.next > at) continue;
      e.next = e.cron.next(at);
      try {
        await e.job.run({ at });
        ran++;
      } catch (err) {
        o.onError(err, e.plugin);
      }
    }
    return ran;
  }

  const cron: Job<never[]> = defineJob<never[]>(`${o.name}PluginCron`, [], () => runDue(), { attempts: 1, timeoutMs: 10 * 60_000 });

  const runtime = {
    registrars,
    cron,
    runDue,

    async dispatch(request: Request, viewer: V | null): Promise<Response> {
      const path = split(new URL(request.url).pathname);
      let allowed = false;
      for (const e of routes) {
        const params = match(e.parts, path);
        if (!params) continue;
        allowed = true;
        if (e.route.method !== request.method) continue;
        if (e.route.permission && (!viewer || !o.can(viewer, e.route.permission))) return problem(viewer ? 403 : 401, viewer ? "Forbidden" : "Sign in first");
        try {
          return await e.route.handler(request, { viewer, params, plugin: e.plugin });
        } catch (err) {
          o.onError(err, e.plugin);
          return problem(500, "The plugin failed to answer");
        }
      }
      return allowed ? problem(405, "Method not allowed") : problem(404, "Unknown plugin route");
    },

    async submit(viewer: V | null, origin: string, route: string, names: readonly string[], values: readonly string[]): Promise<Response> {
      if (!ROUTE.test(route)) return problem(400, "Unknown plugin route");
      if (names.length !== values.length || names.length > PLUGIN_FORM_MAX_FIELDS || names.some((n) => !FIELD.test(n))) return problem(400, "The form is malformed");
      const body = new URLSearchParams(names.map((n, i) => [n, values[i]!]));
      return runtime.dispatch(new Request(new URL(route, origin), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }), viewer);
    },

    page(app: "admin" | "client", path: string): MatchedPluginPage<V> | null {
      const parts = split(path);
      for (const e of pages) {
        if (e.page.app !== app) continue;
        const params = match(e.parts, parts);
        if (params) return { plugin: e.plugin, page: e.page, params };
      }
      return null;
    },

    pages(app: "admin" | "client"): { plugin: string; path: string; title: string; permission?: string }[] {
      return pages.filter((e) => e.page.app === app && !e.parts.some((p) => p.startsWith(":"))).map((e) => ({ plugin: e.plugin, path: e.page.path, title: e.page.title, permission: e.page.permission }));
    },

    jobs(): { plugin: string; name: string; cron: string | null; next: number | null }[] {
      return jobs.map((e) => ({ plugin: e.plugin, name: e.job.name, cron: e.job.cron ?? null, next: Number.isFinite(e.next) ? e.next : null }));
    },

    publish(event: string, payload: unknown): void {
      for (const e of [...events]) {
        if (e.sub.event !== event) continue;
        Promise.resolve()
          .then(() => e.sub.handle(payload))
          .catch((err) => o.onError(err, e.plugin));
      }
    },
  };
  return runtime;
}

export type PluginRuntime<V> = ReturnType<typeof definePluginRuntime<V>>;
