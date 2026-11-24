export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword" | "key" | "tag" | "attr" | "punct" | "variable";

export interface Token {
  kind: TokenKind;
  text: string;
}

export type Language = "text" | "json" | "yaml" | "shell" | "properties" | "ini" | "xml" | "javascript" | "python" | "toml" | "lua";

const EXTENSIONS: Record<string, Language> = {
  json: "json",
  json5: "json",
  mcmeta: "json",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  bash: "shell",
  env: "shell",
  properties: "properties",
  cfg: "ini",
  ini: "ini",
  conf: "ini",
  toml: "toml",
  xml: "xml",
  html: "xml",
  htm: "xml",
  svg: "xml",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "javascript",
  py: "python",
  lua: "lua",
};

export function languageOf(path: string): Language {
  const base = path.split("/").pop() ?? path;
  if (base === ".env" || base.endsWith(".env")) return "shell";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "text";
  return EXTENSIONS[base.slice(dot + 1).toLowerCase()] ?? "text";
}

const KEYWORDS: Partial<Record<Language, string[]>> = {
  json: ["true", "false", "null"],
  yaml: ["true", "false", "null", "yes", "no", "on", "off"],
  toml: ["true", "false"],
  shell: "if then else elif fi for while do done case esac in function return export local set echo exit cd apt apk curl wget mkdir rm cp mv chmod chown".split(" "),
  javascript: "const let var function return if else for while import export from new class extends async await true false null undefined typeof this try catch throw".split(" "),
  python: "def class return if elif else for while import from as with try except finally raise True False None and or not in is lambda pass yield".split(" "),
  lua: "local function end if then else elseif for while do return true false nil and or not in repeat until".split(" "),
};

interface Rule {
  kind: TokenKind;
  re: RegExp;
}

function rulesFor(lang: Language): Rule[] {
  const hash: Rule = { kind: "comment", re: /#.*/y };
  const dq: Rule = { kind: "string", re: /"(?:[^"\\\n]|\\.)*"?/y };
  const sq: Rule = { kind: "string", re: /'(?:[^'\\\n]|\\.)*'?/y };
  const num: Rule = { kind: "number", re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y };
  const word: Rule = { kind: "plain", re: /[A-Za-z_][\w-]*/y };
  switch (lang) {
    case "json":
      return [{ kind: "key", re: /"(?:[^"\\\n]|\\.)*"(?=\s*:)/y }, dq, num, word, { kind: "punct", re: /[{}[\],:]/y }];
    case "yaml":
      return [hash, { kind: "key", re: /(?<=^\s*(?:-\s+)?)[^\s#:'"][^:#\n]*(?=:(?:\s|$))/my }, dq, sq, num, word, { kind: "punct", re: /[-:|>{}[\],]/y }];
    case "toml":
    case "ini":
    case "properties":
      return [
        { kind: "comment", re: /(?<=^\s*)[#;!].*/my },
        { kind: "tag", re: /(?<=^\s*)\[[^\]\n]*\]/my },
        { kind: "key", re: /(?<=^\s*)[^\s=:#;[][^=:\n]*?(?=\s*[=:])/my },
        dq,
        sq,
        num,
        word,
        { kind: "punct", re: /[=:]/y },
      ];
    case "shell":
      return [hash, dq, sq, { kind: "variable", re: /\$(?:\{[^}\n]*\}?|[A-Za-z_]\w*|[0-9@#?$!*-])/y }, num, word, { kind: "punct", re: /[|&;<>()]+/y }];
    case "xml":
      return [
        { kind: "comment", re: /<!--[\s\S]*?(?:-->|$)/y },
        { kind: "tag", re: /<\/?[A-Za-z][\w:.-]*|\/?>/y },
        { kind: "attr", re: /[A-Za-z_:][\w:.-]*(?==)/y },
        dq,
        sq,
      ];
    case "javascript":
      return [{ kind: "comment", re: /\/\/.*|\/\*[\s\S]*?(?:\*\/|$)/y }, dq, sq, { kind: "string", re: /`(?:[^`\\]|\\.)*`?/y }, num, word, { kind: "punct", re: /[{}()[\];,.]/y }];
    case "python":
      return [hash, { kind: "string", re: /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/y }, dq, sq, num, word];
    case "lua":
      return [{ kind: "comment", re: /--\[\[[\s\S]*?(?:\]\]|$)|--.*/y }, dq, sq, num, word];
    default:
      return [];
  }
}

export function tokenize(source: string, lang: Language | string): Token[] {
  const language = (lang in KEYWORDS || ["properties", "ini", "xml"].includes(lang) ? lang : "text") as Language;
  const rules = rulesFor(language);
  const keywords = new Set(KEYWORDS[language] ?? []);
  const out: Token[] = [];
  if (rules.length === 0 || source.length > 500_000) return [{ kind: "plain", text: source }];
  const push = (kind: TokenKind, text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  while (i < source.length) {
    let matched = false;
    for (const r of rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(source);
      if (m && m[0].length > 0) {
        const kind = r.kind === "plain" && keywords.has(m[0]) ? "keyword" : r.kind;
        push(kind, m[0]);
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      push("plain", source[i]!);
      i++;
    }
  }
  return out;
}

export type DiffOp = "same" | "add" | "del";

export interface DiffLine {
  op: DiffOp;
  text: string;
  a: number | null;
  b: number | null;
}

export function diffLines(before: string, after: string, maxEdits = 4000): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v: Int32Array = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  trace.push(v.slice());
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ op: "same", text: a[x - 1]!, a: x, b: y });
      x--;
      y--;
    }
    if (x === prevX) out.push({ op: "add", text: b[y - 1]!, a: null, b: y });
    else out.push({ op: "del", text: a[x - 1]!, a: x, b: null });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    out.push({ op: "same", text: a[x - 1]!, a: x, b: y });
    x--;
    y--;
  }
  return out.reverse();
}

export interface DiffHunk {
  lines: DiffLine[];
  skippedBefore: number;
}

export function diffHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.op === "same") return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = 1;
  });
  const hunks: DiffHunk[] = [];
  let skipped = 0;
  let current: DiffHunk | null = null;
  lines.forEach((l, i) => {
    if (!keep[i]) {
      skipped++;
      current = null;
      return;
    }
    if (!current) {
      current = { lines: [], skippedBefore: skipped };
      hunks.push(current);
      skipped = 0;
    }
    current.lines.push(l);
  });
  return hunks;
}
