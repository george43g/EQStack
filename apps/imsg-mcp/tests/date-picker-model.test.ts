/**
 * Pure date-picker model (swarm finding: "date-picker keys" batch).
 *
 * The original in-component logic clamped every intermediate value during
 * digit entry, which made most values untypeable: year 2026 + '1' → 261 →
 * clamp → 1900, so typing "1999" oscillated between 1900 and 2100 forever;
 * month 05 + '3' → 53 → clamp → 12, so typing month "3" produced 12. The
 * model replaces shift-and-clamp with replace-then-append + clamp-on-submit.
 */
import { describe, expect, it } from "vitest";
import {
  adjust,
  applyDigit,
  applyDigits,
  backspaceField,
  initPickerState,
  moveField,
  type PickerState,
  toIso,
} from "../src/tui/date-picker-model.js";

const base = (): PickerState => initPickerState(new Date(2026, 4, 20)); // 2026-05-20

describe("digit entry (replace-then-append)", () => {
  it("first digit REPLACES the active field", () => {
    const s = applyDigit(base(), 1);
    expect(s.year).toBe(1);
    expect(s.typed).toBe(1);
  });

  it("typing a full year works — the pre-model clamp bug made 1999 untypeable", () => {
    const s = applyDigits(base(), "1999");
    expect(s.year).toBe(1999);
    // 4 digits fill the year → auto-advance to month
    expect(s.active).toBe("month");
    expect(s.typed).toBe(0);
  });

  it("typing month 3 gives 3, not clamp(53)=12", () => {
    const s = applyDigit(moveField(base(), 1), 3);
    expect(s.month).toBe(3);
  });

  it("two-digit month auto-advances to day", () => {
    const s = applyDigits(moveField(base(), 1), "11");
    expect(s.month).toBe(11);
    expect(s.active).toBe("day");
  });

  it("full date typed straight through: 2024-03-15", () => {
    const s = applyDigits(base(), "20240315");
    expect(toIso(s)).toBe("2024-03-15");
  });

  it("day field does not advance past itself", () => {
    const s = applyDigits(base(), "20240315");
    expect(s.active).toBe("day");
    // extra digits keep appending (clamped at submit), never crash
    const more = applyDigit(s, 9);
    expect(more.active).toBe("day");
  });
});

describe("toIso clamping at submit", () => {
  it("clamps a mid-entry zero month to a real date", () => {
    const s = applyDigit(moveField(base(), 1), 0); // month shows 0 mid-entry
    expect(toIso(s)).toBe("2026-01-20");
  });

  it("clamps day to the month's length (Feb 31 → Feb 28)", () => {
    let s = applyDigits(base(), "2023"); // year, advance to month
    s = applyDigits(s, "02"); // Feb, advance to day
    s = applyDigits(s, "31");
    expect(toIso(s)).toBe("2023-02-28");
  });

  it("clamps out-of-range years", () => {
    const s = applyDigit(base(), 3); // year = 3
    expect(toIso(s)).toBe("1900-05-20");
  });
});

describe("adjust (arrows / k-j)", () => {
  it("increments and clamps within the field range", () => {
    const s = adjust(base(), 1);
    expect(s.year).toBe(2027);
  });

  it("re-clamps day when the month shrinks", () => {
    let s = initPickerState(new Date(2026, 0, 31)); // Jan 31
    s = moveField(s, 1); // month
    s = adjust(s, 1); // Feb
    expect(s.day).toBe(28);
  });

  it("resets digit-entry state so the next digit replaces", () => {
    let s = applyDigit(base(), 2); // typed=1
    s = adjust(s, 1);
    expect(s.typed).toBe(0);
  });
});

describe("moveField", () => {
  it("cycles year → month → day → year", () => {
    let s = base();
    expect(s.active).toBe("year");
    s = moveField(s, 1);
    expect(s.active).toBe("month");
    s = moveField(s, 1);
    expect(s.active).toBe("day");
    s = moveField(s, 1);
    expect(s.active).toBe("year");
  });

  it("cycles backwards from year to day", () => {
    expect(moveField(base(), -1).active).toBe("day");
  });
});

describe("backspaceField", () => {
  it("drops the last digit and stays in append mode", () => {
    let s = applyDigits(base(), "199"); // year=199, typed=3
    s = backspaceField(s);
    expect(s.year).toBe(19);
    const next = applyDigit(s, 8);
    expect(next.year).toBe(198); // appended, not replaced
  });
});
