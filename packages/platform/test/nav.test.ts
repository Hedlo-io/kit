import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMON_SLOTS, defineNavigation, defineSlots, NavError, safeHref } from "../src/index.ts";

type Who = { id: string; tenant: string; admin?: boolean; perms: string[] };

test("navigation: slot links + inherited tenant tweaks + custom links + personal pins", async () => {
  const slots = defineSlots<Who>({ slots: COMMON_SLOTS, can: (v, p) => v.perms.includes(p) });
  slots.contribute({ id: "core.servers", slot: "client.nav", href: "/servers", title: "nav.servers", icon: "server", order: 10 });
  slots.contribute({ id: "core.billing", slot: "client.nav", href: "/billing", title: "nav.billing", order: 20 });
  slots.contribute({ id: "core.admin", slot: "client.nav", href: "/admin", title: "nav.admin", order: 30, permission: "admin" });
  const parents: Record<string, string | null> = { platform: null, reseller: "platform", shop: "reseller" };
  const nav = defineNavigation<Who>({
    slots,
    name: "KitNavTest",
    userId: (v) => v.id,
    tenantOf: (v) => v.tenant,
    parentTenant: (t) => parents[t] ?? null,
    canManage: (v, t) => v.admin === true && v.tenant === t,
  });
  const ann: Who = { id: "ann", tenant: "shop", perms: [] };
  const boss: Who = { id: "boss", tenant: "reseller", admin: true, perms: [] };

  assert.deepEqual((await nav.items(ann, "client.nav")).map((i) => i.id), ["core.servers", "core.billing"]);

  assert.equal(
    await nav.configure(boss, "client.nav", {
      tweaks: [{ id: "core.billing", title: "Invoices", order: 5, icon: "receipt" }, { id: "core.servers", hidden: false }],
      links: [{ id: "custom-status", title: "Status", href: "https://status.example.com", newTab: true, order: 50 }],
    }),
    true,
  );
  const tweaked = await nav.items(ann, "client.nav");
  assert.deepEqual(tweaked.map((i) => [i.id, i.title]), [["core.billing", "Invoices"], ["core.servers", "nav.servers"], ["custom-status", "Status"]]);
  assert.equal(tweaked[2]!.newTab, true);

  assert.equal(await nav.configure(ann, "client.nav", { tweaks: [] }), false, "customers cannot change the site menu");
  await assert.rejects(nav.configure(boss, "client.nav", { links: [{ id: "custom-x", title: "x", href: "javascript:alert(1)" }] }), NavError);
  await assert.rejects(nav.configure(boss, "client.nav", { links: [{ id: "custom-x", title: "x", href: "//evil.example" }] }), NavError);

  assert.equal(await nav.pin(ann, "client.nav", ["custom-status"]), true);
  assert.equal((await nav.items(ann, "client.nav"))[0]!.id, "custom-status");
  assert.equal((await nav.items({ id: "zed", tenant: "shop", perms: [] }, "client.nav"))[0]!.id, "core.billing", "pins are personal");

  assert.equal(await nav.reset(ann, "client.nav", "mine"), true);
  assert.equal((await nav.items(ann, "client.nav"))[0]!.pinned, false);

  assert.equal(safeHref("/a?b=1"), "/a?b=1");
  assert.equal(safeHref("http://x.example"), null);
  assert.equal(safeHref("/\\evil"), null);
});
