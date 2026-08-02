/**
 * Shared analytics rendering (text for every type) and the zero-dep YAML
 * serializer used by `imsg analytics … --yaml`.
 */
import { describe, expect, it } from "vitest";
import type { AnalyticType } from "../src/analytics.js";
import { renderAnalyticText, toYaml } from "../src/analytics-render.js";

describe("renderAnalyticText", () => {
  it("renders each analytic type without throwing, empty and populated", () => {
    const samples: Record<AnalyticType, unknown> = {
      messaging_streaks: [
        {
          contact: "Alice",
          longestStreakDays: 5,
          longestStreakStart: "2026-01-01",
          longestStreakEnd: "2026-01-05",
          currentStreakDays: 2,
        },
      ],
      double_texts: [{ contact: "Bob", doubleTextsFromMe: 3, doubleTextsFromThem: 1 }],
      response_time_stats: [
        { contact: "Cara", count: 10, medianMs: 60_000, p95Ms: 3_600_000, meanMs: 120_000 },
      ],
      daily_heatmap: {
        grid: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 1)),
        total: 168,
      },
      tapback_summary: [
        {
          contact: "Dan",
          heart: 2,
          thumbsUp: 1,
          thumbsDown: 0,
          haha: 3,
          exclaim: 0,
          question: 0,
          emoji: 1,
          total: 7,
        },
      ],
      year_in_review_wrapped: {
        windowStart: "2025-01-01",
        windowEnd: "2025-12-31",
        totalSent: 100,
        totalReceived: 120,
        totalReactions: 15,
        topContacts: [{ contact: "Eve", sent: 40, received: 50, total: 90 }],
        peakDay: { date: "2025-06-01", count: 30 },
        longestStreakDays: 12,
        longestStreakContact: "Eve",
      },
      relationship_leaderboard: {
        leaderboard: [
          {
            contact: "Fay",
            handle: "+15550000001",
            total: 200,
            sent: 100,
            received: 100,
            reciprocity: 1,
            daysSinceLast: 3,
            score: 42.5,
          },
        ],
      },
    };
    for (const type of Object.keys(samples) as AnalyticType[]) {
      const populated = renderAnalyticText(type, samples[type]);
      expect(populated.length, type).toBeGreaterThan(0);
      // Empty inputs render a friendly "(no …)" note rather than throwing.
      const emptyInput = Array.isArray(samples[type])
        ? []
        : type === "daily_heatmap"
          ? { grid: Array.from({ length: 7 }, () => new Array(24).fill(0)), total: 0 }
          : type === "relationship_leaderboard"
            ? { leaderboard: [] }
            : samples[type];
      expect(() => renderAnalyticText(type, emptyInput)).not.toThrow();
    }
  });

  it("formats durations and the heatmap grid", () => {
    const rt = renderAnalyticText("response_time_stats", [
      { contact: "X", count: 5, medianMs: 90_000, p95Ms: 7_200_000, meanMs: 3_000 },
    ]);
    expect(rt).toContain("median 2m");
    expect(rt).toContain("p95 2h");
    const heat = renderAnalyticText("daily_heatmap", {
      grid: Array.from({ length: 7 }, () => new Array(24).fill(1)),
      total: 168,
    });
    expect(heat).toContain("Sun");
    expect(heat).toContain("168 messages");
  });
});

describe("toYaml", () => {
  it("quotes values a parser would misread, leaves plain words unquoted", () => {
    expect(toYaml("+15550000119")).toBe('"+15550000119"'); // phone, not int
    expect(toYaml("123")).toBe('"123"'); // numeric string
    expect(toYaml("null")).toBe('"null"'); // keyword
    expect(toYaml("true")).toBe('"true"');
    expect(toYaml("a: b")).toBe('"a: b"'); // mapping-looking
    expect(toYaml("Alice")).toBe("Alice"); // plain
    expect(toYaml(42)).toBe("42");
    expect(toYaml(true)).toBe("true");
    expect(toYaml(null)).toBe("null");
  });

  it("serializes nested objects and arrays as valid indented YAML", () => {
    const out = toYaml({ a: 1, list: [{ k: "v" }, { k: "w" }], empty: [] });
    expect(out).toContain("a: 1");
    expect(out).toContain("list:");
    expect(out).toContain("k: v");
    expect(out).toContain("empty: []");
  });
});
