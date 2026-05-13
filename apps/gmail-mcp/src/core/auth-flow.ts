// OAuth2 authentication flow for Gmail-MCP-Server.
//
// Shared by `gmail-mcp auth` (legacy entry) and `gmail-cli auth` (new entry).
// Implements the loopback-IP redirect pattern that's the only flow Google
// supports for installed/desktop clients today (OOB was deprecated in 2022).
//
// Headless / remote-server pattern: there is no first-class headless flow
// for personal Gmail. Two workarounds, documented in README:
//   a) SSH local port-forward — run the flow on the server, tunnel
//      localhost:3000 back to the user's laptop browser.
//   b) Auth on a laptop, transfer ~/.gmail-mcp/credentials.json to the
//      server (or set GMAIL_CREDENTIALS_JSON / GMAIL_CREDENTIALS_OP).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { OAuth2Client } from "google-auth-library";
import open from "open";
import { scopeNamesToUrls } from "../scopes.js";

const DEFAULT_CALLBACK = "http://localhost:3000/oauth2callback";
const DEFAULT_PORT = 3000;

export interface OAuthKeys {
  client_id: string;
  client_secret: string;
  // The "type" of OAuth client (installed / web). We don't enforce it here
  // but Google issues different consent flows for each.
}

export interface OAuthFlowOptions {
  callback?: string;
  port?: number;
  headless?: boolean; // true → skip browser launch, just print URL
  // Where to print human-facing messages. Stderr by default so stdout stays
  // clean for JSON output / piping.
  log?: (line: string) => void;
}

export interface OAuthFlowResult {
  tokens: Record<string, unknown>;
  scopes: string[];
}

export interface LoadKeysOptions {
  // Path to gcp-oauth.keys.json on disk. Used as the fallback when env-driven
  // keys aren't set. Required for the `gmail-cli auth` flow's first run.
  oauthPath: string;
  cwd?: string; // for the "found in current directory" copy convenience
  configDir?: string; // where to copy local keys to
  // Inject env for tests; defaults to process.env.
  env?: NodeJS.ProcessEnv;
}

/**
 * Parse a JSON blob that came from GMAIL_OAUTH_KEYS_JSON. Accepts the same
 * three shapes Google emits + a bare {client_id, client_secret} for users who
 * don't want to inline the whole Google Cloud Console JSON.
 */
function parseOAuthKeysJson(raw: string, sourceLabel: string): OAuthKeys {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid ${sourceLabel}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid ${sourceLabel}: must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const inner =
    (obj.installed as Record<string, unknown> | undefined) ??
    (obj.web as Record<string, unknown> | undefined) ??
    obj;
  const client_id = inner?.client_id as string | undefined;
  const client_secret = inner?.client_secret as string | undefined;
  if (!client_id || !client_secret) {
    throw new Error(
      `Invalid ${sourceLabel}: must contain client_id and client_secret (either at the root, or under "installed"/"web").`,
    );
  }
  return { client_id, client_secret };
}

/**
 * Load OAuth client keys. Resolution order:
 *   1. GMAIL_OAUTH_KEYS_JSON env var — full inline. Lets a deployment run with
 *      no filesystem state (Docker / Cloud Run / .mcp.json env block).
 *   2. Disk at `oauthPath` — the historical default. Honors the legacy "drop
 *      gcp-oauth.keys.json into the cwd and we'll copy it to the config dir"
 *      convenience for first-time users.
 */
export function loadOAuthKeys(opts: LoadKeysOptions): OAuthKeys {
  const { oauthPath, cwd, configDir } = opts;
  const env = opts.env ?? process.env;

  // 1. Env-inline keys
  const envJson = env.GMAIL_OAUTH_KEYS_JSON;
  if (envJson && envJson.trim().length > 0) {
    return parseOAuthKeysJson(envJson, "GMAIL_OAUTH_KEYS_JSON");
  }

  // 2. Copy from cwd if found there and we have a target (legacy convenience).
  if (cwd && configDir) {
    const localPath = path.join(cwd, "gcp-oauth.keys.json");
    if (fs.existsSync(localPath) && !fs.existsSync(oauthPath)) {
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      }
      fs.copyFileSync(localPath, oauthPath);
    }
  }

  // 3. Disk
  if (!fs.existsSync(oauthPath)) {
    throw new Error(
      `OAuth keys not found. Set GMAIL_OAUTH_KEYS_JSON env var with the JSON contents, or place gcp-oauth.keys.json at ${oauthPath} (or in the current directory).`,
    );
  }
  return parseOAuthKeysJson(fs.readFileSync(oauthPath, "utf8"), `OAuth keys file ${oauthPath}`);
}

export function createOAuthClient(
  keys: OAuthKeys,
  callback: string = DEFAULT_CALLBACK,
): OAuth2Client {
  return new OAuth2Client(keys.client_id, keys.client_secret, callback);
}

/**
 * Run the loopback-IP OAuth flow. Starts a local HTTP server on `port`,
 * generates the consent URL, opens it in the browser (unless headless), and
 * resolves with the tokens once the callback fires. Errors out cleanly on
 * timeout, denied consent, or callback failure.
 */
export async function runOAuthFlow(
  oauth2Client: OAuth2Client,
  scopes: string[],
  options: OAuthFlowOptions = {},
): Promise<OAuthFlowResult> {
  const callback = options.callback ?? DEFAULT_CALLBACK;
  const port = options.port ?? portFromCallback(callback) ?? DEFAULT_PORT;
  const headless = options.headless ?? false;
  const log = options.log ?? ((line: string) => console.error(line));

  const scopeUrls = scopeNamesToUrls(scopes);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopeUrls,
  });

  log(`Requesting scopes: ${scopes.join(", ")}`);
  log("");
  if (headless) {
    log("Headless mode: not launching a browser. Open this URL on a machine with a browser:");
    log("");
    log(`  ${authUrl}`);
    log("");
    log("If running on a remote server with no local browser, you have two options:");
    log("  1. SSH port-forward:  ssh -L 3000:localhost:3000 your-server");
    log("     then open the URL above in your laptop browser. The callback will tunnel back.");
    log("  2. Auth locally on a laptop, then transfer ~/.gmail-mcp/credentials.json to the server");
    log("     (or set GMAIL_CREDENTIALS_JSON / GMAIL_CREDENTIALS_OP env vars).");
    log("");
  } else {
    log("Opening this URL in your browser to authenticate:");
    log("");
    log(`  ${authUrl}`);
    log("");
  }

  const server = http.createServer();
  return new Promise<OAuthFlowResult>((resolve, reject) => {
    const cleanup = () => {
      try {
        server.close();
      } catch {
        /* swallow */
      }
    };

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });

    server.on("request", async (req, res) => {
      try {
        if (!req.url?.startsWith("/oauth2callback")) {
          res.writeHead(404);
          res.end();
          return;
        }
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        const code = url.searchParams.get("code");
        const errParam = url.searchParams.get("error");
        if (errParam) {
          res.writeHead(400);
          res.end(`OAuth error: ${errParam}. You can close this window.`);
          cleanup();
          reject(new Error(`OAuth consent denied: ${errParam}`));
          return;
        }
        if (!code) {
          res.writeHead(400);
          res.end("Missing authorization code.");
          cleanup();
          reject(new Error("Missing authorization code in callback URL"));
          return;
        }
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        res.writeHead(200);
        res.end("Authentication successful! You can close this window.");
        cleanup();
        resolve({ tokens: tokens as unknown as Record<string, unknown>, scopes });
      } catch (err) {
        try {
          res.writeHead(500);
          res.end("Authentication failed.");
        } catch {
          /* ignore */
        }
        cleanup();
        reject(err);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      if (!headless) {
        // Best-effort browser open. Failures are non-fatal — user can copy.
        open(authUrl).catch(() => {
          log("(Could not auto-launch a browser. Copy the URL above instead.)");
        });
      }
    });
  });
}

export interface SaveCredentialsOptions {
  path: string;
  tokens: Record<string, unknown>;
  scopes: string[];
  // mkdir with mode 0700 if config dir missing.
  configDir?: string;
}

export function saveCredentialsToFile(opts: SaveCredentialsOptions): void {
  if (opts.configDir && !fs.existsSync(opts.configDir)) {
    fs.mkdirSync(opts.configDir, { recursive: true, mode: 0o700 });
  }
  const payload = JSON.stringify({ tokens: opts.tokens, scopes: opts.scopes }, null, 2);
  fs.writeFileSync(opts.path, payload, { mode: 0o600 });
}

/**
 * Format credentials for upload to a secret store (GH Actions, 1Password,
 * Doppler, Vault, etc.). Returns the same JSON shape as saveCredentialsToFile
 * writes to disk, suitable as the value of `GMAIL_CREDENTIALS_JSON`.
 */
export function formatCredentialsForExport(
  tokens: Record<string, unknown>,
  scopes: string[],
): string {
  return JSON.stringify({ tokens, scopes });
}

function portFromCallback(callback: string): number | null {
  try {
    const parsed = new URL(callback);
    if (parsed.port) return Number(parsed.port);
    if (parsed.protocol === "https:") return 443;
    if (parsed.protocol === "http:") return 80;
    return null;
  } catch {
    return null;
  }
}
