/**
 * Repo-wide inventory guard: no code or config may run anything through the
 * tsx CLI wrapper (`.bin/tsx`, or a bare `tsx …` package.json script).
 *
 * Why (see scripts/dev-proxy-cmd.ts for the full mechanism): the tsx CLI runs
 * code in a grandchild and relays signals to it with a 30ms IPC-ack window; a
 * busy child is SIGKILLed ~60ms after the signal, truncating graceful shutdown
 * and faking the "no NDJSON shutdown marker = crash" heuristic. PR #113
 * converted every call site to the single-process `node --import <tsx loader>`
 * shape; this test keeps new ones out.
 *
 * Guard shape credit: the mcp-cli-toolkit session's tsx-spawn-inventory test
 * (mcp-cli-starter-template#68). It fails in BOTH directions — a NEW mention
 * outside the allowlist, and a STALE allowlist entry whose file no longer
 * mentions the pattern — so the allowlist cannot rot into decoration.
 * Verified red both ways before merge.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Code/config files where a tsx-CLI invocation could actually execute.
 *  Markdown and other prose are excluded — docs may (should) describe the
 *  hazard by name. */
const CODE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|ya?ml|toml|sh)$/;

/** Files allowed to MENTION `.bin/tsx` — every entry carries its reason and
 *  is itself checked: if the file stops mentioning the pattern, the entry is
 *  stale and this test fails until it is removed. */
const ALLOWED_BIN_TSX_MENTIONS = new Map<string, string>([
  ["apps/imsg-mcp/scripts/dev-proxy-cmd.ts", "documents the hazard; spawns nothing"],
  ["apps/imsg-mcp/scripts/mcp-dev-proxy.ts", "warns against .bin/tsx in MCP_DEV_CMD overrides"],
  ["apps/imsg-mcp/tests/dev-proxy-command.test.ts", "asserts the default excludes .bin/tsx"],
  ["apps/imsg-mcp/tests/tsx-spawn-inventory.test.ts", "this guard's own patterns"],
]);

function trackedCodeFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => CODE_FILE.test(f));
}

describe("tsx spawn inventory", () => {
  const files = trackedCodeFiles();

  it("finds a non-trivial tracked file set (positive control)", () => {
    // A recursion/path failure must not read as "no violations".
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("apps/imsg-mcp/package.json");
  });

  it("no tracked code or config mentions .bin/tsx outside the allowlist", () => {
    const violations = files.filter(
      (f) =>
        !ALLOWED_BIN_TSX_MENTIONS.has(f) &&
        readFileSync(join(REPO_ROOT, f), "utf8").includes("bin/tsx"),
    );
    expect(
      violations,
      `run TypeScript via \`node --import <tsx loader>\`, never the .bin/tsx CLI (see scripts/dev-proxy-cmd.ts): ${violations.join(", ")}`,
    ).toEqual([]);
  });

  it("no package.json script invokes the bare tsx CLI", () => {
    const violations: string[] = [];
    for (const f of files.filter((p) => p.endsWith("package.json"))) {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, f), "utf8")) as {
        scripts?: Record<string, string>;
      };
      for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
        if (/^tsx\s|[&|;]\s*tsx\s/.test(cmd)) violations.push(`${f} → "${name}": "${cmd}"`);
      }
    }
    expect(violations, `use "node --import tsx …" instead: ${violations.join(", ")}`).toEqual([]);
  });

  it("every allowlist entry is still earning its place (stale-exemption check)", () => {
    const stale = [...ALLOWED_BIN_TSX_MENTIONS.keys()].filter(
      (f) => !readFileSync(join(REPO_ROOT, f), "utf8").includes("bin/tsx"),
    );
    expect(
      stale,
      `allowlisted but no longer mentions bin/tsx — remove the entry: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});
