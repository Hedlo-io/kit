import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const dirs = ["kit/ui/components", "bolt/apps/admin/src", "bolt/apps/client/src", "loom/apps/admin/src", "loom/apps/client/src", "hedlo/apps/site/src", "hedlo/apps/market/src"];
const allowed = [/components[\\/]ui[\\/]qr-code\.wx$/, /pages[\\/](settings[\\/])?emails[\\/]\[key\]\.wx$/];
const palette = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const pattern = new RegExp(`(?<![\\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|shadow|accent|caret)-(?:(?:${palette})-\\d{2,3}|white|black)(?:\\/\\d+)?(?![\\w-])`, "g");

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (name.endsWith(".wx")) yield p;
  }
}

const hits = [];
for (const d of dirs) {
  const dir = join(root, d);
  try {
    statSync(dir);
  } catch {
    continue;
  }
  for (const f of files(dir)) {
    if (allowed.some((r) => r.test(f))) continue;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(pattern)) hits.push(`${relative(root, f)}:${i + 1}: ${m[0]}`);
    });
  }
}

if (hits.length > 0) {
  console.error(`${hits.length} hard-coded colour${hits.length === 1 ? "" : "s"}; use theme tokens (primary, muted, destructive, chart-1…5, …):`);
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}
console.log("theme tokens only: ok");
