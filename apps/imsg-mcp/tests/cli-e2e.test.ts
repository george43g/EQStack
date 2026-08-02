/**
 * End-to-end CLI + interactive-console tests: spawn the BUILT `dist/cli.js`
 * exactly as a user or shell script would, against the synthetic fixtures
 * (`.env.test` → VITE_ENV=ai, mock sending, fixtures/*.db). Asserts real
 * stdout + exit codes so a regression in argument parsing, MCP wiring, or the
 * console REPL is caught. Read-only commands only — no messages are sent.
 *
 * Skips gracefully when `dist/cli.js` or the fixture DB is absent (fresh
 * clone before `pnpm build` / `pnpm fixtures`), matching the repo's other
 * environment-gated suites.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..");
const CLI = join(REPO, "dist", "cli.js");
const FIXTURE_DB = join(REPO, "fixtures", "chat.db");
const READY = existsSync(CLI) && existsSync(FIXTURE_DB);

const tmpHome = mkdtempSync(join(tmpdir(), "imsg-cli-e2e-"));
afterAll(() => rmSync(tmpHome, { recursive: true, force: true }));

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn `node --env-file=.env.test dist/cli.js <args>` with optional stdin. */
function runCli(args: string[], stdin?: string, timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--env-file=.env.test", CLI, ...args], {
      cwd: REPO,
      // HOME → throwaway dir so nothing touches the real ~/.imsg-mcp or
      // ~/.agents. VITE_* paths come from .env.test (fixtures/*).
      env: { ...process.env, HOME: tmpHome },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

describe.skipIf(!READY)("CLI end-to-end (fixtures)", () => {
  it("--version prints a semver", async () => {
    const { code, stdout } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help lists the core subcommands", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    for (const cmd of ["conversations", "messages", "search", "send", "export", "humans"]) {
      expect(stdout).toContain(cmd);
    }
  });

  it("list returns conversations from the fixture", async () => {
    const { code, stdout } = await runCli(["list", "3"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/conversation\(s\)/);
    // Each row leads with a bracketed handle — a `~imsg~hash` thread slug once
    // the slug store is warm, or the raw chat_identifier on a cold slugs.db
    // (single-shot CLI exits before the background slug sync persists).
    expect(stdout).toMatch(/•\s*\[[^\]]+\]/);
  });

  it("messages by <token> returns a thread", async () => {
    // Pull the first bracketed token from `list` (thread slug OR raw
    // identifier — both are valid `imsg messages` targets) and fetch it.
    const list = await runCli(["list", "5"]);
    const token = list.stdout.match(/•\s*\[([^\]]+)\]/)?.[1];
    expect(token, "no bracketed handle found in list output").toBeTruthy();
    const { code, stdout } = await runCli(["messages", token!, "5"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/message\(s\)|No messages/);
  });

  it("search runs and reports a count", async () => {
    const { code, stdout } = await runCli(["search", "the", "5"]);
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toMatch(/message|match|found|no /);
  });

  it("contacts search returns results", async () => {
    const { code, stdout } = await runCli(["contacts", "search", "a", "3"]);
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("humans top prints the relationship leaderboard", async () => {
    const { code, stdout } = await runCli(["humans", "top"]);
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toMatch(/leaderboard|relationship|score|no ranked/);
  });

  it("tools lists the available MCP tools", async () => {
    const { code, stdout } = await runCli(["tools"]);
    expect(code).toBe(0);
    expect(stdout).toContain("send_message");
    expect(stdout).toContain("get_messages");
  });

  it("analytics <type> renders each implemented analytic", async () => {
    // Wide window so the fixture's dated messages fall inside it.
    const { code, stdout } = await runCli(["analytics", "relationship_leaderboard", "1825"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Computed relationship_leaderboard|Cached relationship_leaderboard/);
  });

  it("analytics --json emits valid parseable JSON", async () => {
    const { code, stdout } = await runCli([
      "analytics",
      "relationship_leaderboard",
      "1825",
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.type).toBe("relationship_leaderboard");
    expect(Array.isArray(parsed.data.leaderboard)).toBe(true);
    // Handles must survive as strings, not be coerced to numbers.
    if (parsed.data.leaderboard.length > 0) {
      expect(typeof parsed.data.leaderboard[0].handle).toBe("string");
    }
  });

  it("analytics --yaml emits a leading structural key", async () => {
    const { code, stdout } = await runCli(["analytics", "messaging_streaks", "1825", "--yaml"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^type: messaging_streaks/m);
    expect(stdout).toContain("data:");
  });

  it("an unknown subcommand exits non-zero", async () => {
    const { code } = await runCli(["definitely-not-a-command"]);
    expect(code).not.toBe(0);
  });
});

describe.skipIf(!READY)("interactive console (piped stdin)", () => {
  it("runs a script of commands and exits cleanly on EOF", async () => {
    // No trailing `quit` — EOF (stdin close) must exit on its own.
    const { code, stdout } = await runCli(["console"], "list 2\nhelp\n", 25_000);
    expect(code).toBe(0);
    expect(stdout).toMatch(/conversation\(s\)/);
    // `help` prints the command reference.
    expect(stdout).toContain("conversations");
  });

  it("reports an error for a bad command but keeps the session alive", async () => {
    const { code, stdout, stderr } = await runCli(["console"], "frobnicate\nlist 1\n", 25_000);
    expect(code).toBe(0);
    // The bad command surfaces an error, then `list` still runs.
    expect(`${stdout}${stderr}`).toMatch(/Unknown command/);
    expect(stdout).toMatch(/conversation\(s\)/);
  });
});
