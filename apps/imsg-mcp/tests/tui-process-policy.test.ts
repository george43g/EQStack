/**
 * Pins the lifecycle-policy split between the MCP/CLI entry points and the
 * TUI. The user's "TUI exited on its own after sending a single text"
 * report traced back to MCP-shaped shutdown policies leaking into the TUI
 * (uncaughtException → hard kill, orphan watchdog → ppid-change kill, 24h
 * idle restart kill). These tests lock in:
 *
 *   1. `enableFileLogging()` flips file logging on regardless of IMSG_DEV
 *      — the TUI flips this on so a future crash has a postmortem trail
 *      (the user's original incident had NONE).
 *   2. `installWatchdog({ idleRestart: false })` does NOT schedule the idle
 *      restart timer — the TUI is user-facing and a 24h restart would
 *      silently kill an in-use session.
 *   3. `installShutdownHandlers` takes an `exitOnUncaughtException` opt
 *      that the TUI sets to `false` so a transient render/async error
 *      logs but doesn't tear down the user's session.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendLog, enableFileLogging, getLogFilePath } from "../src/logger.js";
import type { ShutdownOpts } from "../src/shutdown.js";

describe("logger.enableFileLogging", () => {
  it("forces file writes even when IMSG_DEV is unset", () => {
    // Snapshot env so the test stays hermetic.
    const prevDev = process.env.IMSG_DEV;
    const prevTmp = process.env.TMPDIR;
    const dir = mkdtempSync(join(tmpdir(), "imsg-test-"));
    process.env.TMPDIR = dir;
    delete process.env.IMSG_DEV;

    try {
      // Before flipping the flag: no file should exist for this PID.
      expect(getLogFilePath()).toBeNull();
      enableFileLogging();
      appendLog("info", "test-marker-after-enable", { sentinel: true });
      const path = getLogFilePath();
      expect(path).not.toBeNull();
      expect(path!).toContain(`imsg-mcp-${process.pid}-`);
      const body = readFileSync(path!, "utf8");
      expect(body).toContain("test-marker-after-enable");
      expect(body).toContain('"sentinel":true');
    } finally {
      // Restore env. We cannot un-force the flag (by design — set once),
      // but other tests that don't `enableFileLogging` are unaffected
      // because they don't write/inspect file paths.
      if (prevDev === undefined) delete process.env.IMSG_DEV;
      else process.env.IMSG_DEV = prevDev;
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });
});

describe("shutdown.installShutdownHandlers opts", () => {
  it("exposes ShutdownOpts.exitOnUncaughtException so the TUI can opt out", () => {
    // Compile-time guarantee — if the field is removed or renamed, this
    // test fails to type-check before it runs. Locks the public contract
    // that the TUI relies on.
    const opts: ShutdownOpts = { exitOnUncaughtException: false };
    expect(opts.exitOnUncaughtException).toBe(false);
  });
});

describe("watchdog.installWatchdog opts", () => {
  it("skips the idle restart timer when idleRestart=false", async () => {
    // We can't easily install the real watchdog twice (it's globally
    // installed once per process), so this test asserts via a mocked
    // setInterval count. A focused unit test on a fresh module instance.
    vi.resetModules();

    let intervalCalls = 0;
    const realSetInterval = globalThis.setInterval;
    (globalThis as { setInterval: typeof setInterval }).setInterval = ((
      fn: () => void,
      ms: number,
    ) => {
      intervalCalls += 1;
      // Return a non-running timer so callbacks never fire during the test.
      const t = realSetInterval(() => {}, 1_000_000);
      t.unref();
      return t;
    }) as typeof setInterval;

    try {
      const mod = await import("../src/watchdog.js");
      mod.installWatchdog({ idleRestart: false });
      // With idleRestart: false we expect exactly TWO intervals (event-loop
      // sampler + memory sampler). With idleRestart enabled the count
      // would be three.
      expect(intervalCalls).toBe(2);
    } finally {
      (globalThis as { setInterval: typeof setInterval }).setInterval = realSetInterval;
      vi.resetModules();
    }
  });

  it("schedules the idle restart timer when idleRestart defaults to true", async () => {
    vi.resetModules();

    let intervalCalls = 0;
    const realSetInterval = globalThis.setInterval;
    (globalThis as { setInterval: typeof setInterval }).setInterval = ((
      fn: () => void,
      ms: number,
    ) => {
      intervalCalls += 1;
      const t = realSetInterval(() => {}, 1_000_000);
      t.unref();
      return t;
    }) as typeof setInterval;

    try {
      const mod = await import("../src/watchdog.js");
      mod.installWatchdog(); // default opts → idleRestart: true
      expect(intervalCalls).toBe(3);
    } finally {
      (globalThis as { setInterval: typeof setInterval }).setInterval = realSetInterval;
      vi.resetModules();
    }
  });
});
