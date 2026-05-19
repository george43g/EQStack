// `gmail console` — interactive REPL over the same commander tree as the CLI.
//
// Modeled on imsg-mcp's console (/Users/george/repos/imsg-mcp/src/cli.ts):
// a readline prompt feeding one line at a time into `program.parseAsync` so
// console commands stay 1:1 with `gmail` CLI commands. A small alias-rewrite
// table layers snappy two-letter shortcuts (`i` → inbox, `s` → search, …)
// on top of the canonical CLI surface.
//
// Output stays terse and human-readable (no JSON envelope) so `sed`/`awk`/
// `grep` work the way you'd expect inside the session.

import { createInterface } from "node:readline";
import pc from "picocolors";
import { buildProgram } from "./index.js";
import { bootstrapForCli, executeCliOp } from "./runtime.js";

// ── Alias table ──────────────────────────────────────────────────────
// Console-only shortcuts. The CLI surface keeps the canonical long names.

const ALIASES: Record<string, string> = {
  i: "inbox",
  s: "search",
  r: "read",
  ra: "reply-all",
  d: "draft",
  t: "threads",
  lab: "labels",
  fil: "filters",
  mod: "modify",
  del: "delete",
  bm: "batch-modify",
  bd: "batch-delete",
  de: "download-email",
  da: "download-attachment",
  h: "health",
};

// ── Tokenizer ────────────────────────────────────────────────────────
// Quote-aware splitter so `s "from:foo bar"` parses as two tokens.
// Copied verbatim from imsg-mcp's parseConsoleInput.

export function parseConsoleInput(line: string): { cmd: string; args: string[] } {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const char of line) {
    if ((char === '"' || char === "'") && quote == null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (char === " " && quote == null) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return { cmd: parts[0] ?? "", args: parts.slice(1) };
}

/** Apply the console alias rewrite to the first token. Returns the resolved
 *  command name; passes through unknown commands so commander handles the
 *  error message itself. */
export function rewriteAlias(cmd: string): string {
  return ALIASES[cmd] ?? cmd;
}

// ── Legend ───────────────────────────────────────────────────────────

const LEGEND_LINES: Array<{ kind: "header" | "cmd" | "blank"; left?: string; right?: string }> = [
  { kind: "header", left: "Read" },
  { kind: "cmd", left: "i [n]", right: "list inbox threads (alias for `inbox`)" },
  { kind: "cmd", left: "s <query>", right: "search emails (Gmail query syntax)" },
  { kind: "cmd", left: "r <messageId>", right: "read an email" },
  { kind: "cmd", left: "t list|get|modify|inbox", right: "thread-level ops" },
  { kind: "blank" },
  { kind: "header", left: "Write" },
  { kind: "cmd", left: "send -t … -s … -b …", right: "send an email" },
  { kind: "cmd", left: "d -t … -s … -b …", right: "create a draft (alias for `draft`)" },
  { kind: "cmd", left: "ra <id> -b …", right: "reply-all to a message" },
  { kind: "cmd", left: "mod <id> --add|--remove", right: "add/remove labels" },
  { kind: "cmd", left: "del <id>", right: "delete a message (confirms in console)" },
  { kind: "cmd", left: "bm / bd", right: "batch-modify / batch-delete" },
  { kind: "blank" },
  { kind: "header", left: "Manage" },
  { kind: "cmd", left: "lab {list,create,update,delete}", right: "labels" },
  { kind: "cmd", left: "fil {list,get,create,delete}", right: "filters" },
  { kind: "cmd", left: "de <id>", right: "download email to disk" },
  { kind: "cmd", left: "da <msgId> <attId>", right: "download an attachment" },
  { kind: "blank" },
  { kind: "header", left: "Debug" },
  { kind: "cmd", left: "h", right: "health_check (local canary)" },
  { kind: "cmd", left: "tools", right: "list every registered MCP tool" },
  { kind: "cmd", left: "raw <name> <json>", right: "call any tool with raw args" },
  { kind: "blank" },
  { kind: "header", left: "Session" },
  { kind: "cmd", left: "help / ?", right: "show this legend" },
  { kind: "cmd", left: "clear / cls", right: "clear the screen" },
  { kind: "cmd", left: "quit / q / exit", right: "exit the console" },
];

function printLegend(write: (s: string) => void = (s) => process.stdout.write(`${s}\n`)): void {
  write(pc.bold("gmail console"));
  write(pc.dim("Type a command. Strings can be quoted; arguments work like the CLI."));
  write("");
  for (const row of LEGEND_LINES) {
    if (row.kind === "blank") {
      write("");
      continue;
    }
    if (row.kind === "header") {
      write(pc.bold(pc.cyan(`${row.left}:`)));
      continue;
    }
    const left = (row.left ?? "").padEnd(34);
    write(`  ${pc.green(left)}${row.right ?? ""}`);
  }
  write("");
  write(pc.dim("Tip: short aliases work too (`i 5`, `s from:noreply`, `r <id>`)."));
  write("");
}

// ── Built-in console intercepts ──────────────────────────────────────

/** Built-in commands handled directly by the REPL (not routed through
 *  commander). Returns true if the command was intercepted. */
export function isBuiltinCommand(cmd: string): boolean {
  return (
    cmd === "help" ||
    cmd === "?" ||
    cmd === "clear" ||
    cmd === "cls" ||
    cmd === "quit" ||
    cmd === "q" ||
    cmd === "exit" ||
    cmd === "tools" ||
    cmd === "raw"
  );
}

async function runRawCommand(args: string[]): Promise<void> {
  if (args.length < 1) {
    process.stderr.write("Usage: raw <toolName> [json-args]   e.g. raw health_check {}\n");
    return;
  }
  const [name, ...rest] = args;
  let parsed: unknown = {};
  if (rest.length > 0) {
    try {
      parsed = JSON.parse(rest.join(" "));
    } catch (err) {
      process.stderr.write(`Invalid JSON: ${(err as Error).message}\n`);
      return;
    }
  }
  await executeCliOp(name as string, parsed, { json: false });
}

async function listTools(): Promise<void> {
  // Side-effect import: loads the registry so we can enumerate every op.
  await bootstrapForCli();
  const { registry } = await import("../core/registry.js");
  for (const name of registry.names().sort()) {
    process.stdout.write(`${name}\n`);
  }
}

// ── REPL entry ───────────────────────────────────────────────────────

export interface ConsoleOptions {
  /** Override the writer for the legend & prompt cues (used by tests). */
  write?: (s: string) => void;
}

/** Public entry point — used by the `gmail console` subcommand action. */
export async function runConsole(options: ConsoleOptions = {}): Promise<void> {
  const write = options.write ?? ((s: string) => process.stdout.write(`${s}\n`));
  printLegend(write);

  // Bootstrap eagerly so the first command isn't slow.
  try {
    await bootstrapForCli();
  } catch (err) {
    process.stderr.write(`Warning: bootstrap deferred — ${(err as Error).message}\n`);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });

  rl.on("close", () => {
    process.exit(0);
  });

  const promptStr = pc.cyan("gmail> ");

  const loop = (): void => {
    rl.question(promptStr, async (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        loop();
        return;
      }

      const { cmd, args } = parseConsoleInput(trimmed);
      const cmdLower = cmd.toLowerCase();

      // Built-in intercepts first — these don't go through commander.
      if (cmdLower === "help" || cmdLower === "?") {
        printLegend(write);
        loop();
        return;
      }
      if (cmdLower === "clear" || cmdLower === "cls") {
        process.stdout.write("\x1b[2J\x1b[H");
        loop();
        return;
      }
      if (cmdLower === "quit" || cmdLower === "q" || cmdLower === "exit") {
        rl.close();
        return;
      }
      if (cmdLower === "tools") {
        try {
          await listTools();
        } catch (err) {
          process.stderr.write(`Error: ${(err as Error).message}\n`);
        }
        process.stdout.write("\n");
        loop();
        return;
      }
      if (cmdLower === "raw") {
        try {
          await runRawCommand(args);
        } catch (err) {
          process.stderr.write(`Error: ${(err as Error).message}\n`);
        }
        process.stdout.write("\n");
        loop();
        return;
      }

      // Route to commander. Rebuild the program per line so option defaults
      // don't leak between calls (Commander v14 caveat).
      const resolvedCmd = rewriteAlias(cmdLower);
      const argv = ["node", "gmail", resolvedCmd, ...args];

      process.env.GMAIL_CLI_REPL = "1";
      try {
        const program = buildProgram();
        program.exitOverride(); // throw instead of process.exit on commander errors
        await program.parseAsync(argv);
      } catch (err) {
        const e = err as { code?: string; message?: string };
        // CommanderError carries code/exitCode; surface the message but stay alive.
        if (e.code?.startsWith("commander.")) {
          // Help and version exits also come through here — those are not
          // errors. Quiet them unless they actually carry a message.
          if (
            e.code !== "commander.help" &&
            e.code !== "commander.helpDisplayed" &&
            e.code !== "commander.version"
          ) {
            process.stderr.write(`Error: ${e.message ?? e.code}\n`);
          }
        } else {
          process.stderr.write(`Error: ${e.message ?? String(err)}\n`);
        }
      } finally {
        delete process.env.GMAIL_CLI_REPL;
      }
      process.stdout.write("\n");
      loop();
    });
  };

  loop();
}
