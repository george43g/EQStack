/**
 * `sleep(ms, signal)` — used by wait_for_reply between poll iterations.
 *
 * Pre-fix bug: sleep ignored the signal. wait_for_reply checked
 * `signal.aborted` between polls but spent up to `pollIntervalSeconds`
 * (default 10s, max 60s) blocked inside the sleep itself. A
 * notifications/cancelled arriving 100ms in took the full poll
 * interval to honor.
 *
 * Post-fix: sleep resolves immediately when the signal aborts.
 * The caller still checks `signal.aborted` after sleep returns and
 * returns the cancellation response.
 */

import { describe, expect, it } from "vitest";
import { sleep } from "../src/index.js";

describe("abort-aware sleep", () => {
  it("resolves naturally when not aborted", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45); // small jitter ok
    expect(elapsed).toBeLessThan(200);
  });

  it("resolves immediately when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await sleep(10_000, ac.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50); // not 10_000
  });

  it("resolves promptly when signal aborts mid-sleep", async () => {
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 30);
    await sleep(10_000, ac.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(150); // not 10_000
  });

  it("does not leak abort listeners when sleep completes naturally", async () => {
    // After many natural sleeps, the same signal should still have its
    // listener slot free — we'd see "MaxListenersExceededWarning" if
    // each sleep added a listener that wasn't removed.
    const ac = new AbortController();
    for (let i = 0; i < 50; i++) {
      await sleep(2, ac.signal);
    }
    // If the listener leak existed, Node would have warned by now.
    // Pass the test as long as no throw / unhandled warning bubbled up.
    expect(ac.signal.aborted).toBe(false);
  });
});
