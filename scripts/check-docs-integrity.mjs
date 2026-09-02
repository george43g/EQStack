#!/usr/bin/env node
/**
 * Documentation-integrity check (harness-engineering: "every path, symbol,
 * command and config name written in the entry point must resolve").
 *
 * The entry point (root AGENTS.md / its CLAUDE.md symlink) is where fresh-clone
 * and cloud agents start; a stale path there misleads exactly the reader least
 * able to notice. This asserts that every repo-relative file path and every
 * `pnpm <script>` named in AGENTS.md still resolves. It rots slower than the
 * prose it guards because it runs in `verify`.
 *
 * Scope is deliberately conservative — only tokens that are unambiguously
 * repo paths or pnpm scripts — so a false positive never blocks a real change.
 * Run `node scripts/check-docs-integrity.mjs --self-test` to prove it can fail.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(repoRoot, "AGENTS.md");

/** A backtick token is a checkable repo path when it starts with a known root. */
const PATH_ROOTS = ["apps/", "packages/", "docs/", "scripts/", ".github/"];
const PATH_RE = /`([^`]+)`/g;

function extractRefs(text) {
  const paths = new Set();
  const scripts = new Set();
  let m;
  while ((m = PATH_RE.exec(text)) !== null) {
    const raw = m[1].trim();
    // pnpm <script> — the script must exist in some package.json
    const pnpm = raw.match(/^pnpm (?:-C \S+ )?([a-z][\w:-]*)$/);
    if (pnpm) {
      const name = pnpm[1];
      // skip pnpm subcommands that are not scripts
      if (!["install", "add", "exec", "test", "build", "run", "why", "dlx"].includes(name)) {
        scripts.add(name);
      }
      continue;
    }
    // strip a trailing :line-range and any glob, take the path head
    const head = raw.split(/[:\s]/)[0].replace(/\/\*.*$/, "/");
    if (!PATH_ROOTS.some((r) => head.startsWith(r))) continue;
    if (/[*{}\u2026]/.test(head)) continue; // globs, brace-expansion, ellipsis are not single files
    if (head.endsWith("/\u2026")) continue;
    paths.add(head);
  }
  return { paths, scripts };
}

function scriptExistsSomewhere(name) {
  const pkgs = [
    "package.json",
    "apps/imsg-mcp/package.json",
    "apps/gmail-mcp/package.json",
    "apps/telephony-mcp/package.json",
    "apps/analysis/package.json",
  ];
  for (const rel of pkgs) {
    const p = join(repoRoot, rel);
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      if (pkg.scripts && name in pkg.scripts) return true;
    } catch {}
  }
  return false;
}

function check(text) {
  const { paths, scripts } = extractRefs(text);
  const failures = [];
  for (const rel of paths) {
    const abs = rel.endsWith("/") ? join(repoRoot, rel) : join(repoRoot, rel);
    if (!existsSync(abs)) failures.push(`missing path: \`${rel}\``);
  }
  for (const name of scripts) {
    if (!scriptExistsSomewhere(name)) failures.push(`missing pnpm script: \`pnpm ${name}\``);
  }
  return { failures, considered: paths.size + scripts.size };
}

if (process.argv.includes("--self-test")) {
  // Prove the check can fail (skill: a green result is untrustworthy until the
  // check has been shown able to fail on a known negative).
  const bad = check("see `apps/does-not-exist/nope.ts` and run `pnpm no-such-script`");
  if (bad.failures.length !== 2) {
    console.error("SELF-TEST FAILED: expected 2 failures, got", bad.failures);
    process.exit(2);
  }
  const good = check("see `apps/imsg-mcp/package.json` and run `pnpm fixtures`");
  if (good.failures.length !== 0) {
    console.error("SELF-TEST FAILED: known-good refs flagged:", good.failures);
    process.exit(2);
  }
  console.log("docs-integrity self-test OK (fails on bad refs, passes on good)");
  process.exit(0);
}

const text = readFileSync(ENTRY, "utf8");
const { failures, considered } = check(text);
if (failures.length > 0) {
  console.error(`✗ AGENTS.md references ${failures.length} thing(s) that no longer resolve:`);
  for (const f of failures) console.error(`    ${f}`);
  console.error(`\n  Fix the reference in AGENTS.md, or the check at scripts/check-docs-integrity.mjs.`);
  process.exit(1);
}
console.log(`✓ AGENTS.md: all ${considered} repo-path / pnpm-script references resolve.`);
