import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Model } from "@weft-framework/data";
import { pgliteAsPool, usePostgres } from "@weft-framework/data/postgres";
import { BrandingError, cleanHead, defineBranding, renderHead, sanitizeCss } from "../src/index.ts";

type Who = { id: string; tenant: string; admin?: boolean; code?: boolean };
const parents: Record<string, string | null> = { platform: null, reseller: "platform", shop: "reseller" };

function setup(name: string) {
  return defineBranding<Who>({
    name,
    userId: (v) => v.id,
    parentTenant: (t) => parents[t] ?? null,
    canManage: (v, t) => v.admin === true && v.tenant === t,
    canEditCode: (v) => v.code === true,
    defaults: { productName: "Loom" },
  });
}

async function scenario(b: ReturnType<typeof setup>) {
  const root: Who = { id: "root", tenant: "platform", admin: true, code: true };
  const boss: Who = { id: "boss", tenant: "reseller", admin: true };
  const ann: Who = { id: "ann", tenant: "shop" };

  assert.equal((await b.effective("shop")).productName, "Loom");
  assert.equal(await b.save(root, "platform", { light: { primary: "oklch(0.5 0.2 260)" }, shared: { radius: "0.5rem" }, customCss: ".brand{font-weight:600}" }), true);
  assert.equal(await b.save(boss, "reseller", { productName: "HostCo", logo: "file_123", dark: { primary: "#ff8800" }, mode: "dark" }), true);
  assert.equal(await b.save(ann, "shop", { productName: "x" }), false);

  const e = await b.effective("shop");
  assert.equal(e.productName, "HostCo");
  assert.equal(e.logo, "file_123");
  assert.equal(e.mode, "dark");
  assert.equal(e.light.primary, "oklch(0.5 0.2 260)");
  assert.equal(e.dark.primary, "#ff8800");
  const css = await b.css("shop");
  assert.match(css, /--primary: oklch\(0\.5 0\.2 260\)/);
  assert.match(css, /--primary: #ff8800/);
  assert.match(css, /--radius: 0\.5rem/);
  assert.match(css, /@layer kit-custom/);

  await assert.rejects(b.save(boss, "reseller", { customCss: "a{color:red}" }), /code permission/);
  await assert.rejects(b.save(boss, "reseller", { light: { primary: "red;}body{display:none" } }), BrandingError);
  await assert.rejects(b.save(boss, "reseller", { light: { evil: "#000" } }), /unknown token/);

  const preview = await b.preview(boss, "reseller", { light: { background: "#101010" } });
  assert.match(preview, /--background: #101010/);
  assert.notEqual((await b.effective("reseller")).light.background, "#101010", "preview does not save");

  b.registerPreset({ id: "acme.ocean", title: "Ocean", light: { primary: "#0066cc" }, plugin: "acme" });
  assert.equal(await b.applyPreset(boss, "reseller", "acme.ocean"), true);
  assert.equal((await b.effective("shop")).light.primary, "#0066cc");
  assert.equal(b.removePlugin("acme"), 1);

  const exported = await b.exportTheme("reseller");
  assert.equal(await b.reset(boss, "reseller"), true);
  assert.equal((await b.effective("shop")).productName, "Loom");
  assert.equal(await b.importTheme(boss, "reseller", exported), true);
  assert.equal((await b.effective("shop")).productName, "HostCo");
  await assert.rejects(b.importTheme(boss, "reseller", "{}"), /not a branding export/);
}

test("branding inherits platform → reseller → tenant (memory)", async () => {
  await scenario(setup("KitBrandMem"));
});

test("branding on Postgres", async () => {
  const b = setup("KitBrandPg");
  await usePostgres(pgliteAsPool(new PGlite()), [b.model] as unknown as Model<never>[], { onWarning: () => {} });
  await scenario(b);
});

test("custom CSS and head tags are restricted", () => {
  assert.equal(sanitizeCss("/* hi */ .a { color: red }"), ".a { color: red }");
  for (const bad of ["@import 'x.css';", ".a{background:url(https://x)}", "</style><script>", ".a{", ".a{width:expression(1)}", ".a{content:'\\41'}"]) {
    assert.throws(() => sanitizeCss(bad), BrandingError, bad);
  }
  const tags = cleanHead([
    { tag: "meta", attrs: { name: "description", content: "Game hosting" } },
    { tag: "meta", attrs: { property: "og:title", content: "Host & Co" } },
    { tag: "link", attrs: { rel: "icon", href: "/favicon.png", sizes: "32x32" } },
  ]);
  assert.equal(renderHead(tags), '<meta name="description" content="Game hosting">\n<meta property="og:title" content="Host &amp; Co">\n<link rel="icon" href="/favicon.png" sizes="32x32">');
  assert.throws(() => cleanHead([{ tag: "script", attrs: {} }]), BrandingError);
  assert.throws(() => cleanHead([{ tag: "meta", attrs: { "http-equiv": "refresh", content: "0" } }]), /not allowed/);
  assert.throws(() => cleanHead([{ tag: "link", attrs: { rel: "stylesheet", href: "https://x/a.css" } }]), /rel/);
  assert.throws(() => cleanHead([{ tag: "link", attrs: { rel: "icon", href: "javascript:x" } }]), /href/);
  assert.throws(() => cleanHead([{ tag: "meta", attrs: { name: "description", content: '"><script>' } }]), BrandingError);
});
