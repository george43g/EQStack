import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTests,
  isShuttingDown,
  registerCleanup,
  shutdown,
  unregisterCleanup,
} from "./shutdown.js";

describe("shutdown registry", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetForTests();
    // process.exit is called by shutdown(); stub it so the test runner survives.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _resetForTests();
  });

  it("runs each registered cleanup once", async () => {
    const a = vi.fn();
    const b = vi.fn();
    registerCleanup(a);
    registerCleanup(b);
    await shutdown(0);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("runs cleanups in registration order", async () => {
    const calls: string[] = [];
    registerCleanup(() => {
      calls.push("first");
    });
    registerCleanup(() => {
      calls.push("second");
    });
    registerCleanup(() => {
      calls.push("third");
    });
    await shutdown(0);
    expect(calls).toEqual(["first", "second", "third"]);
  });

  it("supports async cleanups", async () => {
    const calls: string[] = [];
    registerCleanup(async () => {
      await new Promise((r) => setTimeout(r, 10));
      calls.push("a");
    });
    registerCleanup(() => {
      calls.push("b");
    });
    await shutdown(0);
    expect(calls).toEqual(["a", "b"]);
  });

  it("ignores errors thrown by cleanups", async () => {
    const a = vi.fn(() => {
      throw new Error("boom");
    });
    const b = vi.fn();
    registerCleanup(a);
    registerCleanup(b);
    await expect(shutdown(0)).resolves.toBeUndefined();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("does not re-run cleanups on second shutdown call", async () => {
    const a = vi.fn();
    registerCleanup(a);
    await shutdown(0);
    // Second call — should not run a again
    shutdown(0);
    // Give the second call a microtask to settle
    await new Promise((r) => setImmediate(r));
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("isShuttingDown reports state", async () => {
    expect(isShuttingDown()).toBe(false);
    const promise = shutdown(0);
    expect(isShuttingDown()).toBe(true);
    await promise;
  });

  it("unregisterCleanup removes a cleanup", async () => {
    const a = vi.fn();
    const b = vi.fn();
    registerCleanup(a);
    registerCleanup(b);
    unregisterCleanup(a);
    await shutdown(0);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("calls process.exit with the supplied code", async () => {
    await shutdown(7);
    expect(exitSpy).toHaveBeenCalledWith(7);
  });
});
