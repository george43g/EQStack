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
 * surface that to the user with a hint to run `gmail-cli auth`.
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
  if (/credentials|invalid_grant|gmail-cli auth/i.test(msg)) return 2;
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

/**
 * Standard subcommand wrapper: bootstrap, run the supplied async fn, format
 * the MCP result, exit with the right code. Eliminates the boilerplate every
 * per-op command would otherwise repeat.
 */
export async function runCliOp(
  toolName: string,
  args: unknown,
  options: { json?: boolean } = {},
): Promise<never> {
  try {
    await bootstrapForCli();
    const result = await callMcpTool(toolName, args);
    printToolResult(result, options);
    process.exit(result.isError ? 1 : 0);
  } catch (err) {
    const e = err as Error;
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(exitCodeForError(e));
  }
}
