/**
 * Date-jump modal: free-text discoverability (swarm finding, "date-picker
 * keys" batch).
 *
 * The modal opens in picker mode, where letters used to be silently ignored
 * — typing "yesterday" did nothing, with no hint that free-text mode exists
 * behind Tab. That was the real shape of the "unparseable free-text date
 * silently refused" probe note: the error path in text mode works; the trap
 * was letters dying in the DEFAULT mode. Now a letter flips the modal to
 * text mode seeded with what was typed.
 */
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { DateJumpModal } from "../src/tui/components/DateJumpModal.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";

function mount(props: Partial<Parameters<typeof DateJumpModal>[0]> = {}) {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const ui = render(
    <ThemeProvider value={makeTheme({ preset: "safe" })}>
      <DateJumpModal value="" error="" onChange={onChange} onSubmit={onSubmit} {...props} />
    </ThemeProvider>,
  );
  return { ...ui, onChange, onSubmit };
}

describe("DateJumpModal free-text intent", () => {
  it("opens in picker mode", () => {
    const { lastFrame, unmount } = mount();
    expect(lastFrame()).toContain("[picker]");
    unmount();
  });

  it("typing a letter flips to text mode and seeds the input", async () => {
    const { stdin, lastFrame, onChange, unmount } = mount();
    stdin.write("y");
    expect(onChange).toHaveBeenCalledWith("y");
    // setMode's re-render is async — give React a tick to commit.
    await vi.waitFor(() => expect(lastFrame()).toContain("[text]"));
    unmount();
  });

  it("a pasted chunk with non-digits flips to text mode with the whole chunk", async () => {
    const { stdin, lastFrame, onChange, unmount } = mount();
    stdin.write("2 weeks ago");
    expect(onChange).toHaveBeenCalledWith("2 weeks ago");
    await vi.waitFor(() => expect(lastFrame()).toContain("[text]"));
    unmount();
  });

  it("digits stay in picker mode (field entry, not text intent)", () => {
    const { stdin, lastFrame, onChange, unmount } = mount();
    stdin.write("2");
    expect(onChange).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("[picker]");
    unmount();
  });

  it("hjkl stay in picker mode as navigation, never text intent", () => {
    const { stdin, lastFrame, onChange, unmount } = mount();
    stdin.write("j");
    stdin.write("h");
    expect(onChange).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("[picker]");
    unmount();
  });

  it("renders the parse error when one is set (regression: error path exists)", () => {
    const { lastFrame, unmount } = mount({ error: 'Could not parse "garbage".' });
    expect(lastFrame()).toContain('Could not parse "garbage".');
    unmount();
  });
});
