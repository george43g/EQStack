/**
 * Vim counts must survive arriving as ONE chunk.
 *
 * Ink delivers a fast burst (and every paste) as a single `useInput` call with
 * the whole string, so the App router fans the chunk out per character. The
 * digit accumulator used to rebuild the count from `state.numBuffer` — a RENDER
 * SNAPSHOT — which is only refreshed if React happens to re-render between
 * iterations of that loop. Nothing guarantees it does: two iterations landing in
 * the same render both appended to the same base, the later dispatch won, and a
 * digit vanished.
 *
 * Measured against the real DB on 2026-08-23: typing 3-0-0-j slowly moved the
 * correct 300 rows; sending "300j" as one chunk moved 30. Silent, and worse the
 * longer the count. The accumulator now writes a synchronous ref, so the result
 * no longer depends on scheduler timing.
 *
 * Two digits happened to survive often enough to look fine, so this test uses a
 * THREE-digit count — the shortest one that reliably reproduced the loss.
 * Fixtures env (.env.test), same harness as tui-live-stream.test.tsx; the first
 * conversation there holds 109 messages, so a 100-row jump from the top lands
 * in range instead of clamping (which would hide the bug).
 */

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/tui/App.js";
import { clearCache } from "../src/tui/messageCache.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";

/**
 * The message cursor's ABSOLUTE index, read off the frame. MessageBubble prints
 * `lineNum.padStart(3)` then the "▸" cursor glyph, and ThreadPane prints the
 * absolute index on the cursor row (relative distances on every other row) —
 * so the number attached to "▸" IS `selectedMsgIdx`. The sidebar's own "▸" is
 * blanked while the thread pane holds focus, so there is exactly one match.
 */
function cursorIdx(frame: string): number | null {
  for (const line of frame.split("\n")) {
    const m = line.match(/(\d+)\s*▸/);
    if (m?.[1] !== undefined) return Number(m[1]);
  }
  return null;
}

describe("chunked vim count (fixtures env)", () => {
  it("applies every digit of a 3-digit count delivered as one chunk", async () => {
    const { lastFrame, stdin, unmount } = render(
      <ThemeProvider value={makeTheme()}>
        <App />
      </ThemeProvider>,
    );

    try {
      await vi.waitFor(
        () => {
          expect(lastFrame() ?? "").not.toContain("Loading");
        },
        { timeout: 10_000 },
      );

      // Focus the thread pane, then park the cursor at a known index.
      stdin.write("\t");
      stdin.write("gg");
      await vi.waitFor(
        () => {
          expect(cursorIdx(lastFrame() ?? "")).toBe(0);
        },
        { timeout: 10_000 },
      );

      // The whole count + motion in ONE write — the chunk path.
      stdin.write("100j");
      await vi.waitFor(
        () => {
          expect(cursorIdx(lastFrame() ?? "")).toBe(100);
        },
        { timeout: 10_000 },
      );

      // Regression shape: the dropped-digit bug landed on 10, not 100.
      expect(cursorIdx(lastFrame() ?? "")).not.toBe(10);
    } finally {
      unmount();
      clearCache();
    }
  }, 30_000);

  it("keeps a bare 0 as go-to-top even when it opens a chunk", async () => {
    const { lastFrame, stdin, unmount } = render(
      <ThemeProvider value={makeTheme()}>
        <App />
      </ThemeProvider>,
    );

    try {
      await vi.waitFor(
        () => {
          expect(lastFrame() ?? "").not.toContain("Loading");
        },
        { timeout: 10_000 },
      );

      stdin.write("\t");
      stdin.write("gg");
      await vi.waitFor(
        () => {
          expect(cursorIdx(lastFrame() ?? "")).toBe(0);
        },
        { timeout: 10_000 },
      );

      // Move off the top, then "0" alone must return there rather than being
      // buffered as a count — the branch that reads the buffer to decide.
      stdin.write("25j");
      await vi.waitFor(
        () => {
          expect(cursorIdx(lastFrame() ?? "")).toBe(25);
        },
        { timeout: 10_000 },
      );

      stdin.write("0");
      await vi.waitFor(
        () => {
          expect(cursorIdx(lastFrame() ?? "")).toBe(0);
        },
        { timeout: 10_000 },
      );
    } finally {
      unmount();
      clearCache();
    }
  }, 30_000);
});
