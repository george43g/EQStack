/**
 * Regression test: the `d` (toggle dev stats) handler in App.tsx must guard
 * against Ctrl/Meta modifiers, otherwise Ctrl-d (half-page scroll) silently
 * triggers the dev-stats pane before the Ctrl-d branch can run.
 *
 * Bug history: pressing Ctrl-d in the thread pane toggled the dev stats
 * panel because Ink fires `input === "d"` alongside `key.ctrl === true`, and
 * the `d` handler at App.tsx:334 returned early without checking modifiers.
 *
 * If a future refactor drops the guard, this test fails loudly.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "../src/tui/App.tsx"), "utf8");

describe("App.tsx keymap", () => {
  it("the `d` (dev stats) handler guards against Ctrl and Meta modifiers", () => {
    // Find the dev-stats handler block. It must include the modifier guards
    // alongside the input check so Ctrl-d falls through to the half-page
    // scroll handler.
    const devStatsBlock = SRC.match(/if \(input === "d"[^)]*\)\s*\{\s*[^}]*TOGGLE_DEV_STATS/)?.[0];
    expect(devStatsBlock, "could not find dev-stats handler block").toBeTruthy();
    expect(devStatsBlock).toContain("!key.ctrl");
    expect(devStatsBlock).toContain("!key.meta");
  });

  it("Ctrl-d (half-page down) handler remains present", () => {
    expect(SRC).toMatch(/key\.ctrl && input === "d"/);
  });
});
