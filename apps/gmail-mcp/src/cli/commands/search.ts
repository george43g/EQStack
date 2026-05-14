// `gmail-cli search <query> [-n N] [--json]`
//
// Search emails. Output is the typed SearchEmailsOutput shape under --json
// (Phase B2) or the human-readable text otherwise.

import { Command } from "commander";
import { runCliOp } from "../runtime.js";

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
    .option("--json", "Emit typed JSON instead of human text")
    .action(async (query: string, options: SearchCommandOptions) => {
      await runCliOp("search_emails", { query, maxResults: options.max }, { json: options.json });
    });
  return cmd;
}
