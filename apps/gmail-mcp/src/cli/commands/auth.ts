// `gmail-cli auth` — interactive (or scoped) OAuth flow.
//
// Combines the existing scope resolver (src/auth-scopes.ts) with the
// extracted OAuth flow (src/core/auth-flow.ts). The legacy `gmail-mcp auth`
// entry in src/index.ts also delegates here so behaviour stays identical.

import fs from "node:fs";
import { Command } from "commander";
import { resolveScopes } from "../../auth-scopes.js";
import {
  createOAuthClient,
  formatCredentialsForExport,
  loadOAuthKeys,
  runOAuthFlow,
  saveCredentialsToFile,
} from "../../core/auth-flow.js";
import { getConfigDir, getCredentialsPath, getOAuthPath } from "../../core/config-paths.js";

const CONFIG_DIR = getConfigDir();
const DEFAULT_OAUTH_PATH = getOAuthPath();
const DEFAULT_CREDENTIALS_PATH = getCredentialsPath();

export interface AuthCommandOptions {
  scopes?: string;
  nonInteractive?: boolean;
  headless?: boolean;
  callback?: string;
  port?: number;
  oauthPath?: string;
  credentialsPath?: string;
  printJson?: boolean; // emit credentials JSON on stdout instead of writing to disk
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
      `Path to gcp-oauth.keys.json (default: ${DEFAULT_OAUTH_PATH}, or GMAIL_OAUTH_PATH env)`,
    )
    .option(
      "--credentials-path <path>",
      `Where to save credentials (default: ${DEFAULT_CREDENTIALS_PATH}, or GMAIL_CREDENTIALS_PATH env)`,
    )
    .option(
      "--print-json",
      "Print credentials JSON to stdout instead of writing to disk. Useful for piping into a 1Password item or GH Actions secret.",
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

/**
 * Translate a legacy `gmail-mcp auth …` argv (post-`auth` slice) into the
 * Commander option shape `runAuthCommand` expects. Preserves two behaviors
 * the inline `src/index.ts` handler had that the new CLI never exposed:
 *   - URL as positional arg (`gmail-mcp auth https://my.callback/oauth2callback`)
 *     → mapped to `--callback`.
 *   - Bare invocation (no args after `auth`) → caller is expected to render the
 *     precedence-table help separately. This function just returns options.
 *
 * Used by the `gmail-mcp auth` shim in `src/index.ts` so both entry points
 * end up calling `runAuthCommand` with the same option shape.
 */
export function parseLegacyAuthArgv(argv: readonly string[]): AuthCommandOptions {
  const opts: AuthCommandOptions = {};
  for (const arg of argv) {
    if (arg.startsWith("--scopes=")) {
      opts.scopes = arg.slice("--scopes=".length);
    } else if (arg === "--non-interactive") {
      opts.nonInteractive = true;
    } else if (arg === "--headless") {
      opts.headless = true;
    } else if (arg === "--print-json") {
      opts.printJson = true;
    } else if (arg.startsWith("--callback=")) {
      opts.callback = arg.slice("--callback=".length);
    } else if (arg.startsWith("--port=")) {
      const n = Number.parseInt(arg.slice("--port=".length), 10);
      if (Number.isFinite(n)) opts.port = n;
    } else if (arg.startsWith("--oauth-path=")) {
      opts.oauthPath = arg.slice("--oauth-path=".length);
    } else if (arg.startsWith("--credentials-path=")) {
      opts.credentialsPath = arg.slice("--credentials-path=".length);
    } else if (arg.startsWith("http://") || arg.startsWith("https://")) {
      // Legacy: URL positional → --callback. Only override if no explicit
      // --callback= was already provided.
      if (!opts.callback) opts.callback = arg;
    }
  }
  return opts;
}

/**
 * True when the post-`auth` argv slice contains no flags or URL — the bare
 * invocation case where we render the precedence-table help.
 */
export function isBareAuthInvocation(argv: readonly string[]): boolean {
  return argv.every((a) => a === "" || (!a.startsWith("--") && !a.startsWith("http")));
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

  const oauthPath = options.oauthPath ?? process.env.GMAIL_OAUTH_PATH ?? DEFAULT_OAUTH_PATH;
  const credentialsPath =
    options.credentialsPath ?? process.env.GMAIL_CREDENTIALS_PATH ?? DEFAULT_CREDENTIALS_PATH;

  const keys = loadOAuthKeys({
    oauthPath,
    cwd: process.cwd(),
    configDir: CONFIG_DIR,
  });
  const oauth2Client = createOAuthClient(keys, options.callback);

  const result = await runOAuthFlow(oauth2Client, resolved.scopes, {
    callback: options.callback,
    port: options.port,
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
      configDir: CONFIG_DIR,
    });
    process.stderr.write(`\nCredentials saved to ${credentialsPath}\n`);
  }
}
