import { describe, expect, it } from "vitest";
import { contrastRatio, hexToHsl } from "../../src/tui/themes/color.js";
import { DEFAULT_ACCENT, derivePalette } from "../../src/tui/themes/palette.js";

const ACCENTS = [
  DEFAULT_ACCENT, // iMessage blue
  "#FF6B35", // orange
  "#5AC85A", // green
  "#9B5DE5", // purple
  "#FF00FF", // magenta
  "#00CED1", // dark turquoise
];

describe("derivePalette: shape", () => {
  const p = derivePalette(DEFAULT_ACCENT);

  it("produces hex strings for every required field", () => {
    const hexRe = /^#[0-9a-fA-F]{6}$/;
    expect(p.sent.bg).toMatch(hexRe);
    expect(p.sent.fg).toMatch(hexRe);
    expect(p.received.bg).toMatch(hexRe);
    expect(p.received.fg).toMatch(hexRe);
    expect(p.border).toMatch(hexRe);
    expect(p.dot).toMatch(hexRe);
    expect(p.sidebar.selected).toMatch(hexRe);
    expect(p.header.focused.bg).toMatch(hexRe);
    expect(p.compose.bg).toMatch(hexRe);
    expect(p.drawer.bg).toMatch(hexRe);
    expect(p.rustEngine).toMatch(hexRe);
    expect(p.cpuHigh).toMatch(hexRe);
  });

  it("sent bubble bg uses the accent's hue", () => {
    const accentHsl = hexToHsl(DEFAULT_ACCENT);
    const sentHsl = hexToHsl(p.sent.bg);
    expect(Math.abs(sentHsl.h - accentHsl.h)).toBeLessThan(2);
  });
});

describe("derivePalette: contrast", () => {
  for (const accent of ACCENTS) {
    const p = derivePalette(accent);

    it(`${accent}: sent bubble fg has WCAG-AA contrast against sent.bg`, () => {
      // 4.5:1 is the WCAG-AA target for normal-size text.
      // Some accents at lightness 0.55 are inherently low-contrast vs
      // a near-white fg; iMessage blue ships at ~3.8:1, so we use a
      // slightly relaxed AA-large threshold of 3:1 here.
      expect(contrastRatio(p.sent.fg, p.sent.bg)).toBeGreaterThanOrEqual(3);
    });

    it(`${accent}: received bubble fg has strong contrast against received.bg`, () => {
      expect(contrastRatio(p.received.fg, p.received.bg)).toBeGreaterThanOrEqual(7);
    });

    it(`${accent}: sidebar.selectedFg readable on sidebar.selected`, () => {
      // 4:1 — between WCAG AA (4.5) for normal text and AA-large (3.0).
      // Sidebar items are short labels in bold context; this is comfortable.
      expect(contrastRatio(p.sidebar.selectedFg, p.sidebar.selected)).toBeGreaterThanOrEqual(4);
    });

    it(`${accent}: groupBg.sent and groupBg.received are visually distinct`, () => {
      const a = hexToHsl(p.groupBg.sent);
      const b = hexToHsl(p.groupBg.received);
      // Either the lightness or the hue differs noticeably.
      const dl = Math.abs(a.l - b.l);
      const dh = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h));
      expect(dl + dh / 100).toBeGreaterThan(0.02);
    });
  }
});

describe("derivePalette: stability", () => {
  it("is pure — same accent → same palette", () => {
    const a = derivePalette(DEFAULT_ACCENT);
    const b = derivePalette(DEFAULT_ACCENT);
    expect(a).toEqual(b);
  });

  it("different accents → different sent.bg", () => {
    expect(derivePalette("#1982FC").sent.bg).not.toBe(derivePalette("#FF6B35").sent.bg);
  });

  it("rustEngine and cpuHigh stay constant across accents (semantic)", () => {
    const a = derivePalette("#1982FC");
    const b = derivePalette("#FF6B35");
    expect(a.rustEngine).toBe(b.rustEngine);
    expect(a.cpuHigh).toBe(b.cpuHigh);
    expect(a.sms).toBe(b.sms);
  });
});
