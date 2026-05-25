// E2E against the built `dist/cli/index.js` binary. Spawns the CLI as a
// subprocess with the e2e environment so we exercise the actual published
// shape (commander wiring, env loading, exit codes) — not just in-process
// imports.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_BIN = path.join(REPO_ROOT, "dist/cli/index.js");
const NODE = process.execPath;

function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(NODE, [CLI_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("e2e: gmail CLI binary against fixtures", () => {
  it("`gmail account list --json` returns the fixture manifest", () => {
    const { status, stdout } = runCli(["account", "list", "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as Array<{ id: string; isDefault: boolean }>;
    expect(parsed.map((a) => a.id).sort()).toEqual(["personal", "work"]);
    expect(parsed.find((a) => a.id === "work")?.isDefault).toBe(true);
  });

  it("`gmail account current --json` reports work as the active account", () => {
    const { status, stdout } = runCli(["account", "current", "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { id: string; source: string };
    expect(parsed.id).toBe("work");
    // Source is "env" because the e2e setup stamps GMAIL_ACCOUNT=work into
    // the subprocess env. Either source is valid — assert the chain resolved.
    expect(["env", "manifest-default"]).toContain(parsed.source);
  });

  it("`gmail search 'in:inbox' --json` returns fixture results for the work account", () => {
    const { status, stdout } = runCli(["search", "in:inbox", "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      resultCount: number;
      results: Array<{ id: string | null; subject?: string }>;
    };
    expect(parsed.resultCount).toBeGreaterThanOrEqual(2);
    // Work-account fixture messages all have subjects we can spot-check.
    const subjects = parsed.results.map((r) => r.subject ?? "");
    expect(subjects.some((s) => s.includes("Release 1.2.3"))).toBe(true);
  });

  it("`gmail --account personal search 'in:inbox' --json` returns personal-account results", () => {
    const { status, stdout } = runCli(["--account", "personal", "search", "in:inbox", "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      resultCount: number;
      results: Array<{ subject?: string }>;
    };
    expect(parsed.resultCount).toBeGreaterThanOrEqual(1);
    const subjects = parsed.results.map((r) => r.subject ?? "");
    expect(subjects.some((s) => s.toLowerCase().includes("newsletter"))).toBe(true);
    // Cross-check: work-account subjects should NOT appear under personal.
    expect(subjects.some((s) => s.includes("Release 1.2.3"))).toBe(false);
  });

  it("`gmail health --json` returns a status snapshot without touching Gmail", () => {
    const { status, stdout } = runCli(["health", "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { status: string; pid: number };
    expect(["healthy", "degraded", "unhealthy"]).toContain(parsed.status);
    expect(typeof parsed.pid).toBe("number");
  });
});
