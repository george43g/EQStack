/**
 * Startup / shutdown observability (swarm finding A5, P3 batch).
 *
 * Three gaps in the postmortem trail, all found by reading real NDJSON from a
 * driven session rather than by reading code:
 *
 *  1. Every exit logged `reason: "normal"` — user quit, SIGTERM from a
 *     supervisor, watchdog self-kill and uncaught exception were
 *     indistinguishable in the one line a postmortem starts from.
 *  2. The startup line never recorded which engine won (Rust native vs the TS
 *     fallback), so a perf report from a log file could not be interpreted
 *     without also knowing whether the native module was built on that machine.
 *  3. `readWatchdogState()` reported rssMb/heapMb as 0 until the 60s sampler
 *     first fired — so a just-started process looked like it was using no
 *     memory during exactly the window someone debugging startup is watching.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("shutdown cause", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("defaults to 'normal' when nothing signalled a cause", async () => {
    const { getShutdownCause } = await import("../src/shutdown.js");
    expect(getShutdownCause()).toBe("normal");
  });

  it("records an explicit cause", async () => {
    const { getShutdownCause, noteShutdownCause } = await import("../src/shutdown.js");
    noteShutdownCause("watchdog:rss_exceeded");
    expect(getShutdownCause()).toBe("watchdog:rss_exceeded");
  });

  it("keeps the FIRST cause — the initiating event, not the follow-on", async () => {
    const { getShutdownCause, noteShutdownCause } = await import("../src/shutdown.js");
    // A watchdog kill triggers a shutdown which may itself surface further
    // lifecycle events; the kill is the informative one.
    noteShutdownCause("watchdog:event_loop_blocked");
    noteShutdownCause("signal:SIGTERM");
    expect(getShutdownCause()).toBe("watchdog:event_loop_blocked");
  });

  it("is resettable for tests", async () => {
    const { _resetShutdownCause, getShutdownCause, noteShutdownCause } = await import(
      "../src/shutdown.js"
    );
    noteShutdownCause("signal:SIGHUP");
    expect(getShutdownCause()).toBe("signal:SIGHUP");
    _resetShutdownCause();
    expect(getShutdownCause()).toBe("normal");
  });
});

describe("startup marker", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /** `getLogs()` yields formatted lines: "<ts> [level] <msg> {json}". */
  function startupPayload(lines: string[]): Record<string, unknown> {
    const line = lines.find((l) => l.includes(" startup "));
    expect(line, "no startup line in the ring buffer").toBeDefined();
    const json = line?.slice(line.indexOf("{"));
    return JSON.parse(json ?? "{}") as Record<string, unknown>;
  }

  it("carries caller-supplied fields such as the active engine", async () => {
    const { clearLogs, getLogs, logStartup } = await import("../src/logger.js");
    clearLogs();
    logStartup("mcp-server", { engine: "Rust parser + TS DB" });
    const data = startupPayload(getLogs());
    expect(data.engine).toBe("Rust parser + TS DB");
    expect(data.entrypoint).toBe("mcp-server");
  });

  it("still logs the baseline fields when no extras are passed", async () => {
    const { clearLogs, getLogs, logStartup } = await import("../src/logger.js");
    clearLogs();
    logStartup("tui");
    const data = startupPayload(getLogs());
    expect(data.entrypoint).toBe("tui");
    expect(data.pid).toBe(process.pid);
    expect(data.engine).toBeUndefined();
  });
});

describe("watchdog state memory reporting", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("never reports 0MB before the first 60s sample lands", async () => {
    const { readWatchdogState } = await import("../src/watchdog.js");
    // Read immediately — the sampler has not fired.
    const state = readWatchdogState();
    expect(state.rssMb).toBeGreaterThan(0);
    expect(state.heapMb).toBeGreaterThan(0);
  });

  it("reports a plausible live reading, not a placeholder", async () => {
    const { readWatchdogState } = await import("../src/watchdog.js");
    const state = readWatchdogState();
    const liveRssMb = process.memoryUsage().rss / 1024 / 1024;
    // Same measurement the sampler takes, so it should be in the same
    // ballpark — generous bounds, this is a sanity check not a benchmark.
    expect(state.rssMb).toBeGreaterThan(liveRssMb * 0.5);
    expect(state.rssMb).toBeLessThan(liveRssMb * 2);
  });
});
