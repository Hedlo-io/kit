export type DiffLine = { op: "same" | "add" | "remove"; text: string };

const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ op: "same", text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ op: "same", text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length * y.length > MAX_CELLS) return [...head, ...x.map((text) => ({ op: "remove" as const, text })), ...y.map((text) => ({ op: "add" as const, text })), ...tail];
  const w = y.length + 1;
  const len = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      len[i * w + j] = x[i] === y[j] ? len[(i + 1) * w + j + 1]! + 1 : Math.max(len[(i + 1) * w + j]!, len[i * w + j + 1]!);
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      mid.push({ op: "same", text: x[i]! });
      i++;
      j++;
    } else if (len[(i + 1) * w + j]! >= len[i * w + j + 1]!) {
      mid.push({ op: "remove", text: x[i++]! });
    } else {
      mid.push({ op: "add", text: y[j++]! });
    }
  }
  while (i < x.length) mid.push({ op: "remove", text: x[i++]! });
  while (j < y.length) mid.push({ op: "add", text: y[j++]! });
  return [...head, ...mid, ...tail];
}

export function diffHunks(lines: DiffLine[], context = 3): (DiffLine | { op: "gap"; text: string })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, n) => {
    if (l.op === "same") return;
    for (let k = Math.max(0, n - context); k <= Math.min(lines.length - 1, n + context); k++) keep[k] = true;
  });
  const out: (DiffLine | { op: "gap"; text: string })[] = [];
  let skipped = 0;
  lines.forEach((l, n) => {
    if (keep[n]) {
      if (skipped) out.push({ op: "gap", text: String(skipped) });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ op: "gap", text: String(skipped) });
  return out;
}
