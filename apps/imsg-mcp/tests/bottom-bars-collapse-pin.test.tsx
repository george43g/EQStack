/**
 * StatusBar / HelpBar must never flex-collapse (re-swarm finding, the third
 * member of the height-0-box-still-paints family after #99 and #101).
 *
 * The App root is a fixed-height column; modals (date-jump, send-via, …)
 * render as EXTRA children, making the content taller than the terminal.
 * Yoga then shrinks children to fit — and a 1-line Box shrunk to height 0
 * STILL PAINTS its text, overlaying the row below. Live symptom: fragments
 * of the status bar ("Ai_s_ha", "iM_e_ssage") inside the help row's gap
 * cells at certain terminal geometries (76×22, 100×30 fresh boots).
 * Diagnosed by hexdumping the tmux grid: the junk was IN Ink's emitted
 * line, not stale cells — a screen clear on resize did not remove it.
 *
 * Fix: flexShrink={0} on both bars' root Boxes so the BODY alone absorbs
 * the squeeze (every modal root already carries the same pin).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const STATUS_SRC = readFileSync(resolve(__dirname, "../src/tui/components/StatusBar.tsx"), "utf8");
const HELP_SRC = readFileSync(resolve(__dirname, "../src/tui/components/HelpBar.tsx"), "utf8");

describe("bottom bars are pinned against flex collapse", () => {
  it("StatusBar root box has height 1 AND flexShrink 0", () => {
    // The pin must be on the same Box as height={1} — a pin elsewhere
    // doesn't protect the bar itself.
    const rootBox = STATUS_SRC.slice(
      STATUS_SRC.indexOf("return ("),
      STATUS_SRC.indexOf("justifyContent"),
    );
    expect(rootBox).toContain("height={1}");
    expect(rootBox).toContain("flexShrink={0}");
  });

  it("HelpBar root stays width-shrinkable but overflow-hidden; the vertical pin lives in App", () => {
    // The exact opening tag: flexShrink=0 on HelpBar's OWN root would block
    // horizontal shrink-to-terminal-width, reintroducing the mid-hint wrap
    // (#99) — so the tag must carry height+overflow and NOT a shrink pin.
    expect(HELP_SRC).toContain('<Box paddingX={1} height={1} gap={1} overflow="hidden">');
    // The vertical pin is a wrapper Box at the App usage site instead.
    const appSrc = readFileSync(resolve(__dirname, "../src/tui/App.tsx"), "utf8");
    const usage = appSrc.slice(appSrc.indexOf("<Box flexShrink={0} height={1}>"));
    expect(usage.slice(0, 200)).toContain("<HelpBar");
  });

  it("every modal root keeps its own pin (the bars' fix assumes it)", () => {
    for (const name of ["DateJumpModal", "SendViaModal", "ComposeRecipientModal", "ExportModal"]) {
      const src = readFileSync(resolve(__dirname, `../src/tui/components/${name}.tsx`), "utf8");
      const ret = src.indexOf("return (");
      const root = src.slice(ret, src.indexOf(">", ret));
      expect(root, name).toContain("flexShrink={0}");
    }
  });
});
