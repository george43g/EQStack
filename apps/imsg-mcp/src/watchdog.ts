/**
 * Self-healing watchdog.
 *
 * Three independent monitors run on unref'd timers — they never prevent the
 * process from exiting on their own. When any monitor detects an unrecoverable
 * condition it triggers `shutdown()` so the host (Cursor / Claude / Warp)
 * spawns a clean instance.
 *
 * 1. Event-loop lag monitor (perf_hooks.monitorEventLoopDelay)
 *    - warn  > EVENT_LOOP_WARN_MS p99 over 5s window
 *    - kill  > EVENT_LOOP_KILL_MS p99 over 5s window
 *
 * 2. Memory monitor
 *    - warn  > heap exceeds HEAP_WARN_MB (handled by logger.startHeapMonitor)
 *    - kill  > RSS exceeds MAX_RSS_MB OR heap monotonically grew on
 *      MEMORY_GROWTH_SAMPLES consecutive 60s samples
 *
 * 3. Idle / uptime monitor
 *    - kill  > uptime > IDLE_RESTART_AFTER_MS AND no activity within
 *      IDLE_RESTART_QUIET_MS — graceful restart insurance for crufty
 *      long-running processes.
 *
 * All thresholds are configurable via env vars so they can be tuned per
 * environment without rebuilding.
 */

import { writeFileSync } from "node:fs";
import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";
import { error, info, warn } from "./logger.js";
import { isShuttingDown, registerCleanup, shutdown } from "./shutdown.js";

// ── Config (env-overridable) ─────────────────────────────────────────────

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const EVENT_LOOP_SAMPLE_MS = envNum("IMSG_EVENT_LOOP_SAMPLE_MS", 5_000);
const EVENT_LOOP_WARN_MS = envNum("IMSG_EVENT_LOOP_WARN_MS", 500);
const EVENT_LOOP_KILL_MS = envNum("IMSG_EVENT_LOOP_KILL_MS", 10_000);
// Sustained-lag detector: kill if p99 stays >= the sustained threshold for
// SUSTAINED_SAMPLES consecutive samples. Catches scenarios where the spike
// kill threshold (10s) is never crossed but the UI is sustained-unusable
// (e.g. 800ms event-loop lag for several minutes from a render hot-loop).
const EVENT_LOOP_SUSTAINED_MS = envNum("IMSG_EVENT_LOOP_SUSTAINED_MS", 750);
const EVENT_LOOP_SUSTAINED_SAMPLES = envNum("IMSG_EVENT_LOOP_SUSTAINED_SAMPLES", 6);

const MEMORY_SAMPLE_MS = envNum("IMSG_MEMORY_SAMPLE_MS", 60_000);
const MAX_RSS_MB = envNum("IMSG_MAX_RSS_MB", 1024);
const MEMORY_GROWTH_SAMPLES = envNum("IMSG_HEAP_GROWTH_SAMPLES", 10);

const IDLE_RESTART_AFTER_MS = envNum("IMSG_RESTART_AFTER_MS", 24 * 60 * 60 * 1000); // 24h
const IDLE_RESTART_QUIET_MS = envNum("IMSG_RESTART_QUIET_MS", 60 * 60 * 1000); // 1h
const IDLE_CHECK_MS = envNum("IMSG_IDLE_CHECK_MS", 10 * 60 * 1000); // 10 min

// ── State ────────────────────────────────────────────────────────────────

interface WatchdogState {
  startedAt: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  /** Consecutive samples where p99 was >= EVENT_LOOP_SUSTAINED_MS. */
  eventLoopSustainedCount: number;
  /** Wall-clock timestamp of the most recent event-loop sample tick.
   *  Used to detect system sleep (huge interval gap → reset histogram). */
  lastEventLoopSampleTs: number;
  rssMb: number;
  heapMb: number;
  heapHistory: number[]; // recent heap samples for leak detection
  lastActivityTs: number;
  killReason: string | null;
}

const state: WatchdogState = {
  startedAt: Date.now(),
  eventLoopP99Ms: 0,
  eventLoopMaxMs: 0,
  eventLoopSustainedCount: 0,
  lastEventLoopSampleTs: Date.now(),
  rssMb: 0,
  heapMb: 0,
  heapHistory: [],
  lastActivityTs: Date.now(),
  killReason: null,
};

let eventLoopHistogram: IntervalHistogram | null = null;
let eventLoopTimer: ReturnType<typeof setInterval> | null = null;
let memoryTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;
let installed = false;

// ── Public API ───────────────────────────────────────────────────────────

/** Update the activity timestamp — call this from each tool dispatch. */
export function noteActivity(): void {
  state.lastActivityTs = Date.now();
}

/** Read current watchdog state — used by health_check and TUI dev stats. */
export function readWatchdogState(): Readonly<WatchdogState> {
  return state;
}

// ── Memory-pressure subscriber API ───────────────────────────────────────
type MemorySampleCallback = (rssMb: number, heapMb: number) => void;
const memSampleSubscribers = new Set<MemorySampleCallback>();

/**
 * Subscribe to the watchdog's existing 60s memory sample.
 * Returns an unsubscribe function. Used by the TUI message cache to evict
 * entries under heap pressure without spinning up its own sampler.
 */
export function onMemorySample(cb: MemorySampleCallback): () => void {
  memSampleSubscribers.add(cb);
  return () => {
    memSampleSubscribers.delete(cb);
  };
}

export interface WatchdogOpts {
  /**
   * Whether to run the 24h idle-restart monitor. Defaults to `true` —
   * correct for the MCP server (host respawns a clean instance after an
   * idle restart).
   *
   * **Set to `false` for the TUI**, where the user IS the parent process
   * and a 24h restart would silently kill an active interactive session
   * (and lose the user's compose state) the moment uptime crosses the
   * threshold. The TUI's lifecycle is "user runs it until they quit".
   */
  idleRestart?: boolean;
}

/** Install all three monitors. Idempotent — safe to call multiple times. */
export function installWatchdog(opts: WatchdogOpts = {}): void {
  if (installed) return;
  installed = true;
  const idleRestartEnabled = opts.idleRestart ?? true;

  // 1. Event-loop lag monitor
  eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
  eventLoopHistogram.enable();

  const stateFilePath = process.env.IMSG_WATCHDOG_STATE_PATH ?? "";

  eventLoopTimer = setInterval(() => {
    if (!eventLoopHistogram || isShuttingDown()) return;

    // Sleep-skew detection: if wall-clock time between this tick and the
    // previous one is much larger than the sample interval, the laptop
    // probably slept (macOS suspends timers but the histogram keeps
    // accumulating). Reset the histogram and skip threshold evaluation —
    // otherwise we'd kill the process for "event_loop_blocked" with p99
    // values like 17 minutes that are pure wall-clock skew, not real lag.
    const now = Date.now();
    const interval = now - state.lastEventLoopSampleTs;
    state.lastEventLoopSampleTs = now;
    if (interval > 3 * EVENT_LOOP_SAMPLE_MS) {
      eventLoopHistogram.reset();
      state.eventLoopSustainedCount = 0;
      info("sleep_detected_skipping_sample", {
        actual_interval_ms: interval,
        expected_interval_ms: EVENT_LOOP_SAMPLE_MS,
      });
      return;
    }

    // perf_hooks reports nanoseconds — convert to ms.
    const p99Ms = eventLoopHistogram.percentile(99) / 1e6;
    const maxMs = eventLoopHistogram.max / 1e6;
    state.eventLoopP99Ms = p99Ms;
    state.eventLoopMaxMs = maxMs;
    eventLoopHistogram.reset();

    // External observer hook: write state to a JSON file each sample tick so
    // a parent process (e.g. the CI stress harness) can read RSS / lag /
    // sustained-lag-count without parsing logs. Best-effort; failures are
    // silent so the watchdog never crashes the process it's supposed to
    // protect.
    if (stateFilePath) {
      try {
        writeFileSync(
          stateFilePath,
          JSON.stringify({
            ts: Date.now(),
            uptimeMs: Date.now() - state.startedAt,
            eventLoopP99Ms: state.eventLoopP99Ms,
            eventLoopMaxMs: state.eventLoopMaxMs,
            eventLoopSustainedCount: state.eventLoopSustainedCount,
            rssMb: state.rssMb,
            heapMb: state.heapMb,
            killReason: state.killReason,
          }),
        );
      } catch {
        // ignore — non-essential
      }
    }

    // Single-spike kill: one sample crossing the spike threshold.
    if (p99Ms >= EVENT_LOOP_KILL_MS) {
      triggerKill("event_loop_blocked", {
        p99_ms: p99Ms,
        max_ms: maxMs,
        threshold_ms: EVENT_LOOP_KILL_MS,
      });
      return;
    }

    // Sustained-lag kill: many consecutive samples above the sustained
    // threshold. Catches a render-hot-loop pinning the UI without ever
    // reaching the spike threshold.
    if (p99Ms >= EVENT_LOOP_SUSTAINED_MS) {
      state.eventLoopSustainedCount += 1;
      if (state.eventLoopSustainedCount >= EVENT_LOOP_SUSTAINED_SAMPLES) {
        triggerKill("event_loop_sustained_lag", {
          p99_ms: p99Ms,
          max_ms: maxMs,
          consecutive_samples: state.eventLoopSustainedCount,
          sample_interval_ms: EVENT_LOOP_SAMPLE_MS,
          sustained_threshold_ms: EVENT_LOOP_SUSTAINED_MS,
        });
        return;
      }
    } else {
      state.eventLoopSustainedCount = 0;
    }

    if (p99Ms >= EVENT_LOOP_WARN_MS) {
      warn("event_loop_lag", { p99_ms: p99Ms, max_ms: maxMs, threshold_ms: EVENT_LOOP_WARN_MS });
    }
  }, EVENT_LOOP_SAMPLE_MS);
  eventLoopTimer.unref();

  // 2. Memory monitor — augments logger.ts heap warnings with hard kill rules
  memoryTimer = setInterval(() => {
    if (isShuttingDown()) return;
    const mu = process.memoryUsage();
    const rssMb = round1(mu.rss / 1024 / 1024);
    const heapMb = round1(mu.heapUsed / 1024 / 1024);
    state.rssMb = rssMb;
    state.heapMb = heapMb;

    // Notify subscribers (e.g. TUI message cache) so they can evict on pressure
    for (const cb of memSampleSubscribers) {
      try {
        cb(rssMb, heapMb);
      } catch {
        // Subscriber failures must not crash the watchdog
      }
    }

    // Track heap history for monotonic growth detection
    state.heapHistory.push(heapMb);
    if (state.heapHistory.length > MEMORY_GROWTH_SAMPLES) {
      state.heapHistory.shift();
    }

    if (rssMb >= MAX_RSS_MB) {
      // Forensics before dying: a real incident (2026-07-12) went 160MB →
      // 1071MB inside one 60s sample window with no completed perf span to
      // name the allocator. V8 heap-space stats are cheap and identify WHERE
      // the memory sits (old space vs external vs malloc'd), which separates
      // "JS object leak" from "native/Buffer growth" for the next occurrence.
      try {
        error("rss_kill_heap_forensics", {
          heap_stats: getHeapStatistics(),
          heap_spaces: getHeapSpaceStatistics().map((sp) => ({
            name: sp.space_name,
            used_mb: round1(sp.space_used_size / 1024 / 1024),
          })),
          memory_usage: {
            rss_mb: rssMb,
            heap_used_mb: heapMb,
            external_mb: round1(mu.external / 1024 / 1024),
            array_buffers_mb: round1(mu.arrayBuffers / 1024 / 1024),
          },
        });
      } catch {
        // Forensics must never block the kill.
      }
      triggerKill("rss_exceeded", { rss_mb: rssMb, threshold_mb: MAX_RSS_MB });
      return;
    }

    if (
      state.heapHistory.length >= MEMORY_GROWTH_SAMPLES &&
      isMonotonicallyGrowing(state.heapHistory)
    ) {
      triggerKill("memory_leak_suspected", {
        samples: state.heapHistory.slice(),
        sample_interval_ms: MEMORY_SAMPLE_MS,
      });
    }
  }, MEMORY_SAMPLE_MS);
  memoryTimer.unref();

  // 3. Idle / uptime monitor — kill if uptime > N AND no recent activity.
  //    Skipped entirely for the TUI (see WatchdogOpts.idleRestart docs).
  if (idleRestartEnabled) {
    idleTimer = setInterval(() => {
      if (isShuttingDown()) return;
      const uptimeMs = Date.now() - state.startedAt;
      const idleMs = Date.now() - state.lastActivityTs;
      if (uptimeMs >= IDLE_RESTART_AFTER_MS && idleMs >= IDLE_RESTART_QUIET_MS) {
        triggerKill("idle_restart", { uptime_ms: uptimeMs, idle_ms: idleMs });
      }
    }, IDLE_CHECK_MS);
    idleTimer.unref();
  }

  registerCleanup(() => {
    if (eventLoopHistogram) {
      eventLoopHistogram.disable();
      eventLoopHistogram = null;
    }
    if (eventLoopTimer) clearInterval(eventLoopTimer);
    if (memoryTimer) clearInterval(memoryTimer);
    if (idleTimer) clearInterval(idleTimer);
  });

  info("watchdog_installed", {
    event_loop_warn_ms: EVENT_LOOP_WARN_MS,
    event_loop_kill_ms: EVENT_LOOP_KILL_MS,
    event_loop_sustained_ms: EVENT_LOOP_SUSTAINED_MS,
    event_loop_sustained_samples: EVENT_LOOP_SUSTAINED_SAMPLES,
    max_rss_mb: MAX_RSS_MB,
    memory_growth_samples: MEMORY_GROWTH_SAMPLES,
    idle_restart_after_ms: IDLE_RESTART_AFTER_MS,
  });
}

// ── Internal helpers ─────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Returns true iff every sample is >= the previous (with at least 25MB total growth). */
export function isMonotonicallyGrowing(samples: number[]): boolean {
  if (samples.length < 2) return false;
  let prev = samples[0];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] < prev) return false;
    prev = samples[i];
  }
  // Require at least 25MB total growth to ignore noise. 5MB was too sensitive
  // — innocuous drift triggered false-positive `memory_leak_suspected` kills.
  return samples[samples.length - 1] - samples[0] >= 25;
}

function triggerKill(reason: string, data: Record<string, unknown>): void {
  if (state.killReason) return; // already killing
  state.killReason = reason;
  error(`watchdog_kill: ${reason}`, data);
  // Use shutdown() so registered cleanups run. Force a hard exit if cleanup
  // itself hangs (e.g. SQL is wedged) — 5s grace.
  setTimeout(() => {
    error("watchdog_force_exit — graceful shutdown stalled", { reason });
    process.exit(137);
  }, 5_000).unref();
  shutdown(1).catch(() => process.exit(1));
}
