/**
 * CLI argument validation — Phase B step 9 regression pins.
 *
 * The hand-rolled --mode / --scope checks (Phase A ledger rows L-9/L-10) are
 * gone; the CLI now parses assembled args with the command specs' input
 * schemas and a ZodError surfaces as ONE line (`tel: field: message`), never a
 * stack trace. Validation runs before loadConfig(), so these spawns need no
 * config file — TEL_STATE_DIR/TEL_CONFIG point at a temp dir purely to keep
 * the startup migration inert (env-override).
 */
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), "tel-cli-args-"));

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      {
        cwd: appDir,
        env: {
          ...process.env,
          TEL_STATE_DIR: tmp,
          TEL_CONFIG: join(tmp, "config.json"),
        },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("cli schema validation (L-9/L-10 replaced by command specs)", () => {
  it("call --mode bogus exits 1 with a one-line schema error, no stack", async () => {
    const { code, stderr } = await runCli(["call", "x", "--objective", "y", "--mode", "bogus"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/^tel: mode: /);
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(stderr).not.toContain("at "); // no stack frames
  }, 30_000);

  it("recording delete --scope bogus exits 1 with a one-line schema error", async () => {
    const { code, stderr } = await runCli([
      "recording",
      "delete",
      "RE123",
      "--scope",
      "bogus",
      "--yes",
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/^tel: scope: /);
    expect(stderr.trim().split("\n")).toHaveLength(1);
  }, 30_000);

  it("--help lists the console command", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("console");
  }, 30_000);
});
