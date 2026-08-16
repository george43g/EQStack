/**
 * Self-healing watchdog — thin wrapper over `@george43g/robustness`'s
 * `createWatchdog` (which was extracted 1:1 from this module's previous
 * 368-line implementation: same three monitors, same 12 `IMSG_*` env knobs
 * and defaults, same kill/diagnostic event names).
 *
 * Three independent monitors run on unref'd timers — they never prevent the
 * process from exiting on their own. When any monitor detects an
 * unrecoverable condition it triggers `shutdown()` so the host
 * (Cursor / Claude / Warp) spawns a clean instance:
 *
 * 1. Event-loop lag monitor (perf_hooks.monitorEventLoopDelay)
 * 2. Memory monitor (RSS cap + monotonic-heap-growth leak suspicion)
 * 3. Idle / uptime monitor (24h uptime + 1h quiet → graceful restart)
 *
 * Thresholds stay configurable via the same `IMSG_*` env vars (see CLAUDE.md
 * § watchdog); the kit adds one new knob, `IMSG_HEAP_GROWTH_MIN_MB`
 * (previously the hardcoded 25MB noise floor).
 *
 * This module OWNS its controller (created at module scope with the `IMSG`
 * prefix) rather than using the kit's singleton, so that lazy consumers
 * (`messageCache.onMemorySample`, `useDevStats.readWatchdogState`) can never
 * construct the singleton under the kit's default `MCP` prefix before an
 * entry point calls `installWatchdog()`, and so `vi.resetModules()` in tests
 * gets a genuinely fresh instance.
 */

import { createWatchdog, isMonotonicallyGrowing } from "@george43g/robustness";
import { error, info, warn } from "./logger.js";
import { _controller } from "./shutdown.js";

const controller = createWatchdog({
  envPrefix: "IMSG",
  // Kills must run imsg's cleanup registry (DB close, heap-monitor stop,
  // screen unmount) — the kit's default is its own package singleton, whose
  // registry would be empty here. Since 0.8.x the kit's `triggerKill` also
  // records `watchdog:<reason>` as the shutdown cause through this
  // controller — the local diagnostic-sniffing branch that used to do it
  // is deleted (drill-verified equivalent on the real NDJSON marker).
  shutdownController: _controller,
  onDiagnostic: (d) => {
    // Keep watchdog_kill / rss_kill_heap_forensics / event_loop_lag /
    // sleep_detected_skipping_sample flowing into imsg's ring buffer +
    // NDJSON exactly as before (a custom sink fully replaces the kit's
    // default logger sink).
    if (d.level === "error") error(d.event, d.data);
    else if (d.level === "warn") warn(d.event, d.data);
    else info(d.event, d.data);
  },
});

// ── Public API (unchanged surface) ───────────────────────────────────────

/** Update the activity timestamp — call this from each tool dispatch. */
export function noteActivity(): void {
  controller.noteActivity();
}

/**
 * Read current watchdog state — used by health_check and TUI dev stats.
 *
 * robustness 0.8.0 lifted this module's pre-first-sample fill (a fresh
 * process no longer reads 0MB for its first minute) and applied it to the
 * on-disk state snapshot too, which our local fill never covered. The kit
 * also adds `memorySampled: boolean` so "live reading taken just now" stays
 * distinguishable from "the sampler's last recording".
 */
export function readWatchdogState() {
  return controller.readState();
}

/**
 * Subscribe to the watchdog's existing 60s memory sample.
 * Returns an unsubscribe function. Used by the TUI message cache to evict
 * entries under heap pressure without spinning up its own sampler.
 */
export function onMemorySample(cb: (rssMb: number, heapMb: number) => void): () => void {
  return controller.onMemorySample(cb);
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
  if (opts.idleRestart !== undefined) {
    controller.reconfigure({ idleRestart: opts.idleRestart });
  }
  controller.install();
}

/**
 * Re-exported from the kit (same algorithm, same 25MB default noise floor).
 * Exposed for tests and the memory monitor's leak heuristic.
 */
export { isMonotonicallyGrowing };
