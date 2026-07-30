/**
 * Structured logger with performance monitoring.
 *
 * - In-memory buffer for MCP `get_logs` tool (backwards compatible)
 * - NDJSON file output to $TMPDIR/imsg-mcp/ for post-mortem analysis
 * - Performance spans: `const span = perf("op"); ... span.end({ rows: 100 })`
 * - Heap memory tracking on every log entry
 *
 * Files in $TMPDIR are cleaned up by the OS automatically.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { freemem, tmpdir } from "node:os";
import { join } from "node:path";
import { APP_VERSION } from "./meta.js";

// ── Types ──────────────────────────────────────────────────────────────

export type LogLevel = "info" | "warn" | "error" | "perf";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  dur_ms?: number;
  mem_mb: number;
  mem_delta_mb?: number;
  data?: Record<string, unknown>;
}

export interface PerfSpan {
  /** End the span. Logs duration, memory delta, and optional metadata. */
  end(data?: Record<string, unknown>): number;
}

export interface LastSendErrorDetails {
  message: string;
  stderr?: string;
  stdout?: string;
  code?: string | number;
  timestamp: string;
}

// ── State ──────────────────────────────────────────────────────────────

const MAX_LOG_LINES = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB rotation

/**
 * File logging is opt-in via IMSG_DEV=1 OR a programmatic `enableFileLogging()`
 * call. End users running the published `imsg mcp` bin don't get NDJSON files
 * in $TMPDIR by default. The TUI flips this on unconditionally so a future
 * crash leaves a postmortem trail — without it, the user's "tool exited on its
 * own" report has nothing to investigate. The in-memory ring buffer (500
 * lines) still works either way.
 *
 * Checked at call time, not module-load time, so tests can flip the flag
 * without needing to re-import the module.
 */
let fileLoggingForced = false;

/**
 * Force file logging on regardless of `IMSG_DEV`. Called by long-running
 * interactive entry points (TUI) where a postmortem trail justifies the
 * disk usage (file is 10 MB capped). Idempotent. No way to disable once on.
 */
export function enableFileLogging(): void {
  fileLoggingForced = true;
}

function isFileLoggingEnabled(): boolean {
  return fileLoggingForced || process.env.IMSG_DEV === "1";
}

function isVerboseLogging(): boolean {
  return process.env.IMSG_LOG_VERBOSE === "1";
}

const memoryLines: string[] = [];
let logFilePath: string | null = null;
let logFileBytes = 0;
let lastSendError: LastSendErrorDetails | null = null;

// ── File output ────────────────────────────────────────────────────────

function getLogDir(): string {
  return join(tmpdir(), "imsg-mcp");
}

function ensureLogFile(): string | null {
  if (logFilePath && logFileBytes < MAX_FILE_BYTES) return logFilePath;

  try {
    const dir = getLogDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const date = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    logFilePath = join(dir, `imsg-mcp-${process.pid}-${date}.ndjson`);
    logFileBytes = 0;
    return logFilePath;
  } catch {
    return null;
  }
}

function writeToFile(json: string): void {
  if (!isFileLoggingEnabled()) return;
  const path = ensureLogFile();
  if (!path) return;
  try {
    const line = `${json}\n`;
    appendFileSync(path, line);
    logFileBytes += line.length;
  } catch {
    // Don't let file I/O failures break the app.
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function heapMB(): number {
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
}

function formatMemoryLine(entry: LogEntry): string {
  let line = `${entry.ts} [${entry.level}] ${entry.msg}`;
  if (entry.dur_ms != null) line += ` (${entry.dur_ms.toFixed(1)}ms)`;
  if (entry.data != null) line += ` ${JSON.stringify(entry.data)}`;
  return line;
}

// When enabled (MCP stdio mode), info/warn/error are mirrored to stderr so the
// host (Claude Desktop, Cursor, …) surfaces them in its own connection log.
// OFF by default: the TUI renders a full-screen Ink UI to the same terminal and
// stray stderr writes would corrupt it. Enable explicitly in the MCP entrypoint.
let stderrMirrorEnabled = false;

/**
 * Mirror structured info/warn/error logs to stderr. Call once from the MCP
 * stdio entrypoint. Never call this from the TUI — it would garble the render.
 */
export function enableStderrLogging(): void {
  stderrMirrorEnabled = true;
}

/**
 * Write a line to stderr (fd 2) SYNCHRONOUSLY. Unlike `console.error`, a
 * synchronous fd write is flushed before the process can exit, so the line
 * survives even when we die microseconds later (the exact failure mode that
 * made startup crashes invisible in the host log). Never throws.
 */
export function writeStderrLine(line: string): void {
  try {
    writeSync(2, `${line}\n`);
  } catch {
    // stderr may be closed mid-shutdown; never re-throw from the logger.
  }
}

function emit(entry: LogEntry): void {
  // In-memory buffer for MCP get_logs tool
  const line = formatMemoryLine(entry);
  memoryLines.push(line);
  if (memoryLines.length > MAX_LOG_LINES) {
    memoryLines.splice(0, memoryLines.length - MAX_LOG_LINES);
  }

  // NDJSON file output
  writeToFile(JSON.stringify(entry));

  // Mirror to stderr for the MCP host log (perf spans excluded — too chatty).
  if (stderrMirrorEnabled && entry.level !== "perf") {
    writeStderrLine(`[imsg-mcp] ${line}`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export function info(msg: string, data?: Record<string, unknown>): void {
  emit({ ts: new Date().toISOString(), level: "info", msg, mem_mb: heapMB(), data });
}

export function warn(msg: string, data?: Record<string, unknown>): void {
  emit({ ts: new Date().toISOString(), level: "warn", msg, mem_mb: heapMB(), data });
}

export function error(msg: string, data?: Record<string, unknown>): void {
  emit({ ts: new Date().toISOString(), level: "error", msg, mem_mb: heapMB(), data });
}

/**
 * Start a performance span. Call `.end()` on the returned object to log
 * the duration, heap delta, and optional metadata.
 *
 * ```ts
 * const span = perf("listConversations");
 * // ... work ...
 * span.end({ chats: 200, deduped: 180 });
 * ```
 */
export function perf(msg: string): PerfSpan {
  const startTime = performance.now();
  const startHeap = heapMB();

  return {
    end(data?: Record<string, unknown>): number {
      const dur_ms = performance.now() - startTime;
      const endHeap = heapMB();
      emit({
        ts: new Date().toISOString(),
        level: "perf",
        msg,
        dur_ms,
        mem_mb: endHeap,
        mem_delta_mb: Math.round((endHeap - startHeap) * 10) / 10,
        data,
      });
      return dur_ms;
    },
  };
}

// ── Backwards-compatible API (used by MCP tools in index.ts) ───────────

/** @deprecated Use info/warn/error instead. Kept for MCP tool compat. */
export function appendLog(level: string, message: string, data?: unknown): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level: level as LogLevel,
    msg: message,
    mem_mb: heapMB(),
    data:
      data != null
        ? typeof data === "object"
          ? (data as Record<string, unknown>)
          : { value: data }
        : undefined,
  };
  emit(entry);
}

export function getLogs(tail?: number): string[] {
  if (tail != null && tail > 0) return memoryLines.slice(-tail);
  return [...memoryLines];
}

export function clearLogs(): void {
  memoryLines.length = 0;
}

export function setLastSendError(details: Omit<LastSendErrorDetails, "timestamp">): void {
  lastSendError = { ...details, timestamp: new Date().toISOString() };
  error("send_message failed", details as Record<string, unknown>);
}

export function getLastSendError(): LastSendErrorDetails | null {
  return lastSendError ? { ...lastSendError } : null;
}

/** Return the path to the current log file (if any). */
export function getLogFilePath(): string | null {
  return logFilePath;
}

/** Return the log directory path. */
export function getLogDirectory(): string {
  return getLogDir();
}

/** Log a startup marker — call at process start. */
export function logStartup(entrypoint: string): void {
  info("startup", {
    version: APP_VERSION,
    pid: process.pid,
    ppid: process.ppid,
    entrypoint,
    node: process.version,
    arch: process.arch,
    abi: process.versions.modules,
  });
}

/** Log a shutdown marker — call before process exits. */
export function logShutdown(reason: string): void {
  info("shutdown", { pid: process.pid, reason, uptime_s: Math.round(process.uptime()) });
}

/**
 * Read the latest NDJSON log file from disk (for external access).
 * Returns the last N lines from the most recent log file.
 */
export function getFileLogLines(tail = 50): string[] {
  try {
    // Previously this used inline `require("node:fs")`, which throws
    // ReferenceError under ESM and gets silently swallowed — returning []
    // even when a 135-line NDJSON sat right next to it. The imports now
    // live at the top of the file (ESM-correct).
    //
    // Strategy: read every PID-tagged file in the log dir so the caller
    // gets logs from THIS server process even when stale files from prior
    // crashes / older PIDs sort later. We fall back to the most-recent
    // file if the current PID isn't present (e.g. file rotated).
    const dir = getLogDir();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f: string) => f.endsWith(".ndjson"))
      .sort();
    if (files.length === 0) return [];

    const currentPid = String(process.pid);
    const mine = files.filter((f: string) => f.includes(`imsg-mcp-${currentPid}-`));
    const targetFile = mine[mine.length - 1] ?? files[files.length - 1];

    const content = readFileSync(join(dir, targetFile), "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    return tail > 0 ? lines.slice(-tail) : lines;
  } catch {
    return [];
  }
}

// ── Heap monitor ───────────────────────────────────────────────────────

/**
 * Heap warning threshold for the heartbeat monitor. Tunable via
 * `IMSG_HEAP_WARN_MB` env var. The default of 256 MB is set above the
 * legitimate working-set for big chat_analytics / large search_messages
 * sweeps on real Mac DBs (~240 MB at peak). Pre-fix this was 150,
 * which tripped on every analytic call — agents reading get_logs
 * saw a wall of false-positive "heap exceeds threshold" warnings on
 * every healthy invocation.
 */
const HEAP_WARN_MB = Math.max(
  64,
  Number.parseInt(process.env.IMSG_HEAP_WARN_MB ?? "256", 10) || 256,
);
let heapMonitorTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic heap monitoring. Logs a warning if heap exceeds the
 * threshold. Call once at server startup.
 *
 * No-op when IMSG_DEV is unset — end users running the published bin don't
 * accumulate heartbeats. The watchdog itself (src/watchdog.ts) still runs
 * unconditionally for self-healing; this monitor is purely observability.
 *
 * Heartbeats fire every 60s by default, or every 10s when IMSG_LOG_VERBOSE=1.
 */
export function startHeapMonitor(): void {
  if (!isFileLoggingEnabled()) return;
  if (heapMonitorTimer) return;
  const intervalMs = isVerboseLogging() ? 10_000 : 60_000;
  heapMonitorTimer = setInterval(() => {
    const heap = heapMB();
    const { rss } = process.memoryUsage();
    const rssMb = Math.round((rss / 1024 / 1024) * 10) / 10;
    if (heap > HEAP_WARN_MB) {
      warn("heap exceeds threshold", { heap_mb: heap, rss_mb: rssMb, threshold_mb: HEAP_WARN_MB });
    }
    // System-level memory pressure — captures cases where the host or OS may
    // be about to reclaim us. Helps diagnose "process vanished" reports where
    // the kill came from outside (SIGKILL, OOM, parent host).
    const freeMb = Math.round(freemem() / 1024 / 1024);
    // Always log a periodic heartbeat at info level for post-mortem analysis
    emit({
      ts: new Date().toISOString(),
      level: "info",
      msg: "heartbeat",
      mem_mb: heap,
      data: {
        rss_mb: rssMb,
        uptime_s: Math.round(process.uptime()),
        system_free_mb: freeMb || undefined,
      },
    });
  }, intervalMs);
  // Don't prevent process exit
  heapMonitorTimer.unref();
}

export function stopHeapMonitor(): void {
  if (heapMonitorTimer) {
    clearInterval(heapMonitorTimer);
    heapMonitorTimer = null;
  }
}
