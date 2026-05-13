// `gmail-cli search <query> [--max <n>] [--json]`
//
// First "real" CLI subcommand exercising the in-process dispatcher pipeline:
//   bootstrapForCli → loads credentials + builds Gmail client + dispatcher
//   callMcpTool      → reaches the same registered handler the MCP server uses
//   formatToolResultText → joins the text fragments for human display

import { Command } from "commander";
import { bootstrapForCli, callMcpTool, formatToolResultText } from "../runtime.js";

export interface SearchCommandOptions {
  max?: number;
  json?: boolean;
}

export function buildSearchCommand(): Command {
  const cmd = new Command("search");
  cmd
    .description("Search emails (Gmail query syntax — e.g. 'from:foo newer_than:7d')")
    .argument("<query>", "Gmail search query")
    .option("-n, --max <n>", "Max results (default: 25)", (v) => Number.parseInt(v, 10), 25)
    .option("--json", "Emit raw MCP tool result as JSON instead of human text")
    .action(async (query: string, options: SearchCommandOptions) => {
      try {
        await bootstrapForCli();
        const result = await callMcpTool("search_emails", {
          query,
          maxResults: options.max,
        });
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
