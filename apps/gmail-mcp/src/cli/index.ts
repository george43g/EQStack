#!/usr/bin/env node
//
// gmail — single bin for the Gmail MCP Server package.
//
// One binary, multiple modes (subcommands):
//   gmail mcp [--http]      — run the MCP server
//   gmail tui               — multi-pane terminal UI (Phase D)
//   gmail console           — interactive REPL for ad-hoc Gmail operations
//   gmail auth, search, …   — direct CLI for humans + shell scripts
//
// Bare `gmail` prints help and exits 0. The CLI is the default surface; the
// MCP / TUI / console modes are reachable via their explicit subcommands.
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
import { buildBatchDeleteCommand, buildBatchModifyCommand } from "./commands/batch.js";
import { buildConsoleCommand } from "./commands/console.js";
import { buildDownloadAttachmentCommand, buildDownloadEmailCommand } from "./commands/downloads.js";
import { buildFiltersCommand } from "./commands/filters.js";
import { buildHealthCommand } from "./commands/health.js";
import { buildLabelsCommand } from "./commands/labels.js";
import { buildMcpCommand } from "./commands/mcp.js";
import { buildDeleteCommand, buildModifyCommand } from "./commands/messages.js";
import { buildReadCommand } from "./commands/read.js";
import { buildSearchCommand } from "./commands/search.js";
import { buildDraftCommand, buildReplyAllCommand, buildSendCommand } from "./commands/send.js";
import { buildInboxAliasCommand, buildThreadsCommand } from "./commands/threads.js";
import { buildTuiCommand } from "./commands/tui.js";

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

/**
 * Build the commander tree. Exported so the interactive console and the
 * `usage` spec generator can reuse the exact same subcommand structure
 * without duplicating it.
 */
export function buildProgram(): Command {
  const program = new Command();
  const version = readVersion();

  program
    .name("gmail")
    .description(
      "Gmail — single bin for the Gmail MCP Server package. " +
        "CLI is the default; subcommands `mcp`, `tui`, `console` expose " +
        "the server, terminal UI, and interactive REPL respectively. " +
        "Run `gmail auth` first to authenticate.",
    )
    .version(version, "-V, --version")
    // Note: --json lives on each subcommand individually. Defining it at the
    // program level shadows the subcommand flag in Commander v14, so we keep
    // it scoped.
    .option("-q, --quiet", "Suppress non-error output to stderr")
    .option("-v, --verbose", "Log debug-level information to stderr")
    .addHelpText(
      "after",
      `
Examples:
  gmail                                   # show this help
  gmail mcp                               # run the MCP server (stdio)
  gmail mcp --http --port 8080            # run the MCP server (Streamable HTTP)
  gmail tui                               # multi-pane terminal UI (Phase D)
  gmail console                           # interactive REPL
  gmail auth                              # interactive scope-picker, opens browser
  gmail auth --scopes=gmail.readonly      # specific scopes, no prompt
  gmail auth --headless                   # remote-server flow (prints URL only)
  gmail auth --print-json                 # auth, then print credentials JSON to stdout
                                          # (pipe to GMAIL_CREDENTIALS_JSON / GH secret / 1Password)
  gmail health                            # local canary; no Gmail API call
  gmail search "from:noreply" --json      # typed structured payload (jq-friendly)

Credentials sources (first match wins):
  1. GMAIL_CREDENTIALS_JSON   raw JSON  (CI / Docker / k8s secrets)
  2. GMAIL_CREDENTIALS_OP     op://...  (1Password CLI)
  3. GMAIL_CREDENTIALS_PATH   file path (default ~/.gmail-mcp/credentials.json)

Scopes (space=toggle, a=all, i=invert in interactive mode):
  gmail.readonly, gmail.modify, gmail.compose, gmail.send,
  gmail.labels, gmail.settings.basic, gmail.settings.sharing
`,
    );

  // Mode subcommands.
  program.addCommand(buildMcpCommand());
  program.addCommand(buildTuiCommand());
  program.addCommand(buildConsoleCommand());

  // CLI operations.
  program.addCommand(buildAuthCommand());
  program.addCommand(buildHealthCommand());
  program.addCommand(buildInboxAliasCommand());
  program.addCommand(buildSearchCommand());
  program.addCommand(buildReadCommand());
  program.addCommand(buildThreadsCommand());
  program.addCommand(buildSendCommand());
  program.addCommand(buildReplyAllCommand());
  program.addCommand(buildDraftCommand());
  program.addCommand(buildModifyCommand());
  program.addCommand(buildDeleteCommand());
  program.addCommand(buildBatchModifyCommand());
  program.addCommand(buildBatchDeleteCommand());
  program.addCommand(buildLabelsCommand());
  program.addCommand(buildFiltersCommand());
  program.addCommand(buildDownloadEmailCommand());
  program.addCommand(buildDownloadAttachmentCommand());

  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = buildProgram();
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
      arg1.endsWith("\\cli\\index.ts") ||
      arg1.endsWith("/gmail")
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`gmail: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
