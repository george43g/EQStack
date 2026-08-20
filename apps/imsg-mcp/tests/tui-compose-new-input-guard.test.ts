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
    // The quit handler now records the shutdown cause (user_quit) and carries
    // a comment before closing — anchor on the noteShutdownCause line.
    const quitIdx = SRC.search(
      /if \(input === "q"\)\s*\{[\s\S]{0,400}?noteShutdownCause\("user_quit"\)/,
    );
    expect(guardIdx, "compose-new guard not found").toBeGreaterThan(-1);
    expect(quitIdx, "q-quit handler not found").toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(quitIdx);
  });

  it("every text-entry modal mode short-circuits before the browse-mode keys", () => {
    // The bare `q` quit is the canary: if any text-entry modal falls through
    // to it, a keystroke can kill the TUI. Assert each returns earlier.
    // The quit handler now records the shutdown cause (user_quit) and carries
    // a comment before closing — anchor on the noteShutdownCause line.
    const quitIdx = SRC.search(
      /if \(input === "q"\)\s*\{[\s\S]{0,400}?noteShutdownCause\("user_quit"\)/,
    );
    for (const mode of ["filter", "compose", "compose-new"]) {
      const idx = SRC.search(new RegExp(`if \\(state\\.mode === "${mode}"\\)`));
      expect(idx, `no guard for mode "${mode}"`).toBeGreaterThan(-1);
      expect(idx, `mode "${mode}" guard must precede the q-quit`).toBeLessThan(quitIdx);
    }
  });

  it("select mode whitelists movement keys and returns before the q-quit (A3-2)", () => {
    // Select mode used to FALL THROUGH to the browse handlers for any
    // non-handled key, so `q` inside a visual selection quit the whole app.
    // The block must now bail on anything that isn't a movement key.
    const selectIdx = SRC.search(/if \(state\.mode === "select"\)/);
    // The quit handler now records the shutdown cause (user_quit) and carries
    // a comment before closing — anchor on the noteShutdownCause line.
    const quitIdx = SRC.search(
      /if \(input === "q"\)\s*\{[\s\S]{0,400}?noteShutdownCause\("user_quit"\)/,
    );
    expect(selectIdx, "select-mode block not found").toBeGreaterThan(-1);
    // The movement whitelist + its non-movement early return live inside the block.
    expect(SRC).toMatch(/const selectMovement =/);
    expect(SRC).toMatch(/if \(!selectMovement\) return;/);
    const whitelistIdx = SRC.search(/if \(!selectMovement\) return;/);
    expect(whitelistIdx, "select whitelist must precede the q-quit").toBeLessThan(quitIdx);
    expect(whitelistIdx).toBeGreaterThan(selectIdx);
  });
});

describe("chunked-input fan-out (Ink delivers bursts/pastes as ONE call)", () => {
  it("splits multi-key chunks made entirely of motion keys", () => {
    // "jj" never equalled "j", so fast scrolling dropped most keystrokes.
    // The pure split now lives upstream (tui-kit splitNavChunk, lifted from
    // this router); the owned set and the per-char dispatch stay pinned here.
    expect(SRC).toMatch(/const OWNED_NAV_KEYS = new Set\(\[\.\.\."0123456789gGjk\{\}"\]\)/);
    expect(SRC).toMatch(/for \(const ch of split\) await handleKeyRef\.current\(ch, key\)/);
  });

  it("passes non-motion chunks through WHOLE (a paste must not drive motion)", () => {
    // The fan-out is gated on splitNavChunk's all-or-nothing null contract:
    // any character outside OWNED_NAV_KEYS → null → the chunk passes through
    // whole and can never drive motion or reach a destructive key.
    const gate = SRC.search(/splitNavChunk\(input, OWNED_NAV_KEYS\)/);
    expect(gate, "fan-out must be gated on splitNavChunk(OWNED_NAV_KEYS)").toBeGreaterThan(-1);
    expect(SRC).toMatch(/if \(split\) \{/);
  });

  it("the vim count guard matches a SINGLE digit, not a lexicographic range", () => {
    // `input >= "0" && input <= "9"` is a string range that "5j" satisfies —
    // a chunked count entered the buffer whole and replayed on the next key.
    expect(SRC).not.toMatch(/input >= "0" && input <= "9"/);
    expect(SRC).toMatch(/\/\^\[0-9\]\$\/\.test\(input\)/);
  });
});
