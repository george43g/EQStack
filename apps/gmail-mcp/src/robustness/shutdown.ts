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

type CleanupFn = () => void | Promise<void>;

const registry = new Set<CleanupFn>();
let shuttingDown = false;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let forceExitTimer: ReturnType<typeof setTimeout> | null = null;
let handlersInstalled = false;
const signalHandlers = new Map<NodeJS.Signals, () => void>();
let stdinTarget: NodeJS.ReadableStream | null = null;
let stdinEndHandler: (() => void) | null = null;

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
    if (!forceExitTimer) {
      forceExitTimer = setTimeout(() => process.exit(exitCode), 3000);
      forceExitTimer.unref();
    }
    return new Promise<never>(() => {});
  }
  shuttingDown = true;

  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

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
      const result = fn();
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Ignore
    }
  }
}

/**
 * Install signal handlers and synchronous last-resort cleanup.
 * Call once at process startup.
 */
export function installShutdownHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    const handler = () => {
      shutdown(sig === "SIGINT" ? 130 : 0);
    };
    signalHandlers.set(sig, handler);
    process.on(sig, handler);
  }

  process.on("exit", syncCleanup);
}

/**
 * Enable stdin EOF detection — when the parent process dies, stdin closes.
 * Essential for MCP stdio servers to detect host death.
 */
export function enableStdinEofDetection(): void {
  if (stdinTarget) return;
  stdinTarget = process.stdin;
  stdinEndHandler = () => {
    if (!shuttingDown) shutdown(0);
  };
  stdinTarget.on("end", stdinEndHandler);
  stdinTarget.resume();
}

/**
 * Enable parent PID watchdog — detects orphaned processes.
 * If the parent PID changes (reparented to launchd/init), trigger shutdown.
 * Timer is unref'd so it doesn't prevent natural exit.
 */
export function enableOrphanWatchdog(
  intervalMs = 5000,
  readParentPid: () => number = () => process.ppid,
): void {
  if (watchdogTimer) return;
  const parentPid = readParentPid();

  watchdogTimer = setInterval(() => {
    const currentParentPid = readParentPid();
    if (currentParentPid === 1 || currentParentPid !== parentPid) {
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

/**
 * Test-only: reset internal state. Do not call from production code.
 * @internal
 */
export function _resetForTests(): void {
  for (const [sig, handler] of signalHandlers) {
    process.off(sig, handler);
  }
  signalHandlers.clear();
  if (handlersInstalled) process.off("exit", syncCleanup);
  handlersInstalled = false;
  if (stdinTarget && stdinEndHandler) stdinTarget.removeListener("end", stdinEndHandler);
  stdinTarget = null;
  stdinEndHandler = null;
  registry.clear();
  shuttingDown = false;
  if (forceExitTimer) {
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}
