/**
 * visual-width — terminal-cell-aware string width + truncation.
 *
 * Locks in the contract used by ConversationItem to never split a
 * grapheme cluster mid-emoji and to budget for emoji as 2 cells.
 */

import { describe, expect, it } from "vitest";
import { clusterWidth, truncateToWidth, visualWidth } from "../src/visual-width.js";

describe("clusterWidth", () => {
  it("is 1 for ASCII letters and digits", () => {
    for (const c of "abcXYZ012!?-") {
      expect(clusterWidth(c)).toBe(1);
    }
  });

  it("is 2 for common emoji", () => {
    for (const c of ["🎉", "😀", "👍", "💬", "📱", "🔥"]) {
      expect(clusterWidth(c)).toBe(2);
    }
  });

  it("is 2 for CJK ideographs and fullwidth", () => {
    expect(clusterWidth("中")).toBe(2);
    expect(clusterWidth("문")).toBe(2);
    expect(clusterWidth("Ａ")).toBe(2); // fullwidth A
  });

  it("is 1 for box-drawing characters used in the TUI", () => {
    for (const c of ["─", "│", "┌", "└", "▶", "◀", "●", "✉"]) {
      expect(clusterWidth(c)).toBe(1);
    }
  });
});

describe("visualWidth", () => {
  it("matches code-point count for ASCII", () => {
    expect(visualWidth("hello")).toBe(5);
    expect(visualWidth("Birthday Party!")).toBe(15);
  });

  it("counts each emoji as 2 cells", () => {
    expect(visualWidth("🎉")).toBe(2);
    expect(visualWidth("🎉🎉🎉")).toBe(6);
    expect(visualWidth("🎉Hi")).toBe(4);
  });

  it("handles empty string", () => {
    expect(visualWidth("")).toBe(0);
  });
});

describe("truncateToWidth", () => {
  it("returns the input unchanged when it already fits", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello");
    expect(truncateToWidth("🎉", 2)).toBe("🎉");
  });

  it("appends an ellipsis when truncating ASCII", () => {
    expect(truncateToWidth("Birthday Party", 8)).toBe("Birthda…");
  });

  it("never splits a surrogate pair (the bug we are fixing)", () => {
    const input = "🎉🎉🎉🎉🎉 Family";
    // Width is 5*2 + 1 + 6 = 17. Budget 6 should give "🎉🎉…" not "🎉🎉�…".
    const out = truncateToWidth(input, 6);
    expect(out).toBe("🎉🎉…");
    // Sanity: result is a valid UTF-16 string with no lone surrogates.
    for (let i = 0; i < out.length; i++) {
      const code = out.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = out.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i++; // skip low surrogate
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new Error(`Lone low surrogate at index ${i}`);
      }
    }
  });

  it("accounts for emoji width in the budget (truncate point shifts)", () => {
    // 5-cell budget with a leading 2-cell emoji + ellipsis (1 cell):
    // 2 (emoji) + 2 (text) + 1 (ellipsis) = 5 cells.
    expect(truncateToWidth("🎉Hello", 5)).toBe("🎉He…");
  });

  it("returns '' for non-positive budgets", () => {
    expect(truncateToWidth("anything", 0)).toBe("");
    expect(truncateToWidth("anything", -3)).toBe("");
  });

  it("never produces a result wider than the budget", () => {
    const cases = [
      ["Birthday Party!", 10],
      ["🎉🎉🎉🎉", 5],
      ["🎉Hi", 3],
      ["a🎉b🎉c", 4],
      ["中文测试", 5],
    ] as const;
    for (const [input, budget] of cases) {
      const out = truncateToWidth(input, budget);
      expect(visualWidth(out)).toBeLessThanOrEqual(budget);
    }
  });

  it("fits as much as possible when ellipsis won't fit at all", () => {
    // maxCols == 1 takes the fallback path (ellipsis itself is 1 cell).
    expect(truncateToWidth("hello", 1)).toBe("h");
    expect(truncateToWidth("🎉Hi", 1)).toBe(""); // emoji is 2-cell, doesn't fit
  });

  it("with budget == cluster-width, drops the cluster to fit the ellipsis", () => {
    // maxCols=2, ellipsisW=1: ellipsisW (1) < maxCols (2) so we take the
    // ellipsis path. 🎉 (2 cells) + … (1 cell) = 3 > 2 → just "…".
    expect(truncateToWidth("🎉Hi", 2)).toBe("…");
    // maxCols=3 leaves room for 🎉 (2) + … (1) → "🎉…".
    expect(truncateToWidth("🎉Hi", 3)).toBe("🎉…");
  });
});
