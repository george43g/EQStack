/**
 * Make sure the keymap registry (which the palette uses as a keybinding
 * cheat sheet) doesn't silently drift from the actual keybindings in
 * App.tsx.
 *
 * We don't try to parse the full useInput handler — that would be brittle.
 * Instead we check that a known core set of single-char keys (j/k/c/r/q/N/V/S/O)
 * each appear both:
 *   1. As `input === "<key>"` inside App.tsx, and
 *   2. As a keybinding-string entry in CORE_COMMANDS.
 *
 * Drift then fails loudly with a useful name.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_COMMANDS } from "../src/tui/keymap.js";

const APP_SRC = readFileSync(resolve(__dirname, "../src/tui/App.tsx"), "utf8");

const KEYS_TO_VERIFY: Array<{ key: string; commandId: string }> = [
  { key: "c", commandId: "core.compose" },
  { key: "r", commandId: "core.refresh" },
  { key: "N", commandId: "core.compose.new" },
  { key: "V", commandId: "core.select.start" },
  { key: "S", commandId: "core.send.via" },
  { key: "O", commandId: "core.open.messages" },
  { key: "/", commandId: "core.filter" },
  { key: ":", commandId: "core.date.jump" },
  { key: "d", commandId: "core.devstats" },
];

describe("keymap registry", () => {
  it('every documented core command has a matching `input === "<key>"` in App.tsx', () => {
    for (const { key } of KEYS_TO_VERIFY) {
      const re = new RegExp(`input === "${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
      expect(APP_SRC).toMatch(re);
    }
  });

  it("every documented App.tsx key has an entry in CORE_COMMANDS", () => {
    const byId = new Map(CORE_COMMANDS.map((c) => [c.id, c]));
    for (const { key, commandId } of KEYS_TO_VERIFY) {
      const cmd = byId.get(commandId);
      expect(cmd, `missing command in CORE_COMMANDS: ${commandId}`).toBeTruthy();
      expect(cmd?.keybinding).toContain(key);
    }
  });

  it("Ctrl-P palette trigger is wired in App.tsx", () => {
    expect(APP_SRC).toMatch(/key\.ctrl && input === "p"/);
    expect(APP_SRC).toMatch(/OPEN_PALETTE/);
  });
});
