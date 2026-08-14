#!/usr/bin/env node
/**
 * Diff two V8 heap snapshots by constructor — "what GREW between these?"
 *
 * This is the tool that named the 2026-08-10 TUI leak. Take one snapshot at
 * boot, drive the app (or let it idle), take a second, and diff: the retainer
 * is whatever climbs by tens of thousands of objects.
 *
 *   $ node scripts/heap-diff.mjs Heap.<early>.heapsnapshot Heap.<later>.heapsnapshot
 *       Δcount  Δbytes(MB)  constructor  (before→after)
 *       666921      19.82   (string)  (195914→862835)
 *        74667       4.56   obj:PerformanceMeasure  (11447→86114)   <-- the leak
 *
 * Both snapshots come from the same process (kill -USR2 twice), because node
 * ids are not comparable across processes. Snapshots force a GC, so anything
 * still present is genuinely retained — unlike an RSS reading.
 */
import { readFileSync } from "node:fs";

function load(path) {
  const snap = JSON.parse(readFileSync(path, "utf8"));
  const fields = snap.snapshot.meta.node_fields;
  const types = snap.snapshot.meta.node_types[0];
  const { strings, nodes } = snap;
  const stride = fields.length;
  const iType = fields.indexOf("type");
  const iName = fields.indexOf("name");
  const iSize = fields.indexOf("self_size");
  const by = new Map();
  for (let o = 0; o < nodes.length; o += stride) {
    const t = types[nodes[o + iType]];
    const name = strings[nodes[o + iName]];
    let key;
    if (t === "object") key = `obj:${name}`;
    else if (t === "closure") key = `closure:${name || "(anon)"}`;
    else if (t === "string" || t === "concatenated string" || t === "sliced string")
      key = "(string)";
    else key = `(${t})`;
    const cur = by.get(key) ?? [0, 0];
    cur[0] += 1;
    cur[1] += nodes[o + iSize];
    by.set(key, cur);
  }
  return by;
}

const [, , beforePath, afterPath, topArg] = process.argv;
if (!beforePath || !afterPath) {
  console.error(
    "usage: node scripts/heap-diff.mjs <before.heapsnapshot> <after.heapsnapshot> [topN]",
  );
  process.exit(2);
}
const top = Number(topArg ?? 18);
const a = load(beforePath);
const b = load(afterPath);

const rows = [];
for (const key of new Set([...a.keys(), ...b.keys()])) {
  const [ca, sa] = a.get(key) ?? [0, 0];
  const [cb, sb] = b.get(key) ?? [0, 0];
  rows.push({ dCount: cb - ca, dBytes: sb - sa, key, ca, cb });
}
rows.sort((x, y) => y.dCount - x.dCount);

console.log(`${"Δcount".padStart(10)} ${"Δbytes(MB)".padStart(11)}  constructor  (before→after)`);
for (const r of rows.slice(0, top)) {
  console.log(
    `${String(r.dCount).padStart(10)} ${(r.dBytes / 1024 / 1024).toFixed(2).padStart(10)}  ${r.key}  (${r.ca}→${r.cb})`,
  );
}
