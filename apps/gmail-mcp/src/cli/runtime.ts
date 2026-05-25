// Runtime helpers shared by CLI subcommands that need to drive the MCP
// dispatcher in-process. Bootstraps via main({ skipTransport: true }) so we
// share the same credential loading + Gmail client + dispatcher closure as
// the MCP server, without installing a stdio/HTTP transport.

import fs from "node:fs";
import path from "node:path";
import { callMcpTool } from "../index.js";

let bootstrapped = false;

/**
 * Idempotent. First call loads credentials, builds the Gmail API client,
 * and exposes the dispatcher via callMcpTool. Subsequent calls are no-ops.
 *
 * Throws with a clear message if credentials are missing — callers should
 * surface that to the user with a hint to run `gmail auth`.
 */
export async function bootstrapForCli(): Promise<void> {
  if (bootstrapped) return;
  const indexModule = await import("../index.js");
  await indexModule.main({ skipTransport: true });
  bootstrapped = true;
}

export { callMcpTool } from "../index.js";

/**
 * Helper for `--body @file` / `--body -` (stdin) reading used by send-style
 * CLI subcommands. Centralized so every send/draft/reply-all command behaves
 * the same.
 */
export async function resolveBodyInput(raw: string | undefined): Promise<string | undefined> {
  if (raw === undefined) return undefined;
  if (raw === "-") {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on("data", (c) => chunks.push(c));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      process.stdin.on("error", reject);
    });
  }
  if (raw.startsWith("@")) {
    const filePath = path.resolve(raw.slice(1));
    return fs.readFileSync(filePath, "utf8");
  }
  return raw;
}

/**
 * Format an MCP tool result for terminal output. The MCP convention is
 * `content: [{type:"text", text:"..."}]`; we just join the text fragments.
 */
export function formatToolResultText(result: {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Generic exit-code mapper for CLI command errors. Returns 2 for auth /
 * credential issues (so scripts can branch on "needs re-auth"), 3 for usage
 * errors, 1 otherwise.
 */
export function exitCodeForError(err: Error): number {
  const msg = err.message ?? "";
  if (/credentials|invalid_grant|gmail auth/i.test(msg)) return 2;
  if (/INVALID_SCOPE|invalid scope|usage/i.test(msg)) return 3;
  return 1;
}

/**
 * Print an MCP tool result to stdout in either JSON (typed structured
 * content preferred) or human-readable text mode. Centralised so every
 * subcommand emits consistent output and `--json` is always type-true JSON
 * rather than the legacy wrapped text envelope.
 */
export function printToolResult(
  result: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  },
  options: { json?: boolean } = {},
): void {
  if (options.json) {
    // Prefer the typed structured payload (Phase B2); fall back to the
    // text envelope wrapped as { text } so the consumer always gets valid
    // JSON to parse.
    const payload =
      result.structuredContent !== undefined
        ? result.structuredContent
        : { text: formatToolResultText(result) };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatToolResultText(result)}\n`);
  }
}

export interface ToolResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface CliOpOutcome {
  /** Raw MCP result when the dispatch completed (may still be isError). */
  result?: ToolResult;
  /** True when either the dispatcher returned isError or bootstrap threw. */
  isError: boolean;
  /** Set when bootstrap or dispatch threw (NOT for tool-level isError). */
  errorMessage?: string;
}

/**
 * REPL-safe op execution. Bootstraps the dispatcher (idempotent), runs the
 * tool, prints the formatted result, and returns the outcome. Never calls
 * process.exit — that's `runCliOp`'s job for CLI mode.
 *
 * Used directly by `src/cli/console.ts` so the interactive REPL doesn't
 * tear down the process after each command.
 */
export async function executeCliOp(
  toolName: string,
  args: unknown,
  options: { json?: boolean } = {},
): Promise<CliOpOutcome> {
  try {
    await bootstrapForCli();
    const result = (await callMcpTool(toolName, args)) as ToolResult;
    printToolResult(result, options);
    return { result, isError: result.isError === true };
  } catch (err) {
    const e = err as Error;
    process.stderr.write(`Error: ${e.message}\n`);
    return { isError: true, errorMessage: e.message };
  }
}

/**
 * Standard subcommand wrapper: bootstrap → run tool → print → exit with the
 * right code. Eliminates the boilerplate every per-op command would otherwise
 * repeat.
 *
 * In REPL mode (`process.env.GMAIL_CLI_REPL === "1"`), the exit is suppressed
 * so the interactive console loop continues. The console code is expected to
 * set + clear that env around each `program.parseAsync` call.
 */
export async function runCliOp(
  toolName: string,
  args: unknown,
  options: { json?: boolean } = {},
): Promise<void> {
  const outcome = await executeCliOp(toolName, args, options);
  if (process.env.GMAIL_CLI_REPL === "1") {
    // REPL mode — return control to the console loop. The console renders
    // its own prompt cue; we deliberately do not exit.
    return;
  }
  if (outcome.errorMessage) {
    process.exit(exitCodeForError(new Error(outcome.errorMessage)));
  }
  process.exit(outcome.isError ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Typed in-process op invocation (Pre-TUI Step 2)
// ---------------------------------------------------------------------------

/**
 * Thrown by `callOp` when the dispatcher returns an `isError: true` envelope.
 * Distinguishes tool-level failures (which include their own diagnostic text)
 * from infrastructure errors (which throw the underlying exception directly).
 */
export class ToolCallError extends Error {
  constructor(
    public toolName: string,
    message: string,
    public mcpResult?: ToolResult,
  ) {
    super(message);
    this.name = "ToolCallError";
  }
}

/**
 * Typed in-process dispatch. Bootstraps the server (idempotent), dispatches
 * the tool, returns its structured payload. Throws `ToolCallError` if the
 * tool returned `isError: true`; bubbles any infrastructure error otherwise.
 *
 * Designed for long-lived embedders (the TUI hooks in particular) that want
 * a Promise<TOutput> instead of the legacy MCP envelope. CLI commands keep
 * using `runCliOp`; `callOp` is additive.
 *
 * Type parameter is unchecked at runtime — callers annotate with the op's
 * `outputSchema` inferred type, e.g.
 *   const data = await callOp<z.infer<typeof ListInboxThreadsOutputSchema>>(
 *     "list_inbox_threads",
 *     { maxResults: 25 },
 *   );
 */
export async function callOp<TOutput = unknown>(
  toolName: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<TOutput> {
  await bootstrapForCli();
  const result = (await callMcpTool(toolName, args, signal)) as ToolResult;
  if (result.isError === true) {
    throw new ToolCallError(toolName, formatToolResultText(result), result);
  }
  return result.structuredContent as TOutput;
}
