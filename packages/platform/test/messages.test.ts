import { test } from "node:test";
import assert from "node:assert/strict";
import { argumentsOf, catalogEntries, compareCatalogs, defineI18n, direction, type Catalog } from "@weft-framework/i18n";
import { KIT_CATALOGS, kitLabels, kitMessages, type KitTranslate } from "../src/index.ts";

test("every kit catalog matches the English base", () => {
  for (const [locale, catalog] of Object.entries(KIT_CATALOGS)) {
    const diff = compareCatalogs(kitMessages, catalog as Catalog);
    assert.deepEqual(diff, { missing: [], extra: [], mismatched: [] }, locale);
  }
});

test("translated messages keep the same placeholders", () => {
  const base = new Map(catalogEntries(kitMessages));
  for (const [locale, catalog] of Object.entries(KIT_CATALOGS)) {
    for (const [key, message] of catalogEntries(catalog as Catalog)) {
      assert.deepEqual([...argumentsOf(message)].sort(), [...argumentsOf(base.get(key)!)].sort(), `${locale} ${key}`);
    }
  }
});

test("kitLabels builds every label set from a Weft translator", async () => {
  const i18n = defineI18n({ locales: ["en", "de"], defaultLocale: "en", messages: kitMessages, catalogs: KIT_CATALOGS });
  const de = await i18n.translator("de");
  const t: KitTranslate = (key, params) => (de as unknown as KitTranslate)(key, params);
  const l = kitLabels(t);
  assert.equal(l.copy.copy, "Kopieren");
  assert.equal(l.table.summary({ page: 2, pages: 3, total: 1 }), "Seite 2 von 3 · 1 Eintrag");
  assert.equal(l.members.inherited("Acme"), "über Acme");
  assert.equal(l.status("running"), "Läuft");
  assert.equal(l.status("unknown-state"), "unknown-state");
  assert.equal(l.cronPresets.length, 4);
  for (const [section, value] of Object.entries(l)) {
    if (typeof value !== "object" || Array.isArray(value)) continue;
    for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
      if (typeof text === "string") assert.ok(text.length > 0 && !text.startsWith("kit."), `${section}.${key}`);
    }
  }
  assert.equal(direction("de"), "ltr");
});
