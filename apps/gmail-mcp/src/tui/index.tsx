// Phase D entry point: `gmail tui` lazy-loads this module and calls runTui().
// Boots the in-process dispatcher via bootstrapSession (TUI does NOT use
// main() — Ink owns the signal handlers).

import { withFullScreen } from "fullscreen-ink";
import { BootstrapError, bootstrapSession } from "../index.js";
import { App } from "./App.js";
import { resolveInitialTheme } from "./hooks/useTheme.js";

export async function runTui(): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write(
      "gmail tui requires an interactive terminal (TTY). Use `gmail` for the non-interactive CLI.\n",
    );
    process.exit(2);
  }

  try {
    await bootstrapSession({ skipTransport: true });
  } catch (err) {
    if (err instanceof BootstrapError) {
      process.stderr.write(
        `\nCould not start TUI: ${err.message}\n\n` +
          `Hint: run \`gmail account auth <id>\` to authorise an account, ` +
          `or set GMAIL_FIXTURE_MODE=1 to run against bundled fixtures.\n`,
      );
      process.exit(2);
    }
    throw err;
  }

  const theme = resolveInitialTheme();
  const ink = withFullScreen(<App theme={theme} />);
  await ink.start();
  await ink.waitUntilExit();
}
