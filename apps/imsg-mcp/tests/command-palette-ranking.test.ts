/**
 * Smoke test for the command-palette ranking: short queries should surface
 * the obvious match first. This is the regression net for the palette being
 * useful — if the fuzzy weight tuning ever drifts, this test catches it.
 */
import { describe, expect, it } from "vitest";
import { rankFuzzy } from "../src/fuzzy.js";
import type { Command } from "../src/tui/keymap.js";
import { CORE_COMMANDS } from "../src/tui/keymap.js";
import { MODULES } from "../src/tui/modules/registry.js";

/** Build a flat command list mirroring what the palette renders. */
function allPaletteCommands(): Command[] {
  const out: Command[] = [...CORE_COMMANDS];
  for (const mod of MODULES) {
    for (const cmd of mod.commands) {
      out.push({
        id: cmd.id,
        title: cmd.title,
        description: cmd.description,
        category: mod.name,
        keybinding: cmd.keybinding,
        run: () => {},
      });
    }
  }
  return out;
}

function topMatch(query: string): Command | undefined {
  const ranked = rankFuzzy(
    query,
    allPaletteCommands(),
    (c) => `${c.title} ${c.category} ${c.description ?? ""} ${c.keybinding ?? ""}`,
    0.3,
  );
  return ranked[0]?.item;
}

describe("command-palette ranking", () => {
  it('"str" surfaces the Messaging Streaks analytic at the top', () => {
    const top = topMatch("str");
    expect(top?.id).toBe("analytics.messaging_streaks");
  });

  it('"compose" surfaces the compose command at the top', () => {
    const top = topMatch("compose");
    expect(top?.id).toMatch(/core\.compose/);
  });

  it('"refresh" surfaces the refresh command at the top', () => {
    const top = topMatch("refresh");
    expect(top?.id).toBe("core.refresh");
  });

  it('"heatmap" surfaces the daily heatmap analytic', () => {
    const top = topMatch("heatmap");
    expect(top?.id).toBe("analytics.daily_heatmap");
  });

  it("an unrelated string returns no match", () => {
    const ranked = rankFuzzy(
      "xyzqqq",
      allPaletteCommands(),
      (c) => `${c.title} ${c.category} ${c.description ?? ""} ${c.keybinding ?? ""}`,
      0.6,
    );
    expect(ranked).toHaveLength(0);
  });
});
