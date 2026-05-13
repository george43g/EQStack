import { describe, expect, it } from "vitest";
import { TokenBucket } from "./rate-limit.js";

function makeFakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function makeFakeSleep(clock: { advance: (ms: number) => void }) {
  return async (ms: number) => {
    clock.advance(ms);
  };
}

describe("TokenBucket", () => {
  it("starts at capacity", () => {
    const b = new TokenBucket(5, 1);
    expect(b.available()).toBe(5);
  });

  it("acquire deducts tokens up to capacity without waiting", async () => {
    const c = makeFakeClock();
    const b = new TokenBucket(5, 1, c.now, makeFakeSleep(c));
    await b.acquire();
    expect(b.available()).toBeCloseTo(4, 5);
    await b.acquire(3);
    expect(b.available()).toBeCloseTo(1, 5);
  });

  it("waits when bucket is empty, then refills", async () => {
    const c = makeFakeClock();
    const b = new TokenBucket(2, 1, c.now, makeFakeSleep(c));
    await b.acquire(); // tokens 2 → 1
    await b.acquire(); // tokens 1 → 0
    const before = c.now();
    await b.acquire(); // must wait ~1000ms for one token
    const elapsed = c.now() - before;
    expect(elapsed).toBeGreaterThanOrEqual(1000);
  });

  it("acquire(0) is a no-op", async () => {
    const c = makeFakeClock();
    const b = new TokenBucket(1, 1, c.now, makeFakeSleep(c));
    await b.acquire(0);
    expect(b.available()).toBe(1);
  });

  it("rps=0 disables waiting (acquire returns immediately)", async () => {
    const c = makeFakeClock();
    const b = new TokenBucket(1, 0, c.now, makeFakeSleep(c));
    // Drain the bucket — but with rps=0 the limiter is "disabled" so
    // acquire returns immediately without consuming.
    await b.acquire();
    await b.acquire();
    expect(c.now()).toBe(0);
  });

  it("refill caps at capacity (no overflow)", async () => {
    const c = makeFakeClock();
    const b = new TokenBucket(3, 1, c.now, makeFakeSleep(c));
    await b.acquire(); // tokens → 2
    c.advance(100_000); // 100s × 1rps = 100 tokens but capped
    expect(b.available()).toBeCloseTo(3, 5);
  });

  it("burst is honored: many quick acquires up to capacity", async () => {
    const c = makeFakeClock();
    const b = new TokenBucket(5, 1, c.now, makeFakeSleep(c));
    for (let i = 0; i < 5; i++) {
      await b.acquire();
    }
    expect(c.now()).toBe(0); // never had to wait
  });

  it("rejects negative capacity / rps", () => {
    expect(() => new TokenBucket(-1, 1)).toThrow();
    expect(() => new TokenBucket(1, -1)).toThrow();
  });
});
