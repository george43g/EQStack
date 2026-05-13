/**
 * health_check formatter.
 *
 * Pure functions: takes a snapshot of watchdog state + caller-supplied counters
 * and returns either a structured snapshot or human-readable text. The actual
 * tool wiring (registration + counter increments) lives in the host MCP.
 *
 * Library-eligible: no Gmail-specific imports.
 */

import { readWatchdogState } from "./watchdog.js";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthSnapshot {
  status: HealthStatus;
  issues: string[];
  uptime_s: number;
  pid: number;
  node: string;
  heap_mb: number;
  rss_mb: number;
  event_loop_p99_ms: number;
  event_loop_max_ms: number;
  tool_calls: number;
  recent_errors: number;
  last_activity_age_s: number;
}

export interface HealthCounters {
  toolCalls: number;
  recentErrors: number;
}

const EVENT_LOOP_DEGRADED_MS = 500;
const EVENT_LOOP_UNHEALTHY_MS = 5000;
const RECENT_ERRORS_DEGRADED = 5;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function snapshotHealth(counters: HealthCounters): HealthSnapshot {
  const w = readWatchdogState();
  const now = Date.now();
  const mu = process.memoryUsage();
  const heap = mu.heapUsed / 1024 / 1024;
  const rss = mu.rss / 1024 / 1024;

  const issues: string[] = [];
  let status: HealthStatus = "healthy";

  if (w.eventLoopP99Ms >= EVENT_LOOP_UNHEALTHY_MS) {
    status = "unhealthy";
    issues.push(`event loop p99 ${round1(w.eventLoopP99Ms)}ms`);
  } else if (w.eventLoopP99Ms >= EVENT_LOOP_DEGRADED_MS) {
    status = "degraded";
    issues.push(`event loop p99 ${round1(w.eventLoopP99Ms)}ms`);
  }

  if (counters.recentErrors >= RECENT_ERRORS_DEGRADED) {
    if (status === "healthy") status = "degraded";
    issues.push(`${counters.recentErrors} recent errors`);
  }

  if (w.killReason) {
    status = "unhealthy";
    issues.push(`watchdog kill: ${w.killReason}`);
  }

  return {
    status,
    issues,
    uptime_s: Math.round((now - w.startedAt) / 1000),
    pid: process.pid,
    node: process.version,
    heap_mb: round1(heap),
    rss_mb: round1(rss),
    event_loop_p99_ms: round1(w.eventLoopP99Ms),
    event_loop_max_ms: round1(w.eventLoopMaxMs),
    tool_calls: counters.toolCalls,
    recent_errors: counters.recentErrors,
    last_activity_age_s: Math.round((now - w.lastActivityTs) / 1000),
  };
}

export function formatHealthText(s: HealthSnapshot): string {
  const lines = [`Status: ${s.status}`];
  if (s.issues.length > 0) {
    lines.push(`Issues: ${s.issues.join(", ")}`);
  }
  lines.push(
    `Uptime: ${s.uptime_s}s, last activity ${s.last_activity_age_s}s ago`,
    `PID: ${s.pid}, Node: ${s.node}`,
    `Memory: heap ${s.heap_mb} MB, RSS ${s.rss_mb} MB`,
    `Event loop p99: ${s.event_loop_p99_ms} ms (max ${s.event_loop_max_ms} ms)`,
    `Tool calls: ${s.tool_calls}, recent errors: ${s.recent_errors}`,
  );
  return lines.join("\n");
}
