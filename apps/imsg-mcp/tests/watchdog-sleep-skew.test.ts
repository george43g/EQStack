/**
 * Sleep-skew detection: when macOS suspends, the perf_hooks event-loop
 * histogram keeps accumulating delays as if the loop was blocked for the
 * entire sleep duration. Without skew detection, the next sample after a
 * wake-up sees p99 of minutes (or hours) and kills the process.
 *
 * The watchdog avoids this by checking the wall-clock interval between
 * samples. If the interval is much larger than the configured sample
 * interval, it treats the gap as system sleep, resets the histogram, and
 * skips threshold evaluation.
 *
 * This test pins the heuristic: when invoked at the source level the
 * sleep-skew branch must exist and reference a 3× interval multiplier.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "../src/watchdog.ts"), "utf8");

describe("watchdog sleep-skew detection", () => {
  it("checks wall-clock interval against 3× the sample interval", () => {
    // The branch must reference `EVENT_LOOP_SAMPLE_MS` and a multiplier (3).
    // If the multiplier is changed, the test should be updated explicitly.
    expect(SRC).toMatch(/interval > 3 \* EVENT_LOOP_SAMPLE_MS/);
  });

  it("emits a sleep_detected_skipping_sample log on skew", () => {
    expect(SRC).toContain('"sleep_detected_skipping_sample"');
  });

  it("resets the histogram + sustained counter before returning", () => {
    // The branch order matters: reset → log → return early (no threshold check).
    const branch = SRC.match(
      /if \(interval > 3 \* EVENT_LOOP_SAMPLE_MS\) \{[\s\S]*?return;\s*\}/,
    )?.[0];
    expect(branch, "could not find sleep-skew branch").toBeTruthy();
    expect(branch).toContain("eventLoopHistogram.reset()");
    expect(branch).toContain("eventLoopSustainedCount = 0");
  });

  it("tracks lastEventLoopSampleTs in state", () => {
    expect(SRC).toContain("lastEventLoopSampleTs");
  });
});
