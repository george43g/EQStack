import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { checkLocalAccess, formatAccessReport } from "./access-check.js";
import { ANALYTIC_INFO, type AnalyticType, IMPLEMENTED_TYPES } from "./analytics.js";
import { toYaml } from "./analytics-render.js";
import { LocalMcpClient } from "./mcp-client.js";
import { APP_VERSION } from "./meta.js";
import { installShutdownHandlers, registerCleanup } from "./shutdown.js";
import { looksLikeThreadSlug } from "./thread-slug.js";

// ── Colour helpers ─────────────────────────────────────────────────────

const color = {
  dim: (v: string) => `\x1b[2m${v}\x1b[0m`,
  cyan: (v: string) => `\x1b[36m${v}\x1b[0m`,
  green: (v: string) => `\x1b[32m${v}\x1b[0m`,
  yellow: (v: string) => `\x1b[33m${v}\x1b[0m`,
  red: (v: string) => `\x1b[31m${v}\x1b[0m`,
};

function log(message: string, style: "dim" | "ok" | "warn" | "err" = "dim") {
  const fn =
    style === "ok"
      ? color.green
      : style === "warn"
        ? color.yellow
        : style === "err"
          ? color.red
          : color.dim;
  console.log(fn(message));
}

// ── MCP client helpers ─────────────────────────────────────────────────

async function withClient<T>(run: (client: LocalMcpClient) => Promise<T>): Promise<T> {
  const client = new LocalMcpClient((line) => process.stderr.write(color.dim(`[server] ${line}`)));
  try {
    await client.start();
    return await run(client);
  } finally {
    client.close();
  }
}

async function printToolResult(
  client: LocalMcpClient,
  name: string,
  args: object,
  timeoutMs?: number,
  format?: "pretty" | "json" | "yaml",
) {
  const result = await client.callTool(name, args, timeoutMs);
  const text = result.content?.[0]?.text ?? JSON.stringify(result, null, 2);
  if (result.isError) throw new Error(text);
  if (format === "json" || format === "yaml") {
    // Structured output for scripting. Prefer the tool's structuredContent
    // (the machine-readable payload) over the human text block.
    const payload = (result as { structuredContent?: unknown }).structuredContent ?? result;
    console.log(format === "json" ? JSON.stringify(payload, null, 2) : toYaml(payload));
    return;
  }
  console.log(text);
}

/** Resolve a commander --json/--yaml option pair to a format. */
function pickFormat(opts: { json?: boolean; yaml?: boolean }): "pretty" | "json" | "yaml" {
  if (opts.json) return "json";
  if (opts.yaml) return "yaml";
  return "pretty";
}

/**
 * Parse a `windowDays` CLI/console arg. Absent → fallback. A non-numeric value
 * gives a clear error instead of the cryptic "Expected number, received null"
 * that `Number("abc")` → NaN → JSON `null` produced downstream.
 */
export function parseWindowDays(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`windowDays must be a positive number of days, got "${value}".`);
  }
  return n;
}

// ── Interactive console ────────────────────────────────────────────────

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
  return { cmd: parts[0]?.toLowerCase() ?? "", args: parts.slice(1) };
}

export async function runConsoleCommand(
  cmd: string,
  args: string[],
  client: LocalMcpClient,
): Promise<void> {
  switch (cmd) {
    case "conversations":
    case "list":
      await printToolResult(client, "list_conversations", { limit: Number(args[0] ?? 20) });
      return;
    case "messages":
    case "msg": {
      const first = args[0];
      const firstIsLimit = first != null && /^\d+$/.test(first);
      const chatIdentifier = firstIsLimit ? undefined : first;
      const limit = Number(firstIsLimit ? first : (args[1] ?? 20));
      await printToolResult(client, "get_messages", {
        ...(chatIdentifier
          ? looksLikeThreadSlug(chatIdentifier)
            ? { threadSlug: chatIdentifier }
            : { chatIdentifier }
          : {}),
        limit,
      });
      return;
    }
    case "unread":
      await printToolResult(
        client,
        "get_unread_messages",
        args[0] ? { limit: Number(args[0]) } : {},
      );
      return;
    case "search":
      if (!args[0]) throw new Error("Usage: search <query> [limit]");
      await printToolResult(client, "search_messages", {
        query: args[0],
        limit: Number(args[1] ?? 20),
      });
      return;
    case "resolve":
      if (!args[0]) throw new Error("Usage: resolve <name-or-phrase> [limit]");
      await printToolResult(client, "resolve_conversation", {
        query: args[0],
        limit: Number(args[1] ?? 10),
      });
      return;
    case "wait":
      if (!args[0]) throw new Error("Usage: wait <chat> [timeoutSeconds]");
      await printToolResult(
        client,
        "wait_for_reply",
        {
          ...(looksLikeThreadSlug(args[0]) ? { threadSlug: args[0] } : { chatIdentifier: args[0] }),
          timeoutSeconds: Number(args[1] ?? 60),
          pollIntervalSeconds: 5,
        },
        70_000,
      );
      return;
    case "send":
      if (args.length < 2) throw new Error("Usage: send <target> <message>");
      await printToolResult(client, "send_message", {
        ...(looksLikeThreadSlug(args[0]) ? { threadSlug: args[0] } : { recipient: args[0] }),
        message: args.slice(1).join(" "),
      });
      return;
    case "contacts": {
      const verb = args[0];
      if (verb === "list" || verb === undefined) {
        await printToolResult(client, "list_contacts", {
          limit: Number(args[1] ?? 20),
          offset: Number(args[2] ?? 0),
        });
      } else if (verb === "search") {
        if (!args[1]) throw new Error("Usage: contacts search <query> [limit]");
        await printToolResult(client, "search_contacts", {
          query: args[1],
          limit: Number(args[2] ?? 20),
        });
      } else if (verb === "resolve") {
        if (!args[1]) throw new Error("Usage: contacts resolve <handle>");
        await printToolResult(client, "resolve_handle", { handle: args[1] });
      } else if (verb === "show") {
        if (!args[1]) throw new Error("Usage: contacts show <handle-or-id>");
        const params = /^\d+$/.test(args[1]) ? { id: Number(args[1]) } : { handle: args[1] };
        await printToolResult(client, "get_contact", params);
      } else {
        throw new Error(`Unknown contacts verb: ${verb}. Use list|search|resolve|show.`);
      }
      return;
    }
    case "humans": {
      const verb = args[0];
      if (verb === "init") {
        if (!args[1]) throw new Error("Usage: humans init <contact|slug|top N>");
        if (args[1] === "top") {
          await printToolResult(client, "init_human", { top: Number(args[2] ?? 10) });
        } else if (args[1].includes("~")) {
          await printToolResult(client, "init_human", { threadSlug: args[1] });
        } else {
          await printToolResult(client, "init_human", { contact: args.slice(1).join(" ") });
        }
      } else if (verb === "top") {
        await printToolResult(client, "chat_analytics", {
          type: "relationship_leaderboard",
          windowDays: parseWindowDays(args[1], 1825),
        });
      } else {
        // No verb, `help`, or an unknown verb: show usage without leaking
        // "undefined" (the old `humans` / `humans help` output).
        const prefix = verb && verb !== "help" ? `Unknown humans verb: ${verb}.\n` : "";
        throw new Error(
          `${prefix}Usage:\n  humans init <contact|slug>\n  humans init top [n]\n  humans top [days]`,
        );
      }
      return;
    }
    case "analytics":
    case "stats": {
      const type = args[0] as AnalyticType | undefined;
      if (!type || !IMPLEMENTED_TYPES.includes(type)) {
        throw new Error(`Usage: analytics <${IMPLEMENTED_TYPES.join("|")}> [windowDays]`);
      }
      // Trailing `json`/`yaml` token picks the output format in the console.
      const fmtArg = args[args.length - 1];
      const format = fmtArg === "json" ? "json" : fmtArg === "yaml" ? "yaml" : "pretty";
      const windowDays =
        args[1] && /^\d+$/.test(args[1]) ? Number(args[1]) : ANALYTIC_INFO[type].defaultWindowDays;
      await printToolResult(client, "chat_analytics", { type, windowDays }, undefined, format);
      return;
    }
    case "logs":
      await printToolResult(client, "get_logs", args[0] ? { tail: Number(args[0]) } : {});
      return;
    case "last-error":
    case "lasterror":
      await printToolResult(client, "get_last_send_error", {});
      return;
    case "tools":
      for (const tool of await client.listTools()) {
        console.log(`${tool.name}${tool.description ? ` - ${tool.description}` : ""}`);
      }
      return;
    case "raw":
      if (!args[0]) throw new Error("Usage: raw '<json>'");
      {
        const parsed = JSON.parse(args.join(" ")) as { name?: string; arguments?: object };
        if (!parsed.name)
          throw new Error('Expected JSON like {"name":"tool_name","arguments":{...}}.');
        await printToolResult(client, parsed.name, parsed.arguments ?? {});
      }
      return;
    case "tui": {
      const { runTui } = await import("./tui/index.js");
      await runTui();
      return;
    }
    case "help":
    case "?":
      console.log(CONSOLE_HELP);
      return;
    case "quit":
    case "exit":
      process.exit(0);
      return;
    default:
      throw new Error(`Unknown command: ${cmd}. Type "help" for available commands.`);
  }
}

const CONSOLE_HELP = `
Available commands:
  conversations [n]    List recent conversations (default 20)
  messages [chat] [n]  Show recent messages
  unread [n]           Show unread messages
  search <query> [n]   Search messages
  resolve <name> [n]   Resolve a name/phrase to ranked conversations
  wait <chat> [secs]   Wait for a reply (default 60s)
  send <target> <msg>  Send a message
  contacts [verb]      Contacts: list [n] [offset] | search <q> [n] | resolve <handle> | show <handle-or-id>
  humans <verb>        Relationship files: init <contact|slug> | init top [n] | top [days]
  analytics <type> [days] [json|yaml]
                       Analytics: ${IMPLEMENTED_TYPES.join(" | ")}
  logs [tail]          Show server debug logs
  last-error           Show last send failure
  tools                List available MCP tools
  raw <json>           Send raw JSON-RPC to tools/call
  tui                  Launch the read-only TUI
  help                 Show this help
  quit                 Exit
`.trim();

async function runInteractiveConsole(): Promise<void> {
  log("Starting local MCP server...", "dim");
  const client = new LocalMcpClient((line) => process.stderr.write(color.dim(`[server] ${line}`)));
  await client.start();
  log("Console ready.\n", "ok");
  // Show the full help text on launch so the user doesn't have to type `help`
  // to discover what's available.
  console.log(CONSOLE_HELP);
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Event-driven line loop (not recursive rl.question): each command is async
  // (an MCP round-trip), so lines are queued and processed one at a time. This
  // is what makes piped/scripted input reliable — with recursive rl.question,
  // EOF ("close") raced the in-flight await and killed the command before its
  // output printed. Here EOF only exits AFTER the queue has drained.
  const queue: string[] = [];
  let processing = false;
  let closed = false;

  const finish = () => {
    client.close();
    process.exit(0);
  };

  const drain = async () => {
    if (processing) return;
    processing = true;
    while (queue.length > 0) {
      const line = queue.shift()!;
      const trimmed = line.trim();
      if (!trimmed) continue;
      const { cmd, args } = parseConsoleInput(trimmed);
      try {
        await runConsoleCommand(cmd, args, client);
      } catch (error) {
        log(error instanceof Error ? error.message : String(error), "err");
      }
      console.log("");
    }
    processing = false;
    if (closed) finish();
    else rl.prompt();
  };

  rl.setPrompt(color.cyan("imsg> "));
  rl.prompt();
  rl.on("line", (line) => {
    queue.push(line);
    void drain();
  });
  // Ctrl-D / EOF (or a piped script running out of lines): exit once any
  // in-flight command and the queue have drained. Without this the MCP server
  // subprocess keeps the event loop alive and the console would hang.
  rl.on("close", () => {
    closed = true;
    if (!processing && queue.length === 0) finish();
  });

  installShutdownHandlers();
  registerCleanup(() => client.close());
}

// ── Export command ─────────────────────────────────────────────────────

interface ExportOpts {
  format?: string;
  since?: string;
  until?: string;
  output?: string;
  includeAttachments?: boolean;
  attachmentsDir?: string;
  pageSize?: string;
}

function normalizeFormat(raw: string): "markdown" | "csv" | "json" | "ndjson" {
  const v = raw.toLowerCase();
  if (v === "md" || v === "markdown") return "markdown";
  if (v === "csv") return "csv";
  if (v === "json") return "json";
  if (v === "ndjson") return "ndjson";
  throw new Error(`Unknown format: ${raw}. Expected md, csv, json, or ndjson.`);
}

function extForFormat(fmt: "markdown" | "csv" | "json" | "ndjson"): string {
  return fmt === "markdown" ? "md" : fmt;
}

function sanitizeForFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9._~-]+/g, "_").replace(/^_+|_+$/g, "") || "chat";
}

export async function runExportCommand(target: string, opts: ExportOpts): Promise<void> {
  const { existsSync, mkdirSync, copyFileSync, statSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { dirname, join, isAbsolute, resolve } = await import("node:path");
  const { getContactsDbPaths, getImsgDbPath, getSlugsDbPath } = await import("./config.js");
  const { IMessageDB } = await import("./imessage-db.js");
  const { streamExport } = await import("./exportStream.js");
  const { parseUserDate } = await import("./date-parse.js");

  const format = normalizeFormat(opts.format ?? "md");
  const ext = extForFormat(format);

  const pageSize = Number(opts.pageSize ?? "1000");
  if (!Number.isFinite(pageSize) || pageSize < 100 || pageSize > 5000) {
    throw new Error("--page-size must be between 100 and 5000.");
  }

  const since = opts.since ? parseUserDate(opts.since) : null;
  if (opts.since && !since) throw new Error(`Could not parse --since: ${opts.since}`);
  const until = opts.until ? parseUserDate(opts.until) : null;
  if (opts.until && !until) throw new Error(`Could not parse --until: ${opts.until}`);

  const db = new IMessageDB(getImsgDbPath(), getContactsDbPaths(), getSlugsDbPath());
  try {
    // Resolve target → chatIdentifier + display slug for filename
    let chatIdentifier = target;
    let displayHandle = target;
    if (looksLikeThreadSlug(target)) {
      const rec = db.getSlugRecord(target);
      if (!rec) throw new Error(`Unknown thread slug: ${target}`);
      chatIdentifier = rec.chatIdentifier;
      displayHandle = rec.slug;
    }

    // Default output path: ~/imsg-export-<sanitized>-<YYYY-MM-DD>.<ext>
    let outputPath: string;
    if (opts.output) {
      outputPath = isAbsolute(opts.output) ? opts.output : resolve(opts.output);
    } else {
      const today = new Date().toISOString().slice(0, 10);
      outputPath = join(
        homedir(),
        `imsg-export-${sanitizeForFilename(displayHandle)}-${today}.${ext}`,
      );
    }

    const parent = dirname(outputPath);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

    log(`Exporting ${displayHandle} → ${outputPath} (${format})`, "dim");

    const result = await streamExport({
      db,
      chatIdentifier,
      format,
      outputPath,
      since,
      until,
      pageSize,
    });

    let attachmentSummary = "";
    if (opts.includeAttachments) {
      const dir = opts.attachmentsDir
        ? isAbsolute(opts.attachmentsDir)
          ? opts.attachmentsDir
          : resolve(opts.attachmentsDir)
        : `${outputPath}.attachments`;
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const filters: Parameters<typeof db.searchAttachments>[0] = {
        chatIdentifier,
        limit: 0,
      };
      if (since) filters.sinceMs = since.getTime();
      if (until) filters.untilMs = until.getTime();
      const attachments = db.searchAttachments(filters);

      // Best-effort sync nudge: if any attachment is missing from disk, open
      // the conversation ONCE so Messages pulls the thread's media, then wait
      // up to the configured timeout before copying. Honors `nudge.enabled`;
      // one open covers the whole thread (opening a conversation syncs all its
      // attachments), so we never poll per-file here.
      const { resolveInterpretConfig } = await import("./app-config.js");
      const nudge = resolveInterpretConfig().nudge;
      const firstMissing = attachments.find(
        (a) => a.filename && !existsSync(a.filename.replace(/^~/, homedir())),
      );
      if (nudge.enabled && firstMissing && chatIdentifier) {
        const { ensureAttachmentDownloaded } = await import("./attachment-sync.js");
        log(`  Nudging Messages to sync missing attachments…`, "dim");
        await ensureAttachmentDownloaded(
          { filePath: firstMissing.filename.replace(/^~/, homedir()), chatId: chatIdentifier },
          {
            enabled: nudge.enabled,
            tier2SyncNow: nudge.tier2SyncNow,
            timeoutSeconds: nudge.timeoutSeconds,
          },
        );
      }

      let copied = 0;
      let totalBytes = 0;
      const seen = new Set<string>();
      for (const a of attachments) {
        if (!a.filename) continue;
        const src = a.filename.replace(/^~/, homedir());
        if (!existsSync(src)) continue;
        const baseName = a.transferName || src.split("/").pop() || `att-${a.rowId}`;
        let destName = `${a.rowId}-${sanitizeForFilename(baseName)}`;
        if (seen.has(destName)) destName = `${a.rowId}-${Date.now()}-${baseName}`;
        seen.add(destName);
        const dest = join(dir, destName);
        try {
          copyFileSync(src, dest);
          copied++;
          totalBytes += statSync(dest).size;
        } catch (err) {
          log(
            `  warn: copy failed for ${src}: ${err instanceof Error ? err.message : String(err)}`,
            "warn",
          );
        }
      }
      attachmentSummary = `\nAttachments: ${copied} file(s), ${(totalBytes / 1024).toFixed(1)} KB → ${dir}`;
    }

    log(
      [
        "",
        `✓ Exported ${result.count} message(s) to ${result.savedTo}`,
        `  Format: ${format}`,
        `  Range: ${result.oldest?.toISOString() ?? "(none)"} → ${result.newest?.toISOString() ?? "(none)"}`,
        `  Size: ${(result.sizeBytes / 1024).toFixed(1)} KB${attachmentSummary}`,
      ].join("\n"),
      "ok",
    );
  } finally {
    await db.close();
  }
}

// ── CLI program (Commander) ────────────────────────────────────────────

const program = new Command()
  .name("imsg")
  .version(APP_VERSION, "-v, --version")
  .description("CLI for the imsg-mcp iMessage MCP server")
  .addHelpText(
    "after",
    `
Notes:
  Use "imsg doctor" on a new machine.
  Run the MCP stdio server with "imsg mcp".
  Launch the read-only TUI with "imsg tui".`,
  );

program
  .command("mcp")
  .description("Run the MCP stdio server")
  .action(async () => {
    const { runMcpServer } = await import("./index.js");
    await runMcpServer();
  });

program
  .command("cli")
  .alias("console")
  .description("Launch interactive console")
  .action(runInteractiveConsole);

program
  .command("doctor")
  .description("Check local permissions and database access")
  .action(async () => {
    const report = await checkLocalAccess();
    console.log(formatAccessReport(report));
    process.exitCode = report.ok ? 0 : 1;
  });

program
  .command("conversations")
  .alias("list")
  .description("List recent conversations")
  .argument("[limit]", "Number of conversations", "20")
  .action(async (limit: string) => {
    await withClient((c) => printToolResult(c, "list_conversations", { limit: Number(limit) }));
  });

program
  .command("messages")
  .alias("msg")
  .description("Show recent messages from a conversation")
  .argument("[chat]", "Phone number, email, or thread slug")
  .argument("[limit]", "Number of messages", "20")
  .action(async (chat: string | undefined, limit: string) => {
    const firstIsLimit = chat != null && /^\d+$/.test(chat);
    const chatIdentifier = firstIsLimit ? undefined : chat;
    const finalLimit = Number(firstIsLimit ? chat : limit);
    await withClient((c) =>
      printToolResult(c, "get_messages", {
        ...(chatIdentifier
          ? looksLikeThreadSlug(chatIdentifier)
            ? { threadSlug: chatIdentifier }
            : { chatIdentifier }
          : {}),
        limit: finalLimit,
      }),
    );
  });

program
  .command("unread")
  .description("Show unread messages across all conversations")
  .argument("[limit]", "Number of messages", "100")
  .action(async (limit: string) => {
    await withClient((c) => printToolResult(c, "get_unread_messages", { limit: Number(limit) }));
  });

program
  .command("search")
  .description("Search messages by text content")
  .argument("<query>", "Search query")
  .argument("[limit]", "Number of results", "20")
  .action(async (query: string, limit: string) => {
    await withClient((c) => printToolResult(c, "search_messages", { query, limit: Number(limit) }));
  });

program
  .command("resolve")
  .description("Resolve a free-form name/phrase to ranked conversations (contacts + threads)")
  .argument("<query>", 'Name or phrase, e.g. "Selena"')
  .argument("[limit]", "Max ranked matches", "10")
  .option("--json", "Output structured JSON")
  .option("--yaml", "Output structured YAML")
  .action(async (query: string, limit: string, opts: { json?: boolean; yaml?: boolean }) => {
    await withClient((c) =>
      printToolResult(
        c,
        "resolve_conversation",
        { query, limit: Number(limit) },
        undefined,
        pickFormat(opts),
      ),
    );
  });

program
  .command("wait")
  .description("Wait for a reply in a conversation")
  .argument("<chat>", "Phone number, email, or thread slug")
  .argument("[timeout]", "Timeout in seconds", "60")
  .action(async (chat: string, timeout: string) => {
    await withClient((c) =>
      printToolResult(
        c,
        "wait_for_reply",
        {
          ...(looksLikeThreadSlug(chat) ? { threadSlug: chat } : { chatIdentifier: chat }),
          timeoutSeconds: Number(timeout),
          pollIntervalSeconds: 5,
        },
        70_000,
      ),
    );
  });

program
  .command("send")
  .description("Send a message via Messages.app")
  .argument(
    "<target>",
    "Recipient: thread slug, E.164 phone (+61401990797), local phone (0401 990 797), iMessage email, or contact name",
  )
  .argument("<message...>", "Message text")
  .action(async (target: string, messageParts: string[]) => {
    await withClient((c) =>
      printToolResult(c, "send_message", {
        ...(looksLikeThreadSlug(target) ? { threadSlug: target } : { recipient: target }),
        message: messageParts.join(" "),
      }),
    );
  });

const contactsCommand = program
  .command("contacts")
  .description("Search and inspect macOS contacts (read-only)");

contactsCommand
  .command("list")
  .description("List contacts, sorted by name")
  .argument("[limit]", "Number of contacts", "20")
  .argument("[offset]", "Skip this many (pagination)", "0")
  .action(async (limit: string, offset: string) => {
    await withClient((c) =>
      printToolResult(c, "list_contacts", { limit: Number(limit), offset: Number(offset) }),
    );
  });

contactsCommand
  .command("search")
  .description("Search contacts by name, phone, or email")
  .argument("<query>", "Substring to match")
  .argument("[limit]", "Number of results", "20")
  .action(async (query: string, limit: string) => {
    await withClient((c) => printToolResult(c, "search_contacts", { query, limit: Number(limit) }));
  });

contactsCommand
  .command("resolve")
  .description("Resolve a phone number or email to its contact name")
  .argument("<handle>", "Phone number or email")
  .action(async (handle: string) => {
    await withClient((c) => printToolResult(c, "resolve_handle", { handle }));
  });

contactsCommand
  .command("show")
  .description("Show a contact's handles and the thread slug for each")
  .argument("<handleOrId>", "Phone, email, or numeric contact id")
  .action(async (handleOrId: string) => {
    const args = /^\d+$/.test(handleOrId) ? { id: Number(handleOrId) } : { handle: handleOrId };
    await withClient((c) => printToolResult(c, "get_contact", args));
  });

const humansCommand = program
  .command("humans")
  .description("Scaffold humans/v1 relationship files (~/.agents/humans) — see the humans skill");

humansCommand
  .command("init")
  .description(
    "Scaffold a relationship file for a contact/slug, or --top N for your top relationships",
  )
  .argument("[contact]", "Contact name, phone, email, or thread slug")
  .option("--top <n>", "Scaffold the top N relationships (by the relationship leaderboard)")
  .action(async (contact: string | undefined, opts: { top?: string }) => {
    if (!contact && !opts.top) {
      console.error("Provide a contact/slug or --top N.");
      process.exitCode = 1;
      return;
    }
    const args = opts.top
      ? { top: Number(opts.top) }
      : contact?.includes("~")
        ? { threadSlug: contact }
        : { contact };
    await withClient((c) => printToolResult(c, "init_human", args));
  });

humansCommand
  .command("top")
  .description("Show the relationship leaderboard (volume × reciprocity × recency, last 5 years)")
  .argument("[windowDays]", "Days of history to rank", "1825")
  .option("--json", "Output structured JSON")
  .option("--yaml", "Output structured YAML")
  .action(async (windowDays: string, opts: { json?: boolean; yaml?: boolean }) => {
    await withClient((c) =>
      printToolResult(
        c,
        "chat_analytics",
        { type: "relationship_leaderboard", windowDays: parseWindowDays(windowDays, 1825) },
        undefined,
        pickFormat(opts),
      ),
    );
  });

// `imsg analytics <type> [windowDays] [--json|--yaml]` — every implemented
// analytic, not just the leaderboard. Each type gets its own subcommand so
// `--help` and shell completion enumerate them.
const analyticsCommand = program
  .command("analytics")
  .alias("stats")
  .description("Run chat analytics (streaks, response times, heatmap, tapbacks, wrapped, …)");

for (const type of IMPLEMENTED_TYPES) {
  const info = ANALYTIC_INFO[type];
  analyticsCommand
    .command(type)
    .description(info.description)
    .argument("[windowDays]", "Days of history to analyze", String(info.defaultWindowDays))
    .option("--json", "Output structured JSON")
    .option("--yaml", "Output structured YAML")
    .action(async (windowDays: string, opts: { json?: boolean; yaml?: boolean }) => {
      await withClient((c) =>
        printToolResult(
          c,
          "chat_analytics",
          { type, windowDays: parseWindowDays(windowDays, info.defaultWindowDays) },
          undefined,
          pickFormat(opts),
        ),
      );
    });
}

program
  .command("logs")
  .description("Show server debug logs")
  .argument("[tail]", "Show only last N lines")
  .action(async (tail: string | undefined) => {
    await withClient((c) => printToolResult(c, "get_logs", tail ? { tail: Number(tail) } : {}));
  });

program
  .command("last-error")
  .description("Show last send_message failure details")
  .action(async () => {
    await withClient((c) => printToolResult(c, "get_last_send_error", {}));
  });

program
  .command("tools")
  .description("List available MCP tools")
  .action(async () => {
    await withClient(async (c) => {
      for (const tool of await c.listTools()) {
        console.log(`${tool.name}${tool.description ? ` - ${tool.description}` : ""}`);
      }
    });
  });

program
  .command("raw")
  .description("Send raw JSON-RPC params to tools/call")
  .argument("<json>", 'JSON like {"name":"tool_name","arguments":{...}}')
  .action(async (json: string) => {
    const parsed = JSON.parse(json) as { name?: string; arguments?: object };
    if (!parsed.name) throw new Error('Expected JSON like {"name":"tool_name","arguments":{...}}.');
    await withClient((c) => printToolResult(c, parsed.name!, parsed.arguments ?? {}));
  });

program
  .command("tui")
  .description("Launch the read-only terminal UI")
  .option("--theme <theme>", 'TUI theme: "safe" or "powerline"')
  .option("--accent <hex>", "TUI accent color as #RRGGBB")
  .action(async () => {
    const { runTui } = await import("./tui/index.js");
    await runTui();
  });

// ── Export ───────────────────────────────────────────────────────────────

program
  .command("export <target>")
  .description("Export a conversation to a file (md/csv/json/ndjson)")
  .option("-f, --format <fmt>", "Output format: md (default), csv, json, ndjson", "md")
  .option("--since <date>", "Earliest date (ISO or relative, e.g. '3 months ago')")
  .option("--until <date>", "Latest date (ISO or relative)")
  .option("-o, --output <path>", "Output path (default: ~/imsg-export-<target>-<YYYY-MM-DD>.<ext>)")
  .option("--include-attachments", "Copy attachments next to the export")
  .option("--attachments-dir <path>", "Where to copy attachments (default: <output>.attachments/)")
  .option("--page-size <n>", "Messages per DB page (100-5000)", "1000")
  .action(runExportCommand);

program
  .command("interpret <rowId>")
  .description("Interpret one attachment (transcribe a voice note / caption an image or video)")
  .option("--force", "Re-run even if a cached result exists (evicts the cache entry first)")
  .action(async (rowIdArg: string, opts: { force?: boolean }) => {
    const rowId = Number(rowIdArg);
    if (!Number.isInteger(rowId) || rowId <= 0) {
      log(`Invalid attachment rowId: ${rowIdArg}`, "err");
      process.exitCode = 1;
      return;
    }
    const { getContactsDbPaths, getImsgDbPath, getSlugsDbPath } = await import("./config.js");
    const { IMessageDB } = await import("./imessage-db.js");
    const { getInterpretRuntime, refForAttachment } = await import("./media-intel-runtime.js");
    const { deleteMediaIntel } = await import("./media-intel-cache.js");

    const db = new IMessageDB(getImsgDbPath(), getContactsDbPaths(), getSlugsDbPath());
    try {
      const rec = db.getAttachmentByRowId(rowId);
      if (!rec) {
        log(`Attachment ROWID ${rowId} not found.`, "err");
        process.exitCode = 1;
        return;
      }
      const ref = refForAttachment(rec);
      if (!ref) {
        log(
          `Attachment ${rowId} (${rec.mimeType ?? "?"}) is not interpretable media (audio/image/video).`,
          "warn",
        );
        return;
      }
      if (opts.force) deleteMediaIntel(ref.key);
      const r = await getInterpretRuntime().service.interpret(ref, { force: true });
      if (r.status === "done" && r.text) {
        const label = ref.kind === "audio" ? "Transcript" : "Description";
        log(`${label} (${r.source ?? "?"}${r.cached ? ", cached" : ""}):`, "ok");
        console.log(r.text);
      } else if (r.status === "skipped") {
        log(`No chain configured for ${ref.kind}. Run \`imsg setup --interactive\`.`, "warn");
      } else {
        log(`Interpretation produced no text${r.error ? ` (${r.error})` : ""}.`, "warn");
      }
    } finally {
      await db.close();
    }
  });

// ── Setup ────────────────────────────────────────────────────────────────

program
  .command("setup")
  .description("Autodetect DB paths and emit an MCP host config snippet")
  .option("-w, --write <host>", 'Write into a host config: "claude" or "cursor"')
  .option("-r, --runtime <runtime>", 'Runtime command: "npx" (default), "bunx", or "global"')
  .option("--print-only", "Just print the snippet (default behaviour)")
  .option("-i, --interactive", "Configure media interpretation (providers, chains, keys)")
  .action(
    async (opts: {
      write?: string;
      runtime?: string;
      printOnly?: boolean;
      interactive?: boolean;
    }) => {
      if (opts.interactive) {
        const { runSetupWizard } = await import("./setup-wizard.js");
        try {
          await runSetupWizard();
        } catch (err) {
          // inquirer throws ExitPromptError on Ctrl-C — treat as a clean cancel.
          if (err instanceof Error && err.name === "ExitPromptError") {
            log("setup cancelled", "warn");
            return;
          }
          throw err;
        }
        return;
      }
      const { probeMachine, buildMcpSnippet, writeHostConfig } = await import("./setup.js");
      const report = probeMachine();

      if (!report.imsgDb.readable) {
        log(`✗ Messages DB is not readable: ${report.imsgDb.path}`, "err");
        log(`  ${report.imsgDb.error ?? ""}`, "err");
        log(
          "  Grant Full Disk Access to the running app: System Settings → Privacy & Security → Full Disk Access",
          "warn",
        );
        process.exitCode = 1;
        return;
      }

      log(`✓ Messages DB readable: ${report.imsgDb.path}`, "ok");
      log(
        `✓ Address Book: ${report.contactsDbs.length} source(s), ${report.contactsDbs.filter((p) => p.readable).length} readable`,
        "ok",
      );
      log(
        `  slugs.db: ${report.slugsDb.path} ${report.slugsDb.exists ? "(exists)" : "(will be created on first run)"}`,
      );

      const runtime = opts.runtime === "bunx" || opts.runtime === "global" ? opts.runtime : "npx";
      const snippet = buildMcpSnippet(report, { runtime });

      if (opts.write) {
        if (opts.write !== "claude" && opts.write !== "cursor") {
          log(`✗ unknown host: ${opts.write} (expected "claude" or "cursor")`, "err");
          process.exitCode = 1;
          return;
        }
        const result = writeHostConfig(opts.write, report, { runtime });
        log(
          `✓ wrote ${opts.write} config to ${result.path}${result.replaced ? " (replaced existing imessage entry)" : ""}`,
          "ok",
        );
        log(`  backup of any prior file at ${result.path}.bak`);
        return;
      }

      log("--- snippet ---", "dim");
      process.stdout.write(snippet);
      log("tip: run `imsg setup --interactive` to configure media interpretation", "dim");
    },
  );

// ── Config ───────────────────────────────────────────────────────────────

const configCmd = program
  .command("config")
  .description("Manage TUI settings (theme, accent color)");

configCmd
  .command("show")
  .description("Print resolved TUI settings and where each value came from")
  .action(async () => {
    const { resolveTuiConfig, defaultTuiConfigPath } = await import("./tui-config.js");
    const cfg = resolveTuiConfig();
    log(
      `config file : ${cfg.configPath ?? `(none — defaults; would write to ${defaultTuiConfigPath()})`}`,
    );
    log(`theme       : ${cfg.theme}  (from ${cfg.origin.theme})`);
    log(`accentColor : ${cfg.accentColor}  (from ${cfg.origin.accentColor})`);
    if (cfg.theme === "powerline") {
      log("  — powerline theme requires a Nerd Font (https://www.nerdfonts.com)", "warn");
    }
    for (const w of cfg.warnings) log(w, "warn");
  });

configCmd
  .command("edit")
  .description("Open the TUI config file in $EDITOR (creates it if missing)")
  .action(async () => {
    const { defaultTuiConfigPath, findTuiConfigPath, writeTuiConfig, DEFAULT_TUI_CONFIG } =
      await import("./tui-config.js");
    const path = findTuiConfigPath() ?? defaultTuiConfigPath();
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) {
      writeTuiConfig(DEFAULT_TUI_CONFIG, path);
      log(`created ${path}`, "ok");
    }
    const editor = process.env.EDITOR ?? "vi";
    const { spawn } = await import("node:child_process");
    const child = spawn(editor, [path], { stdio: "inherit" });
    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`editor exited ${code}`)),
      );
      child.on("error", reject);
    });
  });

program.action(() => {
  program.outputHelp();
});

// Only auto-parse when invoked as a script (not when imported from tests).
const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  program.parseAsync(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
