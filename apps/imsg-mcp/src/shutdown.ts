/**
 * Central shutdown / cleanup registry — thin wrapper over
 * `@george43g/robustness`'s ShutdownController (which was extracted from this
 * module's previous 191-line implementation; behaviour is 1:1 except where
 * noted below).
 *
 * Any module can register a cleanup function. On process exit (via signal,
 * stdin EOF, or orphan detection), all registered functions run exactly once
 * before the process exits.
 *
 * This module OWNS its controller instance (created at module scope) rather
 * than using the kit's singleton, so that:
 *  1. diagnostics are wired into imsg's logger exactly once, at construction,
 *     for every entry point (MCP / CLI / TUI) with no per-entry wiring;
 *  2. `vi.resetModules()` in tests re-instantiates a fresh controller — the
 *     kit's externalized module-level singleton would survive a registry
 *     reset and leak state across test files;
 *  3. imsg policy (unhandled rejections NEVER exit — see below) is pinned
 *     here, not repeated at call sites.
 *
 * Deliberate deltas from the old implementation:
 *  - The kit arms its 3s force-exit net on the FIRST `shutdown()` call (the
 *    old code only armed it on a concurrent second call), so a wedged cleanup
 *    on SIGTERM can no longer hang the process forever.
 *  - Failing cleanups now log a `cleanup_failed` diagnostic instead of being
 *    swallowed silently.
 */

import { createShutdownController } from "@george43g/robustness";
import { appendLog } from "./logger.js";

type CleanupFn = () => void | Promise<void>;

const controller = createShutdownController({
  // imsg policy: log unhandled rejections but DO NOT exit. Pre-fix, a single
  // unhandled rejection in a background task (heartbeat / cache sweeper /
  // contact-sync) would crash the MCP without any trace in the NDJSON log —
  // the host saw an EPIPE and reconnected with a fresh PID. The MCP SDK's
  // per-request error handler already isolates request failures, and the TUI
  // must never die over a stray async error. (Kit default is exit(70);
  // pinned false for every imsg entry point.)
  exitOnUnhandledRejection: false,
  onDiagnostic: (d) => {
    // Route lifecycle events (signal_received, unhandled_rejection,
    // uncaught_exception, cleanup_failed, cleanup_timeout, and — since
    // robustness 0.8.0 — stdin_eof and orphaned) into imsg's ring buffer +
    // NDJSON, keeping event names grep-compatible with the old
    // implementation. Stderr mirroring rides the logger's existing
    // enableStderrLogging() gate, so this stays TUI-safe. The logger never
    // throws mid-shutdown (writeToFile/writeStderrLine swallow), so no
    // try/catch is needed here.
    appendLog(d.level, d.event, d.data);
  },
});

/**
 * @internal Consumed by `watchdog.ts` so watchdog kills run THIS registry's
 * cleanups (DB close, heap-monitor stop, screen unmount) — the kit watchdog's
 * default is its own package singleton, whose registry would be empty.
 * Since robustness 0.8.x the kit watchdog also records `watchdog:<reason>`
 * as the shutdown cause through this controller's `noteShutdownCause`.
 */
export const _controller = controller;

/**
 * Why this process went down — `"normal"` for a clean quit, else
 * `signal:<NAME>` / `uncaught_exception` / `unhandled_rejection` /
 * `stdin_eof` / `orphaned` / `watchdog:<reason>` / an explicit note.
 *
 * Fully delegated to robustness ≥0.8.1, which records causes AT the
 * lifecycle call sites (first-writer-wins) and — after our upstream defect
 * report — only when the event actually initiates shutdown: an error the
 * process SURVIVES (imsg pins exitOnUnhandledRejection false everywhere;
 * the TUI also pins exitOnUncaughtException false) is a diagnostic, never
 * a cause, so it cannot poison a later clean quit or mask a real cause.
 * The 0.7.0-era local implementation (module state + diagnostic-sniffing
 * branches, two of which turned out to be dead paths) is deleted.
 */
export function getShutdownCause(): string {
  return controller.getShutdownCause();
}

/**
 * Record an explicit cause (e.g. `user_quit` from the TUI's `q` handler).
 * First writer wins: the initiating cause is more informative than any
 * follow-on event it triggers.
 */
export function noteShutdownCause(cause: string): void {
  controller.noteShutdownCause(cause);
}

/**
 * @internal test seam. NOTE: the kit's `reset()` clears the WHOLE controller
 * (cleanup registry, handlers, shutting-down flag), not just the cause —
 * fine for its one caller (an isolated `vi.resetModules()` test), lethal in
 * a live process. Never call outside tests.
 */
export function _resetShutdownCause(): void {
  controller.reset();
}

/**
 * Register a cleanup function to run on shutdown.
 * Functions are called in registration order.
 */
export function registerCleanup(fn: CleanupFn): void {
  controller.registerCleanup(fn);
}

/**
 * Unregister a previously registered cleanup function.
 */
export function unregisterCleanup(fn: CleanupFn): void {
  controller.unregisterCleanup(fn);
}

/**
 * Trigger graceful shutdown. Runs all cleanup functions, then exits.
 * Safe to call multiple times — only runs once.
 */
export async function shutdown(exitCode = 0): Promise<never> {
  await controller.shutdown(exitCode);
  // controller.shutdown() resolves only when its exit hook didn't terminate
  // the process (tests / embedders / re-entry). Callers treat shutdown() as
  // terminal, so block forever — the force-exit net or the first caller's
  // process.exit will end the process.
  return new Promise<never>(() => {});
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
   * still recorded via the `uncaught_exception` diagnostic so the
   * postmortem trail is intact.
   */
  exitOnUncaughtException?: boolean;
}

/**
 * Install signal handlers (SIGINT/SIGTERM/SIGHUP/SIGQUIT), the
 * unhandledRejection/uncaughtException observers, and the sync last-resort
 * cleanup on `exit`. Call once at process startup.
 */
export function installShutdownHandlers(opts: ShutdownOpts = {}): void {
  if (opts.exitOnUncaughtException !== undefined) {
    controller.reconfigure({ exitOnUncaughtException: opts.exitOnUncaughtException });
  }
  controller.installHandlers();
}

/**
 * Enable stdin EOF detection — when the parent process dies, stdin closes.
 * Essential for MCP stdio servers to detect host death.
 */
export function enableStdinEofDetection(): void {
  controller.enableStdinEofDetection();
}

/**
 * Enable parent PID watchdog — detects orphaned processes.
 * If the parent PID changes (reparented to launchd/init), trigger shutdown.
 * Timer is unref'd so it doesn't prevent natural exit.
 */
export function enableOrphanWatchdog(intervalMs = 5000): void {
  controller.enableOrphanWatchdog(intervalMs);
}

/**
 * Check if shutdown is in progress.
 */
export function isShuttingDown(): boolean {
  return controller.isShuttingDown();
}
