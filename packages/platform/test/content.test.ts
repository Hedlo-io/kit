import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Model } from "@weft-framework/data";
import { pgliteAsPool, usePostgres } from "@weft-framework/data/postgres";
import { defineI18n } from "@weft-framework/i18n";
import {
  checkTemplate,
  COMMON_BLOCKS,
  defineBranding,
  defineContent,
  defineEmails,
  defineTranslations,
  renderMarkdown,
  renderTemplate,
  TemplateError,
  templateVariables,
} from "../src/index.ts";

type Who = { id: string; tenant: string; admin?: boolean; perms?: string[] };
const parents: Record<string, string | null> = { platform: null, reseller: "platform", shop: "reseller" };
const root: Who = { id: "root", tenant: "platform", admin: true };
const boss: Who = { id: "boss", tenant: "reseller", admin: true };
const ann: Who = { id: "ann", tenant: "shop", perms: ["billing.read"] };
const common = {
  userId: (v: Who) => v.id,
  parentTenant: (t: string) => parents[t] ?? null,
  canManage: (v: Who, t: string) => v.admin === true && v.tenant === t,
};

test("markdown is escaped and links are filtered", () => {
  assert.equal(renderMarkdown("# Hi <b>\n\nA **bold** [x](https://a.example/) and [y](javascript:alert(1))"), '<h2>Hi &lt;b&gt;</h2>\n<p>A <strong>bold</strong> <a href="https://a.example/" rel="noopener noreferrer nofollow" target="_blank">x</a> and [y](javascript:alert(1))</p>');
  assert.equal(renderMarkdown("- a\n- b\n\n1. c"), "<ul><li>a</li><li>b</li></ul>\n<ol><li>c</li></ol>");
  assert.equal(renderMarkdown("![Panel](/api/media/a-1?v=2)"), '<p><img src="/api/media/a-1?v=2" alt="Panel" loading="lazy" decoding="async"></p>');
  assert.equal(renderMarkdown("![x](//evil.example/a.png)"), "<p>![x](//evil.example/a.png)</p>");
  assert.ok(!renderMarkdown("![x](https://track.example/p.gif)").includes("<img"));
  assert.equal(renderMarkdown("<script>x</script>"), "<p>&lt;script&gt;x&lt;/script&gt;</p>");
});

test("templates: variables, conditionals and injection", () => {
  const vars = { name: { kind: "string" as const }, url: { kind: "url" as const }, paid: { kind: "boolean" as const } };
  assert.deepEqual([...templateVariables("Hi {{name}}{{#if paid}}!{{else}}?{{/if}}")].sort(), ["name", "paid"]);
  assert.equal(checkTemplate("{{nope}}", vars), "unknown variable `nope`");
  assert.match(checkTemplate("{{#if paid}}x", vars)!, /not closed/);
  assert.throws(() => templateVariables("{{ bad tag }}"), TemplateError);
  const r = renderTemplate("Hi **{{name}}**\n\n[Open]({{url}}){{#unless paid}} unpaid{{/unless}}", { name: "<i>[x](https://evil)</i>", url: "https://ok.example/r?a=1&b=2", paid: false }, vars);
  assert.equal(r.html, '<p>Hi <strong>&lt;i&gt;[x](https://evil)&lt;/i&gt;</strong></p>\n<p><a href="https://ok.example/r?a=1&amp;b=2" rel="noopener noreferrer nofollow" target="_blank">Open</a> unpaid</p>');
  const bad = renderTemplate("[Open]({{url}})", { url: "javascript:alert(1)" }, vars);
  assert.match(bad.html, /<a href="" /);
  assert.match(r.text, /Open \(https:\/\/ok\.example/);
});

const catalog = { auth: { hello: "Hello {name}", bye: "Bye" }, nav: { servers: "Servers" } };

function world(prefix: string) {
  const i18n = defineI18n({ locales: ["en", "de"], defaultLocale: "en", messages: catalog, catalogs: { de: { auth: { hello: "Hallo {name}" } } }, onMissing: () => {} });
  const translations = defineTranslations<Who>({ ...common, name: `${prefix}Translation`, i18n: i18n as never, base: catalog });
  const branding = defineBranding<Who>({ ...common, name: `${prefix}Brand` });
  const emails = defineEmails<Who>({ ...common, name: `${prefix}Email`, defaultLocale: "en", locales: ["en", "de"], branding, fileUrl: (id) => `https://cdn.example/${id}` });
  const content = defineContent<Who>({ ...common, name: prefix, blocks: COMMON_BLOCKS, defaultLocale: "en", locales: ["en", "de"], can: (v, p) => v.perms?.includes(p) === true });
  return { translations, branding, emails, content, models: [translations.model, branding.model, emails.model, ...content.models] };
}

async function scenario(w: ReturnType<typeof world>) {
  const { translations: tr, emails, content, branding } = w;

  assert.equal(await tr.set(root, "platform", "en", { "nav.servers": "Machines" }), 1);
  assert.equal(await tr.set(boss, "reseller", "de", { "auth.hello": "Servus {name}" }), 1);
  await assert.rejects(tr.set(boss, "reseller", "en", { "auth.hello": "Hi {who}" }), /no argument \{who\}/);
  await assert.rejects(tr.set(boss, "reseller", "en", { "auth.nope": "x" }), /unknown key/);
  await assert.rejects(tr.set(boss, "reseller", "en", { "auth.hello": "Hi {name" }), /auth\.hello/);
  await assert.rejects(tr.set(ann, "shop", "en", { "auth.bye": "x" }), /not allowed/);
  const de = await tr.translator("shop", "de");
  assert.equal((de as unknown as (k: string, p?: object) => string)("auth.hello", { name: "Ann" }), "Servus Ann");
  const en = await tr.translator("shop", "en");
  assert.equal((en as unknown as (k: string) => string)("nav.servers"), "Machines");
  assert.equal((en as unknown as (k: string) => string)("auth.bye"), "Bye");
  const listed = await tr.list("reseller", "de", "hello");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.current, "Servus {name}");
  assert.equal(listed[0]!.overridden, true);
  const undo = tr.registerCatalog("acme.web", "en", { "acme.web.title": "Acme {n}" });
  assert.equal(((await tr.translator("shop", "de")) as unknown as (k: string, p: object) => string)("acme.web.title", { n: 2 }), "Acme 2");
  assert.equal(await tr.set(boss, "reseller", "en", { "acme.web.title": "Acme!" }), 1);
  undo();
  const exported = await tr.exportOverrides("reseller", "de");
  assert.equal(await tr.set(boss, "reseller", "de", { "auth.hello": null }), 1);
  assert.deepEqual(await tr.importOverrides(boss, "reseller", exported), { saved: 1, skipped: [] });

  await branding.save(boss, "reseller", { productName: "HostCo", logo: "logo_1", emailFooter: "HostCo Ltd · [Help](https://help.example/)", light: { primary: "#ff8800" } });
  emails.register({ key: "auth.reset", title: "Password reset", variables: { name: { kind: "string" }, url: { kind: "url" } }, subject: "Reset your {{productName}} password", body: "Hi {{name}},\n\n[Reset password]({{url}})", locales: { de: { subject: "Passwort zurücksetzen", body: "Hallo {{name}}" } } });
  assert.throws(() => emails.register({ key: "auth.bad", title: "x", variables: {}, subject: "{{who}}", body: "x" }), /unknown variable/);
  const m = await emails.render("shop", "auth.reset", "en", { name: "Ann", url: "https://shop.example/r/1" });
  assert.equal(m.subject, "Reset your HostCo password");
  assert.equal(m.source, "built-in");
  assert.match(m.html, /<a href="https:\/\/shop\.example\/r\/1"[^>]*>Reset password<\/a>/);
  assert.match(m.html, /src="https:\/\/cdn\.example\/logo_1"/);
  assert.match(m.html, /#ff8800/);
  assert.match(m.text, /HostCo Ltd/);
  assert.equal((await emails.render("shop", "auth.reset", "de", { name: "Ann", url: "x" })).subject, "Passwort zurücksetzen");
  assert.equal(await emails.save(boss, "reseller", "auth.reset", "en", { subject: "{{productName}}: new password", body: "Click {{url}}" }), true);
  await assert.rejects(emails.save(boss, "reseller", "auth.reset", "en", { subject: "x", body: "{{secret}}" }), /unknown variable/);
  assert.equal(await emails.save(ann, "shop", "auth.reset", "en", { subject: "x", body: "y" }), false);
  const custom = await emails.render("shop", "auth.reset", "en", { name: "Ann", url: "https://shop.example/r/2" });
  assert.equal(custom.subject, "HostCo: new password");
  assert.equal(custom.source, "tenant");
  assert.equal((await emails.render("shop", "auth.reset", "de", { name: "Ann", url: "x" })).subject, "Passwort zurücksetzen");
  const preview = await emails.preview(boss, "reseller", "auth.reset", "en", { subject: "Draft {{name}}", body: "x" });
  assert.equal(preview.subject, "Draft name");
  assert.equal(await emails.reset(boss, "reseller", "auth.reset", "en"), true);
  assert.equal((await emails.render("shop", "auth.reset", "en", { name: "A", url: "x" })).source, "built-in");

  assert.equal(await content.block("shop", "login.notice", "en"), null);
  assert.equal(await content.saveBlock(root, "platform", "login.notice", "en", "Maintenance **tonight**"), true);
  assert.equal(await content.saveBlock(boss, "reseller", "login.notice", "de", "Wartung heute"), true);
  assert.equal((await content.block("shop", "login.notice", "en"))!.html, "<p>Maintenance <strong>tonight</strong></p>");
  assert.equal((await content.block("shop", "login.notice", "de"))!.text, "Wartung heute");
  await assert.rejects(content.block("shop", "nope", "en"), /no block/);

  assert.equal(await content.savePage(boss, "reseller", "pricing", "en", { title: "Pricing", body: "Cheap", published: false }), true);
  await assert.rejects(content.savePage(boss, "reseller", "admin", "en", { title: "x", body: "", published: true }), /slug/);
  assert.equal(await content.page(ann, "shop", "pricing", "en"), null);
  assert.equal((await content.page(boss, "reseller", "pricing", "en"))!.title, "Pricing");
  await content.savePage(boss, "reseller", "pricing", "en", { title: "Pricing", body: "Cheap", published: true, order: 2 });
  assert.equal((await content.page(null, "shop", "pricing", "de"))!.html, "<p>Cheap</p>");
  assert.deepEqual((await content.pages(null, "shop", "en")).map((p) => p.slug), ["pricing"]);

  const now = Date.now();
  const a1 = await content.announce(root, "platform", { title: "Network upgrade", body: "See *status*", level: "warning", starts: now - 1000 });
  await content.announce(boss, "reseller", { title: "Staff only", app: "admin", starts: now - 1000 });
  await content.announce(boss, "reseller", { title: "Billing", permission: "billing.read", level: "critical", starts: now - 1000 });
  await content.announce(boss, "reseller", { title: "Later", starts: now + 3_600_000 });
  await content.announce(boss, "reseller", { title: "Local", cascade: false, starts: now - 1000 });
  await assert.rejects(content.announce(ann, "shop", { title: "x" }), /not allowed/);
  const shown = await content.active(ann, "shop", "client");
  assert.deepEqual(shown.map((s) => s.title), ["Billing", "Network upgrade"]);
  assert.equal(shown[0]!.dismissible, false);
  assert.equal(await content.dismiss(ann, shown[0]!.id), false);
  assert.equal(await content.dismiss(ann, a1.id), true);
  assert.deepEqual((await content.active(ann, "shop", "client")).map((s) => s.title), ["Billing"]);
  assert.deepEqual((await content.active(null, "reseller", "client")).map((s) => s.title), ["Network upgrade", "Local"]);
  assert.equal(await content.withdraw(boss, "reseller", (await content.manageable(boss, "reseller")).find((r) => r.title === "Billing")!.id), true);
  assert.deepEqual((await content.active(ann, "shop", "client")).map((s) => s.title), []);
}

test("translations, emails, content blocks, pages and announcements (memory)", async () => {
  await scenario(world("KitCMem"));
});

test("translations, emails, content blocks, pages and announcements (Postgres)", async () => {
  const w = world("KitCPg");
  await usePostgres(pgliteAsPool(new PGlite()), w.models as unknown as Model<never>[], { onWarning: () => {} });
  await scenario(w);
});
