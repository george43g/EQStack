#!/usr/bin/env node
/**
 * Documentation-integrity check (harness-engineering: "every path, symbol,
 * command and config name written in the entry point must resolve").
 *
 * The entry points (root AGENTS.md and each apps/<app>/AGENTS.md, plus their
 * CLAUDE.md symlinks) are where fresh-clone and cloud agents start; a stale
 * path there misleads exactly the reader least able to notice. This asserts
 * that every repo-relative file path and every `pnpm <script>` named in those
 * guides still resolves. It rots slower than the prose it guards because it
 * runs in `verify`.
 *
 * App guides are written app-relative (`src/foo.ts` means
 * `apps/<app>/src/foo.ts`) but may also cite repo-root paths (`apps/…`,
 * `docs/…`), so each reference is resolved against the guide's own directory
 * first and the repo root second. Guides are discovered, not listed, so a new
 * app is covered the day it gets a guide.
 *
 * Scope is deliberately conservative — only tokens that are unambiguously
 * repo paths or pnpm scripts — so a false positive never blocks a real change.
 * Run `node scripts/check-docs-integrity.mjs --self-test` to prove it can fail.
 *
 * Three structural checks run alongside the reference scan:
 *  - Codex instruction cap. Codex concatenates every AGENTS.md from the repo
 *    root down to its working directory and silently truncates the result at
 *    `project_doc_max_bytes` (32,768 bytes by default — codex-rs agents_md.rs,
 *    `data.truncate(remaining)`). Every root-to-guide chain, enumerated from
 *    tracked files with `git ls-files`, must fit. Bytes Codex may add between
 *    files are unknown and not counted, so read the printed margin, not just
 *    pass/fail.
 *  - Claude Code loads a nested CLAUDE.md, never a nested AGENTS.md, so every
 *    guide needs a sibling CLAUDE.md (a symlink to it).
 *  - A KNOWN_ABSENT entry that no guide triggers any more is dead and fails,
 *    so the allowlist cannot rot in the other direction either.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Codex default; override only to experiment — CI must enforce the default. */
const CODEX_PROJECT_DOC_MAX_BYTES = Number(process.env.CODEX_PROJECT_DOC_MAX_BYTES || 32768);

/** Root AGENTS.md plus every apps/<app>/AGENTS.md that exists. */
function findGuides() {
  const guides = [join(repoRoot, "AGENTS.md")];
  const appsDir = join(repoRoot, "apps");
  if (existsSync(appsDir)) {
    for (const app of readdirSync(appsDir).sort()) {
      const guide = join(appsDir, app, "AGENTS.md");
      if (existsSync(guide)) guides.push(guide);
    }
  }
  return guides.filter(existsSync);
}

/**
 * References that are correct prose about a path that intentionally does NOT
 * exist here. Every entry needs a reason: the point is that an absent path is
 * a deliberate statement, not drift. Allowlisted hits are counted in the output
 * so this list cannot quietly grow into a way of muting the check.
 */
const KNOWN_ABSENT = [
  {
    guide: "apps/gmail-mcp/AGENTS.md",
    path: "packages/robustness/",
    why: "a path in the upstream mcp-cli-starter-template repo, not in this one",
  },
  {
    guide: "apps/gmail-mcp/AGENTS.md",
    path: "src/robustness/",
    why: "cited precisely because it was deleted and must not be re-grown locally",
  },
];

/** A backtick token is a checkable repo path when it starts with a known root. */
const PATH_ROOTS = [
  "apps/",
  "packages/",
  "docs/",
  "scripts/",
  ".github/",
  // app-guide-relative roots
  "src/",
  "tests/",
  "native/",
  "skills/",
  "fixtures/",
];
const PATH_RE = /`([^`]+)`/g;
const FENCE_RE = /^```[\s\S]*?^```/gm;

function extractRefs(rawText) {
  // Fenced code blocks must go FIRST. Inline spans are found by pairing
  // backticks in document order, so a ``` fence shifts every pairing after it
  // and silently turns the rest of the file into unchecked noise — which is
  // how `packages/@eqstack/*` (a path that never existed) passed for weeks.
  const text = rawText.replace(FENCE_RE, "");
  const paths = new Set();
  const scripts = new Set();
  let m;
  PATH_RE.lastIndex = 0;
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
    // globs, brace-expansion, ellipsis and <placeholders> are not single files
    if (/[*{}…<>]/.test(head)) continue;
    if (head.endsWith("/…")) continue;
    paths.add(head);
  }
  return { paths, scripts };
}

function scriptExistsSomewhere(name) {
  const pkgs = ["package.json"];
  const appsDir = join(repoRoot, "apps");
  if (existsSync(appsDir)) {
    for (const app of readdirSync(appsDir).sort()) pkgs.push(join("apps", app, "package.json"));
  }
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

/** Resolve against the guide's own directory first, then the repo root. */
function pathResolves(rel, baseDir) {
  return existsSync(join(baseDir, rel)) || existsSync(join(repoRoot, rel));
}

function check(text, baseDir = repoRoot, guideRel = null) {
  const { paths, scripts } = extractRefs(text);
  const failures = [];
  const usedAllow = [];
  for (const rel of paths) {
    if (pathResolves(rel, baseDir)) continue;
    const hit = KNOWN_ABSENT.find((k) => k.guide === guideRel && k.path === rel);
    if (hit) {
      usedAllow.push(`${hit.guide}::${hit.path}`);
      continue;
    }
    failures.push(`missing path: \`${rel}\``);
  }
  for (const name of scripts) {
    if (!scriptExistsSomewhere(name)) failures.push(`missing pnpm script: \`pnpm ${name}\``);
  }
  return { failures, allowlisted: usedAllow.length, usedAllow, considered: paths.size + scripts.size };
}

/** KNOWN_ABSENT entries no guide triggered during this run — dead entries. */
function unusedAllowlist(allow, usedKeys) {
  const used = new Set(usedKeys);
  return allow.filter((k) => !used.has(`${k.guide}::${k.path}`));
}

/** Chains longer than the cap. Exactly at the cap still fits. */
function chainOverruns(chains, cap) {
  return chains.filter((c) => c.bytes > cap);
}

/** Guides with no sibling CLAUDE.md — Claude Code would never load them. */
function missingClaudeSiblings(guideRels, exists) {
  return guideRels.filter((g) => !exists(join(dirname(g), "CLAUDE.md")));
}

/**
 * Root-to-directory AGENTS.md chains as Codex assembles them. Tracked files
 * only, so an untracked guide on one machine cannot change the verdict. Per
 * directory Codex prefers AGENTS.override.md over AGENTS.md.
 */
function codexChains() {
  let listing;
  try {
    listing = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    throw new Error(
      `cannot enumerate tracked guides with \`git ls-files\` (${err.message.split("\n")[0]}). ` +
        "The chain-size check needs a git checkout; refusing to report a pass it could not measure.",
    );
  }
  const guides = listing
    .split("\0")
    .filter((f) => f === "AGENTS.md" || f === "AGENTS.override.md" || f.endsWith("/AGENTS.md") || f.endsWith("/AGENTS.override.md"));
  const tracked = new Set(guides);
  const fileFor = (dir) => {
    const prefix = dir === "." ? "" : `${dir}/`;
    for (const name of ["AGENTS.override.md", "AGENTS.md"]) if (tracked.has(`${prefix}${name}`)) return `${prefix}${name}`;
    return null;
  };
  return [...new Set(guides.map((f) => dirname(f)))].sort().map((dir) => {
    const parts = dir === "." ? [] : dir.split("/");
    const ancestors = ["."].concat(parts.map((_, i) => parts.slice(0, i + 1).join("/")));
    const files = ancestors.map(fileFor).filter(Boolean);
    const bytes = files.reduce((n, f) => n + readFileSync(join(repoRoot, f)).length, 0);
    return { dir, files, bytes };
  });
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
  // Base-dir resolution must actually depend on the base: an app-relative path
  // resolves from the app dir and not from the repo root.
  const appRelative = "see `src/imessage-db.ts`";
  const fromApp = check(appRelative, join(repoRoot, "apps/imsg-mcp"));
  const fromRoot = check(appRelative, repoRoot);
  if (fromApp.failures.length !== 0) {
    console.error("SELF-TEST FAILED: app-relative path not resolved from app dir:", fromApp.failures);
    process.exit(2);
  }
  if (fromRoot.failures.length !== 1) {
    console.error("SELF-TEST FAILED: app-relative path wrongly resolved from repo root");
    process.exit(2);
  }
  // A fenced code block must not shift inline-span pairing for the text after
  // it — the regression that hid a bad path from this very check.
  const fenced = check(
    ["```", "get_logs({ tail: 50 })", "```", "then see `apps/does-not-exist/nope.ts`"].join("\n"),
  );
  if (fenced.failures.length !== 1) {
    console.error("SELF-TEST FAILED: a code fence hid a bad path from the check:", fenced);
    process.exit(2);
  }
  // A dead allowlist entry is reported; a live one is not.
  const dead = unusedAllowlist([{ guide: "g.md", path: "a/" }, { guide: "g.md", path: "b/" }], ["g.md::a/"]);
  if (dead.length !== 1 || dead[0].path !== "b/") {
    console.error("SELF-TEST FAILED: dead allowlist entry not reported:", dead);
    process.exit(2);
  }
  // Codex cap: one byte over is caught; exactly at the cap is not.
  const over = chainOverruns([{ dir: "x", bytes: 32769 }, { dir: "y", bytes: 32768 }], 32768);
  if (over.length !== 1 || over[0].dir !== "x") {
    console.error("SELF-TEST FAILED: chain overrun not caught at the boundary:", over);
    process.exit(2);
  }
  // A guide without a sibling CLAUDE.md is reported.
  const noSib = missingClaudeSiblings(["apps/a/AGENTS.md", "apps/b/AGENTS.md"], (p) => p === "apps/a/CLAUDE.md");
  if (noSib.length !== 1 || noSib[0] !== "apps/b/AGENTS.md") {
    console.error("SELF-TEST FAILED: missing CLAUDE.md sibling not reported:", noSib);
    process.exit(2);
  }
  console.log(
    "docs-integrity self-test OK (bad refs fail, good pass, base-dir honoured, fences stripped, " +
      "dead allowlist entries caught, Codex chain cap caught at the boundary, missing CLAUDE.md caught)",
  );
  process.exit(0);
}

const guides = findGuides();
let total = 0;
let failed = 0;
const usedKeys = [];
for (const guide of guides) {
  const rel = relative(repoRoot, guide);
  const { failures, usedAllow, considered } = check(readFileSync(guide, "utf8"), dirname(guide), rel);
  total += considered;
  usedKeys.push(...usedAllow);
  if (failures.length > 0) {
    failed += failures.length;
    console.error(`✗ ${rel} references ${failures.length} thing(s) that no longer resolve:`);
    for (const f of failures) console.error(`    ${f}`);
  }
}

const deadEntries = unusedAllowlist(KNOWN_ABSENT, usedKeys);
if (deadEntries.length > 0) {
  failed += deadEntries.length;
  console.error(`✗ ${deadEntries.length} KNOWN_ABSENT entr${deadEntries.length === 1 ? "y is" : "ies are"} dead — no guide mentions the path any more. Delete:`);
  for (const k of deadEntries) console.error(`    ${k.guide} → \`${k.path}\``);
}

let chains;
try {
  chains = codexChains();
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
const overruns = chainOverruns(chains, CODEX_PROJECT_DOC_MAX_BYTES);
if (overruns.length > 0) {
  failed += overruns.length;
  console.error(
    `✗ ${overruns.length} AGENTS.md chain(s) exceed Codex's project_doc_max_bytes (${CODEX_PROJECT_DOC_MAX_BYTES}); Codex truncates the tail silently:`,
  );
  for (const c of overruns) {
    console.error(`    ${c.dir}: ${c.bytes} B (${c.bytes - CODEX_PROJECT_DOC_MAX_BYTES} over) = ${c.files.join(" + ")}`);
  }
  console.error("    Fix: move reference detail into that app's docs/ and link it from the guide.");
}

const orphans = missingClaudeSiblings(guides.map((g) => relative(repoRoot, g)), (p) => existsSync(join(repoRoot, p)));
if (orphans.length > 0) {
  failed += orphans.length;
  console.error(`✗ ${orphans.length} guide(s) have no sibling CLAUDE.md, so Claude Code never loads them:`);
  for (const g of orphans) console.error(`    ${g}  (fix: ln -s AGENTS.md ${join(dirname(g), "CLAUDE.md")})`);
}

if (failed > 0) {
  console.error("\n  Fix the guide, or the check at scripts/check-docs-integrity.mjs.");
  process.exit(1);
}
const tightest = chains.reduce((a, c) => (c.bytes > a.bytes ? c : a));
console.log(
  `✓ ${guides.length} agent guide(s): all ${total} repo-path / pnpm-script references resolve (${usedKeys.length} allowlisted as intentionally absent).`,
);
console.log(
  `✓ ${chains.length} AGENTS.md chain(s) fit Codex's ${CODEX_PROJECT_DOC_MAX_BYTES} B cap; tightest is ${tightest.dir} at ${tightest.bytes} B (${CODEX_PROJECT_DOC_MAX_BYTES - tightest.bytes} B spare).`,
);
console.log(`✓ every guide has a sibling CLAUDE.md.`);
