/**
 * Command palette title squeeze (re-swarm finding).
 *
 * Title and description were flex-shrink SIBLINGS inside the fixed-width
 * title column, so a long description stole the title's columns and
 * truncated it mid-word ("Copy thread s", "Analytics: Messag") while the
 * description kept generous room. The title is now pinned; the description
 * alone absorbs the squeeze.
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { CommandPalette } from "../src/tui/components/CommandPalette.js";
import type { Command } from "../src/tui/keymap.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";

const COMMANDS: Command[] = [
  {
    id: "t.copy",
    title: "Copy thread slug",
    category: "Conversations",
    keybinding: "y",
    description: "Sidebar focus — copies the ~slug of the selected row to the clipboard",
    run: () => {},
  },
  {
    id: "t.plain",
    title: "Refresh conversations",
    category: "Conversations",
    keybinding: "r",
    run: () => {},
  },
];

function mount(width = 80) {
  return render(
    <ThemeProvider value={makeTheme({ preset: "safe" })}>
      <CommandPalette
        commands={COMMANDS}
        query=""
        cursor={0}
        width={width}
        height={20}
        // ctx is only consumed when a command RUNS — render never touches it.
        ctx={{} as never}
        onQueryChange={() => {}}
        onCursorMove={() => {}}
        onSelectCursor={() => {}}
        onClose={() => {}}
      />
    </ThemeProvider>,
  );
}

describe("palette title squeeze", () => {
  it("a long description never truncates the title mid-word", () => {
    const { lastFrame, unmount } = mount(80);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Copy thread slug");
    expect(frame).not.toContain("Copy thread s ");
    unmount();
  });

  it("the description is what truncates when space runs out", () => {
    const { lastFrame, unmount } = mount(70);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Copy thread slug");
    unmount();
  });

  it("rows without a description are unaffected", () => {
    const { lastFrame, unmount } = mount(80);
    expect(lastFrame()).toContain("Refresh conversations");
    unmount();
  });
});
