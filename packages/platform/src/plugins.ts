import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { asyncTransaction, defineModel, type Model } from "@weft-framework/data";
import { settingProblem, type SettingsSchema } from "@weft-framework/server/settings";
import type { Branding, ThemePreset } from "./branding.ts";
import { compareVersions, parseVersion, satisfies, validRange } from "./semver.ts";
import type { Contribution, SlotRegistry } from "./slots.ts";
import type { WidgetDef, WidgetRegistry } from "./widgets.ts";

export const CAPABILITIES = ["db", "net", "fs", "auth", "slots", "widgets", "themes", "pages", "jobs", "webhooks", "mail", "i18n", "extensions"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface PluginRoute<V> {
  method: RouteMethod;
  path: string;
  permission?: string;
  handler(req: Request, ctx: { viewer: V | null; params: Record<string, string>; plugin: string }): Response | Promise<Response>;
}

export interface PluginPage<V> {
  path: string;
  title: string;
  app: "admin" | "client";
  permission?: string;
  component: Contribution<V, any>["component"] & {};
}

export interface PluginJob {
  name: string;
  cron?: string;
  run(payload: unknown): void | Promise<void>;
}

export interface PluginEvent {
  event: string;
  handle(payload: unknown): void | Promise<void>;
}

export interface PluginRegistrars<V> {
  route?(plugin: string, route: PluginRoute<V>): () => void;
  page?(plugin: string, page: PluginPage<V>): () => void;
  job?(plugin: string, job: PluginJob): () => void;
  on?(plugin: string, sub: PluginEvent): () => void;
  translations?(plugin: string, locale: string, catalog: Record<string, string>): () => void;
  extension?(plugin: string, kind: string, value: unknown): () => void;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  engines: Record<string, string>;
  requires?: Record<string, string>;
  capabilities: Capability[];
  permissions?: { id: string; description?: string }[];
  settings?: SettingsSchema;
  models?: string[];
  translations?: Record<string, string>;
  entry: string;
}

export interface PluginRow {
  id: string;
  version: string;
  enabled: boolean;
  manifest: PluginManifest;
  signer: string | null;
  settings: Record<string, boolean | number | string>;
  error: string | null;
  installed: number;
  updated: number;
}

export interface PluginModule<V> {
  activate(api: PluginApi<V>): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface PluginApi<V> {
  readonly id: string;
  readonly manifest: PluginManifest;
  settings(): Promise<Record<string, boolean | number | string>>;
  contribute<P extends object>(c: Omit<Contribution<V, P>, "plugin">): void;
  registerWidget(def: Omit<WidgetDef<V>, "plugin">): void;
  registerPreset(p: Omit<ThemePreset, "plugin">): void;
  defineModel<T>(name: string, config: Parameters<typeof defineModel<T>>[1]): Model<T>;
  route(route: PluginRoute<V>): void;
  page(page: PluginPage<V>): void;
  job(job: PluginJob): void;
  on(event: string, handle: PluginEvent["handle"]): void;
  extend(kind: string, value: unknown): void;
  onDisable(fn: () => void | Promise<void>): void;
}

export interface PluginHostOptions<V> {
  host: { name: string; version: string; kit?: string };
  slots: SlotRegistry<V>;
  widgets: WidgetRegistry<V>;
  branding?: Branding<V>;
  load(manifest: PluginManifest): Promise<PluginModule<V>>;
  attachModels?(models: Model<any, any>[]): Promise<void>;
  registrars?: PluginRegistrars<V>;
  readFile?(manifest: PluginManifest, path: string): Promise<string>;
  canManage(viewer: V): boolean;
  userId(viewer: V): string | null;
  trustedKeys?: readonly (string | KeyObject)[] | (() => readonly (string | KeyObject)[]);
  requireSignature?: boolean;
  onError?(err: unknown, plugin: string): void;
  name?: string;
  now?(): number;
}

export class PluginError extends Error {}

const PLUGIN_ID = /^[a-z][a-z0-9]{1,30}(?:[.-][a-z0-9]{1,30}){1,3}$/;
const KIT_VERSION = "0.1.0";
const SYSTEM = Object.freeze({ kit: "plugins" });

function underPath(path: unknown, base: string): boolean {
  if (typeof path !== "string" || path.length > 300) return false;
  if (path !== base && !path.startsWith(`${base}/`)) return false;
  return !/(^|\/)\.\.?(\/|$)|\/\/|[\\\s?#%]/.test(path) && /^[A-Za-z0-9/._:\-[\]]+$/.test(path);
}

export function parseCatalog(id: string, locale: string, text: string): Record<string, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PluginError(`${id}: translations ${locale} is not JSON`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PluginError(`${id}: translations ${locale} is a flat object`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith(`${id}.`) || k.length > 200) throw new PluginError(`${id}: translation keys start with \`${id}.\` (${k})`);
    if (typeof v !== "string" || v.length > 10_000) throw new PluginError(`${id}: translation ${k} is text`);
    out[k] = v;
  }
  return out;
}

export function modelPrefix(id: string): string {
  return id
    .split(/[.-]/)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join("");
}

export function validateManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PluginError("manifest: an object");
  const m = raw as Record<string, unknown>;
  const fail = (msg: string): never => {
    throw new PluginError(`manifest${typeof m.id === "string" ? ` of ${m.id}` : ""}: ${msg}`);
  };
  if (typeof m.id !== "string" || !PLUGIN_ID.test(m.id)) fail("id is like `vendor.name` (lower-case, dotted)");
  const id = m.id as string;
  if (typeof m.name !== "string" || m.name.trim() === "" || m.name.length > 80) fail("name is 1–80 characters");
  if (!parseVersion(m.version)) fail("version is semver (1.2.3)");
  for (const k of ["description", "author", "homepage"] as const) {
    if (m[k] !== undefined && (typeof m[k] !== "string" || (m[k] as string).length > 500)) fail(`${k} is text`);
  }
  if (m.homepage !== undefined && !/^https:\/\//.test(m.homepage as string)) fail("homepage is an https URL");
  if (!m.engines || typeof m.engines !== "object") fail("engines names the products it runs on, e.g. { loom: \"^1.0.0\" }");
  for (const [k, r] of Object.entries(m.engines as object)) if (!/^[a-z]{2,20}$/.test(k) || !validRange(r)) fail(`engines.${k} is a semver range`);
  if (m.requires !== undefined) {
    if (typeof m.requires !== "object" || m.requires === null) fail("requires is { pluginId: range }");
    for (const [k, r] of Object.entries(m.requires as object)) {
      if (!PLUGIN_ID.test(k) || k === id) fail(`requires.${k}: another plugin id`);
      if (!validRange(r)) fail(`requires.${k} is a semver range`);
    }
  }
  if (!Array.isArray(m.capabilities) || !m.capabilities.every((c) => (CAPABILITIES as readonly string[]).includes(c))) fail(`capabilities are some of ${CAPABILITIES.join(", ")}`);
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) fail("permissions is a list");
    for (const p of m.permissions as { id?: unknown; description?: unknown }[]) {
      if (typeof p?.id !== "string" || !p.id.startsWith(`${id}.`) || !/^[a-z0-9._-]{3,120}$/.test(p.id)) fail(`permission ids start with \`${id}.\``);
    }
  }
  if (m.settings !== undefined) {
    if (typeof m.settings !== "object" || m.settings === null) fail("settings is a settings schema");
    for (const [k, spec] of Object.entries(m.settings as SettingsSchema)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k)) fail(`setting key \`${k}\``);
      const p = spec && typeof spec === "object" && "default" in spec ? settingProblem(spec, spec.default) : "no default";
      if (p) fail(`setting \`${k}\`: ${p}`);
    }
  }
  if (m.models !== undefined) {
    const prefix = modelPrefix(id);
    if (!Array.isArray(m.models)) fail("models is a list of model names");
    if ((m.models as unknown[]).length && !(m.capabilities as string[]).includes("db")) fail("models need the `db` capability");
    for (const n of m.models as unknown[]) if (typeof n !== "string" || !new RegExp(`^${prefix}[A-Z][A-Za-z0-9]{0,40}$`).test(n)) fail(`model names start with \`${prefix}\``);
  }
  if (m.translations !== undefined) {
    if (typeof m.translations !== "object" || m.translations === null) fail("translations is { locale: path }");
    for (const [loc, path] of Object.entries(m.translations as object)) {
      if (!/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/.test(loc) || typeof path !== "string" || !/^\.\/[A-Za-z0-9._/-]+\.json$/.test(path) || path.includes("..")) fail(`translations.${loc}`);
    }
  }
  if (typeof m.entry !== "string" || !/^\.\/[A-Za-z0-9._/-]+\.(m?js|ts)$/.test(m.entry) || m.entry.includes("..")) fail("entry is a relative module path inside the package");
  return Object.freeze(structuredClone(m)) as unknown as PluginManifest;
}

function toKey(k: string | KeyObject): KeyObject {
  if (typeof k !== "string") return k;
  if (k.includes("BEGIN")) return createPublicKey(k);
  const raw = Buffer.from(k, "base64");
  if (raw.length !== 32) throw new PluginError("trusted key: an Ed25519 public key (PEM or 32-byte base64)");
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

export function keyFingerprint(k: string | KeyObject): string {
  const der = toKey(k).export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex").slice(0, 32);
}

export function verifyPackage(bytes: Uint8Array, signature: string, keys: readonly (string | KeyObject)[]): string | null {
  if (typeof signature !== "string" || signature.length > 200) return null;
  let sig: Buffer;
  try {
    sig = Buffer.from(signature, "base64");
  } catch {
    return null;
  }
  if (sig.length !== 64) return null;
  const digest = createHash("sha256").update(bytes).digest();
  for (const k of keys) {
    try {
      const key = toKey(k);
      if (key.asymmetricKeyType === "ed25519" && verify(null, digest, key, sig)) return keyFingerprint(key);
    } catch {
      continue;
    }
  }
  return null;
}

export class PluginHost<V> {
  readonly model: Model<PluginRow>;
  readonly #o: PluginHostOptions<V>;
  readonly #rows = new Map<string, PluginRow>();
  readonly #active = new Map<string, { module: PluginModule<V>; undo: (() => unknown)[]; disable: (() => unknown)[] }>();

  constructor(o: PluginHostOptions<V>) {
    this.#o = o;
    const manages = (a: unknown) => {
      if (a === SYSTEM) return true;
      try {
        return o.userId(a as V) !== null && o.canManage(a as V) === true;
      } catch {
        return false;
      }
    };
    this.model = defineModel<PluginRow>(o.name ?? "KitPlugin", {
      fields: {
        id: "string",
        version: "string",
        enabled: "boolean",
        manifest: "PluginManifest",
        signer: "string | null",
        settings: "Record<string, boolean | number | string>",
        error: "string | null",
        installed: "number",
        updated: "number",
      },
      read: (a) => manages(a),
      write: (a) => manages(a),
    });
  }

  enabled = (id: string): boolean => this.#rows.get(id)?.enabled === true && this.#active.has(id);

  list(): PluginRow[] {
    return [...this.#rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async boot(): Promise<void> {
    this.#rows.clear();
    for (const r of await this.model.as(SYSTEM as never).all()) this.#rows.set(r.id, r);
    const order = this.#order([...this.#rows.values()].filter((r) => r.enabled).map((r) => r.id));
    for (const id of order) {
      const problem = this.#unmet(this.#rows.get(id)!.manifest, true);
      if (problem) {
        await this.#store(SYSTEM, id, { error: problem });
        continue;
      }
      await this.#activate(id).catch(() => {});
    }
  }

  async install(viewer: V, raw: unknown, pkg: { bytes?: Uint8Array; signature?: string } = {}): Promise<PluginRow> {
    this.#gate(viewer);
    const manifest = validateManifest(raw);
    if (this.#rows.has(manifest.id)) throw new PluginError(`${manifest.id} is installed; update it instead`);
    const signer = this.#signer(manifest, pkg);
    const problem = this.#engines(manifest) ?? this.#unmet(manifest, false);
    if (problem) throw new PluginError(problem);
    const now = (this.#o.now ?? Date.now)();
    const row: PluginRow = { id: manifest.id, version: manifest.version, enabled: false, manifest, signer, settings: this.#defaults(manifest), error: null, installed: now, updated: now };
    const made = await this.model.as(viewer as never).create(row);
    if (!made) throw new PluginError("not allowed");
    this.#rows.set(row.id, made);
    return made;
  }

  async update(viewer: V, raw: unknown, pkg: { bytes?: Uint8Array; signature?: string } = {}): Promise<PluginRow> {
    this.#gate(viewer);
    const manifest = validateManifest(raw);
    const old = this.#rows.get(manifest.id);
    if (!old) throw new PluginError(`${manifest.id} is not installed`);
    if (compareVersions(parseVersion(manifest.version)!, parseVersion(old.version)!) <= 0) throw new PluginError(`${manifest.id}: ${manifest.version} is not newer than ${old.version}`);
    const signer = this.#signer(manifest, pkg);
    const problem = this.#engines(manifest) ?? this.#unmet(manifest, false);
    if (problem) throw new PluginError(problem);
    for (const dep of this.#dependents(manifest.id, false)) {
      const range = dep.manifest.requires![manifest.id]!;
      if (!satisfies(manifest.version, range)) throw new PluginError(`${dep.id} needs ${manifest.id} ${range}`);
    }
    const wasOn = old.enabled;
    if (this.#active.has(manifest.id)) await this.#deactivate(manifest.id);
    const settings = { ...this.#defaults(manifest), ...Object.fromEntries(Object.entries(old.settings).filter(([k]) => manifest.settings && k in manifest.settings)) };
    await this.#store(viewer, manifest.id, { version: manifest.version, manifest, signer, settings, error: null });
    if (wasOn) await this.#activate(manifest.id).catch(() => {});
    return this.#rows.get(manifest.id)!;
  }

  async enable(viewer: V, id: string): Promise<boolean> {
    this.#gate(viewer);
    const row = this.#row(id);
    const problem = this.#engines(row.manifest) ?? this.#unmet(row.manifest, true);
    if (problem) throw new PluginError(problem);
    await this.#store(viewer, id, { enabled: true, error: null });
    try {
      await this.#activate(id);
      return true;
    } catch (err) {
      await this.#store(viewer, id, { enabled: false });
      throw err instanceof PluginError ? err : new PluginError(`${id} failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async disable(viewer: V, id: string): Promise<boolean> {
    this.#gate(viewer);
    this.#row(id);
    const on = this.#dependents(id, true).map((r) => r.id);
    if (on.length) throw new PluginError(`disable ${on.join(", ")} first; they need ${id}`);
    await this.#deactivate(id);
    await this.#store(viewer, id, { enabled: false });
    return true;
  }

  async uninstall(viewer: V, id: string): Promise<boolean> {
    this.#gate(viewer);
    const row = this.#row(id);
    if (row.enabled) throw new PluginError(`disable ${id} first`);
    const deps = this.#dependents(id, false).map((r) => r.id);
    if (deps.length) throw new PluginError(`uninstall ${deps.join(", ")} first; they need ${id}`);
    const n = await this.model.as(viewer as never).delete((r) => r.id === id);
    if (n !== 1) return false;
    this.#rows.delete(id);
    return true;
  }

  async configure(viewer: V, id: string, patch: Record<string, unknown>): Promise<Record<string, boolean | number | string>> {
    this.#gate(viewer);
    const row = this.#row(id);
    const schema = row.manifest.settings ?? {};
    const next = { ...row.settings };
    for (const [k, v] of Object.entries(patch ?? {})) {
      const spec = schema[k];
      if (!spec) throw new PluginError(`${id} has no setting \`${k}\``);
      if (spec.editable === false) throw new PluginError(`${id}: \`${k}\` is fixed`);
      const p = settingProblem(spec, v);
      if (p) throw new PluginError(`${id} setting \`${k}\`: ${p}`);
      next[k] = v as boolean | number | string;
    }
    await this.#store(viewer, id, { settings: next });
    return next;
  }

  #gate(viewer: V): void {
    let ok = false;
    try {
      ok = this.#o.userId(viewer) !== null && this.#o.canManage(viewer) === true;
    } catch {
      ok = false;
    }
    if (!ok) throw new PluginError("only platform administrators manage plugins");
  }

  #row(id: string): PluginRow {
    const r = this.#rows.get(id);
    if (!r) throw new PluginError(`${id} is not installed`);
    return r;
  }

  #signer(m: PluginManifest, pkg: { bytes?: Uint8Array; signature?: string }): string | null {
    const required = this.#o.requireSignature ?? true;
    if (pkg.bytes && pkg.signature) {
      const keys = this.#o.trustedKeys;
      const who = verifyPackage(pkg.bytes, pkg.signature, typeof keys === "function" ? keys() : (keys ?? []));
      if (!who) throw new PluginError(`${m.id}: the package signature does not match a trusted key`);
      return who;
    }
    if (required) throw new PluginError(`${m.id}: a signed package is required`);
    return null;
  }

  #engines(m: PluginManifest): string | null {
    const hosts: Record<string, string> = { [this.#o.host.name]: this.#o.host.version, kit: this.#o.host.kit ?? KIT_VERSION };
    if (!(this.#o.host.name in m.engines)) return `${m.id} does not support ${this.#o.host.name}`;
    for (const [name, range] of Object.entries(m.engines)) {
      if (!(name in hosts)) continue;
      if (!satisfies(hosts[name]!, range)) return `${m.id} needs ${name} ${range} (this is ${hosts[name]})`;
    }
    return null;
  }

  #unmet(m: PluginManifest, mustBeOn: boolean): string | null {
    for (const [dep, range] of Object.entries(m.requires ?? {})) {
      const r = this.#rows.get(dep);
      if (!r) return `${m.id} needs ${dep} ${range}; install it first`;
      if (!satisfies(r.version, range)) return `${m.id} needs ${dep} ${range}; ${r.version} is installed`;
      if (mustBeOn && !r.enabled) return `${m.id} needs ${dep} enabled`;
    }
    return null;
  }

  #dependents(id: string, enabledOnly: boolean): PluginRow[] {
    return [...this.#rows.values()].filter((r) => r.id !== id && r.manifest.requires && id in r.manifest.requires && (!enabledOnly || r.enabled));
  }

  #order(ids: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string, path: Set<string>) => {
      if (seen.has(id) || path.has(id) || !ids.includes(id)) return;
      path.add(id);
      for (const dep of Object.keys(this.#rows.get(id)?.manifest.requires ?? {})) visit(dep, path);
      path.delete(id);
      seen.add(id);
      out.push(id);
    };
    for (const id of [...ids].sort()) visit(id, new Set());
    return out;
  }

  #defaults(m: PluginManifest): Record<string, boolean | number | string> {
    return Object.fromEntries(Object.entries(m.settings ?? {}).map(([k, s]) => [k, s.default]));
  }

  async #store(viewer: unknown, id: string, patch: Partial<PluginRow>): Promise<void> {
    const updated = (this.#o.now ?? Date.now)();
    const scoped = this.model.as(viewer as never);
    const run = async () => {
      const n = await scoped.update((r) => r.id === id, { ...patch, updated });
      if (n !== 1) throw new PluginError(`could not update ${id}`);
      const row = await scoped.get(id);
      if (row) this.#rows.set(id, row);
    };
    await (this.model.isAsync ? asyncTransaction(run) : run());
  }

  async #activate(id: string): Promise<void> {
    if (this.#active.has(id)) return;
    const row = this.#row(id);
    const m = row.manifest;
    const caps = new Set(m.capabilities);
    const undo: (() => unknown)[] = [];
    const disable: (() => unknown)[] = [];
    const models: Model<any, any>[] = [];
    const prefix = modelPrefix(id);
    const need = (c: Capability, what: string) => {
      if (!caps.has(c)) throw new PluginError(`${id}: ${what} needs the \`${c}\` capability`);
    };
    const own = (x: string, what: string) => {
      if (x !== id && !x.startsWith(`${id}.`)) throw new PluginError(`${id}: ${what} \`${x}\` must start with \`${id}.\``);
    };
    const api: PluginApi<V> = {
      id,
      manifest: m,
      settings: async () => ({ ...(this.#rows.get(id)?.settings ?? {}) }),
      contribute: (c) => {
        need("slots", "slot entries");
        own(c.id, "slot entry id");
        undo.push(this.#o.slots.contribute({ ...c, plugin: id } as Contribution<V, any>));
      },
      registerWidget: (def) => {
        need("widgets", "widgets");
        own(def.id, "widget id");
        undo.push(this.#o.widgets.register({ ...def, plugin: id }));
      },
      registerPreset: (p) => {
        need("themes", "theme presets");
        own(p.id, "preset id");
        if (!this.#o.branding) throw new PluginError(`${id}: this product has no branding`);
        undo.push(this.#o.branding.registerPreset({ ...p, plugin: id }));
      },
      defineModel: <T>(name: string, config: Parameters<typeof defineModel<T>>[1]) => {
        need("db", "models");
        if (!(m.models ?? []).includes(name) || !name.startsWith(prefix)) throw new PluginError(`${id}: model \`${name}\` is not declared in the manifest`);
        const model = defineModel<T>(name, config);
        models.push(model);
        return model;
      },
      route: (r) => {
        need("pages", "API routes");
        const reg = registrar("route");
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(r.method)) throw new PluginError(`${id}: route method \`${r.method}\``);
        if (!underPath(r.path, `/api/plugins/${id}`)) throw new PluginError(`${id}: route paths start with /api/plugins/${id}`);
        if (typeof r.handler !== "function") throw new PluginError(`${id}: route handler`);
        undo.push(reg(id, Object.freeze({ ...r })));
      },
      page: (p) => {
        need("pages", "pages");
        const reg = registrar("page");
        if (p.app !== "admin" && p.app !== "client") throw new PluginError(`${id}: page app is admin or client`);
        if (!underPath(p.path, `/plugins/${id}`)) throw new PluginError(`${id}: page paths start with /plugins/${id}`);
        if (typeof p.component !== "function") throw new PluginError(`${id}: page component`);
        undo.push(reg(id, Object.freeze({ ...p })));
      },
      job: (j) => {
        need("jobs", "jobs");
        const reg = registrar("job");
        own(j.name, "job name");
        if (j.cron !== undefined && (typeof j.cron !== "string" || !/^[\d*/,\- ]{9,80}$/.test(j.cron) || j.cron.trim().split(/\s+/).length !== 5)) throw new PluginError(`${id}: job cron \`${j.cron}\``);
        if (typeof j.run !== "function") throw new PluginError(`${id}: job run`);
        undo.push(reg(id, Object.freeze({ ...j })));
      },
      on: (event, handle) => {
        need("webhooks", "event handlers");
        const reg = registrar("on");
        if (typeof event !== "string" || !/^[a-z][a-z0-9_.-]{0,80}$/.test(event)) throw new PluginError(`${id}: event \`${event}\``);
        if (typeof handle !== "function") throw new PluginError(`${id}: event handler`);
        undo.push(reg(id, { event, handle }));
      },
      extend: (kind, value) => {
        need("extensions", "extensions");
        const reg = registrar("extension");
        if (typeof kind !== "string" || !/^[a-z][a-z0-9-]{1,40}$/.test(kind)) throw new PluginError(`${id}: extension kind \`${kind}\``);
        if (!value || typeof value !== "object") throw new PluginError(`${id}: extension value`);
        undo.push(reg(id, kind, value));
      },
      onDisable: (fn) => {
        disable.push(fn);
      },
    };
    const registrar = <K extends keyof PluginRegistrars<V>>(k: K): NonNullable<PluginRegistrars<V>[K]> => {
      const r = this.#o.registrars?.[k];
      if (!r) throw new PluginError(`${id}: ${this.#o.host.name} does not accept plugin ${k}s`);
      return r.bind(this.#o.registrars) as NonNullable<PluginRegistrars<V>[K]>;
    };
    try {
      const module = await this.#o.load(m);
      if (!module || typeof module.activate !== "function") throw new PluginError(`${id}: the entry module exports no activate()`);
      for (const [locale, path] of Object.entries(m.translations ?? {})) {
        if (!this.#o.readFile || !this.#o.registrars?.translations) break;
        need("i18n", "translations");
        undo.push(this.#o.registrars.translations(id, locale, parseCatalog(id, locale, await this.#o.readFile(m, path))));
      }
      await module.activate(api);
      if (models.length && this.#o.attachModels) await this.#o.attachModels(models);
      this.#active.set(id, { module, undo, disable });
    } catch (err) {
      for (const u of undo.reverse()) {
        try {
          u();
        } catch {
          continue;
        }
      }
      this.#report(err, id);
      await this.#store(SYSTEM, id, { error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500) }).catch(() => {});
      throw err;
    }
  }

  async #deactivate(id: string): Promise<void> {
    const a = this.#active.get(id);
    if (!a) return;
    this.#active.delete(id);
    for (const fn of [...a.disable, () => a.module.deactivate?.()]) {
      try {
        await fn();
      } catch (err) {
        this.#report(err, id);
      }
    }
    for (const u of a.undo.reverse()) {
      try {
        u();
      } catch (err) {
        this.#report(err, id);
      }
    }
    this.#o.slots.removePlugin(id);
    this.#o.widgets.removePlugin(id);
    this.#o.branding?.removePlugin(id);
  }

  #report(err: unknown, id: string): void {
    try {
      this.#o.onError?.(err, id);
    } catch {
      return;
    }
  }
}

export function definePluginHost<V>(o: PluginHostOptions<V>): PluginHost<V> {
  return new PluginHost<V>(o);
}
