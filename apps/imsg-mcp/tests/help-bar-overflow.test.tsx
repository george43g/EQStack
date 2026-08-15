/**
 * HelpBar must never exceed its row (swarm finding, re-swarm after v1.21.12).
 *
 * The bar's hints are flexShrink={0} (deliberate — see component comments),
 * but without overflow="hidden" a hint set wider than the terminal made Ink
 * emit a line LONGER than the terminal. The terminal then hard-wrapped it
 * MID-HINT ("Tab:→msgs" → "Tab:→msg" + "s /:filter…"), eating a content row
 * and desyncing Ink's frame bookkeeping — stale cells stayed visible after
 * mode switches (live artifact: "picker↔text s←→/h/l:field t↑↓/k/j:adjust").
 */
import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { HelpBar } from "../src/tui/components/HelpBar.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";

function frameAt(width: number, mode: string, focus: "sidebar" | "thread") {
  const { lastFrame, unmount } = render(
    <ThemeProvider value={makeTheme({ preset: "safe" })}>
      <Box width={width}>
        {/* biome-ignore lint/suspicious/noExplicitAny: exercising every mode string */}
        <HelpBar mode={mode as any} focus={focus} />
      </Box>
    </ThemeProvider>,
  );
  const frame = lastFrame() ?? "";
  unmount();
  return frame;
}

describe("HelpBar overflow containment", () => {
  it("thread-mode hints (the 14-entry worst case) stay on ONE line at 60 cols", () => {
    const frame = frameAt(60, "browse", "thread");
    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThanOrEqual(60);
  });

  it("sidebar-mode hints stay on one line at 60 cols", () => {
    const frame = frameAt(60, "browse", "sidebar");
    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });

  it("every modal mode stays on one line even at 40 cols", () => {
    for (const mode of [
      "compose",
      "compose-new",
      "filter",
      "drawer",
      "info",
      "settings",
      "select",
      "export",
      "date-jump",
      "send-via",
      "palette",
    ]) {
      const frame = frameAt(40, mode, "thread");
      const lines = frame.split("\n").filter((l) => l.trim().length > 0);
      expect(lines, `mode=${mode}`).toHaveLength(1);
      expect(lines[0].length, `mode=${mode}`).toBeLessThanOrEqual(40);
    }
  });

  it("hints that fit are rendered intact at a wide width", () => {
    const frame = frameAt(120, "date-jump", "thread");
    expect(frame).toContain("Enter:jump");
    expect(frame).toContain("Esc:cancel");
  });
});
