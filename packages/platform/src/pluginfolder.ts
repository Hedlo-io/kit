import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { keyFingerprint, PluginError, validateManifest, verifyPackage, type PluginHost, type PluginManifest, type PluginModule, type PluginRow } from "./plugins.ts";
import { downloadPackage, fetchRegistry, latestFor, unpackPlugin, type RegistryEntry, type RegistryFetch, advisoriesFor, severityRank, type Advisory } from "./registry.ts";
import { compareVersions, parseVersion } from "./semver.ts";

const MAX_FILES = 5000;
const MAX_BYTES = 64 * 1024 * 1024;
const ALWAYS_SKIP = [".git", ".DS_Store"];

export type PluginDiskState = "available" | "installed" | "update" | "older" | "invalid";

export interface PluginOnDisk {
  folder: string;
  id: string | null;
  name: string;
  version: string | null;
  description: string;
  author: string;
  signed: boolean;
  state: PluginDiskState;
  problem: string | null;
}

export interface Publisher {
  name: string;
  key: string;
}

export interface MarketPlugin extends RegistryEntry {
  installed: string | null;
  advisory: Advisory | null;
  state: "available" | "update" | "installed";
  verified: boolean;
  licensed: boolean;
}

export interface MarketReview {
  entry: MarketPlugin;
  manifest: PluginManifest;
  publisher: { name: string | null; fingerprint: string; verified: boolean };
  capabilities: string[];
  permissions: { id: string; description: string }[];
  settings: string[];
  requires: Record<string, string>;
  added: { capabilities: string[]; permissions: string[] };
  approval: string;
}

export interface MarketOptions<V> {
  registry: string;
  hostVersion: string;
  trustedKeys: readonly string[];
  publishers?: readonly Publisher[];
  signers?: () => Promise<readonly Publisher[]>;
  requireReview?: boolean;
  canManage: (v: V) => boolean;
  fetch?: RegistryFetch;
  paid?: {
    licensed(): Promise<ReadonlySet<string>>;
    package(entry: RegistryEntry): Promise<{ bytes: Uint8Array; signature: string; sha256: string }>;
  };
}

export interface PluginFolderOptions<V> {
  dir: string;
  manifestFile: string;
  signatureFile: string;
  host: () => PluginHost<V>;
  market?: MarketOptions<V>;
  canManage?: (v: V) => boolean;
}

function versionCompare(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  return compareVersions(pa, pb);
}

async function listFiles(root: string, skip: Set<string>, dir = root, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) throw new PluginError(`${relative(root, p)}: symbolic links are not allowed in a plugin`);
    if (e.isDirectory()) await listFiles(root, skip, p, out);
    else if (e.isFile()) out.push(p);
    if (out.length > MAX_FILES) throw new PluginError(`more than ${MAX_FILES} files`);
  }
  return out;
}

export async function packPluginFolder(root: string, signatureFile: string): Promise<Uint8Array> {
  const skip = new Set([signatureFile, ...ALWAYS_SKIP]);
  const list = (await listFiles(root, skip)).map((p) => ({ p, rel: relative(root, p).split(sep).join("/") })).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const parts: Buffer[] = [];
  let size = 0;
  for (const f of list) {
    const body = await readFile(f.p);
    size += body.length;
    if (size > MAX_BYTES) throw new PluginError("the plugin is larger than 64 MB");
    parts.push(Buffer.from(`${f.rel}\0${body.length}\0`, "utf8"), body);
  }
  return new Uint8Array(Buffer.concat(parts));
}

export function approvalOf(m: PluginManifest): string {
  const caps = [...m.capabilities].sort();
  const perms = (m.permissions ?? []).map((p) => p.id).sort();
  return createHash("sha256").update(JSON.stringify([m.id, m.version, caps, perms, Object.keys(m.settings ?? {}).sort()])).digest("hex").slice(0, 32);
}

export function definePluginFolder<V>(o: PluginFolderOptions<V>) {
  const root = resolve(o.dir);
  const skip = new Set([o.signatureFile, ...ALWAYS_SKIP]);
  const fingerprints = new Map<string, string>();
  for (const p of o.market?.publishers ?? []) {
    try {
      fingerprints.set(keyFingerprint(p.key), p.name);
    } catch {
      continue;
    }
  }
  const trusted = [...(o.market?.trustedKeys ?? []), ...(o.market?.publishers ?? []).map((p) => p.key)];

  async function signerSet(): Promise<{ keys: readonly string[]; names: Map<string, string>; official: Set<string> }> {
    if (!o.market?.signers) return { keys: trusted, names: fingerprints, official: new Set() };
    const names = new Map<string, string>();
    const official = new Set<string>();
    const keys: string[] = [];
    for (const p of await o.market.signers()) {
      try {
        const f = keyFingerprint(p.key);
        names.set(f, p.name);
        official.add(f);
        keys.push(p.key);
      } catch {
        continue;
      }
    }
    return { keys, names, official };
  }

  function manager(v: V): void {
    const ok = o.market?.canManage(v) ?? o.canManage?.(v) ?? false;
    if (!ok) throw new PluginError("only platform staff with plugins.manage may do this");
  }

  function folderPath(folder: string): string {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(folder)) throw new PluginError(`\`${folder}\` is not a plugin folder`);
    const p = resolve(root, folder);
    if (!p.startsWith(root + sep)) throw new PluginError(`\`${folder}\` is not a plugin folder`);
    return p;
  }

  async function manifestOf(folder: string): Promise<PluginManifest> {
    const raw = JSON.parse(await readFile(join(folderPath(folder), o.manifestFile), "utf8")) as unknown;
    const m = validateManifest(raw);
    if (m.id !== folder) throw new PluginError(`the folder must be named after the plugin id \`${m.id}\``);
    return m;
  }

  async function signatureOf(folder: string): Promise<string | undefined> {
    try {
      return (await readFile(join(folderPath(folder), o.signatureFile), "utf8")).trim();
    } catch {
      return undefined;
    }
  }

  async function bundle(folder: string): Promise<{ manifest: PluginManifest; pkg: { bytes?: Uint8Array; signature?: string } }> {
    const manifest = await manifestOf(folder);
    const signature = await signatureOf(folder);
    return { manifest, pkg: signature ? { bytes: await packPluginFolder(folderPath(folder), o.signatureFile), signature } : {} };
  }

  function decorate(e: RegistryEntry, installed: Map<string, PluginRow>): MarketPlugin {
    const row = installed.get(e.id);
    const cmp = row ? versionCompare(e.version, row.version) : 1;
    return { ...e, installed: row?.version ?? null, advisory: row ? (advisoriesFor(e, row.version)[0] ?? null) : null, state: !row ? "available" : cmp > 0 ? "update" : "installed", verified: false, licensed: !e.paid };
  }

  async function latest(): Promise<Map<string, RegistryEntry>> {
    if (!o.market?.registry) throw new PluginError("no plugin registry is configured");
    return latestFor(await fetchRegistry(o.market.registry, o.market.fetch), { version: o.market.hostVersion });
  }

  async function download(id: string): Promise<{ entry: RegistryEntry; bytes: Uint8Array; files: { path: string; body: Uint8Array }[]; manifest: PluginManifest; signer: string; names: Map<string, string>; official: Set<string> }> {
    const listed = (await latest()).get(id);
    if (!listed) throw new PluginError(`\`${id}\` is not in the registry`);
    let entry = listed;
    let bytes: Uint8Array;
    if (listed.paid) {
      if (!o.market?.paid) throw new PluginError("paid plugins are not available on this installation");
      const got = await o.market.paid.package(listed);
      entry = { ...listed, signature: got.signature, sha256: got.sha256, size: got.bytes.byteLength };
      bytes = got.bytes;
    } else bytes = await downloadPackage(listed, o.market!.fetch);
    const trust = await signerSet();
    const signer = verifyPackage(bytes, entry.signature, trust.keys);
    if (!signer) throw new PluginError("the package signature is not from a trusted key");
    const files = unpackPlugin(bytes);
    const manifestFile = files.find((f) => f.path === o.manifestFile);
    if (!manifestFile) throw new PluginError(`the package has no ${o.manifestFile}`);
    if (files.some((f) => f.path === o.signatureFile || f.path.split("/").some((s) => skip.has(s)))) throw new PluginError("the package contains files a plugin may not ship");
    const manifest = validateManifest(JSON.parse(Buffer.from(manifestFile.body).toString("utf8")) as unknown);
    if (manifest.id !== entry.id || manifest.version !== entry.version) throw new PluginError("the package does not match its registry entry");
    return { entry, bytes, files, manifest, signer, names: trust.names, official: trust.official };
  }

  async function place(v: V, entry: RegistryEntry, bytes: Uint8Array, files: { path: string; body: Uint8Array }[], manifest: PluginManifest): Promise<PluginRow> {
    const target = folderPath(manifest.id);
    const staging = join(root, `.incoming-${manifest.id}-${randomBytes(6).toString("hex")}`);
    const previous = join(root, `.previous-${manifest.id}-${randomBytes(6).toString("hex")}`);
    await mkdir(staging, { recursive: true });
    let moved = false;
    let placed = false;
    try {
      for (const f of files) {
        const p = resolve(staging, f.path);
        if (!p.startsWith(staging + sep)) throw new PluginError(`unsafe path ${f.path}`);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, f.body, { flag: "wx" });
      }
      await writeFile(join(staging, o.signatureFile), entry.signature + "\n", { flag: "wx" });
      const repacked = await packPluginFolder(staging, o.signatureFile);
      if (Buffer.compare(Buffer.from(repacked), Buffer.from(bytes)) !== 0) throw new PluginError("the unpacked plugin does not match the signed package");
      const exists = await stat(target).then(() => true, () => false);
      if (exists) {
        await rename(target, previous);
        moved = true;
      }
      await rename(staging, target);
      placed = true;
      const has = o.host().list().some((r) => r.id === manifest.id);
      const row = has ? await o.host().update(v, manifest, { bytes, signature: entry.signature }) : await o.host().install(v, manifest, { bytes, signature: entry.signature });
      if (moved) await rm(previous, { recursive: true, force: true });
      return row;
    } catch (e) {
      await rm(staging, { recursive: true, force: true });
      if (placed) await rm(target, { recursive: true, force: true });
      if (moved) await rename(previous, target).catch(() => undefined);
      throw e;
    }
  }

  return {
    dir: root,

    async scan(): Promise<PluginOnDisk[]> {
      let entries: string[] = [];
      try {
        entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
      } catch {
        return [];
      }
      const installed = new Map(o.host().list().map((r) => [r.id, r]));
      const out: PluginOnDisk[] = [];
      for (const folder of entries.sort()) {
        try {
          const m = await manifestOf(folder);
          const row = installed.get(m.id);
          const cmp = row ? versionCompare(m.version, row.version) : 1;
          out.push({ folder, id: m.id, name: m.name, version: m.version, description: m.description ?? "", author: m.author ?? "", signed: (await signatureOf(folder)) !== undefined, state: !row ? "available" : cmp > 0 ? "update" : cmp < 0 ? "older" : "installed", problem: null });
        } catch (e) {
          out.push({ folder, id: null, name: folder, version: null, description: "", author: "", signed: false, state: "invalid", problem: e instanceof Error ? e.message : String(e) });
        }
      }
      return out;
    },

    async advisories(v: V): Promise<MarketPlugin[]> {
      manager(v);
      if (!o.market?.registry) return [];
      const installed = new Map(o.host().list().map((r) => [r.id, r]));
      if (installed.size === 0) return [];
      const entries = [...(await latest()).values()].filter((e) => installed.has(e.id));
      return entries.map((e) => decorate(e, installed)).filter((m) => m.advisory !== null).sort((a, b) => severityRank(b.advisory!.severity) - severityRank(a.advisory!.severity));
    },

    async market(v: V): Promise<MarketPlugin[]> {
      manager(v);
      if (!o.market?.registry) return [];
      const installed = new Map(o.host().list().map((r) => [r.id, r]));
      const official = Boolean(o.market.signers);
      const entries = [...(await latest()).values()];
      let owned: ReadonlySet<string> = new Set();
      if (o.market.paid && entries.some((e) => e.paid)) owned = await o.market.paid.licensed().catch(() => new Set<string>());
      return entries.sort((a, b) => a.name.localeCompare(b.name)).map((e) => ({ ...decorate(e, installed), verified: official || (e.publisher !== "" && [...fingerprints.values()].includes(e.publisher)), licensed: !e.paid || owned.has(e.id) }));
    },

    async review(v: V, id: string): Promise<MarketReview> {
      manager(v);
      const d = await download(id);
      const installed = new Map(o.host().list().map((r) => [r.id, r]));
      const name = d.names.get(d.signer) ?? null;
      const verified = d.official.has(d.signer) || (name !== null && (d.entry.publisher === "" || d.entry.publisher === name));
      const before = installed.get(id)?.manifest;
      const oldCaps = new Set<string>(before?.capabilities ?? []);
      const oldPerms = new Set((before?.permissions ?? []).map((p) => p.id));
      return {
        entry: { ...decorate(d.entry, installed), verified, licensed: true },
        manifest: d.manifest,
        publisher: { name, fingerprint: d.signer, verified },
        capabilities: [...d.manifest.capabilities].sort(),
        permissions: (d.manifest.permissions ?? []).map((p) => ({ id: p.id, description: p.description ?? "" })),
        settings: Object.keys(d.manifest.settings ?? {}),
        requires: { ...(d.manifest.requires ?? {}) },
        added: { capabilities: d.manifest.capabilities.filter((c) => !oldCaps.has(c)), permissions: (d.manifest.permissions ?? []).map((p) => p.id).filter((p) => !oldPerms.has(p)) },
        approval: approvalOf(d.manifest),
      };
    },

    async fromMarket(v: V, id: string, approval?: string): Promise<PluginRow> {
      manager(v);
      const d = await download(id);
      if ((o.market?.requireReview ?? false) || approval !== undefined) {
        if (approval !== approvalOf(d.manifest)) throw new PluginError("the plugin asks for different access than you reviewed; review it again");
      }
      return place(v, d.entry, d.bytes, d.files, d.manifest);
    },

    async remove(v: V, id: string): Promise<boolean> {
      manager(v);
      const target = folderPath(id);
      const done = o.host().list().some((r) => r.id === id) ? await o.host().uninstall(v, id) : true;
      if (!done) return false;
      await rm(target, { recursive: true, force: true });
      return true;
    },

    async install(v: V, folder: string): Promise<PluginRow> {
      const b = await bundle(folder);
      return o.host().install(v, b.manifest, b.pkg);
    },

    async update(v: V, folder: string): Promise<PluginRow> {
      const b = await bundle(folder);
      return o.host().update(v, b.manifest, b.pkg);
    },

    async load(m: PluginManifest): Promise<PluginModule<V>> {
      const base = folderPath(m.id);
      const entry = resolve(base, m.entry);
      if (!entry.startsWith(base + sep)) throw new PluginError(`${m.id}: entry is outside the plugin`);
      if (!(await stat(entry)).isFile()) throw new PluginError(`${m.id}: entry \`${m.entry}\` is missing`);
      const mod = (await import(`${pathToFileURL(entry).href}?v=${encodeURIComponent(m.version)}`)) as { default?: PluginModule<V> } & Partial<PluginModule<V>>;
      const plugin = mod.default ?? (mod as PluginModule<V>);
      if (typeof plugin?.activate !== "function") throw new PluginError(`${m.id}: the entry exports no activate()`);
      return plugin;
    },

    async readFile(m: PluginManifest, path: string): Promise<string> {
      const base = folderPath(m.id);
      const p = resolve(base, path);
      if (!p.startsWith(base + sep)) throw new PluginError(`${m.id}: ${path} is outside the plugin`);
      return readFile(p, "utf8");
    },
  };
}

export type PluginFolder<V> = ReturnType<typeof definePluginFolder<V>>;
