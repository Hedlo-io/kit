import { test } from "node:test";
import assert from "node:assert/strict";
import { advisoriesFor, severityRank, type Advisory } from "../src/index.ts";

const base = { title: "Token leak", url: "https://marketplace.hedlo.io/items/acme.x#advisory-a", published: 1 };
const list: Advisory[] = [
  { id: "a", severity: "medium", affected: "<1.4.2", fixed: "1.4.2", ...base },
  { id: "b", severity: "critical", affected: ">=1.2.0 <1.3.0", fixed: "1.3.0", ...base },
  { id: "c", severity: "low", affected: "<1.0.0", fixed: null, ...base },
];

test("advisories match the installed version and sort by severity", () => {
  assert.deepEqual(advisoriesFor({ advisories: list }, "1.2.5").map((a) => a.id), ["b", "a"]);
  assert.deepEqual(advisoriesFor({ advisories: list }, "1.4.2").map((a) => a.id), []);
  assert.deepEqual(advisoriesFor({ advisories: list }, "0.9.0").map((a) => a.id), ["a", "c"]);
});

test("unparseable installed versions and missing advisories match nothing", () => {
  assert.deepEqual(advisoriesFor({ advisories: list }, "dev"), []);
  assert.deepEqual(advisoriesFor({}, "1.0.0"), []);
});

test("severity ranks are ordered", () => {
  assert.ok(severityRank("critical") > severityRank("high"));
  assert.ok(severityRank("high") > severityRank("medium"));
  assert.ok(severityRank("medium") > severityRank("low"));
});
