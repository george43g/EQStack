// Runtime helpers shared by CLI subcommands that need to drive the MCP
// dispatcher in-process. Bootstraps via main({ skipTransport: true }) so we
// share the same credential loading + Gmail client + dispatcher closure as
// the MCP server, without installing a stdio/HTTP transport.

import fs from "node:fs";
import path from "node:path";

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
