/**
 * SettingsPanel row-collapse regression (re-swarm finding after v1.21.13).
 *
 * The panel windowed its rows by ROW COUNT (`height - chrome` rows), but a
 * rendered row costs up to 3 physical lines (section header with its blank
 * margin + row + selected-row hint). The overflow made yoga flex-shrink
 * collapse row boxes to height 0 — and a height-0 box still paints its text,
 * overlaying the next row. Reproduced deterministically at 78×20/24:
 * "Apple transcript (instant, free)" collapsed onto "Local tools
 * (hear/yap/whisper)" leaving the longer label's tail visible past the
 * shorter one: "Local tools (hear/yap/whisper)e)".
 *
 * Fix: computeSettingsWindow slices by rendered lines; row boxes are
 * flexShrink={0} so any residual overflow clips instead of collapsing.
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { InterpretConfigSchema } from "../src/app-config.js";
import { SettingsPanel } from "../src/tui/components/SettingsPanel.js";
import {
  buildSettingsRows,
  computeSettingsWindow,
  settingsRowLineCost,
} from "../src/tui/settings-model.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";

function rows() {
  const interpret = InterpretConfigSchema.parse({
    auto: "all",
    chains: {
      audio: ["apple", "local", "provider:openrouter"],
      image: ["provider:openrouter"],
      video: ["provider:openrouter"],
    },
    providers: [{ name: "openrouter", preset: "openrouter" }],
  });
  return buildSettingsRows(interpret, { openrouter: true });
}

function renderPanel(cursor: number, width: number, height: number) {
  const ui = render(
    <ThemeProvider value={makeTheme({ preset: "safe" })}>
      <SettingsPanel
        rows={rows()}
        cursor={cursor}
        configPath="/tmp/c.json"
        warnings={[]}
        width={width}
        height={height}
      />
    </ThemeProvider>,
  );
  const frame = ui.lastFrame() ?? "";
  ui.unmount();
  return frame;
}

describe("settings panel row overlap regression", () => {
  it("the exact live repro: no collapsed-row tail at 78×20", () => {
    const frame = renderPanel(0, 78, 20);
    // The overlap artifact: the longer collapsed label peeking past the
    // shorter one it was painted under.
    expect(frame).not.toMatch(/whisper\)e\)/);
    // Every label that IS shown must be intact, not a 2-char tail.
    for (const line of frame.split("\n")) {
      expect(line).not.toMatch(/\)\S+\)/); // ")<junk>)" glue pattern
    }
  });

  it("no overlap at 78×24 either (the second live repro height)", () => {
    expect(renderPanel(0, 78, 24)).not.toMatch(/whisper\)e\)/);
  });

  it("the cursor row and its hint are always visible", () => {
    const all = rows();
    const lastSelectable = all
      .map((r, i) => (r.selectable ? i : -1))
      .filter((i) => i >= 0)
      .pop();
    const frame = renderPanel(lastSelectable ?? 0, 78, 20);
    expect(frame).toContain("▸");
    const hint = all[lastSelectable ?? 0].hint;
    if (hint) expect(frame).toContain(hint.slice(0, 8));
  });
});

describe("computeSettingsWindow", () => {
  const all = rows();

  it("always includes the cursor", () => {
    for (let c = 0; c < all.length; c++) {
      const { start, end } = computeSettingsWindow(all, c, 10);
      expect(start).toBeLessThanOrEqual(c);
      expect(end).toBeGreaterThan(c);
    }
  });

  it("total line cost of the window never exceeds the budget", () => {
    for (let c = 0; c < all.length; c++) {
      for (const budget of [4, 8, 12, 20]) {
        const { start, end } = computeSettingsWindow(all, c, budget);
        let lines = 0;
        for (let i = start; i < end; i++) lines += settingsRowLineCost(all, i, c);
        // A single row can cost up to 3 lines; if even the cursor alone
        // exceeds the budget, the window is just the cursor (clipped render).
        if (end - start > 1) expect(lines).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("fills the budget when there are more rows than fit", () => {
    const { start, end } = computeSettingsWindow(all, 0, 8);
    expect(end - start).toBeLessThan(all.length);
    // Extending the window by one more row in either direction must bust
    // the budget — i.e. the window is maximal.
    let lines = 0;
    for (let i = start; i < end; i++) lines += settingsRowLineCost(all, i, 0);
    if (end < all.length) {
      expect(lines + settingsRowLineCost(all, end, 0)).toBeGreaterThan(8);
    }
  });

  it("handles an empty row list", () => {
    expect(computeSettingsWindow([], 0, 10)).toEqual({ start: 0, end: 0 });
  });
});
