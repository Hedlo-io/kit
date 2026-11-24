import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HEDLO_MARKETPLACE, type HedloTrust } from "./hedlo.ts";
import { PluginError } from "./plugins.ts";
import { readCapped, type RegistryEntry, type RegistryFetch } from "./registry.ts";

type Market = typeof import("@hedlo/market");
let lib: Promise<Market> | null = null;
const market = (): Promise<Market> => (lib ??= import("@hedlo/market"));

const STATE_FILE = ".hedlo-site.json";
const PACKAGE_MAX = 96 << 20;

interface SiteState {
  v: 1;
  domain: string;
  signKey: string;
  signPem: string;
  boxKey: string;
  boxPem: string;
  link: { id: string; code: string; uri: string; expiresAt: number } | null;
  site: string | null;
  linkedAt: number | null;
  telemetry?: boolean;
}

export interface HedloSiteStatus {
  linked: boolean;
  domain: string | null;
  site: string | null;
  fingerprint: string | null;
  pending: { code: string; uri: string; expiresAt: number } | null;
  telemetry: boolean;
}

export interface HedloLicence {
  item: string;
  licence: string;
  latest: string | null;
  expires: number;
  updatesUntil: number | null;
  trialUntil: number | null;
}

export interface HedloSiteOptions {
  dir: string;
  product: "loom" | "bolt";
  version: string;
  trust: HedloTrust;
  fetch?: RegistryFetch;
  installed?: () => readonly { id: string; version: string }[];
}

const TELEMETRY_MAX = 300;

export function hedloSite(o: HedloSiteOptions) {
  const file = join(o.dir, STATE_FILE);
  const fetcher = (o.fetch ?? fetch) as unknown as (url: string, init: RequestInit) => Promise<Response>;
  let cache: { at: number; rows: { item: string; licence: string; latest: string | null; certificate: string }[] } | null = null;

  async function load(): Promise<SiteState | null> {
    try {
      const s = JSON.parse(await readFile(file, "utf8")) as SiteState;
      return s && s.v === 1 && typeof s.signPem === "string" && typeof s.boxPem === "string" ? s : null;
    } catch {
      return null;
    }
  }

  async function save(s: SiteState): Promise<void> {
    await mkdir(o.dir, { recursive: true });
    await writeFile(file, JSON.stringify(s) + "\n", { mode: 0o600 });
  }

  async function view(s: SiteState | null): Promise<HedloSiteStatus> {
    if (!s) return { linked: false, domain: null, site: null, fingerprint: null, pending: null, telemetry: false };
    const m = await market();
    const pending = !s.site && s.link && s.link.expiresAt > Date.now() ? { code: s.link.code, uri: s.link.uri, expiresAt: s.link.expiresAt } : null;
    return { linked: Boolean(s.site), domain: s.domain, site: s.site, fingerprint: m.fingerprint(s.signKey), pending, telemetry: s.telemetry === true };
  }

  async function call(s: SiteState, method: "GET" | "POST", path: string, accept = "application/json", max = 1 << 20, payload?: unknown): Promise<Uint8Array> {
    const m = await market();
    const time = Date.now();
    const body = method === "POST" && payload !== undefined ? new Uint8Array(Buffer.from(JSON.stringify(payload), "utf8")) : new Uint8Array(0);
    const res = await fetcher(HEDLO_MARKETPLACE + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      headers: { accept, ...(body.length > 0 ? { "content-type": "application/json" } : {}), "x-hedlo-key": s.signKey, "x-hedlo-time": String(time), "x-hedlo-signature": m.signBytes(m.siteRequestMessage(method, path, time, body), s.signPem) },
      body: method === "POST" ? body : undefined,
    });
    const bytes = await readCapped(res, max);
    if (!res.ok) {
      let message = `the Hedlo Marketplace answered ${res.status}`;
      try {
        const j = JSON.parse(Buffer.from(bytes).toString("utf8")) as { message?: unknown };
        if (typeof j.message === "string" && j.message) message = j.message.slice(0, 200);
      } catch {
        message = `the Hedlo Marketplace answered ${res.status}`;
      }
      throw new PluginError(message);
    }
    return bytes;
  }

  async function json<T>(s: SiteState, method: "GET" | "POST", path: string, payload?: unknown): Promise<T> {
    return JSON.parse(Buffer.from(await call(s, method, path, "application/json", 1 << 20, payload)).toString("utf8")) as T;
  }

  function report(s: SiteState): { telemetry: boolean; installed?: { item: string; version: string }[] } {
    if (s.telemetry !== true || !o.installed) return { telemetry: false };
    const installed = o.installed()
      .filter((p) => /^[a-z0-9][a-z0-9._-]{0,119}$/.test(p.id) && /^[0-9A-Za-z.+-]{1,40}$/.test(p.version))
      .slice(0, TELEMETRY_MAX)
      .map((p) => ({ item: p.id, version: p.version }));
    return { telemetry: true, installed };
  }

  async function linkedState(): Promise<SiteState> {
    const s = await load();
    if (!s?.site) throw new PluginError("link this installation to the Hedlo Marketplace first");
    return s;
  }

  async function certificates(force = false): Promise<{ item: string; licence: string; latest: string | null; certificate: string }[]> {
    if (!force && cache && Date.now() - cache.at < 5 * 60_000) return cache.rows;
    const s = await linkedState();
    const r = await json<{ certificates?: unknown }>(s, "POST", "/api/v1/site/certificates", report(s));
    const rows = Array.isArray(r.certificates)
      ? r.certificates
          .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
          .map((c) => ({ item: String(c.item ?? ""), licence: String(c.licence ?? ""), latest: typeof c.latest === "string" ? c.latest : null, certificate: String(c.certificate ?? "") }))
          .filter((c) => c.item && c.certificate)
          .slice(0, 2000)
      : [];
    cache = { at: Date.now(), rows };
    return rows;
  }

  async function checked(item: string) {
    const s = await linkedState();
    const m = await market();
    const keys = await o.trust.licenceKeys();
    if (keys.length === 0) throw new PluginError("the Hedlo Marketplace has not published a licence key");
    for (const force of [false, true]) {
      const row = (await certificates(force)).find((c) => c.item === item);
      if (!row) continue;
      const c = m.checkCertificate(row.certificate, keys, { installKey: s.signKey, domain: s.domain, item }, Date.now());
      if (c.ok) return { s, cert: c.cert, row };
    }
    throw new PluginError(`this installation has no licence for ${item}; buy it on the Hedlo Marketplace`);
  }

  return {
    async status(): Promise<HedloSiteStatus> {
      return view(await load());
    },

    async link(domain: string): Promise<HedloSiteStatus> {
      const m = await market();
      const current = await load();
      if (current?.site) throw new PluginError("this installation is already linked");
      const host = m.normaliseDomain(String(domain).trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? "");
      const sign = current && current.domain === host ? { publicKey: current.signKey, privateKey: current.signPem } : m.ed25519Pair();
      const box = current && current.domain === host ? { publicKey: current.boxKey, privateKey: current.boxPem } : m.x25519Pair();
      const request = { domain: host, product: o.product, version: o.version, signKey: sign.publicKey, boxKey: box.publicKey, nonce: randomBytes(24).toString("base64url"), iat: Date.now() };
      const signature = m.signBytes(m.linkRequestMessage(request), sign.privateKey);
      const res = await fetcher(`${HEDLO_MARKETPLACE}/api/v1/site/link`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000), headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ request, signature }) });
      const text = Buffer.from(await readCapped(res, 16 * 1024)).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = {};
      }
      if (!res.ok) throw new PluginError(typeof body.message === "string" ? body.message.slice(0, 200) : `the Hedlo Marketplace answered ${res.status}`);
      const uri = String(body.verification_uri_complete ?? "");
      if (!uri.startsWith(HEDLO_MARKETPLACE + "/")) throw new PluginError("the Hedlo Marketplace sent an unexpected link address");
      const s: SiteState = { v: 1, domain: host, signKey: sign.publicKey, signPem: sign.privateKey, boxKey: box.publicKey, boxPem: box.privateKey, link: { id: String(body.id ?? ""), code: String(body.code ?? ""), uri, expiresAt: Number(body.expires_at ?? 0) }, site: null, linkedAt: null };
      await save(s);
      return view(s);
    },

    async check(): Promise<HedloSiteStatus> {
      const s = await load();
      if (!s || s.site || !s.link) return view(s);
      const r = await json<{ state?: string; site?: string | null }>(s, "GET", `/api/v1/site/link/${encodeURIComponent(s.link.id)}`);
      if (r.state === "linked" && typeof r.site === "string") {
        s.site = r.site;
        s.linkedAt = Date.now();
        s.link = null;
        await save(s);
      } else if (r.state !== "pending") {
        s.link = null;
        await save(s);
      }
      return view(s);
    },

    async setTelemetry(on: boolean): Promise<HedloSiteStatus> {
      const s = await load();
      if (!s) throw new PluginError("link this installation to the Hedlo Marketplace first");
      s.telemetry = on;
      await save(s);
      if (s.site) await certificates(true).catch(() => undefined);
      return view(s);
    },

    async forget(): Promise<void> {
      cache = null;
      await rm(file, { force: true });
    },

    async proof(domain: string, challenge: string): Promise<string | null> {
      const s = await load();
      if (!s || !/^[A-Za-z0-9_-]{16,64}$/.test(challenge)) return null;
      const m = await market();
      if (m.normaliseDomain(domain) !== s.domain) return null;
      if (!s.site && !(s.link && s.link.expiresAt > Date.now())) return null;
      return m.signBytes(m.proofMessage(s.domain, challenge), s.signPem);
    },

    async licences(): Promise<HedloLicence[]> {
      const s = await load();
      if (!s?.site) return [];
      const m = await market();
      const keys = await o.trust.licenceKeys();
      const out: HedloLicence[] = [];
      for (const row of await certificates()) {
        const c = m.checkCertificate(row.certificate, keys, { installKey: s.signKey, domain: s.domain, item: row.item }, Date.now());
        if (c.ok) out.push({ item: row.item, licence: row.licence, latest: row.latest, expires: c.cert.exp, updatesUntil: c.cert.updatesUntil, trialUntil: c.cert.trialUntil });
      }
      return out;
    },

    async package(entry: RegistryEntry): Promise<{ bytes: Uint8Array; signature: string; sha256: string }> {
      const url = new URL(entry.url);
      if (url.origin !== HEDLO_MARKETPLACE || !url.pathname.startsWith("/api/v1/licences/package/")) throw new PluginError("paid packages come only from the Hedlo Marketplace");
      const { s, cert } = await checked(entry.id);
      const m = await market();
      const raw = await call(s, "GET", url.pathname, "application/json", PACKAGE_MAX);
      const issued = JSON.parse(Buffer.from(raw).toString("utf8")) as Parameters<Market["openPackage"]>[0];
      if (issued.item !== entry.id || issued.version !== entry.version) throw new PluginError("the marketplace sent a different package than requested");
      const opened = m.openPackage(issued, s.boxPem, o.trust.keys(), cert);
      return { bytes: new Uint8Array(opened.bytes), signature: issued.signature, sha256: issued.sha256 };
    },
  };
}

export type HedloSite = ReturnType<typeof hedloSite>;
