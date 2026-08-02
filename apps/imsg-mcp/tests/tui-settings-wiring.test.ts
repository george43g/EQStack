/**
 * Source-assertion: the settings panel stays fully wired in App.tsx + keymap.
 *
 * The TUI has one top-level useInput; every modal mode MUST have its own guard
 * block that early-returns, or browse-mode keys (most dangerously `q` = quit)
 * leak into the modal. This locks the `,` open key, the settings-mode guard
 * (with `q`/Esc closing the PANEL, not the app), the render, and the palette
 * command — cheap insurance against a refactor silently dropping any of them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = readFileSync(join("src", "tui", "App.tsx"), "utf8");
const KEYMAP = readFileSync(join("src", "tui", "keymap.ts"), "utf8");
const HELPBAR = readFileSync(join("src", "tui", "components", "HelpBar.tsx"), "utf8");

describe("settings panel wiring in App.tsx", () => {
  it("binds the `,` key to open the settings panel", () => {
    expect(APP).toMatch(/input === ","[\s\S]*openSettings\(dispatch\)/);
  });

  it("has a dedicated input-router guard for settings mode", () => {
    expect(APP).toContain('if (state.mode === "settings") {');
    expect(APP).toContain('dispatch({ type: "CLOSE_SETTINGS" })');
  });

  it("closes the panel (not the app) on q / Esc inside the guard", () => {
    // The guard's first branch must handle q + escape so browse-mode quit can't leak.
    expect(APP).toMatch(/state\.mode === "settings"[\s\S]{0,200}key\.escape \|\| input === "q"/);
  });

  it("wires the edit + reorder actions to applySettings", () => {
    expect(APP).toContain('applySettings("toggle")');
    expect(APP).toContain('applySettings("moveUp")');
    expect(APP).toContain('applySettings("moveDown")');
  });

  it("renders the SettingsPanel for settings mode", () => {
    expect(APP).toMatch(/state\.mode === "settings" \?[\s\S]*<SettingsPanel/);
  });
});

describe("settings command in the palette + help bar", () => {
  it("registers a core.settings command bound to `,`", () => {
    expect(KEYMAP).toContain('id: "core.settings"');
    expect(KEYMAP).toMatch(/keybinding: ","/);
    expect(KEYMAP).toContain("openSettings(dispatch)");
  });

  it("advertises the settings key in the help bar", () => {
    expect(HELPBAR).toContain("SETTINGS_KEYS");
    expect(HELPBAR).toMatch(/mode === "settings"/);
  });
});
