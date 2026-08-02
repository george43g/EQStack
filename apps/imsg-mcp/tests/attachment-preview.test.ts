/**
 * Regression test: attachment open uses macOS Quick Look (qlmanage -p) for
 * non-video attachments, with mpv preferred for video. The previous in-terminal
 * image preview path (terminal-image.ts displayImage()) was dead code and
 * relied on terminal-graphics protocols that don't work reliably in kitty;
 * the rewrite goes through Quick Look instead.
 *
 * Source-grep guards against future regressions back to a dead-code path.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The open/save helpers moved from App.tsx into the extracted actions module.
const ACTIONS_SRC = readFileSync(resolve(__dirname, "../src/tui/attachmentActions.ts"), "utf8");
const APP_SRC = readFileSync(resolve(__dirname, "../src/tui/App.tsx"), "utf8");

describe("attachment preview path", () => {
  it("uses qlmanage -p for non-video attachments", () => {
    expect(ACTIONS_SRC).toContain('"qlmanage"');
    expect(ACTIONS_SRC).toContain('"-p"');
  });

  it("uses mpv for video with qlmanage fallback", () => {
    // mpv spawn with on('error') fallback to qlmanage
    expect(ACTIONS_SRC).toMatch(/spawn\("mpv"/);
    expect(ACTIONS_SRC).toMatch(/child\.on\("error", spawnQuickLook\)/);
  });

  it("does not reference the deleted terminal-image module", () => {
    for (const src of [ACTIONS_SRC, APP_SRC]) {
      expect(src).not.toContain("terminal-image");
      expect(src).not.toContain("displayImage");
    }
    expect(existsSync(resolve(__dirname, "../src/tui/terminal-image.ts"))).toBe(false);
  });
});
