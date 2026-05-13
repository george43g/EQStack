#!/usr/bin/env node
//
// gmail-cli — Commander-based CLI surface for Gmail-MCP-Server.
//
// Three bins ship in this package:
//   gmail-mcp  — stdio MCP server (the original surface)
//   gmail-cli  — this binary; subcommands per Gmail operation
//   gmail-tui  — Ink/React TUI (Phase D)
//
// The CLI is *not* a thin client over the MCP server — it imports the same
// core modules in-process, so it shares OAuth state and produces richer
// human-readable output (tables/colors via picocolors + cli-table3) when
// stdout is a TTY, or compact `--json` for scripting.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { buildAuthCommand } from "./commands/auth.js";
import { buildHealthCommand } from "./commands/health.js";
import { buildLabelsCommand } from "./commands/labels.js";
import { buildReadCommand } from "./commands/read.js";
import { buildSearchCommand } from "./commands/search.js";
import { buildServeCommand } from "./commands/serve.js";

// Read version from package.json at runtime to avoid hand-syncing.
function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/cli/index.js → ../../package.json; src/cli/index.ts → same.
    const pkgPath = path.resolve(here, "..", "..", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = new Command();
  const version = readVersion();

  program
    .name("gmail-cli")
    .description(
      "Gmail CLI — runs the same operations as the gmail-mcp MCP server, " +
        "but for humans and shell scripts. Run `gmail-cli auth` first to authenticate.",
    )
    .version(version, "-V, --version")
    .option("--json", "Emit machine-readable JSON (where supported by the subcommand)")
    .option("-q, --quiet", "Suppress non-error output to stderr")
    .option("-v, --verbose", "Log debug-level information to stderr")
    .addHelpText(
      "after",
      `
Examples:
  gmail-cli auth                          # interactive scope-picker, opens browser
  gmail-cli auth --scopes=gmail.readonly  # specific scopes, no prompt
  gmail-cli auth --headless               # remote-server flow (prints URL only)
  gmail-cli auth --print-json             # auth, then print credentials JSON to stdout
                                          # (pipe to GMAIL_CREDENTIALS_JSON / GH secret / 1Password)
  gmail-cli health                        # local canary; no Gmail API call

Credentials sources (first match wins):
  1. GMAIL_CREDENTIALS_JSON   raw JSON  (CI / Docker / k8s secrets)
  2. GMAIL_CREDENTIALS_OP     op://...  (1Password CLI)
  3. GMAIL_CREDENTIALS_PATH   file path (default ~/.gmail-mcp/credentials.json)

Scopes (space=toggle, a=all, i=invert in interactive mode):
  gmail.readonly, gmail.modify, gmail.compose, gmail.send,
  gmail.labels, gmail.settings.basic, gmail.settings.sharing
`,
    );

  program.addCommand(buildAuthCommand());
  program.addCommand(buildHealthCommand());
  program.addCommand(buildSearchCommand());
  program.addCommand(buildReadCommand());
  program.addCommand(buildLabelsCommand());
  program.addCommand(buildServeCommand());

  // Phase C continuation will add: inbox, read, search, threads, send,
  // reply-all, draft, modify, delete, batch-modify, batch-delete, labels,
  // filters, download-email, download-attachment, serve, tui.

  await program.parseAsync(argv as string[]);
}

// Run when invoked directly (not when imported by tests).
const isMain = (() => {
  try {
    const arg1 = process.argv[1] ?? "";
    return (
      arg1.endsWith("/cli/index.js") ||
      arg1.endsWith("/cli/index.ts") ||
      arg1.endsWith("\\cli\\index.js") ||
      arg1.endsWith("\\cli\\index.ts")
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`gmail-cli: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
