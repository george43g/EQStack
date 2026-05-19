// `gmail tui` — Ink/React terminal UI.
//
// The TUI module is lazy-loaded so the rest of the CLI doesn't pay the
// Ink/React startup cost. Phase D delivers the actual implementation; until
// then, this subcommand prints a clear "not yet implemented" message.

import { Command } from "commander";

export function buildTuiCommand(): Command {
  const cmd = new Command("tui");
  cmd.description("Launch the multi-pane terminal UI (Phase D)").action(async () => {
    try {
      const mod = (await import("../../tui/index.js")) as { runTui?: () => Promise<void> };
      if (typeof mod.runTui !== "function") {
        process.stderr.write(
          "TUI not yet implemented. See docs/phase-d-tui-plan.md for the implementation plan.\n",
        );
        process.exit(0);
      }
      await mod.runTui();
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "MODULE_NOT_FOUND") {
        process.stderr.write(
          "TUI not yet implemented. See docs/phase-d-tui-plan.md for the implementation plan.\n",
        );
        process.exit(0);
      }
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
  });
  return cmd;
}
