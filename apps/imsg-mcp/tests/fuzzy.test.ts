import { describe, expect, it } from "vitest";
import { cleanText, fuzzyScore, rankFuzzy } from "../src/fuzzy.js";

describe("fuzzyScore — emoji / punctuation literal substring", () => {
  // Regression: cleanText strips emoji, so a query like "🪦" used to
  // become "" → score 0 → filtered. search_messages then returned 0
  // hits even when the literal emoji existed verbatim in the body.
  it("scores an emoji query as a verbatim hit when present in the candidate", () => {
    expect(fuzzyScore("🪦", "i need a money 🪦")).toBeGreaterThanOrEqual(0.95);
  });

  it("scores multi-emoji and emoji+text queries as verbatim hits", () => {
    expect(fuzzyScore("🎉🎉", "Party 🎉🎉🎉 incoming")).toBeGreaterThanOrEqual(0.95);
    expect(fuzzyScore("done ✓", "task done ✓ today")).toBeGreaterThanOrEqual(0.95);
  });

  it("is case-insensitive in the raw fast path", () => {
    expect(fuzzyScore("HELLO", "say hello world")).toBeGreaterThanOrEqual(0.95);
  });

  it("does not false-positive when the query is absent", () => {
    expect(fuzzyScore("🪦", "no emoji here")).toBeLessThan(0.6);
  });

  it("rankFuzzy includes emoji-literal hits above the default threshold", () => {
    const candidates = ["nothing here", "i need a money 🪦", "🪦 only"];
    const ranked = rankFuzzy("🪦", candidates, (s) => s);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].score).toBeGreaterThanOrEqual(0.95);
  });
});

describe("cleanText", () => {
  it("lowercases and trims", () => {
    expect(cleanText("  Hello WORLD  ")).toBe("hello world");
  });

  it("collapses internal whitespace", () => {
    expect(cleanText("a  b\tc\nd")).toBe("a b c d");
  });

  it("strips emoji and joins surrounding tokens", () => {
    expect(cleanText("yo 🚀 dawg")).toBe("yo dawg");
  });
});

describe("fuzzyScore", () => {
  it("substring match scores 0.95", () => {
    expect(fuzzyScore("hello", "hello world")).toBeCloseTo(0.95, 2);
  });

  it("exact match scores 0.95 (substring shortcut)", () => {
    expect(fuzzyScore("hello", "hello")).toBeCloseTo(0.95, 2);
  });

  it("single-character typo on short query still scores high", () => {
    // 'helllo' vs 'hello': lev distance 1, max len 6, ratio 5/6 ≈ 0.833
    expect(fuzzyScore("helllo", "hello")).toBeGreaterThan(0.6);
  });

  it("returns 0 for empty inputs", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("anything", "")).toBe(0);
  });

  it("ranks token-set overlap higher than unrelated text", () => {
    const a = fuzzyScore("dinner tonight", "dinner plans for tonight at 8");
    const b = fuzzyScore("dinner tonight", "got coffee yesterday morning");
    expect(a).toBeGreaterThan(b);
  });

  it("ignores emoji in both query and candidate", () => {
    expect(fuzzyScore("dinner 🍕 tonight", "dinner tonight 🍕🍕🍕")).toBeGreaterThan(0.6);
  });
});

describe("rankFuzzy", () => {
  it("filters by minScore and sorts descending", () => {
    const items = [
      { id: 1, text: "totally unrelated content" },
      { id: 2, text: "hello there" },
      { id: 3, text: "hello world" },
      { id: 4, text: "helllo wurld" },
    ];
    const ranked = rankFuzzy("hello world", items, (i) => i.text, 0.5);
    // Substring "hello world" wins; "hello there" and the typo'd "helllo wurld" follow
    expect(ranked[0]?.item.id).toBe(3);
    expect(ranked.map((r) => r.item.id)).not.toContain(1);
  });

  it("returns empty array when no candidates pass minScore", () => {
    expect(rankFuzzy("zzzz", [{ text: "hello" }], (i) => i.text, 0.6)).toEqual([]);
  });
});
