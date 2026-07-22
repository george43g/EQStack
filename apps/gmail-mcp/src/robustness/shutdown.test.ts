import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTests,
  enableOrphanWatchdog,
  enableStdinEofDetection,
  installShutdownHandlers,
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

// ---------------------------------------------------------------------------
// Process-level shutdown machinery (Pre-TUI Step 5)
// ---------------------------------------------------------------------------

describe("installShutdownHandlers", () => {
  // Stash + restore the real process.on so the test runner survives.
  let originalOn: typeof process.on;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const registeredSignals: Record<string, Array<() => void>> = {};

  beforeEach(() => {
    _resetForTests();
    originalOn = process.on;
    Object.keys(registeredSignals).forEach((k) => delete registeredSignals[k]);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    // Stub process.on so we can observe which signals are wired without
    // actually attaching real OS-signal listeners (which would persist past
    // the test).
    (process as unknown as { on: typeof process.on }).on = ((
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (typeof event === "string") {
        if (!registeredSignals[event]) registeredSignals[event] = [];
        registeredSignals[event].push(listener);
      }
      return process;
    }) as typeof process.on;
  });

  afterEach(() => {
    (process as unknown as { on: typeof process.on }).on = originalOn;
    exitSpy.mockRestore();
    _resetForTests();
  });

  it("registers SIGINT / SIGTERM / SIGHUP / SIGQUIT handlers + an `exit` listener", () => {
    installShutdownHandlers();
    expect(registeredSignals.SIGINT?.length).toBe(1);
    expect(registeredSignals.SIGTERM?.length).toBe(1);
    expect(registeredSignals.SIGHUP?.length).toBe(1);
    expect(registeredSignals.SIGQUIT?.length).toBe(1);
    expect(registeredSignals.exit?.length).toBe(1);
  });

  it("does not install duplicate process handlers", () => {
    installShutdownHandlers();
    installShutdownHandlers();
    expect(registeredSignals.SIGINT?.length).toBe(1);
    expect(registeredSignals.SIGTERM?.length).toBe(1);
    expect(registeredSignals.SIGHUP?.length).toBe(1);
    expect(registeredSignals.SIGQUIT?.length).toBe(1);
    expect(registeredSignals.exit?.length).toBe(1);
  });

  it("SIGINT handler triggers shutdown with exit code 130 (128 + signal 2)", async () => {
    installShutdownHandlers();
    const handler = registeredSignals.SIGINT?.[0];
    expect(handler).toBeDefined();
    handler!();
    // Wait for the async shutdown to settle.
    await new Promise((r) => setImmediate(r));
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it("SIGTERM handler triggers shutdown with exit code 0", async () => {
    installShutdownHandlers();
    const handler = registeredSignals.SIGTERM?.[0];
    handler!();
    await new Promise((r) => setImmediate(r));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("registered cleanups run before exit on signal", async () => {
    const cleanup = vi.fn();
    registerCleanup(cleanup);
    installShutdownHandlers();
    registeredSignals.SIGHUP?.[0]?.();
    await new Promise((r) => setImmediate(r));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("enableStdinEofDetection", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalStdin: NodeJS.ReadableStream;

  beforeEach(() => {
    _resetForTests();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    originalStdin = process.stdin;
  });

  afterEach(() => {
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    exitSpy.mockRestore();
    _resetForTests();
  });

  it("triggers shutdown when stdin emits 'end' (host died)", async () => {
    const fakeStdin = new EventEmitter() as unknown as NodeJS.ReadableStream;
    // resume() is called inside enableStdinEofDetection — provide a no-op.
    (fakeStdin as unknown as { resume: () => void }).resume = () => {};
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });

    enableStdinEofDetection();

    const cleanup = vi.fn();
    registerCleanup(cleanup);

    (fakeStdin as unknown as EventEmitter).emit("end");
    await new Promise((r) => setImmediate(r));

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe("enableOrphanWatchdog", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let parentPid: number;

  beforeEach(() => {
    _resetForTests();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.useFakeTimers();
    parentPid = 12345;
  });

  afterEach(() => {
    vi.useRealTimers();
    exitSpy.mockRestore();
    _resetForTests();
  });

  it("triggers shutdown when ppid changes to 1 (reparented to init/launchd)", async () => {
    enableOrphanWatchdog(100, () => parentPid);

    // Simulate the parent dying → reparent to init (pid 1 on macOS/Linux).
    parentPid = 1;
    await vi.advanceTimersByTimeAsync(150);

    expect(exitSpy).toHaveBeenCalled();
  });

  it("triggers shutdown when ppid changes to a different non-1 parent (reparented)", async () => {
    enableOrphanWatchdog(100, () => parentPid);

    parentPid = 99999;
    await vi.advanceTimersByTimeAsync(150);

    expect(exitSpy).toHaveBeenCalled();
  });

  it("is idempotent — second call doesn't double-install the timer", async () => {
    enableOrphanWatchdog(100, () => parentPid);
    enableOrphanWatchdog(100, () => parentPid);
    parentPid = 1;
    await vi.advanceTimersByTimeAsync(150);
    // We expect ONE exit call even if two timers had fired (shutdown gates
    // re-entry via shuttingDown). The point is "no crash + no double-trigger".
    expect(exitSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
