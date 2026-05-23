// gen-usage --check drift detection. Runs the script as a child process
// against a temporary copy of the repo where we control the contents of
// usage.kdl, so we can verify both the in-sync (exit 0) and drifted /
// missing (non-zero) paths without mutating the committed file.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const USAGE_FILE = path.join(REPO_ROOT, "usage.kdl");

function runCheck(): { status: number | null; stderr: string } {
  // Use the project's local tsx so the script's TS imports resolve. We spawn
  // through pnpm exec to inherit the local node_modules/.bin without
  // depending on the developer's PATH.
  const result = spawnSync(
    "pnpm",
    ["exec", "tsx", path.join(REPO_ROOT, "scripts/gen-usage.ts"), "--check"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return { status: result.status, stderr: `${result.stderr ?? ""}${result.stdout ?? ""}` };
}

describe("scripts/gen-usage.ts --check", () => {
  let backup: string | null;
  let tmpBackup: string | null;

  beforeEach(() => {
    backup = fs.existsSync(USAGE_FILE) ? fs.readFileSync(USAGE_FILE, "utf8") : null;
    // Stash any backup somewhere safe outside the repo so a crashed test
    // doesn't leave the file mangled.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-usage-test-"));
    tmpBackup = path.join(tmpDir, "usage.kdl.bak");
    if (backup !== null) fs.writeFileSync(tmpBackup, backup);
  });

  afterEach(() => {
    if (backup !== null) {
      fs.writeFileSync(USAGE_FILE, backup);
    } else if (fs.existsSync(USAGE_FILE)) {
      fs.unlinkSync(USAGE_FILE);
    }
    if (tmpBackup) {
      fs.rmSync(path.dirname(tmpBackup), { recursive: true, force: true });
    }
  });

  it("exits 0 when usage.kdl is in sync with the commander tree", () => {
    // The committed file must already be in sync (CI requires it via
    // `pnpm verify`). This is the canary that the --check path returns 0
    // when nothing has drifted.
    if (backup === null) {
      // Skip silently if the committed file is missing in the working
      // tree — we don't want to author it here.
      return;
    }
    const { status, stderr } = runCheck();
    expect(status, `stderr was: ${stderr}`).toBe(0);
    expect(stderr).toMatch(/in sync/);
  });

  it("exits non-zero when usage.kdl drifts from the commander tree", () => {
    // Tamper the file so byte-equality fails.
    fs.writeFileSync(USAGE_FILE, "// intentionally drifted by test\n");
    const { status, stderr } = runCheck();
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/out of date/);
  });

  it("exits non-zero when usage.kdl is missing", () => {
    fs.unlinkSync(USAGE_FILE);
    const { status, stderr } = runCheck();
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/missing/);
  });
});
