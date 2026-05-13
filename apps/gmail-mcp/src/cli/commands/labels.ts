// `gmail-cli labels list` — minimal sub-command demo for the labels namespace.
// Other label ops (create / update / delete / get-or-create) follow the same
// pattern.

import { Command } from "commander";
import { bootstrapForCli, callMcpTool, formatToolResultText } from "../runtime.js";

export interface LabelsListOptions {
  json?: boolean;
}

export function buildLabelsCommand(): Command {
  const cmd = new Command("labels");
  cmd.description("Manage Gmail labels");

  cmd
    .command("list")
    .description("List all available labels (system + user)")
    .option("--json", "Emit raw MCP tool result as JSON")
    .action(async (options: LabelsListOptions) => {
      try {
        await bootstrapForCli();
        const result = await callMcpTool("list_email_labels", {});
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
