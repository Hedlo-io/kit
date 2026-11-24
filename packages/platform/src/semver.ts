export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const VERSION = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;

export function parseVersion(v: unknown): Version | null {
  if (typeof v !== "string") return null;
  const m = VERSION.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

export function compareVersions(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

type Cmp = { op: "<" | "<=" | ">" | ">=" | "="; v: Version };

function partial(s: string): { v: Version; parts: number } | null {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(s);
  if (!m) return null;
  const nums = [m[1], m[2], m[3]];
  let parts = 0;
  for (const n of nums) {
    if (n === undefined || /^[xX*]$/.test(n)) break;
    parts++;
  }
  const get = (i: number) => (i < parts ? Number(nums[i]) : 0);
  return { v: { major: get(0), minor: get(1), patch: get(2), pre: parts === 3 && m[4] ? m[4].split(".") : [] }, parts };
}

const bump = (v: Version, at: 0 | 1 | 2): Version =>
  at === 0 ? { major: v.major + 1, minor: 0, patch: 0, pre: ["0"] } : at === 1 ? { major: v.major, minor: v.minor + 1, patch: 0, pre: ["0"] } : { major: v.major, minor: v.minor, patch: v.patch + 1, pre: ["0"] };

function comparators(token: string): Cmp[] | null {
  if (token === "*" || token === "x" || token === "") return [];
  const opm = /^(<=|>=|<|>|=|\^|~)?(.+)$/.exec(token);
  if (!opm) return null;
  const op = opm[1] ?? "";
  const p = partial(opm[2]!);
  if (!p) return null;
  const { v, parts } = p;
  if (op === "^") {
    if (parts === 0) return [];
    const upper = v.major > 0 || parts === 1 ? bump(v, 0) : v.minor > 0 || parts === 2 ? bump(v, 1) : bump(v, 2);
    return [{ op: ">=", v }, { op: "<", v: upper }];
  }
  if (op === "~") {
    if (parts === 0) return [];
    return [{ op: ">=", v }, { op: "<", v: parts === 1 ? bump(v, 0) : bump(v, 1) }];
  }
  if (op === "" || op === "=") {
    if (parts === 3) return [{ op: "=", v }];
    if (parts === 0) return [];
    return [{ op: ">=", v }, { op: "<", v: bump(v, parts === 1 ? 0 : 1) }];
  }
  if (parts < 3 && (op === ">" || op === "<=")) {
    const up = parts === 0 ? null : bump(v, parts === 1 ? 0 : 1);
    if (!up) return op === ">" ? [{ op: "<", v: { major: 0, minor: 0, patch: 0, pre: ["0"] } }] : [];
    return [{ op: op === ">" ? ">=" : "<", v: up }];
  }
  return [{ op: op as Cmp["op"], v }];
}

function test(v: Version, c: Cmp): boolean {
  const r = compareVersions(v, c.v);
  switch (c.op) {
    case "<":
      return r < 0;
    case "<=":
      return r <= 0;
    case ">":
      return r > 0;
    case ">=":
      return r >= 0;
    default:
      return r === 0;
  }
}

export function validRange(range: unknown): boolean {
  if (typeof range !== "string" || range.length > 200) return false;
  return range.split("||").every((alt) => {
    const tokens = hyphen(alt.trim());
    return tokens !== null && tokens.every((t) => comparators(t) !== null);
  });
}

function hyphen(alt: string): string[] | null {
  const h = /^(\S+)\s+-\s+(\S+)$/.exec(alt);
  if (h) return [`>=${h[1]}`, `<=${h[2]}`];
  return alt === "" ? [""] : alt.split(/\s+/);
}

export function satisfies(version: string | Version, range: string): boolean {
  const v = typeof version === "string" ? parseVersion(version) : version;
  if (!v || !validRange(range)) return false;
  return range.split("||").some((alt) => {
    const cmps = hyphen(alt.trim())!.flatMap((t) => comparators(t)!);
    if (!cmps.every((c) => test(v, c))) return false;
    if (v.pre.length === 0) return true;
    return cmps.some((c) => c.v.pre.length > 0 && c.v.pre[0] !== "0" && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch);
  });
}
