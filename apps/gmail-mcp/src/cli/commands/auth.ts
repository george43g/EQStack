// Deprecated top-level auth command.
//
// Account lifecycle now lives under `gmail account ...` so the noun-first
// surface stays coherent. This stub remains only to stop users at the old path
// with a direct pointer to the replacement command.

import { Command } from "commander";

export function buildAuthCommand(): Command {
  const cmd = new Command("auth");
  cmd
    .description("Deprecated. Use `gmail account` instead.")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .addHelpText(
      "after",
      `
This command has moved.

Use:
  gmail account                    # interactive account manager
  gmail account auth <id>          # authenticate or re-authenticate an account
  gmail account list               # list configured accounts
`,
    )
    .action(() => {
      process.stderr.write("gmail auth has moved. Use gmail account instead.\n");
      process.exit(1);
    });
  return cmd;
}
