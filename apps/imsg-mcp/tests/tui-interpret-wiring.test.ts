/**
 * Stage 4 — source-assertion wiring for the TUI media-interpret keys.
 * Verifies the input-guard law: every new key (R interpret, f reveal) is
 * handled inside its mode's guard block and calls its action.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = readFileSync(join("src", "tui", "App.tsx"), "utf8");
const USEIMSG = readFileSync(join("src", "tui", "hooks", "useImsg.ts"), "utf8");
const ACTIONS = readFileSync(join("src", "tui", "attachmentActions.ts"), "utf8");

describe("TUI media-interpret wiring in App.tsx", () => {
  it("binds R to interpret the selected message and routes work through core", () => {
    expect(APP).toMatch(/input === "R"[\s\S]{0,200}interpretMessage\(/);
    expect(APP).toMatch(/getInterpretRuntime\(\)\.service\.interpret/);
  });

  it("dispatches the resolved interpretation onto the message", () => {
    expect(APP).toContain('type: "SET_MESSAGE_INTERPRET"');
  });

  it("wires R (interpret) and f (reveal) inside the drawer-mode guard", () => {
    expect(APP).toMatch(
      /input === "R" && selectedMsg[\s\S]{0,120}interpretMessage\(selectedMsg, true\)/,
    );
    expect(APP).toMatch(/input === "f"[\s\S]{0,120}revealAttachment\(selectedMsg/);
  });

  it("wires f (reveal) inside the info-mode guard", () => {
    expect(APP).toMatch(/state\.mode === "info"[\s\S]*revealAttachmentFile\(att, dispatch\)/);
  });

  it("peeks cached/instant transcripts when messages load (never blocking)", () => {
    expect(USEIMSG).toMatch(/applyInlineInterpretations\(messages\)/);
    expect(USEIMSG).toMatch(/applyInlineInterpretations\(older\)/);
  });

  it("revealAttachmentFile reveals via `open -R`", () => {
    expect(ACTIONS).toMatch(/spawn\("open", \["-R", filepath\]/);
  });
});
