import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Model } from "@weft-framework/data";
import { pgliteAsPool, usePostgres } from "@weft-framework/data/postgres";
import { defineComponent } from "@weft-framework/runtime";
import {
  COMMON_SLOTS,
  compareVersions,
  defineBranding,
  definePluginHost, definePluginRuntime,
  defineSlots,
  defineWidgets,
  keyFingerprint,
  parseVersion,
  PluginError,
  satisfies,
  validateManifest,
  verifyPackage,
  type PluginHost,
  type PluginManifest,
  type SlotRegistry,
  type WidgetRegistry,
  type PluginModule,
} from "../src/index.ts";

type Who = { id: string; root?: boolean };
const root: Who = { id: "root", root: true };
const ann: Who = { id: "ann" };

test("semver ranges", () => {
  const cases: [string, string, boolean][] = [
    ["1.2.3", "^1.0.0", true],
    ["2.0.0", "^1.0.0", false],
    ["0.2.5", "^0.2.1", true],
    ["0.3.0", "^0.2.1", false],
    ["0.0.4", "^0.0.4", true],
    ["0.0.5", "^0.0.4", false],
    ["1.4.9", "~1.4.2", true],
    ["1.5.0", "~1.4.2", false],
    ["1.2.3", ">=1.2.0 <2", true],
    ["3.0.0", "1.x || >=2.5", true],
    ["2.1.0", "1.x || >=2.5", false],
    ["1.5.0", "1.0.0 - 2.0.0", true],
    ["2.0.0-beta.1", "^1.0.0", false],
    ["2.0.0-beta.2", ">=2.0.0-beta.1", true],
    ["1.0.0", "*", true],
    ["1.2.0", ">1.1", true],
    ["1.1.9", ">1.1", false],
    ["1.1.9", "<=1.1", true],
  ];
  for (const [v, r, want] of cases) assert.equal(satisfies(v, r), want, `${v} ${r}`);
  assert.equal(compareVersions(parseVersion("1.0.0-alpha")!, parseVersion("1.0.0")!), -1);
  assert.equal(compareVersions(parseVersion("1.0.0-alpha.2")!, parseVersion("1.0.0-alpha.10")!), -1);
  assert.equal(satisfies("1.0.0", "not a range"), false);
});

test("manifest validation", () => {
  const ok = { id: "acme.stats", name: "Stats", version: "1.0.0", engines: { loom: "^1.0.0" }, capabilities: ["widgets"], entry: "./index.js" };
  assert.equal(validateManifest(ok).id, "acme.stats");
  const bad: Record<string, unknown>[] = [
    { ...ok, id: "Stats" },
    { ...ok, version: "1.0" },
    { ...ok, engines: { loom: "nope!" } },
    { ...ok, capabilities: ["root"] },
    { ...ok, entry: "../../etc/passwd.js" },
    { ...ok, entry: "/abs.js" },
    { ...ok, homepage: "http://x" },
    { ...ok, requires: { "acme.stats": "^1" } },
    { ...ok, models: ["AcmeStatsRow"] },
    { ...ok, capabilities: ["db"], models: ["OtherRow"] },
    { ...ok, permissions: [{ id: "other.read" }] },
    { ...ok, settings: { limit: { type: "number", default: "x" } } },
  ];
  for (const b of bad) assert.throws(() => validateManifest(b), PluginError, JSON.stringify(b));
});

test("Ed25519 package signatures", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519").publicKey;
  const bytes = new TextEncoder().encode("package contents");
  const sig = sign(null, createHash("sha256").update(bytes).digest(), privateKey).toString("base64");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
  assert.equal(verifyPackage(bytes, sig, [other, raw]), keyFingerprint(publicKey));
  assert.equal(verifyPackage(bytes, sig, [publicKey.export({ format: "pem", type: "spki" }) as string]), keyFingerprint(publicKey));
  assert.equal(verifyPackage(new TextEncoder().encode("tampered"), sig, [publicKey]), null);
  assert.equal(verifyPackage(bytes, sig, [other]), null);
  assert.equal(verifyPackage(bytes, "garbage", [publicKey]), null);
});

function world(name: string, modules: Record<string, PluginModule<Who>>, keys: string[] = []) {
  const slots: SlotRegistry<Who> = defineSlots<Who>({ slots: COMMON_SLOTS, can: () => true, enabled: (p): boolean => host.enabled(p) });
  const widgets: WidgetRegistry<Who> = defineWidgets<Who>({ can: () => true, enabled: (p): boolean => host.enabled(p) });
  const branding = defineBranding<Who>({ name: `${name}Brand`, userId: (v) => v.id, parentTenant: () => null, canManage: () => true });
  const attached: string[] = [];
  const host: PluginHost<Who> = definePluginHost<Who>({
    name,
    host: { name: "loom", version: "1.2.0" },
    slots,
    widgets,
    branding,
    load: async (m) => {
      const mod = modules[m.id];
      if (!mod) throw new Error(`no module for ${m.id}`);
      return mod;
    },
    attachModels: async (models) => {
      for (const m of models) attached.push(m.name);
    },
    canManage: (v) => v.root === true,
    userId: (v) => v.id,
    trustedKeys: keys,
    requireSignature: keys.length > 0,
  });
  return { host, slots, widgets, branding, attached };
}

const Card = defineComponent("TestCard", () => ({ handlers: {}, render: () => "<div>card</div>" }));
const manifest = (id: string, extra: Partial<PluginManifest> = {}): PluginManifest => ({
  id,
  name: id,
  version: "1.0.0",
  engines: { loom: "^1.0.0" },
  capabilities: ["slots", "widgets", "themes", "db"],
  entry: "./index.js",
  ...extra,
});

async function lifecycle(name: string, pg: boolean) {
  const log: string[] = [];
  const modules: Record<string, PluginModule<Who>> = {
    "acme.core": {
      activate(api) {
        api.contribute({ id: "acme.core.nav", slot: "admin.nav", title: "Acme", href: "/acme" });
        api.registerWidget({ id: "acme.core.stats", title: "Stats", sizes: [{ w: 4, h: 2 }], component: Card });
        api.registerPreset({ id: "acme.core.ocean", title: "Ocean", light: { primary: "#0066cc" } });
        api.defineModel<{ id: string }>("AcmeCoreThing", { fields: { id: "string" }, read: () => true, write: () => true });
        api.onDisable(() => {
          log.push("core off");
        });
      },
    },
    "acme.extra": {
      async activate(api) {
        log.push(`extra on limit=${(await api.settings()).limit}`);
        api.contribute({ id: "acme.extra.nav", slot: "admin.nav", title: "Extra", href: "/extra" });
      },
    },
    "acme.bad": {
      activate(api) {
        api.contribute({ id: "acme.bad.nav", slot: "admin.nav", title: "Bad", href: "/bad" });
        api.contribute({ id: "steal.nav", slot: "admin.nav", title: "Steal", href: "/x" });
      },
    },
  };
  const w = world(name, modules);
  if (pg) await usePostgres(pgliteAsPool(new PGlite()), [w.host.model, w.branding.model] as unknown as Model<never>[], { onWarning: () => {} });
  await w.host.boot();
  const { host, slots, widgets, branding } = w;

  await assert.rejects(host.install(ann, manifest("acme.core")), /administrators/);
  await host.install(root, manifest("acme.core", { models: ["AcmeCoreThing"] }));
  await assert.rejects(host.install(root, manifest("acme.core")), /installed/);
  await assert.rejects(host.install(root, manifest("acme.old", { engines: { loom: "^2.0.0" } })), /needs loom/);
  await assert.rejects(host.install(root, manifest("acme.other", { engines: { bolt: "^1.0.0" } })), /does not support loom/);
  await assert.rejects(host.install(root, manifest("acme.lonely", { requires: { "acme.none": "^1.0.0" } })), /install it first/);

  const extra = manifest("acme.extra", { requires: { "acme.core": "^1.0.0" }, settings: { limit: { type: "number", default: 5, min: 1, max: 10 } } });
  await host.install(root, extra);
  await assert.rejects(host.enable(root, "acme.extra"), /acme.core enabled/);

  assert.equal(await host.enable(root, "acme.core"), true);
  assert.deepEqual(w.attached, ["AcmeCoreThing"]);
  await host.configure(root, "acme.extra", { limit: 7 });
  await assert.rejects(host.configure(root, "acme.extra", { limit: 99 }), PluginError);
  await assert.rejects(host.configure(root, "acme.extra", { nope: 1 }), /no setting/);
  assert.equal(await host.enable(root, "acme.extra"), true);
  assert.deepEqual(log, ["extra on limit=7"]);

  assert.deepEqual(slots.entries("admin.nav", root, {}).map((e) => e.id), ["acme.core.nav", "acme.extra.nav"]);
  assert.ok(widgets.get("acme.core.stats"));
  assert.equal(branding.presets().length, 1);

  await assert.rejects(host.disable(root, "acme.core"), /acme.extra first/);
  await host.disable(root, "acme.extra");
  await host.disable(root, "acme.core");
  assert.deepEqual(log, ["extra on limit=7", "core off"]);
  assert.deepEqual(slots.entries("admin.nav", root, {}), []);
  assert.equal(widgets.get("acme.core.stats"), undefined);
  assert.equal(branding.presets().length, 0);

  await host.enable(root, "acme.core");
  await host.enable(root, "acme.extra");
  await assert.rejects(host.update(root, { ...manifest("acme.core"), version: "1.0.0" }), /not newer/);
  await assert.rejects(host.update(root, { ...manifest("acme.core"), version: "2.0.0" }), /acme.extra needs acme.core/);
  await host.update(root, { ...manifest("acme.core", { models: ["AcmeCoreThing"] }), version: "1.1.0" });
  assert.equal(host.enabled("acme.core"), true);
  assert.equal(host.list().find((r) => r.id === "acme.core")!.version, "1.1.0");

  await host.install(root, manifest("acme.bad"));
  await assert.rejects(host.enable(root, "acme.bad"), /must start with/);
  assert.equal(host.enabled("acme.bad"), false);
  assert.match(host.list().find((r) => r.id === "acme.bad")!.error ?? "", /must start with/);
  assert.ok(!slots.entries("admin.nav", root, {}).some((e) => e.id.startsWith("acme.bad")));

  await assert.rejects(host.uninstall(root, "acme.core"), /disable acme.core first/);
  await host.disable(root, "acme.extra");
  await host.disable(root, "acme.core");
  await assert.rejects(host.uninstall(root, "acme.core"), /uninstall acme.extra first/);

  const again = world(name, modules);
  Object.defineProperty(again.host, "model", { value: host.model });
  await host.enable(root, "acme.core");
  await again.host.boot();
  assert.equal(again.host.enabled("acme.core"), true);
  assert.equal(again.host.enabled("acme.extra"), false);
  assert.deepEqual(again.slots.entries("admin.nav", root, {}).map((e) => e.id), ["acme.core.nav"]);

  assert.equal(await host.uninstall(root, "acme.extra"), true);
  await host.disable(root, "acme.core");
  assert.equal(await host.uninstall(root, "acme.core"), true);
}

test("plugin lifecycle: install, deps, enable, settings, disable, update, uninstall, boot (memory)", async () => {
  await lifecycle("KitPlugMem", false);
});

test("plugin lifecycle on Postgres", async () => {
  await lifecycle("KitPlugPg", true);
});

test("signed install with trusted keys", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ format: "pem", type: "spki" }) as string;
  const { host } = world("KitPlugSig", { "acme.core": { activate() {} } }, [pem]);
  await host.boot();
  const bytes = new TextEncoder().encode(JSON.stringify(manifest("acme.core")));
  const sig = sign(null, createHash("sha256").update(bytes).digest(), privateKey).toString("base64");
  await assert.rejects(host.install(root, manifest("acme.core")), /signed package is required/);
  await assert.rejects(host.install(root, manifest("acme.core"), { bytes: new TextEncoder().encode("x"), signature: sig }), /does not match/);
  const row = await host.install(root, manifest("acme.core"), { bytes, signature: sig });
  assert.equal(row.signer, keyFingerprint(publicKey));
});

test("routes, pages, jobs, events and translations go through host registrars with capability and namespace checks", async () => {
  const seen: string[] = [];
  const reg = (kind: string) => (plugin: string, x: { path?: string; name?: string; event?: string }) => {
    const key = `${kind}:${plugin}:${x.path ?? x.name ?? x.event}`;
    seen.push(key);
    return () => {
      seen.splice(seen.indexOf(key), 1);
    };
  };
  const slots: SlotRegistry<Who> = defineSlots<Who>({ slots: COMMON_SLOTS, can: () => true });
  const widgets: WidgetRegistry<Who> = defineWidgets<Who>({ can: () => true });
  let attempt: (api: Parameters<PluginModule<Who>["activate"]>[0]) => void = () => {};
  const host = definePluginHost<Who>({
    name: "KitPlugReg",
    host: { name: "loom", version: "1.2.0" },
    slots,
    widgets,
    load: async () => ({ activate: (api) => attempt(api) }),
    canManage: (v) => v.root === true,
    userId: (v) => v.id,
    requireSignature: false,
    readFile: async (_m, path) => (path === "./de.json" ? JSON.stringify({ "acme.web.hello": "Hallo" }) : "{}"),
    registrars: {
      route: reg("route"),
      page: reg("page"),
      job: reg("job"),
      on: reg("on"),
      translations: (plugin, locale, cat) => reg("i18n")(plugin, { name: `${locale}:${Object.keys(cat).join(",")}` }),
    },
  });
  await host.boot();
  await host.install(root, manifest("acme.web", { capabilities: ["pages", "jobs", "webhooks", "i18n"], translations: { de: "./de.json" } }));
  attempt = (api) => {
    api.route({ method: "GET", path: "/api/plugins/acme.web/ping", handler: () => new Response("pong") });
    api.page({ path: "/plugins/acme.web", title: "Web", app: "admin", component: Card as never });
    api.job({ name: "acme.web.sync", cron: "*/5 * * * *", run: () => {} });
    api.on("server.created", () => {});
  };
  await host.enable(root, "acme.web");
  assert.deepEqual(seen.sort(), ["i18n:acme.web:de:acme.web.hello", "job:acme.web:acme.web.sync", "on:acme.web:server.created", "page:acme.web:/plugins/acme.web", "route:acme.web:/api/plugins/acme.web/ping"]);
  await host.disable(root, "acme.web");
  assert.deepEqual(seen, []);

  const bad: [string, (api: Parameters<PluginModule<Who>["activate"]>[0]) => void, RegExp][] = [
    ["route outside", (api) => api.route({ method: "GET", path: "/api/admin/users", handler: () => new Response() }), /start with \/api\/plugins/],
    ["route traversal", (api) => api.route({ method: "GET", path: "/api/plugins/acme.web/../x", handler: () => new Response() }), /start with/],
    ["page other", (api) => api.page({ path: "/plugins/acme.other", title: "x", app: "client", component: Card as never }), /start with/],
    ["job name", (api) => api.job({ name: "core.billing", run: () => {} }), /must start with/],
    ["job cron", (api) => api.job({ name: "acme.web.x", cron: "rm -rf", run: () => {} }), /cron/],
    ["contribute without cap", (api) => api.contribute({ id: "acme.web.nav", slot: "admin.nav", href: "/x" }), /`slots` capability/],
  ];
  for (const [label, fn, re] of bad) {
    attempt = fn;
    await assert.rejects(host.enable(root, "acme.web"), re, label);
    assert.deepEqual(seen, [], label);
  }
});

test("extensions go through the host registrar with the extensions capability; the runtime routes, pages, jobs and events", async () => {
  const added: string[] = [];
  const rt = definePluginRuntime<Who>({
    name: "KitExt",
    can: (v, p) => v.root === true || p === "open",
    extension: (plugin, kind, value) => {
      const key = `${plugin}:${kind}:${(value as { id: string }).id}`;
      added.push(key);
      return () => added.splice(added.indexOf(key), 1);
    },
    onError: () => {},
    now: () => Date.UTC(2026, 0, 1, 0, 0),
  });
  const slots: SlotRegistry<Who> = defineSlots<Who>({ slots: COMMON_SLOTS, can: () => true });
  const widgets: WidgetRegistry<Who> = defineWidgets<Who>({ can: () => true });
  let attempt: (api: Parameters<PluginModule<Who>["activate"]>[0]) => void = () => {};
  const host = definePluginHost<Who>({
    name: "KitPlugExt",
    host: { name: "loom", version: "1.2.0" },
    slots,
    widgets,
    load: async () => ({ activate: (api) => attempt(api) }),
    canManage: (v) => v.root === true,
    userId: (v) => v.id,
    requireSignature: false,
    registrars: rt.registrars,
  });
  await host.boot();
  await host.install(root, manifest("acme.pay", { capabilities: ["extensions", "pages", "jobs", "webhooks"] }));
  const got: unknown[] = [];
  let ran = 0;
  attempt = (api) => {
    api.extend("gateway", { id: "acme_pay", name: "Acme Pay" });
    api.route({ method: "POST", path: "/api/plugins/acme.pay/hook/:ref", permission: "open", handler: (_r, c) => Response.json({ ref: c.params.ref, plugin: c.plugin }) });
    api.page({ path: "/plugins/acme.pay/:id", title: "Pay", app: "admin", component: Card as never });
    api.job({ name: "acme.pay.sync", cron: "*/5 * * * *", run: () => void ran++ });
    api.on("invoice.paid", (p) => void got.push(p));
  };
  await host.enable(root, "acme.pay");
  assert.deepEqual(added, ["acme.pay:gateway:acme_pay"]);
  const res = await rt.dispatch(new Request("https://x.test/api/plugins/acme.pay/hook/r%201", { method: "POST" }), { id: "u" } as Who);
  assert.deepEqual(await res.json(), { ref: "r 1", plugin: "acme.pay" });
  assert.equal((await rt.dispatch(new Request("https://x.test/api/plugins/acme.pay/hook/x"), null)).status, 405);
  assert.equal(rt.page("admin", "/plugins/acme.pay/42")?.params.id, "42");
  assert.equal(rt.page("client", "/plugins/acme.pay/42"), null);
  rt.publish("invoice.paid", { invoice: "i1" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(got, [{ invoice: "i1" }]);
  assert.equal(rt.jobs()[0]?.next, Date.UTC(2026, 0, 1, 0, 5));
  await host.disable(root, "acme.pay");
  assert.deepEqual(added, []);
  assert.equal(rt.page("admin", "/plugins/acme.pay/42"), null);
  assert.equal(ran, 0);

  await host.install(root, manifest("acme.nocap", { capabilities: ["pages"] }));
  attempt = (api) => api.extend("gateway", { id: "acme_nocap", name: "x" });
  await assert.rejects(host.enable(root, "acme.nocap"), /`extensions` capability/);
  assert.deepEqual(added, []);
});
