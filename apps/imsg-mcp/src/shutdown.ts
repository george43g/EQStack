/**
 * Central shutdown / cleanup registry.
 *
 * Any module can register a cleanup function. On process exit (via signal,
 * stdin EOF, or orphan detection), all registered functions run exactly once
 * before the process exits.
 *
 * Prevents orphaned processes by:
 * 1. Trapping SIGINT, SIGTERM, SIGHUP, SIGQUIT
 * 2. Detecting stdin EOF (parent MCP host died)
 * 3. Watching for parent PID change (reparented to launchd = orphaned)
 */

import { appendLog } from "./logger.js";

type CleanupFn = () => void | Promise<void>;

const registry = new Set<CleanupFn>();
let shuttingDown = false;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Register a cleanup function to run on shutdown.
 * Functions are called in registration order.
 */
export function registerCleanup(fn: CleanupFn): void {
  registry.add(fn);
}

/**
 * Unregister a previously registered cleanup function.
 */
export function unregisterCleanup(fn: CleanupFn): void {
  registry.delete(fn);
}

/**
 * Trigger graceful shutdown. Runs all cleanup functions, then exits.
 * Safe to call multiple times — only runs once.
 */
export async function shutdown(exitCode = 0): Promise<never> {
  if (shuttingDown) {
    // Already shutting down — force exit after 3s safety net
    setTimeout(() => process.exit(exitCode), 3000).unref();
    // Block forever (the timeout or a prior shutdown will exit)
    return new Promise<never>(() => {});
  }
  shuttingDown = true;

  // Stop watchdog
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  // Run all cleanup functions (best-effort, don't let one failure block others)
  for (const fn of registry) {
    try {
      await fn();
    } catch {
      // Ignore cleanup errors during shutdown
    }
  }
  registry.clear();

  process.exit(exitCode);
}

/** Synchronous cleanup — last resort on process.on('exit') */
function syncCleanup(): void {
  for (const fn of registry) {
    try {
      // Only call sync-safe functions here; async ones will be no-ops
      const result = fn();
      // If it returns a promise, we can't await it here — just ignore
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Ignore
    }
  }
}

export interface ShutdownOpts {
  /**
   * Whether to call `shutdown(70)` on `uncaughtException`. Defaults to
   * `true` — correct for MCP / one-shot CLI where an uncaught error means
   * undefined state and a clean restart is the right answer.
   *
   * **Set to `false` for the TUI**, where killing a long-running interactive
   * session over a transient render or async error wastes the user's work
   * and feels like a phantom crash. The TUI keeps running; the error is
   * still recorded via `appendLog("error", "uncaught_exception", …)` so the
   * postmortem trail is intact.
   */
  exitOnUncaughtException?: boolean;
}

/**
 * Install signal handlers and orphan detection.
 * Call once at process startup.
 */
export function installShutdownHandlers(opts: ShutdownOpts = {}): void {
  const exitOnUncaught = opts.exitOnUncaughtException ?? true;
  // Signal handlers — log the signal name before cleanup so the post-mortem
  // NDJSON tells us *why* the process ended (e.g. host sent SIGTERM at $time).
  const onSignal = (signal: string) => {
    try {
      appendLog("info", "signal_received", { signal });
    } catch {
      // logger may already be torn down; never fail shutdown over logging.
    }
    shutdown(signal === "SIGINT" ? 130 : 0);
  };

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    process.on(sig, () => onSignal(sig));
  }

  // Catch-all for stray async errors. Pre-fix, a single unhandled
  // rejection in a background task (heartbeat / cache sweeper /
  // contact-sync) would crash the MCP without any trace in the NDJSON
  // log — the host saw an EPIPE and reconnected with a fresh PID.
  // We log + record but DO NOT exit; the SDK's per-request error
  // handler already isolates request failures.
  process.on("unhandledRejection", (reason) => {
    try {
      appendLog("error", "unhandled_rejection", {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    } catch {
      // Logger may be torn down mid-shutdown; never re-throw from here.
    }
  });
  process.on("uncaughtException", (err) => {
    try {
      appendLog("error", "uncaught_exception", {
        message: err.message,
        stack: err.stack,
      });
    } catch {
      // Same as above.
    }
    // MCP / CLI policy: shutdown on uncaughtException — state is undefined,
    // a restart is the right answer. TUI policy (opt-in): log + keep
    // running so a transient React/Ink error doesn't kill the user's
    // session mid-compose.
    if (exitOnUncaught) shutdown(70);
  });

  // Synchronous last-resort cleanup
  process.on("exit", syncCleanup);
}

/**
 * Enable stdin EOF detection — when the parent process dies, stdin closes.
 * Essential for MCP stdio servers to detect host death.
 */
export function enableStdinEofDetection(): void {
  process.stdin.on("end", () => {
    if (!shuttingDown) shutdown(0);
  });
  process.stdin.resume();
}

/**
 * Enable parent PID watchdog — detects orphaned processes.
 * If the parent PID changes (reparented to launchd/init), trigger shutdown.
 * Timer is unref'd so it doesn't prevent natural exit.
 */
export function enableOrphanWatchdog(intervalMs = 5000): void {
  if (watchdogTimer) return;
  const parentPid = process.ppid;

  watchdogTimer = setInterval(() => {
    // ppid changes to 1 (launchd/init) when parent dies
    if (process.ppid === 1 || process.ppid !== parentPid) {
      shutdown(0);
    }
  }, intervalMs);
  watchdogTimer.unref();
}

/**
 * Check if shutdown is in progress.
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}
