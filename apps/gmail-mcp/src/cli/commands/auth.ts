// `gmail auth` — interactive (or scoped) OAuth flow.
//
// Combines the scope resolver (src/auth-scopes.ts) with the OAuth flow
// implementation (src/core/auth-flow.ts).

import fs from "node:fs";
import { Command } from "commander";
import { resolveScopes } from "../../auth-scopes.js";
import { addAccount, getAccountCredentialsPath, validateAccountId } from "../../core/accounts.js";
import {
  createOAuthClient,
  findAvailablePort,
  formatCredentialsForExport,
  loadOAuthKeys,
  runOAuthFlow,
  saveCredentialsToFile,
} from "../../core/auth-flow.js";
import { getConfigDir, getCredentialsPath, getOAuthPath } from "../../core/config-paths.js";

export interface AuthCommandOptions {
  scopes?: string;
  nonInteractive?: boolean;
  headless?: boolean;
  callback?: string;
  port?: number;
  oauthPath?: string;
  credentialsPath?: string;
  printJson?: boolean; // emit credentials JSON on stdout instead of writing to disk
  /**
   * Named account id (Phase M1). When supplied:
   *   - Credentials are written to <configDir>/accounts/<id>/credentials.json
   *     (unless --credentials-path overrides explicitly).
   *   - On success the manifest is updated (account added if new, scopes mirrored).
   *   - OAuth keys honour a per-account override at <configDir>/accounts/<id>/gcp-oauth.keys.json.
   * When omitted, the legacy single-account path applies.
   */
  account?: string;
}

export function buildAuthCommand(): Command {
  const cmd = new Command("auth");
  cmd
    .description("Authenticate with Google OAuth and save credentials")
    .option(
      "-s, --scopes <list>",
      "Comma- or space-separated scopes (gmail.readonly, gmail.modify, gmail.compose, gmail.send, gmail.labels, gmail.settings.basic, gmail.settings.sharing). Overrides GMAIL_SCOPES env.",
    )
    .option(
      "--non-interactive",
      "Skip the scope-selection prompt; fall back to defaults if --scopes / GMAIL_SCOPES unset (also auto-detected from CI=truthy or non-TTY stdin)",
    )
    .option(
      "--headless",
      "Don't launch a browser; print the consent URL and remote-server hints. Use with SSH port-forward (`ssh -L 3000:localhost:3000 server`) or auth locally and copy credentials.json over.",
    )
    .option(
      "--callback <url>",
      "OAuth callback URL (default: http://localhost:3000/oauth2callback)",
    )
    .option("--port <n>", "Port for the local OAuth callback server (default: 3000)", (v) =>
      Number.parseInt(v, 10),
    )
    .option(
      "--oauth-path <path>",
      "Path to gcp-oauth.keys.json (default: ~/.gmail-mcp/gcp-oauth.keys.json, or GMAIL_OAUTH_PATH env)",
    )
    .option(
      "--credentials-path <path>",
      "Where to save credentials (default: ~/.gmail-mcp/credentials.json, or GMAIL_CREDENTIALS_PATH env)",
    )
    .option(
      "--print-json",
      "Print credentials JSON to stdout instead of writing to disk. Useful for piping into a 1Password item or GH Actions secret.",
    )
    .option(
      "-a, --account <id>",
      "Name the account being authenticated (Phase M1). Credentials are stored at ~/.gmail-mcp/accounts/<id>/credentials.json and the account is added to the manifest. Defaults to env GMAIL_ACCOUNT, or to single-account legacy layout if neither is set.",
    )
    .action(async (options: AuthCommandOptions) => {
      try {
        await runAuthCommand(options);
      } catch (err) {
        const e = err as Error & { code?: string };
        process.stderr.write(`Error: ${e.message}\n`);
        process.exit(e.code === "INVALID_SCOPE" ? 3 : 2);
      }
    });
  return cmd;
}

export async function runAuthCommand(options: AuthCommandOptions): Promise<void> {
  // Translate CLI flags into argv-shaped input the existing resolver expects.
  // (resolveScopes was originally written to read process.argv directly; we
  // construct an equivalent so it works the same here.)
  const fakeArgv: string[] = [];
  if (options.scopes) fakeArgv.push(`--scopes=${options.scopes}`);
  if (options.nonInteractive) fakeArgv.push("--non-interactive");

  const resolved = await resolveScopes({
    argv: fakeArgv,
    env: process.env,
  });
  process.stderr.write(
    `Using scopes (source: ${resolved.source}): ${resolved.scopes.join(", ")}\n`,
  );

  // Resolve config paths against the current env so tests / overrides take
  // effect at call time (rather than at module-load time as before).
  const env = process.env;
  const configDir = getConfigDir(env);
  const defaultOAuthPath = getOAuthPath(env);
  const defaultCredentialsPath = getCredentialsPath(env);

  // Multi-account: --account (or GMAIL_ACCOUNT) selects which account's files
  // we read/write. The legacy single-account layout still applies when neither
  // is set.
  const accountId =
    options.account ??
    (env.GMAIL_ACCOUNT && env.GMAIL_ACCOUNT.trim().length > 0
      ? env.GMAIL_ACCOUNT.trim()
      : undefined);
  if (accountId) validateAccountId(accountId);

  const oauthPath = options.oauthPath ?? env.GMAIL_OAUTH_PATH ?? defaultOAuthPath;
  // Credentials path resolution:
  //   1. --credentials-path explicit override → use it verbatim.
  //   2. GMAIL_CREDENTIALS_PATH env → use it verbatim.
  //   3. If account id is set → per-account directory.
  //   4. Legacy single-account file.
  const credentialsPath =
    options.credentialsPath ??
    env.GMAIL_CREDENTIALS_PATH ??
    (accountId ? getAccountCredentialsPath(accountId, env) : defaultCredentialsPath);

  if (accountId) {
    process.stderr.write(`Authenticating account: ${accountId}\n`);
  }

  const keys = loadOAuthKeys({
    oauthPath,
    cwd: process.cwd(),
    configDir,
    accountId,
  });

  // Port resolution. If the user explicitly passed --port or --callback, we
  // honour them as-is and let runOAuthFlow surface any EADDRINUSE error.
  // Otherwise we probe :3000 and fall back to a neighbouring free port so a
  // busy dev server (a frequent collision) doesn't crash the flow. Loopback-IP
  // OAuth accepts any localhost:PORT redirect URI without re-registering it
  // in the Google Cloud Console.
  // (Headless mode listens but the user opens the URL on a different host, so
  // port-finding still helps the local listener bind cleanly.)
  let resolvedPort = options.port;
  let resolvedCallback = options.callback;
  if (options.port === undefined && options.callback === undefined) {
    const chosen = await findAvailablePort(3000);
    if (chosen !== 3000) {
      process.stderr.write(
        `Port 3000 is in use; using port ${chosen} instead for the OAuth callback.\n`,
      );
    }
    resolvedPort = chosen;
    resolvedCallback = `http://localhost:${chosen}/oauth2callback`;
  }

  const oauth2Client = createOAuthClient(keys, resolvedCallback);

  const result = await runOAuthFlow(oauth2Client, resolved.scopes, {
    callback: resolvedCallback,
    port: resolvedPort,
    headless: options.headless ?? false,
    log: (line) => process.stderr.write(`${line}\n`),
  });

  if (options.printJson) {
    // Emit canonical {tokens, scopes} JSON + the matching OAuth keys JSON, so
    // users get a one-shot env-driven config capture they can paste into a
    // host's `.mcp.json` env block, GH Actions secrets, 1Password, etc.
    const credentialsJson = formatCredentialsForExport(result.tokens, result.scopes);
    let keysJson: string | null = null;
    try {
      keysJson = fs.readFileSync(oauthPath, "utf8").trim();
    } catch {
      // OAuth keys may have come from GMAIL_OAUTH_KEYS_JSON env, in which case
      // we can re-emit it verbatim.
      if (process.env.GMAIL_OAUTH_KEYS_JSON) keysJson = process.env.GMAIL_OAUTH_KEYS_JSON;
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          GMAIL_OAUTH_KEYS_JSON: keysJson,
          GMAIL_CREDENTIALS_JSON: credentialsJson,
        },
        null,
        2,
      )}\n`,
    );
    process.stderr.write(
      "\nFully env-driven config printed to stdout. Pipe into your host config:\n",
    );
    process.stderr.write(
      "  Add both keys to your `.mcp.json` env block, or to GH Actions secrets, or to 1Password.\n",
    );
    process.stderr.write(
      "  GMAIL_OAUTH_KEYS_JSON   = the OAuth client keys (from Google Cloud Console)\n",
    );
    process.stderr.write("  GMAIL_CREDENTIALS_JSON  = the access/refresh tokens (just minted)\n");
    process.stderr.write(
      "Either env var unblocks the matching loader; together they remove the need for ~/.gmail-mcp/.\n",
    );
  } else {
    saveCredentialsToFile({
      path: credentialsPath,
      tokens: result.tokens,
      scopes: result.scopes,
      configDir,
    });
    process.stderr.write(`\nCredentials saved to ${credentialsPath}\n`);

    // Stamp the manifest when an account was named, so `gmail account list`
    // sees it immediately.
    if (accountId) {
      addAccount(accountId, { scopes: result.scopes }, env);
      process.stderr.write(`Account "${accountId}" added to the manifest.\n`);
    }
  }
}
