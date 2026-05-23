// `gmail account …` — Phase M1 multi-account management.
//
// Subcommands:
//   gmail account add <id>      authenticate & add an account to the manifest
//   gmail account list          tabular view of all accounts (id, email, scopes, default?)
//   gmail account use <id>      set defaultAccount in the manifest
//   gmail account rm <id>       remove account from manifest + delete its files
//   gmail account current       print the resolved active account (and how it was resolved)
//
// All subcommands are pure manifest operations except `add`, which delegates
// to the auth flow (`runAuthCommand({ ..., account: id })`).

import fs from "node:fs";
import { confirm } from "@inquirer/prompts";
import { Command } from "commander";
import pc from "picocolors";
import {
  AccountNotFoundError,
  getAccountDir,
  listAccounts,
  loadManifest,
  removeAccount,
  resolveActiveAccount,
  setDefaultAccount,
  validateAccountId,
} from "../../core/accounts.js";
import { type AuthCommandOptions, runAuthCommand } from "./auth.js";

export function buildAccountCommand(): Command {
  const cmd = new Command("account");
  cmd.description("Manage Gmail accounts (multi-account, Phase M1)");

  cmd
    .command("list")
    .description("List configured accounts in the manifest")
    .option("--json", "Emit JSON instead of the table")
    .action((options: { json?: boolean }) => {
      const items = listAccounts();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
        return;
      }
      if (items.length === 0) {
        process.stdout.write(
          "No accounts in the manifest yet. Run `gmail auth` (or `gmail account add <id>`) to create one.\n",
        );
        return;
      }
      // Plain tabular output — picocolors only when stdout is a TTY so pipes stay clean.
      const isTty = process.stdout.isTTY ?? false;
      const decorate = (s: string, fn: (x: string) => string) => (isTty ? fn(s) : s);
      const header = `${"ID".padEnd(18)}${"EMAIL".padEnd(34)}${"SCOPES".padEnd(28)}DEFAULT`;
      process.stdout.write(`${decorate(header, pc.bold)}\n`);
      for (const item of items) {
        const id = item.id.padEnd(18);
        const email = (item.entry.emailAddress ?? "—").padEnd(34);
        const scopes = ((item.entry.scopes ?? []).join(",") || "—").padEnd(28);
        const def = item.isDefault ? decorate("✓", pc.green) : "";
        process.stdout.write(`${id}${email}${scopes}${def}\n`);
      }
    });

  cmd
    .command("current")
    .description("Print the active account and how it was resolved")
    .option("--json", "Emit JSON")
    .action((options: { json?: boolean }) => {
      const active = resolveActiveAccount();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(active, null, 2)}\n`);
        return;
      }
      if (active.id) {
        process.stdout.write(`${active.id}  (source: ${active.source})\n`);
      } else {
        process.stdout.write(
          `No active account. Source: ${active.source}. Run \`gmail auth\` to create one.\n`,
        );
      }
    });

  cmd
    .command("use")
    .description("Set the default account used when --account / GMAIL_ACCOUNT is not supplied")
    .argument("<id>", "Account id to make default")
    .action((id: string) => {
      try {
        validateAccountId(id);
        const m = setDefaultAccount(id);
        process.stdout.write(`Default account set to "${m.defaultAccount}".\n`);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(err instanceof AccountNotFoundError ? 2 : 3);
      }
    });

  cmd
    .command("rm")
    .description("Remove an account: deletes its credentials directory and manifest entry")
    .argument("<id>", "Account id to remove")
    .option("--force", "Skip the confirmation prompt")
    .option("--keep-files", "Remove from manifest only; leave the on-disk directory in place")
    .action(async (id: string, options: { force?: boolean; keepFiles?: boolean }) => {
      try {
        validateAccountId(id);
        const manifest = loadManifest();
        if (!manifest || !manifest.accounts[id]) {
          throw new AccountNotFoundError(id);
        }
        if (!options.force && process.stdin.isTTY) {
          const ok = await confirm({
            message: `Remove account "${id}"? This deletes credentials at ${getAccountDir(id)}.`,
            default: false,
          });
          if (!ok) {
            process.stderr.write("Aborted.\n");
            return;
          }
        }
        removeAccount(id);
        if (!options.keepFiles) {
          const dir = getAccountDir(id);
          if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
        process.stdout.write(`Account "${id}" removed.\n`);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(err instanceof AccountNotFoundError ? 2 : 3);
      }
    });

  cmd
    .command("add")
    .description("Authenticate a new account and add it to the manifest")
    .argument("<id>", "Account id to create (e.g. 'work', 'personal')")
    .option("-s, --scopes <list>", "Comma- or space-separated scopes (see `gmail auth --help`)")
    .option("--non-interactive", "Skip the scope-selection prompt")
    .option("--headless", "Don't launch a browser; print the consent URL only")
    .option("--callback <url>", "OAuth callback URL")
    .option("--port <n>", "Port for the local OAuth callback server", (v) => Number.parseInt(v, 10))
    .option("--print-json", "Emit credentials JSON to stdout instead of writing files")
    .action(
      async (
        id: string,
        options: Omit<AuthCommandOptions, "account" | "credentialsPath" | "oauthPath">,
      ) => {
        try {
          validateAccountId(id);
          await runAuthCommand({ ...options, account: id });
        } catch (err) {
          process.stderr.write(`Error: ${(err as Error).message}\n`);
          process.exit(2);
        }
      },
    );

  return cmd;
}
