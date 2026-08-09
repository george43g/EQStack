/**
 * Behavioural pin for the watchdog's sleep-skew guard.
 *
 * Incident class: when macOS suspends, the perf_hooks event-loop histogram
 * keeps accumulating delays as if the loop was blocked for the entire sleep
 * duration. Without skew detection, the next sample after wake-up sees a p99
 * of minutes (or hours) and kills the process. The guard detects a sample
 * arriving later than `sleepSkewMultiplier × eventLoopSampleMs`, resets the
 * histogram + sustained counter, emits `sleep_detected_skipping_sample`, and
 * must NOT kill.
 *
 * Previous versions of this test regex-asserted the guard against the
 * watchdog's source text. Since the migration to `@george43g/robustness`
 * (which has no sleep-skew test of its own), this exercises the real
 * behaviour through `createWatchdog` with fake timers, so it also guards
 * against upstream regressions.
 */

import { createWatchdog } from "@george43g/robustness";
import { afterEach, describe, expect, it, vi } from "vitest";

interface Diag {
  level: string;
  event: string;
  data?: Record<string, unknown>;
}

function makeHarness() {
  const diagnostics: Diag[] = [];
  const shutdownCalls: number[] = [];
  const exits: number[] = [];
  const wd = createWatchdog({
    eventLoopSampleMs: 1_000,
    idleRestart: false,
    onDiagnostic: (d) => diagnostics.push(d),
    exit: (code) => exits.push(code),
    shutdownController: {
      registerCleanup: () => {},
      unregisterCleanup: () => {},
      isShuttingDown: () => false,
      shutdown: async (code = 0) => {
        shutdownCalls.push(code);
      },
    },
  });
  return { wd, diagnostics, shutdownCalls, exits };
}

describe("watchdog sleep-skew guard (behavioural)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips the sample, resets the sustained counter, and does not kill after a sleep gap", () => {
    vi.useFakeTimers();
    const { wd, diagnostics, shutdownCalls, exits } = makeHarness();
    wd.install();
    try {
      // Simulate lid-close: wall clock jumps far past 3× the sample interval
      // before the next interval tick fires.
      vi.setSystemTime(Date.now() + 60_000);
      vi.advanceTimersByTime(1_000);

      const skip = diagnostics.find((d) => d.event === "sleep_detected_skipping_sample");
      expect(skip, "sleep gap must emit the skip diagnostic").toBeDefined();
      expect(skip?.level).toBe("info");
      // The reported gap is the real elapsed wall time, well past 3× 1000ms.
      expect(Number(skip?.data?.actual_interval_ms)).toBeGreaterThan(3_000);
      expect(skip?.data?.expected_interval_ms).toBe(1_000);

      // The guard's whole point: a sleep gap must never look like lag.
      expect(diagnostics.some((d) => d.event.startsWith("watchdog_kill"))).toBe(false);
      expect(shutdownCalls).toEqual([]);
      expect(exits).toEqual([]);
      expect(wd.readState().eventLoopSustainedCount).toBe(0);
    } finally {
      wd.reset();
    }
  });

  it("samples normally at regular cadence (no spurious skip)", () => {
    vi.useFakeTimers();
    const { wd, diagnostics } = makeHarness();
    wd.install();
    try {
      vi.advanceTimersByTime(1_000);
      vi.advanceTimersByTime(1_000);
      expect(diagnostics.some((d) => d.event === "sleep_detected_skipping_sample")).toBe(false);
      // The sampler DID run: the state's sample timestamp tracked the ticks.
      expect(wd.readState().lastEventLoopSampleTs).toBe(Date.now());
    } finally {
      wd.reset();
    }
  });
});
