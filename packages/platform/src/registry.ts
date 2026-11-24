import { createHash } from "node:crypto";
import { PluginError } from "./plugins.ts";
import { compareVersions, parseVersion, satisfies, validRange } from "./semver.ts";

export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage: string;
  engine: string;
  url: string;
  sha256: string;
  signature: string;
  size: number;
  kind: "plugin" | "theme";
  publisher: string;
  paid?: boolean;
  advisories?: Advisory[];
}

export type AdvisorySeverity = "low" | "medium" | "high" | "critical";

export interface Advisory {
  id: string;
  severity: AdvisorySeverity;
  title: string;
  affected: string;
  fixed: string | null;
  url: string;
  published: number;
}

const SEVERITIES = new Set<AdvisorySeverity>(["low", "medium", "high", "critical"]);
const SEVERITY_RANK: Record<AdvisorySeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export function severityRank(s: AdvisorySeverity): number {
  return SEVERITY_RANK[s];
}

function parseAdvisories(raw: unknown): Advisory[] {
  if (!Array.isArray(raw)) return [];
  const out: Advisory[] = [];
  for (const x of raw.slice(0, 50)) {
    if (!x || typeof x !== "object") continue;
    const a = x as Record<string, unknown>;
    const id = str(a.id, 64);
    const severity = a.severity as AdvisorySeverity;
    const affected = str(a.affected, 100);
    const fixed = typeof a.fixed === "string" && parseVersion(a.fixed) ? a.fixed.slice(0, 64) : null;
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id) || !SEVERITIES.has(severity) || !affected || !validRange(affected)) continue;
    out.push({ id, severity, title: str(a.title, 200), affected, fixed, url: httpsUrl(str(a.url, 2048)) ?? "", published: typeof a.published === "number" && Number.isFinite(a.published) ? a.published : 0 });
  }
  return out;
}

export function advisoriesFor(entry: Pick<RegistryEntry, "advisories">, installed: string): Advisory[] {
  if (!parseVersion(installed)) return [];
  return (entry.advisories ?? []).filter((a) => satisfies(installed, a.affected)).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

export interface Registry {
  name: string;
  entries: RegistryEntry[];
}

export type RegistryFetch = (url: string, init: { signal: AbortSignal; redirect: "error"; headers: Record<string, string> }) => Promise<Response>;

const ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/;
const HEX = /^[0-9a-f]{64}$/;
const MAX_INDEX = 4 * 1024 * 1024;
export const MAX_PACKAGE = 64 * 1024 * 1024;
const MAX_FILES = 5000;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function httpsUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function parseRegistry(raw: unknown, base: string): Registry {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!root || !Array.isArray(root.plugins)) throw new PluginError("the registry index has no `plugins` list");
  const entries: RegistryEntry[] = [];
  for (const item of root.plugins.slice(0, 5000)) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const id = str(p.id, 100);
    const version = str(p.version, 64);
    const url = httpsUrl(str(p.url, 2048), base);
    const sha256 = str(p.sha256, 64).toLowerCase();
    const signature = str(p.signature, 512);
    const size = typeof p.size === "number" && Number.isInteger(p.size) ? p.size : -1;
    const engine = str(p.engine, 100);
    const paid = p.paid === true;
    if (!ID.test(id) || !parseVersion(version) || !url || size <= 0 || size > MAX_PACKAGE) continue;
    if (!paid && (!HEX.test(sha256) || !signature)) continue;
    if (engine && !validRange(engine)) continue;
    entries.push({ id, name: str(p.name, 100) || id, version, description: str(p.description, 500), author: str(p.author, 100), homepage: httpsUrl(str(p.homepage, 2048)) ?? "", engine, url, sha256, kind: p.kind === "theme" ? "theme" : "plugin", publisher: str(p.publisher, 100), signature, size, paid, advisories: parseAdvisories(p.advisories) });
  }
  return { name: str(root.name, 100), entries };
}

export function latestFor(registry: Registry, host: { version: string }): Map<string, RegistryEntry> {
  const out = new Map<string, RegistryEntry>();
  for (const e of registry.entries) {
    if (e.engine && !satisfies(host.version, e.engine)) continue;
    const cur = out.get(e.id);
    if (!cur || compareVersions(parseVersion(e.version)!, parseVersion(cur.version)!) > 0) out.set(e.id, e);
  }
  return out;
}

export async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) throw new PluginError(`the download is larger than ${max} bytes`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new PluginError(`the download is larger than ${max} bytes`);
    }
    parts.push(value);
  }
  return new Uint8Array(Buffer.concat(parts));
}

export async function fetchRegistry(url: string, fetcher: RegistryFetch = fetch as RegistryFetch): Promise<Registry> {
  const target = httpsUrl(url);
  if (!target) throw new PluginError("the registry must be an https URL");
  const res = await fetcher(target, { signal: AbortSignal.timeout(15_000), redirect: "error", headers: { accept: "application/json" } });
  if (!res.ok) throw new PluginError(`the registry answered ${res.status}`);
  const body = await readCapped(res, MAX_INDEX);
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new PluginError("the registry index is not JSON");
  }
  return parseRegistry(raw, target);
}

export async function downloadPackage(entry: RegistryEntry, fetcher: RegistryFetch = fetch as RegistryFetch): Promise<Uint8Array> {
  const res = await fetcher(entry.url, { signal: AbortSignal.timeout(120_000), redirect: "error", headers: { accept: "application/octet-stream" } });
  if (!res.ok) throw new PluginError(`the download answered ${res.status}`);
  const bytes = await readCapped(res, Math.min(entry.size, MAX_PACKAGE));
  if (bytes.byteLength !== entry.size) throw new PluginError("the download has the wrong size");
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new PluginError("the download does not match its sha256");
  return bytes;
}

const SAFE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

export function unpackPlugin(bytes: Uint8Array): { path: string; body: Uint8Array }[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { path: string; body: Uint8Array }[] = [];
  const seen = new Set<string>();
  let i = 0;
  let last = "";
  while (i < buf.length) {
    const a = buf.indexOf(0, i);
    if (a < 0 || a - i > 512) throw new PluginError("the package is damaged");
    const path = buf.subarray(i, a).toString("utf8");
    const b = buf.indexOf(0, a + 1);
    if (b < 0 || b - a > 12) throw new PluginError("the package is damaged");
    const len = Number(buf.subarray(a + 1, b).toString("ascii"));
    if (!Number.isInteger(len) || len < 0 || b + 1 + len > buf.length) throw new PluginError("the package is damaged");
    if (!SAFE_PATH.test(path) || path.length > 400 || seen.has(path.toLowerCase())) throw new PluginError(`the package has an unsafe path \`${path.slice(0, 80)}\``);
    if (path <= last) throw new PluginError("the package is not in canonical order");
    seen.add(path.toLowerCase());
    last = path;
    out.push({ path, body: new Uint8Array(buf.subarray(b + 1, b + 1 + len)) });
    if (out.length > MAX_FILES) throw new PluginError(`more than ${MAX_FILES} files`);
    i = b + 1 + len;
  }
  return out;
}
