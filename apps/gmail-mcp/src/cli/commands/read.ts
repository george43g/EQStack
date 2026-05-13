// `gmail-cli read <messageId> [--json]`
//
// Print a single email by ID, identical output to the MCP `read_email` tool.

import { Command } from "commander";
import { bootstrapForCli, callMcpTool, formatToolResultText } from "../runtime.js";

export interface ReadCommandOptions {
  json?: boolean;
}

export function buildReadCommand(): Command {
  const cmd = new Command("read");
  cmd
    .description("Read an email by message ID")
    .argument("<messageId>", "Gmail message ID (from search results or thread listing)")
    .option("--json", "Emit raw MCP tool result as JSON instead of human text")
    .action(async (messageId: string, options: ReadCommandOptions) => {
      try {
        await bootstrapForCli();
        const result = await callMcpTool("read_email", { messageId });
        if (options.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(`${formatToolResultText(result)}\n`);
        }
        process.exit(result.isError ? 1 : 0);
      } catch (err) {
        const e = err as Error;
        process.stderr.write(`Error: ${e.message}\n`);
        process.exit(/credentials|invalid_grant|gmail-cli auth/i.test(e.message) ? 2 : 1);
      }
    });
  return cmd;
}
