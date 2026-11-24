import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pgliteAsPool } from "@weft-framework/data/postgres";
import { createJobs } from "@weft-framework/server";
import { defineKitWebhooks, kitCsp, pgRateLimit, TURNSTILE_CSP, verifyTurnstile } from "../src/index.ts";

const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("turnstile tokens are verified server side", async () => {
  let sent: URLSearchParams | null = null;
  const ok = await verifyTurnstile({
    secret: "s3cret",
    token: "tok",
    ip: "203.0.113.9",
    action: "sign-up",
    fetch: (async (_url: string, init: RequestInit) => {
      sent = init.body as URLSearchParams;
      return new Response(JSON.stringify({ success: true, action: "sign-up", hostname: "panel.example.test" }));
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(ok, { ok: true, codes: [] });
  assert.equal(sent!.get("remoteip"), "203.0.113.9");
  assert.deepEqual(await verifyTurnstile({ secret: "s", token: "" }), { ok: false, codes: ["missing-input-response"] });
  assert.deepEqual(await verifyTurnstile({ secret: "s", token: "t", fetch: reply({ success: false, "error-codes": ["invalid-input-response"] }) }), { ok: false, codes: ["invalid-input-response"] });
  assert.deepEqual(await verifyTurnstile({ secret: "s", token: "t", action: "login", fetch: reply({ success: true, action: "sign-up" }) }), { ok: false, codes: ["action-mismatch"] });
  assert.deepEqual(await verifyTurnstile({ secret: "s", token: "t", fetch: reply({}, 500) }), { ok: false, codes: ["http-500"] });
  const down = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  assert.deepEqual(await verifyTurnstile({ secret: "s", token: "t", fetch: down }), { ok: false, codes: ["unreachable"] });
});

test("kit CSP merges sources without duplicates", () => {
  const csp = kitCsp(TURNSTILE_CSP, { frame: ["https://challenges.cloudflare.com"], img: ["https://cdn.example.test"] });
  assert.deepEqual(csp.frame, ["https://challenges.cloudflare.com"]);
  assert.deepEqual(csp.img, ["data:", "blob:", "https://cdn.example.test"]);
  assert.throws(() => kitCsp({ img: ["javascript:"] }));
});

test("shared rate limit counts across instances per window", async () => {
  const pool = pgliteAsPool(new PGlite());
  const a = pgRateLimit(pool, "loom_rate");
  const b = pgRateLimit(pool, "loom_rate");
  const t = 1_700_000_000_000;
  assert.equal((await a.take("sign-in:1.2.3.4", 2, 60_000, t)).ok, true);
  const second = await b.take("sign-in:1.2.3.4", 2, 60_000, t + 10);
  assert.deepEqual([second.ok, second.remaining], [true, 0]);
  assert.equal((await a.take("sign-in:1.2.3.4", 2, 60_000, t + 20)).ok, false);
  assert.equal((await a.take("sign-in:5.6.7.8", 2, 60_000, t + 20)).ok, true);
  assert.equal((await a.take("sign-in:1.2.3.4", 2, 60_000, t + 60_000)).ok, true);
  await assert.rejects(a.take("k", 0, 60_000));
});

test("webhooks are stored per product in Postgres", async () => {
  const pool = pgliteAsPool(new PGlite());
  assert.throws(() => defineKitWebhooks({ pool, prefix: "Bad", events: ["server.created"], key: "k".repeat(32), jobs: () => createJobs({ jobs: [] }) }));
  const hooks = defineKitWebhooks({ pool, prefix: "loom_", events: ["server.created", "server.deleted"], key: "k".repeat(32), jobs: () => createJobs({ jobs: [] }) });
  assert.ok(hooks);
});
