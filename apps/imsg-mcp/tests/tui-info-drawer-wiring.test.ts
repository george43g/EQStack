/**
 * Source-assertion: the per-thread info drawer stays fully wired in App.tsx.
 *
 * The TUI has one top-level useInput; every modal mode MUST have its own guard
 * block that early-returns, or browse-mode keys (most dangerously `q` = quit)
 * leak into the modal. This locks the `i` key, the info-mode guard, the
 * export-all action, and the render — cheap insurance against a refactor
 * silently dropping any of them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = readFileSync(join("src", "tui", "App.tsx"), "utf8");

describe("info drawer wiring in App.tsx", () => {
  it("binds the `i` key to open the info drawer", () => {
    expect(APP).toMatch(/input === "i"[\s\S]*openInfoDrawer\(\)/);
  });

  it("has a dedicated input-router guard for info mode", () => {
    expect(APP).toContain('if (state.mode === "info") {');
    expect(APP).toContain('dispatch({ type: "CLOSE_INFO_DRAWER" })');
  });

  it("wires the export-all-attachments action", () => {
    // Whitespace-tolerant: the call wraps across lines once formatted.
    expect(APP).toMatch(/saveAllAttachmentFiles\(\s*state\.infoAttachments/);
  });

  it("renders the InfoDrawer for info mode", () => {
    expect(APP).toMatch(/state\.mode === "info" && selected && \([\s\S]*<InfoDrawer/);
  });
});
