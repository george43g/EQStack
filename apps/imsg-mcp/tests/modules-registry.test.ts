/**
 * Module registry invariants. These are the contracts the palette + sidebar
 * rely on — if they're broken, the wrong renderer fires (or none at all)
 * when an instance is opened.
 */
import { describe, expect, it } from "vitest";
import { CORE_COMMANDS } from "../src/tui/keymap.js";
import { allCommands, findModule, MODULES } from "../src/tui/modules/registry.js";
import { initialState } from "../src/tui/types.js";

describe("module registry", () => {
  it("every command id is unique across modules + core", () => {
    const seen = new Map<string, string>();
    for (const c of CORE_COMMANDS) {
      expect(seen.has(c.id), `duplicate command id: ${c.id}`).toBe(false);
      seen.set(c.id, "core");
    }
    for (const mod of MODULES) {
      for (const cmd of mod.commands) {
        expect(seen.has(cmd.id), `duplicate command id: ${cmd.id}`).toBe(false);
        seen.set(cmd.id, mod.id);
      }
    }
  });

  it("every module command id is namespaced with `<moduleId>.`", () => {
    for (const mod of MODULES) {
      for (const cmd of mod.commands) {
        expect(cmd.id.startsWith(`${mod.id}.`)).toBe(true);
      }
    }
  });

  it("every module exposes a Pane renderer", () => {
    for (const mod of MODULES) {
      expect(typeof mod.Pane).toBe("function");
    }
  });

  it("findModule(id) returns the registered module", () => {
    for (const mod of MODULES) {
      expect(findModule(mod.id)).toBe(mod);
    }
    expect(findModule("nope-not-a-module")).toBeUndefined();
  });

  it("allCommands(state) merges core + module commands", () => {
    const merged = allCommands(initialState);
    const moduleCmdCount = MODULES.reduce((acc, m) => acc + m.commands.length, 0);
    // Core commands may be filtered by `when` — the count is the upper bound.
    expect(merged.length).toBeLessThanOrEqual(CORE_COMMANDS.length + moduleCmdCount);
    expect(merged.length).toBeGreaterThan(moduleCmdCount);
  });
});
