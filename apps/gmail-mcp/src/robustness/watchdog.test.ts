import { describe, expect, it } from "vitest";
import { isMonotonicallyGrowing } from "./watchdog.js";

describe("isMonotonicallyGrowing", () => {
  it("returns false for fewer than 2 samples", () => {
    expect(isMonotonicallyGrowing([])).toBe(false);
    expect(isMonotonicallyGrowing([100])).toBe(false);
  });

  it("returns true for clean monotonic growth past 5MB", () => {
    expect(isMonotonicallyGrowing([10, 11, 12, 13, 14, 15])).toBe(true);
    expect(isMonotonicallyGrowing([100, 105, 110])).toBe(true);
  });

  it("returns false when any sample drops", () => {
    expect(isMonotonicallyGrowing([10, 11, 10, 12, 15])).toBe(false);
    expect(isMonotonicallyGrowing([100, 99, 100, 101])).toBe(false);
  });

  it("returns false for plateau / flat samples below 5MB total", () => {
    expect(isMonotonicallyGrowing([100, 100, 100, 100])).toBe(false);
  });

  it("returns false when total growth is under 5MB", () => {
    expect(isMonotonicallyGrowing([100, 100.5, 101, 101.5, 102])).toBe(false);
  });

  it("treats equal consecutive values as still monotonic", () => {
    expect(isMonotonicallyGrowing([10, 10, 11, 12, 15])).toBe(true);
  });

  it("boundary: total growth of exactly 5 returns true", () => {
    expect(isMonotonicallyGrowing([10, 11, 12, 13, 14, 15])).toBe(true);
  });

  it("boundary: total growth of 4 returns false", () => {
    expect(isMonotonicallyGrowing([10, 11, 12, 13, 14])).toBe(false);
  });
});
