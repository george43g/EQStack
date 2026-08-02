/**
 * Regression: get_logs(source:"file") must actually read the NDJSON
 * log file on disk and return its tail.
 *
 * Pre-fix bug: `getFileLogLines` did `require("node:fs")` inline. Under
 * ESM that throws ReferenceError, was caught by an empty `catch {}`, and
 * the function returned []. The MCP responded with "No file log
 * entries." even when a multi-hundred-line NDJSON file sat right next
 * to it in `$TMPDIR/imsg-mcp/`.
 *
 * Post-fix: the fs imports live at the top of `logger.ts` (ESM-correct)
 * and the function also prefers files tagged with the current PID so
 * the caller sees logs from this server, not a stale crashed instance.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFileLogLines } from "../src/logger.js";

const ORIG_TMPDIR = process.env.TMPDIR;
let workDir: string;
let logDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "imsg-logs-test-"));
  process.env.TMPDIR = workDir;
  logDir = join(workDir, "imsg-mcp");
  // log dir is created lazily by the logger; mirror that here.
});

afterEach(() => {
  process.env.TMPDIR = ORIG_TMPDIR;
});

describe("getFileLogLines", () => {
  it("returns [] when the log dir doesn't exist (no false positives)", () => {
    expect(getFileLogLines(50)).toEqual([]);
  });

  it("reads the NDJSON file written by the logger", () => {
    // Simulate a logger-written file in $TMPDIR/imsg-mcp/.
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(logDir, { recursive: true });
    const myPid = String(process.pid);
    const file = join(logDir, `imsg-mcp-${myPid}-2026-06-04T08-00-00.ndjson`);
    const lines = [
      `{"ts":"2026-06-04T08:00:00.000Z","level":"info","msg":"startup","mem_mb":20.0}`,
      `{"ts":"2026-06-04T08:00:01.000Z","level":"perf","msg":"op","dur_ms":42,"mem_mb":20.1}`,
      `{"ts":"2026-06-04T08:00:02.000Z","level":"warn","msg":"heap exceeds","mem_mb":160.0}`,
    ];
    writeFileSync(file, `${lines.join("\n")}\n`);

    const got = getFileLogLines(50);
    expect(got).toHaveLength(3);
    expect(got[0]).toContain('"msg":"startup"');
    expect(got[2]).toContain('"msg":"heap exceeds"');
  });

  it("returns only the last N lines when tail is set", () => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(logDir, { recursive: true });
    const myPid = String(process.pid);
    const file = join(logDir, `imsg-mcp-${myPid}-2026-06-04T08-00-00.ndjson`);
    const lines = Array.from({ length: 20 }, (_, i) => `{"i":${i}}`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    const got = getFileLogLines(5);
    expect(got).toHaveLength(5);
    expect(got[0]).toBe('{"i":15}');
    expect(got[4]).toBe('{"i":19}');
  });

  it("prefers the current PID's file over stale files from other PIDs", () => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(logDir, { recursive: true });
    const myPid = String(process.pid);
    const stalePid = String(Number(myPid) + 1);

    // Write a stale file first (alphabetically sorts before or after, we
    // use timestamps to control order — make stale APPEAR newer).
    writeFileSync(
      join(logDir, `imsg-mcp-${stalePid}-2099-01-01T00-00-00.ndjson`),
      `{"src":"stale"}\n`,
    );
    writeFileSync(join(logDir, `imsg-mcp-${myPid}-2026-06-04T08-00-00.ndjson`), `{"src":"mine"}\n`);

    const got = getFileLogLines(10);
    expect(got).toHaveLength(1);
    expect(got[0]).toBe('{"src":"mine"}');
  });

  it("falls back to the most-recent file when no current-PID file exists", () => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, `imsg-mcp-99999-2099-01-01T00-00-00.ndjson`), `{"src":"newer"}\n`);
    writeFileSync(join(logDir, `imsg-mcp-99998-2025-01-01T00-00-00.ndjson`), `{"src":"older"}\n`);
    const got = getFileLogLines(10);
    expect(got).toHaveLength(1);
    expect(got[0]).toBe('{"src":"newer"}');
  });
});

// Sanity: the log dir was actually created somewhere we can clean up.
describe("getFileLogLines smoke", () => {
  it("existsSync probe is honest about missing dirs", () => {
    expect(existsSync(join(workDir, "imsg-mcp-missing"))).toBe(false);
  });
});
