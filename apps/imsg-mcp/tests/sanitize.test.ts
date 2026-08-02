import { describe, expect, it } from "vitest";
import { sanitizeUserText } from "../src/sanitize.js";

describe("sanitizeUserText", () => {
  it("strips ANSI escape sequences", () => {
    const input = "\x1b[31mRed text\x1b[0m and \x1b[1;32mbold green\x1b[0m";
    expect(sanitizeUserText(input)).toBe("Red text and bold green");
  });

  it("replaces NUL and C0 control characters with U+FFFD", () => {
    const input = "Hello\x00World\x0BTest\x1F";
    expect(sanitizeUserText(input)).toBe("Hello\uFFFDWorld\uFFFDTest\uFFFD");
  });

  it("preserves safe whitespace (newlines, tabs, carriage returns)", () => {
    const input = "Line 1\nLine 2\tTabbed\r";
    expect(sanitizeUserText(input)).toBe(input);
  });

  it("preserves multi-byte UTF-8 emoji", () => {
    const input = "Hello 🌍! Good 🧑‍🚀";
    expect(sanitizeUserText(input)).toBe(input);
  });

  it("truncates text exceeding maxLength", () => {
    const input = "A".repeat(5000);
    const sanitized = sanitizeUserText(input, 4096)!;
    expect(sanitized.length).toBe(4096);
    expect(sanitized.endsWith("…")).toBe(true);
    expect(sanitized.slice(0, 4095)).toBe("A".repeat(4095));
  });

  it("handles null and undefined safely", () => {
    expect(sanitizeUserText(null)).toBe(null);
    expect(sanitizeUserText(undefined)).toBe(null);
  });
});
