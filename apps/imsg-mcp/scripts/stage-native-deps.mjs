#!/usr/bin/env node
/**
 * Ensure native dependencies are present in the MCPB staging dir.
 *
 * `pack:mcpb` installs the staged node_modules with `--ignore-scripts` (so that
 * arbitrary dependency lifecycle hooks never run inside the release stage). That
 * flag also suppresses better-sqlite3's own `install` hook, which is what fetches
 * or compiles its `better_sqlite3.node` binding. Without this step the bundle
 * ships better-sqlite3's C++ *source* but no compiled binary, so Claude Desktop's
 * built-in Node throws `Could not locate the bindings file` the first time a
 * Database is opened — the process exits silently right after `initialize`.
 *
 * This copies the already-compiled binding from the repo's installed
 * node_modules (built for THIS machine's Node ABI on `pnpm install`) into the
 * stage. Pack with the same Node major that Claude Desktop bundles (currently
 * Node 24 → MODULE_VERSION 137) so the ABI matches the host runtime.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = join(repoRoot, "release", "mcpb-stage");

/** Recursively find the first file named `target` under `dir` (bounded depth). */
function findFile(dir, target, depth = 6) {
  if (depth < 0 || !existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name === target) return full;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findFile(join(dir, e.name), target, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/** Candidate source locations for a compiled binding, most-specific first. */
function locateBinding(pkgName, bindingFile) {
  const candidates = [
    join(repoRoot, "node_modules", pkgName, "build", "Release", bindingFile),
    join(repoRoot, "node_modules", pkgName, "prebuilds"),
  ];
  for (const c of candidates) {
    if (c.endsWith(bindingFile) && existsSync(c)) return c;
  }
  // pnpm store: node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/build/Release/<file>
  const pnpmDir = join(repoRoot, "node_modules", ".pnpm");
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (!entry.startsWith(`${pkgName}@`)) continue;
      const p = join(pnpmDir, entry, "node_modules", pkgName, "build", "Release", bindingFile);
      if (existsSync(p)) return p;
    }
  }
  // Last resort: recursive search under node_modules.
  return findFile(join(repoRoot, "node_modules"), bindingFile);
}

function stageBinding(pkgName, bindingFile) {
  const destDir = join(stageRoot, "node_modules", pkgName, "build", "Release");
  const dest = join(destDir, bindingFile);
  if (existsSync(dest)) {
    console.log(`✓ ${pkgName}: binding already staged (${dest})`);
    return;
  }
  if (!existsSync(join(stageRoot, "node_modules", pkgName))) {
    throw new Error(
      `${pkgName} is not present in the stage (${stageRoot}). Did the staged 'npm install' run?`,
    );
  }
  const src = locateBinding(pkgName, bindingFile);
  if (!src) {
    throw new Error(
      `Could not find a compiled ${bindingFile} for ${pkgName} in node_modules.\n` +
        `Run 'pnpm install' (which builds/fetches it) before 'pnpm pack:mcpb', or\n` +
        `run 'npm rebuild ${pkgName}' inside ${stageRoot}.`,
    );
  }
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  const size = statSync(dest).size;
  console.log(
    `✓ ${pkgName}: staged ${bindingFile} (${(size / 1024 / 1024).toFixed(1)} MB) from ${src.replace(repoRoot + "/", "")}`,
  );
}

console.log(
  `Staging native deps · Node ${process.version} ${process.arch} (MODULE_VERSION=${process.versions.modules})`,
);
stageBinding("better-sqlite3", "better_sqlite3.node");
console.log(
  "Native deps staged. Pack with the same Node major Claude Desktop bundles for ABI compatibility.",
);
