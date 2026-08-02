import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  hexToHsl,
  hslToHex,
  relativeLuminance,
  rotateHue,
  tint,
  withL,
  withS,
} from "../../src/tui/themes/color.js";

describe("color: hexToHsl", () => {
  it("parses pure red", () => {
    const hsl = hexToHsl("#ff0000");
    expect(hsl.h).toBeCloseTo(0, 1);
    expect(hsl.s).toBeCloseTo(1, 2);
    expect(hsl.l).toBeCloseTo(0.5, 2);
  });

  it("parses pure green", () => {
    const hsl = hexToHsl("#00ff00");
    expect(hsl.h).toBeCloseTo(120, 1);
  });

  it("parses pure blue", () => {
    const hsl = hexToHsl("#0000ff");
    expect(hsl.h).toBeCloseTo(240, 1);
  });

  it("parses iMessage blue", () => {
    const hsl = hexToHsl("#1982FC");
    expect(hsl.h).toBeGreaterThan(200);
    expect(hsl.h).toBeLessThan(220);
    expect(hsl.s).toBeGreaterThan(0.9);
  });

  it("rejects invalid input", () => {
    expect(() => hexToHsl("not-a-hex")).toThrow();
    expect(() => hexToHsl("#abc")).toThrow(); // 3-digit not supported
    expect(() => hexToHsl("#GGGGGG")).toThrow();
  });
});

describe("color: hslToHex round-trip", () => {
  for (const hex of ["#1982FC", "#FF6B35", "#5AC85A", "#7AA2F7", "#000000", "#FFFFFF"]) {
    it(`round-trips ${hex}`, () => {
      const hsl = hexToHsl(hex);
      const back = hslToHex(hsl);
      // Allow ±1 unit per channel due to rounding in HSL math.
      const a = Number.parseInt(hex.slice(1), 16);
      const b = Number.parseInt(back.slice(1), 16);
      const dr = Math.abs((a >> 16) - (b >> 16));
      const dg = Math.abs(((a >> 8) & 0xff) - ((b >> 8) & 0xff));
      const db = Math.abs((a & 0xff) - (b & 0xff));
      expect(Math.max(dr, dg, db)).toBeLessThanOrEqual(1);
    });
  }
});

describe("color: adjusters", () => {
  it("withL drops luminance to a known value", () => {
    const lower = withL("#1982FC", 0.2);
    const hsl = hexToHsl(lower);
    expect(hsl.l).toBeCloseTo(0.2, 2);
  });

  it("withS=0 produces grey", () => {
    const grey = withS("#1982FC", 0);
    const hsl = hexToHsl(grey);
    expect(hsl.s).toBeCloseTo(0, 2);
  });

  it("rotateHue +180° on red gives cyan", () => {
    const cyan = rotateHue("#ff0000", 180);
    const hsl = hexToHsl(cyan);
    expect(hsl.h).toBeCloseTo(180, 1);
  });

  it("rotateHue is wrap-safe (-360 = identity)", () => {
    const same = rotateHue("#7AA2F7", -360);
    expect(same.toLowerCase()).toBe("#7aa2f7");
  });

  it("tint(L, satMul) lowers saturation by the multiplier", () => {
    const t = tint("#1982FC", 0.5, 0.1);
    const hsl = hexToHsl(t);
    expect(hsl.s).toBeLessThan(0.2);
    expect(hsl.l).toBeCloseTo(0.5, 2);
  });
});

describe("color: WCAG luminance + contrast", () => {
  it("white luminance ~= 1", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 2);
  });

  it("black luminance ~= 0", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 2);
  });

  it("white-on-black contrast = 21", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 0);
  });

  it("contrast is symmetric", () => {
    const a = contrastRatio("#1982FC", "#FFFFFF");
    const b = contrastRatio("#FFFFFF", "#1982FC");
    expect(a).toBeCloseTo(b, 5);
  });
});
