/**
 * The TUI export's date bounds.
 *
 * The widening is the whole point of the module: the export query compares Mac
 * NANOSECONDS and `dateToMacTimestamp` floors a JS Date, which carries only
 * milliseconds. An exact `until` bound therefore lands BELOW a row stored with
 * sub-millisecond precision and excludes the message the user selected last —
 * measured 2026-08-23 against the real DB, where a 10-row visual selection
 * exported 9 and the missing one was exactly the `until` endpoint.
 *
 * These tests exist so a future "why is this ±1?" cleanup fails loudly.
 */
import { describe, expect, it } from "vitest";
import { exportBounds } from "../src/tui/export-bounds.js";

const at = (iso: string) => ({ date: new Date(iso) });

describe("exportBounds", () => {
  it("returns null for an empty scope", () => {
    expect(exportBounds([])).toBeNull();
  });

  it("widens both ends by exactly 1ms so the endpoints survive the ns floor", () => {
    const scope = [at("2026-08-23T07:30:12.461Z"), at("2026-08-23T08:59:16.959Z")];
    const b = exportBounds(scope);
    expect(b).not.toBeNull();
    expect(b?.since.toISOString()).toBe("2026-08-23T07:30:12.460Z");
    expect(b?.until.toISOString()).toBe("2026-08-23T08:59:16.960Z");
  });

  it("brackets a single-message selection on both sides", () => {
    const only = at("2026-08-23T08:59:16.959Z");
    const b = exportBounds([only]);
    // Strictly outside on both ends — a lone message is simultaneously the
    // `since` and the `until` endpoint, so an exact bound would drop it twice.
    expect(b?.since.getTime()).toBeLessThan(only.date.getTime());
    expect(b?.until.getTime()).toBeGreaterThan(only.date.getTime());
  });

  it("never returns since > until, even for a descending scope", () => {
    const b = exportBounds([at("2026-08-23T09:00:00.000Z"), at("2026-08-23T07:00:00.000Z")]);
    expect(b?.since.getTime()).toBeLessThan(b?.until.getTime() ?? 0);
  });

  it("keeps every selected message strictly inside the bounds", () => {
    const scope = [
      at("2026-08-23T07:30:12.461Z"),
      at("2026-08-23T08:08:43.001Z"),
      at("2026-08-23T08:59:16.959Z"),
    ];
    const b = exportBounds(scope);
    for (const m of scope) {
      expect(m.date.getTime()).toBeGreaterThan(b?.since.getTime() ?? Number.POSITIVE_INFINITY);
      expect(m.date.getTime()).toBeLessThan(b?.until.getTime() ?? Number.NEGATIVE_INFINITY);
    }
  });
});
