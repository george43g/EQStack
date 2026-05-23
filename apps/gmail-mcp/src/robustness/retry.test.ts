import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTransientError, withRetry } from "./retry.js";

describe("isTransientError", () => {
  it.each([
    Object.assign(new Error("nope"), { code: 429 }),
    Object.assign(new Error("server error"), { code: 503 }),
    Object.assign(new Error("server error"), { status: 502 }),
    Object.assign(new Error("server error"), { response: { status: 504 } }),
    Object.assign(new Error("network"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("network"), { code: "ECONNRESET" }),
    Object.assign(new Error("dns"), { code: "ENOTFOUND" }),
  ])("returns true for transient %s", (err) => {
    expect(isTransientError(err)).toBe(true);
  });

  it.each([
    new Error("validation failed"),
    Object.assign(new Error("auth"), { code: 401 }),
    Object.assign(new Error("forbidden"), { code: 403 }),
    Object.assign(new Error("not found"), { status: 404 }),
    null,
    undefined,
  ])("returns false for non-transient %s", (err) => {
    expect(isTransientError(err)).toBe(false);
  });
});

describe("withRetry", () => {
  let immediateTimer: (cb: () => void, _ms: number) => void;

  beforeEach(() => {
    immediateTimer = (cb, _ms) => setImmediate(cb);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const out = await withRetry(fn, { timer: immediateTimer });
    expect(out).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient error and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("503"), { code: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error("503"), { code: 503 }))
      .mockResolvedValue("ok");
    const out = await withRetry(fn, { maxAttempts: 5, timer: immediateTimer });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxAttempts and re-throws", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("retry"), { code: 503 }));
    await expect(withRetry(fn, { maxAttempts: 3, timer: immediateTimer })).rejects.toThrow("retry");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-transient errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("validation"));
    await expect(withRetry(fn, { maxAttempts: 5, timer: immediateTimer })).rejects.toThrow(
      "validation",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects custom shouldRetry predicate", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error("custom");
      return "done";
    });
    const out = await withRetry(fn, {
      maxAttempts: 5,
      shouldRetry: (err) => (err as Error).message === "custom",
      timer: immediateTimer,
    });
    expect(out).toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("withRetry backoff schedule (jitter + cap)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCapturingTimer() {
    const delays: number[] = [];
    const timer = (cb: () => void, ms: number) => {
      delays.push(ms);
      setImmediate(cb);
    };
    return { delays, timer };
  }

  it("emits exponential backoff with no jitter when jitter=false", async () => {
    const { delays, timer } = makeCapturingTimer();
    const transient = () => Object.assign(new Error("503"), { code: 503 });
    const fn = vi.fn(async () => {
      throw transient();
    });

    await expect(
      withRetry(fn, {
        maxAttempts: 4,
        baseMs: 100,
        capMs: 10_000,
        jitter: false,
        timer,
      }),
    ).rejects.toBeDefined();

    // Attempts 1..3 trigger a delay (last attempt re-throws without scheduling).
    // base * 2^(attempt-1) → 100, 200, 400.
    expect(delays).toEqual([100, 200, 400]);
  });

  it("with deterministic Math.random=0, jitter contributes 0 — pure exponential", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { delays, timer } = makeCapturingTimer();
    const transient = () => Object.assign(new Error("503"), { code: 503 });
    const fn = vi.fn(async () => {
      throw transient();
    });

    await expect(
      withRetry(fn, {
        maxAttempts: 4,
        baseMs: 50,
        capMs: 10_000,
        jitter: true,
        timer,
      }),
    ).rejects.toBeDefined();
    // Math.random()*baseMs = 0 → equals no-jitter path.
    expect(delays).toEqual([50, 100, 200]);
  });

  it("with Math.random=0.999, jitter adds ~baseMs — still capped at capMs", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const { delays, timer } = makeCapturingTimer();
    const transient = () => Object.assign(new Error("503"), { code: 503 });
    const fn = vi.fn(async () => {
      throw transient();
    });

    // baseMs=1000, capMs=2500. exp = min(cap, base*2^(n-1)).
    // attempt 1: exp=1000, +999.x jitter, capped at 2500 → ~1999.x
    // attempt 2: exp=2000, +999.x jitter, capped at 2500 → 2500
    // attempt 3: exp=min(2500, 4000)=2500, +999.x jitter → capped at 2500
    await expect(
      withRetry(fn, {
        maxAttempts: 4,
        baseMs: 1000,
        capMs: 2500,
        jitter: true,
        timer,
      }),
    ).rejects.toBeDefined();

    expect(delays.length).toBe(3);
    expect(delays[0]).toBeGreaterThan(1000);
    expect(delays[0]).toBeLessThanOrEqual(2500);
    expect(delays[1]).toBe(2500);
    expect(delays[2]).toBe(2500);
    // Hard cap invariant: nothing ever exceeds capMs.
    for (const d of delays) expect(d).toBeLessThanOrEqual(2500);
  });
});
