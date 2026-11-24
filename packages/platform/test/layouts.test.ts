import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { defineComponent } from "@weft-framework/runtime";
import type { Model } from "@weft-framework/data";
import { pgliteAsPool, usePostgres } from "@weft-framework/data/postgres";
import { defineLayouts, defineWidgets, LayoutError } from "../src/index.ts";

type Who = { id: string; tenant: string; roles: string[]; admin?: boolean; perms?: string[] };

const parents: Record<string, string | null> = { platform: null, reseller: "platform", shop: "reseller" };

function setup(name: string) {
  const widgets = defineWidgets<Who>({ can: (v, p) => (v.perms ?? []).includes(p) });
  const Card = defineComponent(`Card${name}`, () => ({ handlers: {}, render: () => "" }));
  widgets.register({ id: "core.servers", title: "s", sizes: [{ w: 4, h: 2 }, { w: 6, h: 3 }], settings: { limit: { type: "number", default: 5, min: 1, max: 20 } }, component: Card });
  widgets.register({ id: "core.billing", title: "b", sizes: [{ w: 4, h: 2 }], permission: "billing.read", component: Card });
  const layouts = defineLayouts<Who>({
    name,
    widgets,
    dashboards: [{ id: "client.home", defaults: [{ i: "a", widget: "core.servers", x: 0, y: 0, w: 4, h: 2 }] }],
    userId: (v) => v.id,
    tenantOf: (v) => v.tenant,
    rolesOf: (v) => v.roles,
    parentTenant: (t) => parents[t] ?? null,
    canManage: (v, t) => v.admin === true && v.tenant === t,
  });
  return { widgets, layouts };
}

async function scenario(layouts: ReturnType<typeof setup>["layouts"]) {
  const ann: Who = { id: "ann", tenant: "shop", roles: ["customer"] };
  const boss: Who = { id: "boss", tenant: "reseller", roles: ["owner"], admin: true };
  const shopAdmin: Who = { id: "sa", tenant: "shop", roles: ["owner"], admin: true };

  const first = await layouts.resolve(ann, "client.home");
  assert.equal(first.source.scope, "default");
  assert.deepEqual(first.items.map((i) => i.i), ["a"]);
  assert.deepEqual(first.items[0]!.settings, { limit: 5 });

  assert.equal(await layouts.save(boss, "client.home", [{ i: "r", widget: "core.servers", x: 0, y: 0, w: 6, h: 3 }], { scope: "tenant" }), true);
  const fromReseller = await layouts.resolve(ann, "client.home");
  assert.deepEqual(fromReseller.source, { scope: "tenant", tenant: "reseller", owner: null });

  assert.equal(await layouts.save(shopAdmin, "client.home", [{ i: "c", widget: "core.servers", x: 2, y: 0, w: 4, h: 2 }], { scope: "role", role: "customer" }), true);
  assert.equal((await layouts.resolve(ann, "client.home")).source.scope, "role");

  assert.equal(await layouts.save(ann, "client.home", [{ i: "mine", widget: "core.servers", x: 0, y: 0, w: 4, h: 2, settings: { limit: 9 } }]), true);
  const mine = await layouts.resolve(ann, "client.home");
  assert.equal(mine.source.scope, "user");
  assert.deepEqual(mine.items[0]!.settings, { limit: 9 });

  assert.equal(await layouts.save(ann, "client.home", [], { scope: "tenant" }), false, "a customer cannot set the tenant default");
  await assert.rejects(layouts.save(ann, "client.home", [{ i: "x", widget: "core.billing", x: 0, y: 0, w: 4, h: 2 }]), LayoutError);
  await assert.rejects(
    layouts.save(ann, "client.home", [
      { i: "x", widget: "core.servers", x: 0, y: 0, w: 4, h: 2 },
      { i: "y", widget: "core.servers", x: 2, y: 1, w: 4, h: 2 },
    ]),
    /overlaps/,
  );
  await assert.rejects(layouts.save(ann, "client.home", [{ i: "x", widget: "core.servers", x: 10, y: 0, w: 4, h: 2 }]), /outside the grid/);

  assert.equal(await layouts.reset(ann, "client.home"), true);
  assert.equal((await layouts.resolve(ann, "client.home")).source.scope, "role");
  const other: Who = { id: "zed", tenant: "shop", roles: [] };
  assert.equal((await layouts.resolve(other, "client.home")).source.tenant, "reseller");
}

test("layouts resolve user → role → tenant → parent tenants → default (memory)", async () => {
  await scenario(setup("KitLayoutMem").layouts);
});

test("layouts on Postgres", async () => {
  const { layouts } = setup("KitLayoutPg");
  await usePostgres(pgliteAsPool(new PGlite()), [layouts.model] as unknown as Model<never>[], { onWarning: () => {} });
  await scenario(layouts);
});
