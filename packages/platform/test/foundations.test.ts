import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { defineModel, type Model } from "@weft-framework/data";
import { pgliteAsPool, usePostgres } from "@weft-framework/data/postgres";
import {
  bootstrapPlatform,
  chatHookUrl,
  chatPayload,
  defineActivity,
  defineGdpr,
  defineKitAccess,
  kitGuards,
  sendChat,
  SYSTEM_USER,
  verifyChain,
  type Viewer,
} from "../src/index.ts";

async function setup(pg: boolean, prefix: string) {
  const access = defineKitAccess({
    prefix,
    scopes: { server: { parent: "customer", label: "Server" } },
    permissions: { "servers.read": "See servers", "servers.control": "Start and stop servers" },
    roles: { subuser: { scope: "server", permissions: ["servers.read"] } },
    extend: { customer_owner: ["servers.read", "servers.control"], admin: ["servers.read", "servers.control"] },
  });
  const users = defineModel<{ id: string; name: string }>(`${prefix}User`, { fields: { id: "string", name: "string" }, read: () => true, write: () => true });
  const notes = defineModel<{ id: string; owner: string; text: string }>(`${prefix}Note`, { fields: { id: "string", owner: "string", text: "string" }, attrs: { owner: { ref: `${prefix}User` } }, read: () => true, write: () => true });
  let guards!: ReturnType<typeof kitGuards>;
  const activity = defineActivity<Viewer>({ name: `${prefix}Activity`, parentTenant: (s) => guards.parentTenant(s), canRead: (v, s) => guards.can(v, "audit.read", s) });
  const gdpr = defineGdpr<Viewer>({ name: `${prefix}Gdpr`, models: () => [users, notes], subject: users, userId: (v) => guards.userId(v), canHandle: (v, s) => guards.can(v, "gdpr.manage", s), activity });
  const models = [...Object.values(access.models), users, notes, activity.model, gdpr.model] as unknown as Model<never>[];
  if (pg) await usePostgres(pgliteAsPool(new PGlite()), models, { onWarning: () => {} });
  const { platform } = await bootstrapPlatform(access, { name: "Platform", owner: "olga" });
  await bootstrapPlatform(access, { name: "Platform", owner: "olga" });
  guards = kitGuards(access, platform);
  const reseller = await access.createScope(SYSTEM_USER, { type: "reseller", parent: platform, name: "HostCo" });
  const customer = await access.createScope(SYSTEM_USER, { type: "customer", parent: reseller.id, name: "Ann's shop" });
  const server = await access.createScope(SYSTEM_USER, { type: "server", parent: customer.id, name: "mc-1" });
  await access.assign(SYSTEM_USER, { user: "adam", role: "admin", scope: platform });
  await access.assign(SYSTEM_USER, { user: "sue", role: "support", scope: platform });
  await access.assign(SYSTEM_USER, { user: "rita", role: "reseller_owner", scope: reseller.id });
  await access.assign(SYSTEM_USER, { user: "ann", role: "customer_owner", scope: customer.id });
  await access.assign(SYSTEM_USER, { user: "sam", role: "subuser", scope: server.id });
  await users.as({} as never).create({ id: "ann", name: "Ann" });
  await users.as({} as never).create({ id: "bob", name: "Bob" });
  await notes.as({} as never).create({ id: "n1", owner: "ann", text: "hello" });
  await notes.as({} as never).create({ id: "n2", owner: "bob", text: "other" });
  return { access, guards, activity, gdpr, notes, platform, reseller: reseller.id, customer: customer.id, server: server.id };
}

async function scenario(pg: boolean, prefix: string) {
  const w = await setup(pg, prefix);
  const { guards: g } = w;
  const v = (id: string, scope: string, impersonator?: string): Viewer => ({ id, scope, impersonator: impersonator ?? null });

  assert.equal(g.parentTenant(w.server), w.customer);
  assert.equal(g.parentTenant(w.customer), w.reseller);
  assert.equal(g.parentTenant(w.reseller), w.platform);
  assert.equal(g.parentTenant(w.platform), null);
  assert.equal(g.scopeType(w.server), "server");
  assert.equal(g.isStaff("adam"), true);
  assert.equal(g.isStaff("sue"), true);
  assert.equal(g.isStaff("rita"), false);
  assert.equal(g.can(v("ann", w.customer), "servers.control", w.server), true);
  assert.equal(g.can(v("sam", w.server), "servers.control"), false);
  assert.equal(g.can(v("sam", w.server), "servers.read"), true);
  assert.equal(g.can(v("rita", w.reseller), "branding.manage", w.customer), true, "reseller manages customers below it");
  assert.equal(g.can(v("rita", w.reseller), "branding.code", w.reseller), false);
  assert.equal(g.can(v("rita", w.reseller), "branding.manage", w.platform), false, "not upwards");
  assert.equal(g.canManage("branding.manage")(v("adam", w.platform), w.platform), true);
  assert.equal(g.canManage("branding.manage")(v("adam", w.platform, "olga"), w.platform), false, "impersonated sessions do not manage");
  assert.equal(g.can(v(SYSTEM_USER, w.platform), "branding.manage"), false);
  assert.deepEqual(g.rolesOf(v("ann", w.server)), ["customer_owner"]);
  assert.equal(g.canImpersonate(v("sue", w.platform), "ann"), true);
  assert.equal(g.canImpersonate(v("sue", w.platform), "adam"), false, "support cannot become staff");
  assert.equal(g.canImpersonate(v("olga", w.platform), "adam"), true, "owner can");
  assert.equal(g.canImpersonate(v("rita", w.reseller), "ann"), false);
  assert.equal(g.canImpersonate(v("sue", w.platform, "x"), "ann"), false, "no nested impersonation");
  assert.throws(() => defineKitAccess({ roles: { owner: { scope: "platform" } } as never }), /defined by kit/);

  const a = w.activity;
  await Promise.all([
    a.log({ scope: w.server, actor: "ann", action: "server.started", target: w.server, meta: { password: "hunter2", plan: "pro" } }),
    a.log({ scope: w.customer, actor: "sue", impersonator: "sue", action: "auth.impersonated", target: "ann" }),
    a.log({ scope: w.reseller, actor: "rita", action: "branding.saved" }),
    a.log({ scope: w.platform, actor: "adam", action: "plugins.enabled", target: "acme.stats" }),
  ]);
  await assert.rejects(a.log({ scope: w.server, actor: "ann", action: "Bad Action" }), /action/);
  const forAnn = await a.list(v("ann", w.customer), w.customer);
  assert.deepEqual(forAnn.map((r) => r.action), ["auth.impersonated", "server.started"]);
  assert.equal(forAnn[1]!.meta.password, "[redacted]");
  assert.equal(forAnn[1]!.meta.plan, "pro");
  assert.equal((await a.list(v("rita", w.reseller), w.reseller)).length, 3);
  assert.equal((await a.list(v("adam", w.platform), w.platform)).length, 4);
  assert.equal((await a.list(v("adam", w.platform), w.platform, { action: "server." })).length, 1);
  await assert.rejects(a.list(v("sam", w.server), w.server), /not allowed/);
  await assert.rejects(a.list(v("ann", w.customer), w.reseller), /not allowed/);
  assert.deepEqual(await a.verify(), { ok: true, checked: 4, brokenAt: null });
  const all = (await a.list(v("adam", w.platform), w.platform)).reverse();
  assert.equal(verifyChain(all).ok, true);
  assert.equal(verifyChain(all.map((r) => (r.seq === 3 ? { ...r, target: "tampered" } : r))).brokenAt, 3);
  assert.equal(verifyChain(all.filter((r) => r.seq !== 2)).brokenAt, 3);
  assert.equal(await a.model.as({ kit: "activity" } as never).update((r) => r.seq === 1, { target: "x" }), 0, "append-only for everyone else");

  const ann = v("ann", w.customer);
  const ex = await w.gdpr.request(ann, "export", w.customer);
  assert.equal(ex.status, "done");
  const dump = JSON.parse(await w.gdpr.download(ann, ex.id));
  assert.equal(dump.rows[`${prefix}Note`].length, 1);
  await assert.rejects(w.gdpr.download(v("sam", w.server), ex.id), /not allowed/);
  const er = await w.gdpr.request(ann, "erase", w.customer);
  assert.equal(er.status, "pending");
  assert.equal((await w.gdpr.request(ann, "erase", w.customer)).id, er.id, "one open request at a time");
  await assert.rejects(w.gdpr.decide(v("rita", w.reseller), er.id, true), /not allowed/);
  assert.equal((await w.gdpr.queue(v("adam", w.platform), w.platform)).length, 1);
  const done = await w.gdpr.decide(v("adam", w.platform), er.id, true, "verified by email");
  assert.equal(done.status, "done");
  assert.deepEqual((await w.notes.as({} as never).all()).map((n) => n.id), ["n2"]);
  assert.ok((await a.list(v("adam", w.platform), w.platform, { action: "gdpr." })).some((r) => r.action === "gdpr.erase.done"));
}

test("kit access conventions, activity log and GDPR requests (memory)", async () => {
  await scenario(false, "KitFMem");
});

test("kit access conventions, activity log and GDPR requests (Postgres)", async () => {
  await scenario(true, "KitFPg");
});

test("Discord and Slack webhooks", async () => {
  assert.equal(chatHookUrl("discord", "https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz"), "https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz");
  for (const bad of ["http://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz", "https://discord.com.evil.io/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz", "https://169.254.169.254/latest", "https://u:p@discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz"]) {
    assert.throws(() => chatHookUrl("discord", bad), /webhook URL/, bad);
  }
  assert.throws(() => chatHookUrl("slack", "https://hooks.slack.com/other"), /Slack/);
  const d = chatPayload("discord", { title: "Hi @everyone", body: "<@123> ping", level: "critical" }) as { allowed_mentions: unknown; embeds: { title: string; color: number }[] };
  assert.deepEqual(d.allowed_mentions, { parse: [] });
  assert.equal(d.embeds[0]!.title, "Hi @​everyone");
  const s = chatPayload("slack", { title: "<!channel> x & y", url: "https://a.example/" }) as { text: string };
  assert.equal(s.text, "&lt;\u200b!channel&gt; x &amp; y");
  const sent: string[] = [];
  await sendChat("slack", "https://hooks.slack.com/services/T0000AAA/B0000BBB/abcdefghijklmnop", { title: "Backup done" }, { send: async (url, body) => (sent.push(url + body), { status: 200 }) });
  assert.equal(sent.length, 1);
  await assert.rejects(sendChat("slack", "https://hooks.slack.com/services/T0000AAA/B0000BBB/abcdefghijklmnop", { title: "x" }, { send: async () => ({ status: 404 }) }), /404/);
});
