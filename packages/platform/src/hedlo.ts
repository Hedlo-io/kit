import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keyFingerprint, PluginError } from "./plugins.ts";
import type { Publisher } from "./pluginfolder.ts";
import type { RegistryFetch } from "./registry.ts";

export const HEDLO_MARKETPLACE = "https://marketplace.hedlo.io";
export const HEDLO_MARKETPLACE_NAME = "Hedlo Marketplace";
const KEYS_FILE = ".hedlo-keys.json";
const TTL = 60 * 60 * 1000;

export function hedloRegistry(product: "loom" | "bolt" | "shuttle"): string {
  return `${HEDLO_MARKETPLACE}/api/v1/registry/${product}`;
}

function validKey(k: unknown): k is string {
  if (typeof k !== "string" || k.length < 40 || k.length > 120 || k.includes("BEGIN")) return false;
  try {
    keyFingerprint(k);
    return true;
  } catch {
    return false;
  }
}

export interface HedloTrust {
  keys(): readonly string[];
  licenceKeys(): Promise<readonly string[]>;
  signers(): Promise<readonly Publisher[]>;
}

export function hedloTrust(dir: string, fetcher: RegistryFetch = fetch as RegistryFetch): HedloTrust {
  const file = join(dir, KEYS_FILE);
  let keys: string[] = [];
  let licence: string[] = [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (Array.isArray(raw)) keys = raw.filter(validKey).slice(0, 8);
    else if (raw && typeof raw === "object") {
      const r = raw as { signing?: unknown; licence?: unknown };
      if (Array.isArray(r.signing)) keys = r.signing.filter(validKey).slice(0, 8);
      if (Array.isArray(r.licence)) licence = r.licence.filter(validKey).slice(0, 8);
    }
  } catch {
    keys = [];
    licence = [];
  }
  let checked = 0;
  let pending: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    const res = await fetcher(`${HEDLO_MARKETPLACE}/api/v1/keys`, { signal: AbortSignal.timeout(15_000), redirect: "error", headers: { accept: "application/json" } });
    if (!res.ok) throw new PluginError(`the Hedlo Marketplace answered ${res.status}`);
    const text = await res.text();
    if (text.length > 4096) throw new PluginError("the Hedlo Marketplace key list is too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new PluginError("the Hedlo Marketplace key list is not JSON");
    }
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (!validKey(b.signing)) throw new PluginError("the Hedlo Marketplace has not published a signing key");
    checked = Date.now();
    const signing = b.signing;
    const addSigning = !keys.includes(signing);
    const addLicence = validKey(b.licence) && !licence.includes(b.licence);
    if (!addSigning && !addLicence) return;
    if (addSigning) keys = [...keys, signing].slice(-8);
    if (addLicence) licence = [...licence, b.licence as string].slice(-8);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ signing: keys, licence }) + "\n", { mode: 0o644 });
  }

  async function fresh(): Promise<void> {
    if (keys.length > 0 && Date.now() - checked <= TTL) return;
    pending ??= refresh().finally(() => {
      pending = null;
    });
    try {
      await pending;
    } catch (e) {
      if (keys.length === 0) throw e;
    }
  }

  return {
    keys: () => keys,
    async licenceKeys(): Promise<readonly string[]> {
      await fresh();
      return licence;
    },
    async signers(): Promise<readonly Publisher[]> {
      await fresh();
      return keys.map((key) => ({ name: HEDLO_MARKETPLACE_NAME, key }));
    },
  };
}
