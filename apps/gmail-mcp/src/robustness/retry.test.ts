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
