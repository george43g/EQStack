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
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  {
    guide: "apps/gmail-mcp/AGENTS.md",
    path: "scripts/capture-fixtures.ts",
    why: "documented in that guide as not yet shipped",
  },
  {
    guide: "apps/gmail-mcp/AGENTS.md",
    path: "scripts/anonymise-fixtures.ts",
    why: "documented in that guide as not yet shipped",
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
  let allowlisted = 0;
  for (const rel of paths) {
    if (pathResolves(rel, baseDir)) continue;
    if (KNOWN_ABSENT.some((k) => k.guide === guideRel && k.path === rel)) {
      allowlisted += 1;
      continue;
    }
    failures.push(`missing path: \`${rel}\``);
  }
  for (const name of scripts) {
    if (!scriptExistsSomewhere(name)) failures.push(`missing pnpm script: \`pnpm ${name}\``);
  }
  return { failures, allowlisted, considered: paths.size + scripts.size };
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
  console.log(
    "docs-integrity self-test OK (fails on bad refs, passes on good, base-dir honoured, fences stripped)",
  );
  process.exit(0);
}

const guides = findGuides();
let total = 0;
let failed = 0;
let allowed = 0;
for (const guide of guides) {
  const rel = relative(repoRoot, guide);
  const { failures, allowlisted, considered } = check(readFileSync(guide, "utf8"), dirname(guide), rel);
  total += considered;
  allowed += allowlisted;
  if (failures.length > 0) {
    failed += failures.length;
    console.error(`✗ ${rel} references ${failures.length} thing(s) that no longer resolve:`);
    for (const f of failures) console.error(`    ${f}`);
  }
}
if (failed > 0) {
  console.error(`\n  Fix the reference in the guide, or the check at scripts/check-docs-integrity.mjs.`);
  process.exit(1);
}
const suffix = allowed > 0 ? ` (${allowed} allowlisted as intentionally absent)` : "";
console.log(
  `✓ ${guides.length} agent guide(s): all ${total} repo-path / pnpm-script references resolve${suffix}.`,
);
