/**
 * Regression test: the TUI must NOT enable any-event mouse tracking
 * (?1003h). That mode floods stdin with one event per pixel of mouse
 * motion, which pinned the event loop at ~950ms p99 lag and burned 100%
 * CPU before this was caught. The hook should use ?1000h
 * (button-event-only — clicks + scroll wheel).
 *
 * If a future refactor reverts this, the test fails loudly. We grep for
 * the actual escape-sequence emit (e.g. `\x1b[?1003h`) inside a write
 * call, not the literal substring "?1003h", because comments may legitimately
 * mention the bug.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "../src/tui/hooks/useMouse.ts"), "utf8");

/** Strip block comments + line comments before scanning code for escapes. */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("useMouse hook", () => {
  const code = stripComments(SRC);

  it("does NOT emit ?1003h (any-event mouse tracking — floods event loop)", () => {
    expect(code).not.toContain("?1003h");
    expect(code).not.toContain("?1003l");
  });

  it("emits ?1000h (button-event tracking — clicks + scroll only)", () => {
    expect(code).toContain("?1000h");
    expect(code).toContain("?1000l");
  });

  it("emits ?1006h (SGR extended coordinates) so x/y aren't capped at 223", () => {
    expect(code).toContain("?1006h");
  });
});
