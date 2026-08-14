#!/usr/bin/env node
/**
 * Constructor histogram for a V8 heap snapshot — "what is holding the heap?"
 *
 * Written during the 2026-08-10 TUI leak hunt and kept because RSS readings
 * lie in BOTH directions: V8 frees memory without returning it to the OS
 * (phantom growth), and it can also hide real retention behind a flat RSS.
 * A snapshot forces a GC first, so what it shows is genuinely retained.
 *
 * Usage:
 *   node --heapsnapshot-signal=SIGUSR2 dist/cli.js tui   # run the target
 *   kill -USR2 <pid>                                     # writes Heap.*.heapsnapshot in its CWD
 *   node scripts/heap-histo.mjs Heap.*.heapsnapshot [topN]
 *
 * The leak this found: `obj:PerformanceMeasure` climbing ~250/sec, from
 * react-reconciler's DEVELOPMENT build calling performance.measure() on every
 * commit (see AGENTS.md § TUI invariant 1).
 */
import { readFileSync } from "node:fs";

const path = process.argv[2];
const top = Number(process.argv[3] ?? 25);
if (!path) {
  console.error("usage: node scripts/heap-histo.mjs <file.heapsnapshot> [topN]");
  process.exit(2);
}

const snap = JSON.parse(readFileSync(path, "utf8"));
const fields = snap.snapshot.meta.node_fields;
const types = snap.snapshot.meta.node_types[0];
const { strings, nodes } = snap;
const stride = fields.length;
const iType = fields.indexOf("type");
const iName = fields.indexOf("name");
const iSize = fields.indexOf("self_size");

const by = new Map(); // key -> [count, bytes]
let total = 0;
for (let o = 0; o < nodes.length; o += stride) {
  const t = types[nodes[o + iType]];
  const name = strings[nodes[o + iName]];
  let key;
  if (t === "object") key = `obj:${name}`;
  else if (t === "closure") key = `closure:${name || "(anon)"}`;
  else if (t === "string" || t === "concatenated string" || t === "sliced string") key = "(string)";
  else key = `(${t})`;
  const size = nodes[o + iSize];
  const cur = by.get(key) ?? [0, 0];
  cur[0] += 1;
  cur[1] += size;
  by.set(key, cur);
  total += size;
}

console.log(
  `total self-size: ${(total / 1024 / 1024).toFixed(1)}MB, nodes: ${nodes.length / stride}`,
);
for (const [key, [count, bytes]] of [...by.entries()].sort((a, b) => b[1][1] - a[1][1]).slice(0, top)) {
  console.log(`${(bytes / 1024 / 1024).toFixed(2).padStart(9)}MB ${String(count).padStart(9)}  ${key}`);
}
