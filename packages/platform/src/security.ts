import type { PgPool } from "@weft-framework/data/postgres";
import { defineWebhooks, type WebhooksOptions } from "@weft-framework/server/webhooks";
import { PgWebhookStore } from "@weft-framework/server/pg-stores";
import { checkCspSources, type CspSources, type Secret } from "@weft-framework/server";

function mergeCspSources(...sets: (CspSources | undefined)[]): CspSources {
  const out: Record<string, string[]> = {};
  for (const set of sets) {
    if (!set) continue;
    for (const [k, list] of Object.entries(set)) for (const v of list ?? []) if (!(out[k] ??= []).includes(v)) out[k].push(v);
  }
  return checkCspSources(out, "kit csp");
}

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export const TURNSTILE_CSP: CspSources = { frame: [TURNSTILE_ORIGIN], connect: [TURNSTILE_ORIGIN] };

export const TURNSTILE_SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js`;

export function kitCsp(...extra: (CspSources | undefined)[]): CspSources {
  return mergeCspSources({ img: ["data:", "blob:"], worker: ["blob:"] }, ...extra);
}

export interface CaptchaResult {
  ok: boolean;
  codes: string[];
}

export interface TurnstileOptions {
  secret: Secret | string;
  token: string | null | undefined;
  ip?: string | null;
  action?: string;
  hostname?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const secretText = (s: Secret | string): string => (typeof s === "string" ? s : s.reveal());

export async function verifyTurnstile(o: TurnstileOptions): Promise<CaptchaResult> {
  const token = typeof o.token === "string" ? o.token.trim() : "";
  if (token === "" || token.length > 2048) return { ok: false, codes: ["missing-input-response"] };
  const body = new URLSearchParams({ secret: secretText(o.secret), response: token });
  if (o.ip) body.set("remoteip", o.ip);
  try {
    const res = await (o.fetch ?? fetch)(`${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
    });
    if (!res.ok) return { ok: false, codes: [`http-${res.status}`] };
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[]; action?: string; hostname?: string };
    const codes = Array.isArray(data["error-codes"]) ? data["error-codes"].filter((c) => typeof c === "string") : [];
    if (data.success !== true) return { ok: false, codes: codes.length ? codes : ["rejected"] };
    if (o.action !== undefined && data.action !== o.action) return { ok: false, codes: ["action-mismatch"] };
    if (o.hostname !== undefined && data.hostname !== o.hostname) return { ok: false, codes: ["hostname-mismatch"] };
    return { ok: true, codes };
  } catch {
    return { ok: false, codes: ["unreachable"] };
  }
}

export interface SharedLimiter {
  take(key: string, limit: number, windowMs: number, now?: number): Promise<{ ok: boolean; remaining: number; resetAt: number }>;
}

export function pgRateLimit(pool: PgPool, table: string): SharedLimiter {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table)) throw new TypeError(`not a valid table name: ${table}`);
  let ready: Promise<unknown> | null = null;
  let swept = 0;
  return {
    async take(key, limit, windowMs, now = Date.now()) {
      if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1000) throw new RangeError("limit must be ≥ 1 and window ≥ 1s");
      ready ??= pool.query(`CREATE TABLE IF NOT EXISTS "${table}" (key text NOT NULL, win bigint NOT NULL, hits integer NOT NULL, PRIMARY KEY (key, win))`).catch((e) => {
        ready = null;
        throw e;
      });
      await ready;
      const win = Math.floor(now / windowMs);
      const res = await pool.query(
        `INSERT INTO "${table}" (key, win, hits) VALUES ($1, $2, 1) ON CONFLICT (key, win) DO UPDATE SET hits = "${table}".hits + 1 RETURNING hits`,
        [key.slice(0, 512), win],
      );
      if (now - swept > 60_000) {
        swept = now;
        await pool.query(`DELETE FROM "${table}" WHERE win < $1`, [Math.floor((now - 86_400_000) / windowMs)]);
      }
      const hits = Number((res.rows[0] as { hits: unknown }).hits);
      return { ok: hits <= limit, remaining: Math.max(0, limit - hits), resetAt: (win + 1) * windowMs };
    },
  };
}

export interface KitWebhookOptions<E extends string> extends Omit<WebhooksOptions<E>, "store"> {
  pool: PgPool;
  prefix: string;
}

export function defineKitWebhooks<const E extends string>(o: KitWebhookOptions<E>) {
  if (!/^[a-z][a-z0-9_]{0,30}_$/.test(o.prefix)) throw new TypeError(`table prefix must look like "loom_": ${o.prefix}`);
  const { pool, prefix, ...rest } = o;
  return defineWebhooks<E>({ ...rest, store: new PgWebhookStore(pool, `${prefix}webhooks`) });
}
