/**
 * Phase E step 7 — the report that answers "where does the time go".
 * Pure: takes timing rows + their call mode, returns per-leg percentiles.
 * Legs are keyed "<mode>.<leg>" because the metrics registry has no labels
 * and the report mirrors the series names (tel_direct_*).
 */
import type { CallMode, TurnTiming } from "./types.js";

export interface LegStats {
  n: number;
  p50: number;
  p90: number;
  p99: number;
  maxMs: number;
}

export interface LatencyReport {
  calls: number;
  turns: number;
  legs: Record<string, LegStats>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

function stats(values: number[]): LegStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1] as number,
  };
}

export function buildLatencyReport(
  rows: Array<{ timing: TurnTiming; mode: CallMode }>,
  callCount: number,
): LatencyReport {
  const legs: Record<string, number[]> = {};
  const add = (key: string, v: number | null) => {
    if (v === null || !Number.isFinite(v) || v < 0) return;
    let arr = legs[key];
    if (!arr) {
      arr = [];
      legs[key] = arr;
    }
    arr.push(v);
  };
  for (const { timing: t, mode } of rows) {
    if (t.endOfTurnMs === null) continue;
    if (mode === "direct") {
      add(
        "direct.pickup",
        t.deliveredToHostMs !== null ? t.deliveredToHostMs - t.endOfTurnMs : null,
      );
      add(
        "direct.think",
        t.deliveredToHostMs !== null && t.replyReceivedMs !== null
          ? t.replyReceivedMs - t.deliveredToHostMs
          : null,
      );
      add(
        "direct.egress",
        t.replyReceivedMs !== null && t.firstTokenToTwilioMs !== null
          ? t.firstTokenToTwilioMs - t.replyReceivedMs
          : null,
      );
      add(
        "direct.turn",
        t.firstTokenToTwilioMs !== null ? t.firstTokenToTwilioMs - t.endOfTurnMs : null,
      );
    } else {
      add(
        `${mode}.firstToken`,
        t.firstModelTokenMs !== null ? t.firstModelTokenMs - t.endOfTurnMs : null,
      );
      add(
        `${mode}.firstTokenToTwilio`,
        t.firstTokenToTwilioMs !== null ? t.firstTokenToTwilioMs - t.endOfTurnMs : null,
      );
    }
  }
  const out: Record<string, LegStats> = {};
  for (const [key, values] of Object.entries(legs)) {
    const s = stats(values);
    if (s) out[key] = s;
  }
  return { calls: callCount, turns: rows.length, legs: out };
}
