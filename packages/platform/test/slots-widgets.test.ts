import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent } from "@weft-framework/runtime";
import { COMMON_SLOTS, defineSlots, defineWidgets, SlotError, WidgetError } from "../src/index.ts";

type Who = { id: string; perms: string[] };
const can = (v: Who, p: string) => v.perms.includes(p);

const Tab = (label: string) =>
  defineComponent(`Tab${label}`, (p: { viewer: Who; server?: string }) => ({
    handlers: {},
    render: () => `<a>${label}:${p.server ?? ""}:${p.viewer.id}</a>`,
  }));

test("slots filter by permission, plugin state and when, sort by order, and isolate failures", () => {
  const disabled = new Set<string>();
  const errors: string[] = [];
  const slots = defineSlots<Who>({
    slots: { ...COMMON_SLOTS, "server.tabs": { kind: "component", max: 3 } },
    can,
    enabled: (p) => !disabled.has(p),
    onError: (_e, at) => errors.push(at.id),
  });
  slots.contribute({ id: "core.console", slot: "server.tabs", order: 10, component: Tab("console") });
  slots.contribute({ id: "core.files", slot: "server.tabs", order: 20, component: Tab("files"), permission: "files.read" });
  slots.contribute({ id: "acme.mods", slot: "server.tabs", order: 15, component: Tab("mods"), plugin: "acme" });
  slots.contribute({
    id: "bad.plugin",
    slot: "server.tabs",
    order: 5,
    component: Tab("bad"),
    plugin: "bad",
    when: () => {
      throw new Error("boom");
    },
  });
  const ann: Who = { id: "ann", perms: ["files.read"] };
  const bob: Who = { id: "bob", perms: [] };
  assert.deepEqual(slots.entries("server.tabs", ann).map((e) => e.id), ["core.console", "acme.mods", "core.files"]);
  assert.deepEqual(slots.entries("server.tabs", bob).map((e) => e.id), ["core.console", "acme.mods"]);
  assert.deepEqual(errors, ["bad.plugin", "bad.plugin"]);
  disabled.add("acme");
  assert.equal(slots.render("server.tabs", ann, { server: "s1" }), "<a>console:s1:ann</a><a>files:s1:ann</a>");
  assert.equal(slots.removePlugin("acme"), 1);
  assert.throws(() => slots.contribute({ id: "core.console", slot: "server.tabs", component: Tab("x") }), SlotError);
  assert.throws(() => slots.contribute({ id: "x", slot: "nope.slot" }), /no slot/);
  assert.throws(() => slots.contribute({ id: "nav", slot: "admin.nav" }), /no href/);
  const off = slots.contribute({ id: "core.home", slot: "admin.nav", href: (p: { base?: string }) => `${p.base ?? ""}/`, title: "nav.home" });
  assert.equal(slots.entries("admin.nav", ann, { base: "/admin" })[0]!.link, "/admin/");
  off();
  assert.equal(slots.entries("admin.nav", ann).length, 0);
});

test("widgets validate sizes and settings and honour permissions and dashboards", () => {
  const widgets = defineWidgets<Who>({ can });
  const Card = defineComponent("Card", () => ({ handlers: {}, render: () => "<div></div>" }));
  widgets.register({
    id: "core.servers",
    title: "widgets.servers",
    sizes: [{ w: 4, h: 2 }, { w: 8, h: 4 }],
    settings: { limit: { type: "number", default: 5, min: 1, max: 50, integer: true }, mode: { type: "string", default: "list", options: ["list", "grid"] } },
    component: Card,
  });
  widgets.register({ id: "core.billing", title: "widgets.billing", sizes: [{ w: 4, h: 2 }], permission: "billing.read", dashboards: ["admin.home"], component: Card });
  assert.throws(() => widgets.register({ id: "Bad Id", title: "", sizes: [{ w: 1, h: 1 }], component: Card }), WidgetError);
  assert.throws(() => widgets.register({ id: "x", title: "", sizes: [{ w: 99, h: 1 }], component: Card }), /sizes/);
  const ann: Who = { id: "ann", perms: ["billing.read"] };
  assert.deepEqual(widgets.available(ann, "admin.home").map((w) => w.id), ["core.billing", "core.servers"]);
  assert.deepEqual(widgets.available(ann, "client.home").map((w) => w.id), ["core.servers"]);
  assert.deepEqual(widgets.available({ id: "bob", perms: [] }, "admin.home").map((w) => w.id), ["core.servers"]);
  const def = widgets.get("core.servers")!;
  assert.deepEqual(widgets.settings(def, { limit: 10, junk: 1 }), { limit: 10, mode: "list" });
  assert.throws(() => widgets.settings(def, { limit: 500 }), /limit/);
  assert.equal(widgets.fits(def, { w: 8, h: 4 }), true);
  assert.equal(widgets.fits(def, { w: 3, h: 3 }), false);
});
