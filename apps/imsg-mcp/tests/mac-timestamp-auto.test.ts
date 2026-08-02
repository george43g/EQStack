/**
 * Regression: macAutoTimestampToDate must distinguish between seconds
 * and nanoseconds storage units.
 *
 * Pre-fix bug: `searchAttachments` used `macTimestampToDate` for
 * `attachment.created_date`. That column stores seconds since the Mac
 * epoch (2001-01-01), not nanoseconds. The pure-ns converter divided
 * by 1e9 and produced ~0.8 seconds past 2001 for every recent
 * attachment — "2001-01-01T00:00:00.802Z" surfaced to the agent.
 *
 * Post-fix: an auto-detecting helper checks the magnitude
 * (< 1e15 → seconds, ≥ 1e15 → nanoseconds) and returns the right Date.
 */

import { describe, expect, it } from "vitest";
import {
  MAC_EPOCH_OFFSET,
  macAutoTimestampToDate,
  macTimestampToDate,
  NANOS_PER_SECOND,
  SECONDS_NS_BOUNDARY,
} from "../src/db-schema.js";

describe("macAutoTimestampToDate", () => {
  it("returns null for null / 0", () => {
    expect(macAutoTimestampToDate(null)).toBeNull();
    expect(macAutoTimestampToDate(0)).toBeNull();
  });

  it("treats values below the seconds/ns boundary as seconds", () => {
    // 802198044 s past 2001-01-01 → 2026-06-04T~08:07
    const d = macAutoTimestampToDate(802_198_044);
    expect(d).not.toBeNull();
    const year = d?.getUTCFullYear();
    expect(year).toBe(2026);
  });

  it("treats values above the boundary as nanoseconds", () => {
    // A modern message.date value: ~8e17 ns past Mac epoch.
    const ns = 802_198_044 * NANOS_PER_SECOND; // same instant, in ns
    const d = macAutoTimestampToDate(ns);
    expect(d?.getUTCFullYear()).toBe(2026);
    // And equals what macTimestampToDate (pure-ns) returns.
    expect(d?.getTime()).toBe(macTimestampToDate(ns)?.getTime());
  });

  it("the boundary itself is treated as nanoseconds (>=)", () => {
    const d = macAutoTimestampToDate(SECONDS_NS_BOUNDARY);
    // SECONDS_NS_BOUNDARY ns = 10⁶ s past Mac epoch = ~Jan 1971 from
    // Mac epoch's perspective, so before 2001 is impossible. The point
    // here is the BRANCH choice — verify by comparing to the pure-ns
    // converter at the same input.
    expect(d?.getTime()).toBe(macTimestampToDate(SECONDS_NS_BOUNDARY)?.getTime());
  });

  it("agrees with macTimestampToDate when both interpret as ns", () => {
    const nsNow = (Date.now() / 1000 - MAC_EPOCH_OFFSET) * NANOS_PER_SECOND;
    expect(macAutoTimestampToDate(nsNow)?.getTime()).toBe(macTimestampToDate(nsNow)?.getTime());
  });

  it("the original bug shape converts to a 2026 date, not 2001 epoch", () => {
    // The exact value from the live MCP probe.
    const d = macAutoTimestampToDate(802_198_044);
    expect(d).not.toBeNull();
    const iso = d?.toISOString() ?? "";
    expect(iso.startsWith("2001-01-01"), `got ${iso}, must not be epoch zero`).toBe(false);
    expect(iso.slice(0, 4)).toBe("2026");
  });
});
