import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { DatePicker } from "../src/tui/components/DatePicker.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";

const SRC = readFileSync(resolve(__dirname, "../src/tui/components/DatePicker.tsx"), "utf8");
const initial = new Date(2026, 4, 20); // 2026-05-20

function mount(onSubmit = vi.fn(), onCancel = vi.fn()) {
  return render(
    <ThemeProvider value={makeTheme()}>
      <DatePicker initial={initial} focused onSubmit={onSubmit} onCancel={onCancel} />
    </ThemeProvider>,
  );
}

describe("DatePicker render + submit", () => {
  it("renders the initial date in YYYY-MM-DD form", () => {
    const { lastFrame, unmount } = mount();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("2026");
    expect(frame).toContain("05");
    expect(frame).toContain("20");
    unmount();
  });

  it("Enter submits an ISO date string", () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = mount(onSubmit);
    stdin.write("\r");
    expect(onSubmit).toHaveBeenCalledWith("2026-05-20");
    unmount();
  });
});

describe("DatePicker source-level keymap", () => {
  // ink-testing-library doesn't reliably translate ANSI escape sequences into
  // Ink's `key.rightArrow`/`upArrow`/etc, so we pin the keymap at source
  // level. Manual TUI exercise verifies the runtime behavior; the state
  // transitions themselves are unit-tested in date-picker-model.test.ts.
  it("arrows AND h/l advance fields", () => {
    expect(SRC).toMatch(/key\.leftArrow \|\| input === "h"/);
    expect(SRC).toMatch(/key\.rightArrow \|\| input === "l"/);
  });
  it("arrows AND k/j adjust the active field", () => {
    expect(SRC).toMatch(/key\.upArrow \|\| input === "k"/);
    expect(SRC).toMatch(/key\.downArrow \|\| input === "j"/);
  });
  it("Esc invokes onCancel", () => {
    expect(SRC).toMatch(/if \(key\.escape\)/);
    expect(SRC).toContain("onCancel()");
  });
  it("digit chunks fan into the model (chunked-keystroke law)", () => {
    expect(SRC).toMatch(/\/\^\[0-9\]\+\$\//);
    expect(SRC).toContain("applyDigits");
  });
  it("does not consume Tab — modal owns that for mode swap", () => {
    // key.tab may appear only as a NEGATED guard on the text-intent branch;
    // an `if (key.tab)` handler would steal the modal's mode toggle.
    expect(SRC).not.toMatch(/if \(key\.tab\)/);
    expect(SRC).toContain("!key.tab");
  });
});
