/**
 * Regression: the App-level useInput router must short-circuit while the
 * compose-to-new-thread modal (mode "compose-new") is open, BEFORE reaching
 * the browse-mode single-key handlers — most importantly the bare `q` quit.
 *
 * Bug history (found via a VHS/tmux repro of the compose scene): Ink fires
 * every registered useInput handler, so ComposeRecipientModal's own text
 * input and the App-level router both saw each keystroke. Every other modal
 * mode (compose, confirm, filter, drawer, date-jump, send-via, export,
 * select) returned early, but "compose-new" had no guard — so typing a
 * recipient name containing "q" (e.g. "quinn") hit `if (input === "q")` and
 * silently killed the entire TUI. `d`/`V`/`:`/`O`/`S` in a name misfired too.
 *
 * This test fails loudly if a refactor drops the early return or moves it
 * after the browse-mode handlers.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "../src/tui/App.tsx"), "utf8");

describe("App.tsx compose-new input guard", () => {
  it("returns early for compose-new mode", () => {
    expect(SRC).toMatch(/if \(state\.mode === "compose-new"\)\s*\{\s*return;\s*\}/);
  });

  it("guards compose-new BEFORE the bare `q` quit handler", () => {
    const guardIdx = SRC.search(/if \(state\.mode === "compose-new"\)/);
    const quitIdx = SRC.search(/if \(input === "q"\)\s*\{\s*await imsg\.close\(\)/);
    expect(guardIdx, "compose-new guard not found").toBeGreaterThan(-1);
    expect(quitIdx, "q-quit handler not found").toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(quitIdx);
  });

  it("every text-entry modal mode short-circuits before the browse-mode keys", () => {
    // The bare `q` quit is the canary: if any text-entry modal falls through
    // to it, a keystroke can kill the TUI. Assert each returns earlier.
    const quitIdx = SRC.search(/if \(input === "q"\)\s*\{\s*await imsg\.close\(\)/);
    for (const mode of ["filter", "compose", "compose-new"]) {
      const idx = SRC.search(new RegExp(`if \\(state\\.mode === "${mode}"\\)`));
      expect(idx, `no guard for mode "${mode}"`).toBeGreaterThan(-1);
      expect(idx, `mode "${mode}" guard must precede the q-quit`).toBeLessThan(quitIdx);
    }
  });
});
