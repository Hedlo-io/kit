import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "components");
const target = resolve(process.cwd(), process.argv[2] ?? "src/components/kit");

if (!existsSync(source)) {
  console.error(`no components at ${source}`);
  process.exit(1);
}
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
let n = 0;
for (const f of readdirSync(source)) {
  if (!/\.(wx|ts)$/.test(f)) continue;
  cpSync(join(source, f), join(target, f));
  n++;
}
console.log(`kit/ui: ${n} files → ${target}`);
