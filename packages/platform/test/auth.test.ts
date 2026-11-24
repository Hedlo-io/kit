import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pgliteAsPool } from "@weft-framework/data/postgres";
import type { Identity, PageContext } from "@weft-framework/server";
import { checkTemplate } from "../src/markdown.ts";
import { defineKitAuth, KIT_AUTH_EMAILS, KitAuthError, pgSamlReplayStore, type Activity, type KitAuthOptions, type KitUser } from "../src/index.ts";

function setup(over: Partial<KitAuthOptions> = {}) {
  const users = new Map<string, KitUser>([
    ["u1", { id: "u1", email: "ada@example.test" }],
    ["staff", { id: "staff", email: "staff@example.test" }],
  ]);
  const logged: unknown[] = [];
  const mailed: unknown[] = [];
  const pool = pgliteAsPool(new PGlite());
  const auth = defineKitAuth({
    pool,
    prefix: "loom_",
    url: "https://panel.example.test",
    name: "Loom",
    key: "k".repeat(32),
    users: {
      byEmail: (e) => [...users.values()].find((u) => u.email === e) ?? null,
      byId: (id) => users.get(id) ?? null,
      create: (email) => {
        const id = `u${users.size + 1}`;
        users.set(id, { id, email });
        return id;
      },
      setPassword: () => undefined,
      setEmail: () => undefined,
      markVerified: () => undefined,
      byIdentity: (i) => (i.provider === "github" && i.subject === "42" ? "u1" : null),
    },
    mail: (key, to, values) => void mailed.push({ key, to, values }),
    activity: { log: async (row: unknown) => (logged.push(row), row) } as unknown as Activity<unknown>,
    auditScope: () => "platform",
    canImpersonate: (op) => op === "staff",
    ...over,
  });
  return { auth, pool, logged, mailed };
}

const identity = (o: Partial<Identity>): Identity => ({ provider: "google", subject: "s", email: null, emailVerified: false, name: null, picture: null, claims: {}, ...o });

test("auth email templates only use declared variables", () => {
  for (const def of KIT_AUTH_EMAILS) {
    assert.equal(checkTemplate(def.subject, def.variables), null, def.key);
    assert.equal(checkTemplate(def.body, def.variables), null, def.key);
  }
  assert.equal(new Set(KIT_AUTH_EMAILS.map((d) => d.key)).size, KIT_AUTH_EMAILS.length);
});

test("table prefix is validated", () => {
  assert.throws(() => setup({ prefix: "Loom" }), KitAuthError);
  assert.throws(() => setup({ prefix: "x; drop_" }), KitAuthError);
});

test("identities sign in by link or verified email only", async () => {
  const { auth } = setup();
  assert.equal(await auth.signIn(identity({ provider: "github", subject: "42" })), "u1");
  assert.equal(await auth.signIn(identity({ email: "ada@example.test", emailVerified: false })), null);
  assert.equal(await auth.signIn(identity({ email: "ada@example.test", emailVerified: true })), "u1");
  assert.equal(await auth.signIn(identity({ email: "nobody@example.test", emailVerified: true })), null);
});

test("impersonation needs a reason, permission and a real target", async () => {
  const { auth, logged } = setup();
  const ctx = { user: "staff" } as unknown as PageContext;
  await assert.rejects(auth.impersonate(ctx, "staff", { user: "u1", reason: "" }), /reason/);
  await assert.rejects(auth.impersonate(ctx, "staff", { user: "staff", reason: "ticket 12" }), /yourself/);
  await assert.rejects(auth.impersonate(ctx, "u1", { user: "staff", reason: "ticket 12" }), /not allowed/);
  await assert.rejects(auth.impersonate(ctx, "staff", { user: "ghost", reason: "ticket 12" }), /unknown/);
  assert.equal(logged.length, 0);
  assert.equal(await auth.stopImpersonating(ctx), false);
});

test("SAML assertions are claimed once across instances", async () => {
  const pool = pgliteAsPool(new PGlite());
  const a = pgSamlReplayStore(pool, "loom_saml_replay");
  const b = pgSamlReplayStore(pool, "loom_saml_replay");
  const until = Date.now() + 60_000;
  assert.equal(await a.claim("assertion-1", until), true);
  assert.equal(await b.claim("assertion-1", until), false);
  assert.equal(await b.claim("assertion-2", until), true);
  assert.throws(() => pgSamlReplayStore(pool, "bad name"), KitAuthError);
});
