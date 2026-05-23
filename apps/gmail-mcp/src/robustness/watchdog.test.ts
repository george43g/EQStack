import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMonotonicallyGrowing } from "./watchdog.js";

describe("isMonotonicallyGrowing", () => {
  it("returns false for fewer than 2 samples", () => {
    expect(isMonotonicallyGrowing([])).toBe(false);
    expect(isMonotonicallyGrowing([100])).toBe(false);
  });

  it("returns true for clean monotonic growth past 5MB", () => {
    expect(isMonotonicallyGrowing([10, 11, 12, 13, 14, 15])).toBe(true);
    expect(isMonotonicallyGrowing([100, 105, 110])).toBe(true);
  });

  it("returns false when any sample drops", () => {
    expect(isMonotonicallyGrowing([10, 11, 10, 12, 15])).toBe(false);
    expect(isMonotonicallyGrowing([100, 99, 100, 101])).toBe(false);
  });

  it("returns false for plateau / flat samples below 5MB total", () => {
    expect(isMonotonicallyGrowing([100, 100, 100, 100])).toBe(false);
  });

  it("returns false when total growth is under 5MB", () => {
    expect(isMonotonicallyGrowing([100, 100.5, 101, 101.5, 102])).toBe(false);
  });

  it("treats equal consecutive values as still monotonic", () => {
    expect(isMonotonicallyGrowing([10, 10, 11, 12, 15])).toBe(true);
  });

  it("boundary: total growth of exactly 5 returns true", () => {
    expect(isMonotonicallyGrowing([10, 11, 12, 13, 14, 15])).toBe(true);
  });

  it("boundary: total growth of 4 returns false", () => {
    expect(isMonotonicallyGrowing([10, 11, 12, 13, 14])).toBe(false);
  });
});

describe("noteActivity / readWatchdogState", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("noteActivity stamps the current Date.now() onto state.lastActivityTs", async () => {
    // Use fresh module so other suites don't bleed activity timestamps in.
    vi.resetModules();
    const mod = await import("./watchdog.js");
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mod.noteActivity();
    const snapshot = mod.readWatchdogState();
    expect(snapshot.lastActivityTs).toBe(1_700_000_000_000);

    dateSpy.mockReturnValue(1_700_000_005_000);
    mod.noteActivity();
    expect(mod.readWatchdogState().lastActivityTs).toBe(1_700_000_005_000);
  });

  it("readWatchdogState returns a live reference to the same state object", async () => {
    vi.resetModules();
    const mod = await import("./watchdog.js");
    const first = mod.readWatchdogState();
    const second = mod.readWatchdogState();
    expect(second).toBe(first);
    // Default-shape sanity check — these keys must exist for health_check.
    expect(first).toMatchObject({
      startedAt: expect.any(Number),
      eventLoopP99Ms: expect.any(Number),
      eventLoopMaxMs: expect.any(Number),
      rssMb: expect.any(Number),
      heapMb: expect.any(Number),
      heapHistory: expect.any(Array),
      lastActivityTs: expect.any(Number),
      killReason: null,
    });
  });
});

describe("onMemorySample subscriber + installWatchdog memory tick", () => {
  const ORIGINAL_ENV: Record<string, string | undefined> = {};
  const KEYS = [
    "MCP_EVENT_LOOP_SAMPLE_MS",
    "MCP_MEMORY_SAMPLE_MS",
    "MCP_MAX_RSS_MB",
    "MCP_HEAP_GROWTH_SAMPLES",
    "MCP_IDLE_CHECK_MS",
    "MCP_RESTART_AFTER_MS",
    "MCP_RESTART_QUIET_MS",
  ] as const;

  beforeEach(() => {
    for (const k of KEYS) ORIGINAL_ENV[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL_ENV[k];
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fan-outs to every subscriber on each memory sample tick", async () => {
    // Tight tick so the fake timer drives it deterministically.
    process.env.MCP_MEMORY_SAMPLE_MS = "100";
    process.env.MCP_EVENT_LOOP_SAMPLE_MS = "9999999";
    process.env.MCP_IDLE_CHECK_MS = "9999999";
    process.env.MCP_MAX_RSS_MB = "10000"; // high — don't kill on sample
    process.env.MCP_HEAP_GROWTH_SAMPLES = "9999";

    vi.useFakeTimers();
    vi.resetModules();

    // Stub memoryUsage BEFORE installing so the first tick sees our values.
    const memSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 50 * 1024 * 1024,
      heapTotal: 30 * 1024 * 1024,
      heapUsed: 20 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    } as ReturnType<typeof process.memoryUsage>);

    const mod = await import("./watchdog.js");
    const shutdownMod = await import("./shutdown.js");
    shutdownMod._resetForTests();

    const a = vi.fn();
    const b = vi.fn();
    mod.onMemorySample(a);
    const unsubB = mod.onMemorySample(b);

    mod.installWatchdog();
    vi.advanceTimersByTime(120); // one tick

    expect(a).toHaveBeenCalledWith(50, 20);
    expect(b).toHaveBeenCalledWith(50, 20);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    // After unsubscribe, only `a` keeps firing.
    unsubB();
    vi.advanceTimersByTime(100); // one more tick
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);

    memSpy.mockRestore();
  });

  it("a throwing subscriber must not break the watchdog or other subscribers", async () => {
    process.env.MCP_MEMORY_SAMPLE_MS = "100";
    process.env.MCP_EVENT_LOOP_SAMPLE_MS = "9999999";
    process.env.MCP_IDLE_CHECK_MS = "9999999";
    process.env.MCP_MAX_RSS_MB = "10000";
    process.env.MCP_HEAP_GROWTH_SAMPLES = "9999";

    vi.useFakeTimers();
    vi.resetModules();

    vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 10 * 1024 * 1024,
      heapTotal: 5 * 1024 * 1024,
      heapUsed: 4 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    } as ReturnType<typeof process.memoryUsage>);

    const mod = await import("./watchdog.js");
    const shutdownMod = await import("./shutdown.js");
    shutdownMod._resetForTests();

    const survivor = vi.fn();
    mod.onMemorySample(() => {
      throw new Error("subscriber blew up");
    });
    mod.onMemorySample(survivor);

    mod.installWatchdog();
    vi.advanceTimersByTime(120);

    expect(survivor).toHaveBeenCalledTimes(1);
  });
});

describe("triggerKill via RSS overrun (one-shot semantics)", () => {
  const ORIGINAL_ENV: Record<string, string | undefined> = {};
  const KEYS = [
    "MCP_EVENT_LOOP_SAMPLE_MS",
    "MCP_MEMORY_SAMPLE_MS",
    "MCP_MAX_RSS_MB",
    "MCP_HEAP_GROWTH_SAMPLES",
    "MCP_IDLE_CHECK_MS",
    "MCP_RESTART_AFTER_MS",
    "MCP_RESTART_QUIET_MS",
  ] as const;

  beforeEach(() => {
    for (const k of KEYS) ORIGINAL_ENV[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL_ENV[k];
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs an error, invokes shutdown, sets killReason — and does not fire twice", async () => {
    process.env.MCP_MEMORY_SAMPLE_MS = "100";
    process.env.MCP_EVENT_LOOP_SAMPLE_MS = "9999999";
    process.env.MCP_IDLE_CHECK_MS = "9999999";
    process.env.MCP_MAX_RSS_MB = "100"; // tiny cap so any sample trips it
    process.env.MCP_HEAP_GROWTH_SAMPLES = "9999";

    vi.useFakeTimers();
    vi.resetModules();

    // Way above the 100MB cap, so triggerKill fires immediately.
    vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 500 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      heapUsed: 80 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    } as ReturnType<typeof process.memoryUsage>);

    // Stub process.exit so the force-exit fallback can't kill the runner.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const shutdownMod = await import("./shutdown.js");
    shutdownMod._resetForTests();
    const loggerMod = await import("./logger.js");
    loggerMod.clearLogs();

    const mod = await import("./watchdog.js");

    expect(mod.readWatchdogState().killReason).toBeNull();

    mod.installWatchdog();
    // Trigger the very first memory sample.
    await vi.advanceTimersByTimeAsync(120);

    const stateAfterFirst = mod.readWatchdogState();
    expect(stateAfterFirst.killReason).toBe("rss_exceeded");

    // The error log line emitted by triggerKill should include the reason tag.
    const logs = loggerMod.getLogs();
    const killLine = logs.find((l) => l.includes("watchdog_kill: rss_exceeded"));
    expect(killLine).toBeDefined();
    expect(killLine).toContain("rss_mb");

    // Shutdown invoked, exit code 1 (per triggerKill → shutdown(1)).
    // exitSpy is hit by shutdown() AND by the 5s force-exit fallback;
    // both paths converge here. We only care that it was called.
    expect(exitSpy).toHaveBeenCalled();

    // Drive another tick — killReason is one-shot; should remain `rss_exceeded`
    // and no second `watchdog_kill` line should appear in the ring.
    await vi.advanceTimersByTimeAsync(200);
    expect(mod.readWatchdogState().killReason).toBe("rss_exceeded");
    const killLines = loggerMod.getLogs().filter((l) => l.includes("watchdog_kill: rss_exceeded"));
    expect(killLines.length).toBe(1);
  });
});
