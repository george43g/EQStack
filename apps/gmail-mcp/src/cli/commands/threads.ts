// `gmail-cli threads …` — list, get, modify, inbox.

import { Command } from "commander";
import { runCliOp } from "../runtime.js";

export function buildThreadsCommand(): Command {
  const cmd = new Command("threads");
  cmd.description("Thread-level operations (groups of related messages)");

  cmd
    .command("list")
    .description("List inbox threads (Gmail query syntax via --query)")
    .option("-q, --query <q>", "Gmail search query (default: in:inbox)")
    .option("-n, --max <n>", "Max results (default: 25)", (v) => Number.parseInt(v, 10), 25)
    .option("--json", "Emit typed JSON")
    .action(async (options: { query?: string; max?: number; json?: boolean }) => {
      await runCliOp(
        "list_inbox_threads",
        { query: options.query, maxResults: options.max },
        { json: options.json },
      );
    });

  cmd
    .command("get <threadId>")
    .description("Fetch a thread's messages")
    .option("-f, --format <fmt>", "full | metadata | minimal (default: full)", "full")
    .option("--json", "Emit typed JSON")
    .action(
      async (
        threadId: string,
        options: { format?: "full" | "metadata" | "minimal"; json?: boolean },
      ) => {
        await runCliOp("get_thread", { threadId, format: options.format }, { json: options.json });
      },
    );

  cmd
    .command("modify <threadId>")
    .description("Add/remove labels on every message in a thread")
    .option("--add <ids>", "Comma-separated label IDs to add")
    .option("--remove <ids>", "Comma-separated label IDs to remove")
    .option("--json", "Emit typed JSON")
    .action(
      async (threadId: string, options: { add?: string; remove?: string; json?: boolean }) => {
        await runCliOp(
          "modify_thread",
          {
            threadId,
            addLabelIds: options.add?.split(",").map((s) => s.trim()),
            removeLabelIds: options.remove?.split(",").map((s) => s.trim()),
          },
          { json: options.json },
        );
      },
    );

  cmd
    .command("inbox")
    .description("Get inbox threads with optional message-body expansion")
    .option("-q, --query <q>", "Gmail search query (default: in:inbox)")
    .option("-n, --max <n>", "Max threads (default: 25)", (v) => Number.parseInt(v, 10), 25)
    .option("-e, --expand", "Expand each thread with full message content")
    .option("--json", "Emit typed JSON")
    .action(async (options: { query?: string; max?: number; expand?: boolean; json?: boolean }) => {
      await runCliOp(
        "get_inbox_with_threads",
        {
          query: options.query,
          maxResults: options.max,
          expandThreads: options.expand ?? false,
        },
        { json: options.json },
      );
    });

  return cmd;
}

/**
 * Top-level `gmail-cli inbox` — friendly alias for `threads list` with sane
 * inbox defaults. The most common one-liner I'd want from a terminal.
 */
export function buildInboxAliasCommand(): Command {
  const cmd = new Command("inbox");
  cmd
    .description("Shortcut: list recent inbox threads (alias for `threads list -q in:inbox`)")
    .option("-n, --max <n>", "Max threads (default: 10)", (v) => Number.parseInt(v, 10), 10)
    .option("--json", "Emit typed JSON")
    .action(async (options: { max?: number; json?: boolean }) => {
      await runCliOp(
        "list_inbox_threads",
        { query: "in:inbox", maxResults: options.max },
        { json: options.json },
      );
    });
  return cmd;
}
