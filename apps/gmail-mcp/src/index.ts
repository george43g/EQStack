// MCP server orchestrator.
//
// `gmail mcp` (and `gmail mcp --http`) routes here via the commander tree in
// src/cli/index.ts. The CLI commands also reach `callMcpTool` in-process via
// the runtime helper in src/cli/runtime.ts.
//
// Heavy lifting lives in:
//   - src/core/                — credentials, config paths, session state,
//                                registry, per-tool op handlers
//   - src/server/build.ts      — MCP Server factory + dispatcher closure
//   - src/server/http.ts       — Streamable HTTP transport (Phase G)
//   - src/cli/commands/auth.ts — OAuth flow

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { resolveActiveAccount } from "./core/accounts.js";
import { loadOAuthKeys } from "./core/auth-flow.js";
import { getConfigDir, getCredentialsPath, getOAuthPath } from "./core/config-paths.js";
import { loadCredentials as coreLoadCredentials } from "./core/credentials.js";
// Side-effect import: each op file under core/ops/ registers itself with
// the registry at module load time. Adding an import here exposes the op
// to the dispatcher constructed by server/build.ts.
import "./core/ops/index.js";
import { getRecentErrorCount, getToolCallCount, setSession } from "./core/session.js";
import {
  enableOrphanWatchdog,
  enableStdinEofDetection,
  installShutdownHandlers,
  installWatchdog,
  info as logInfo,
  logShutdown,
  logStartup,
  registerCleanup,
  shutdown,
  startHeapMonitor,
} from "./robustness/index.js";
import { DEFAULT_SCOPES } from "./scopes.js";
import { buildMcpServer, type CallToolFn } from "./server/build.js";

const CONFIG_DIR = getConfigDir();
const OAUTH_PATH = getOAuthPath();
const CREDENTIALS_PATH = getCredentialsPath();

// In-process dispatcher reference. Populated by `main()` after session
// initialisation so non-stdio callers (CLI / TUI / HTTP wrapper) can call
// tool handlers directly without going through a transport.
let _dispatcherFn: CallToolFn | null = null;

/**
 * Call a tool by name with structured arguments, in-process. Throws if
 * `main()` hasn't completed bootstrap yet — credentials / Gmail client /
 * dispatcher are all initialised together.
 */
export async function callMcpTool(
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<ReturnType<CallToolFn>> {
  if (!_dispatcherFn) {
    throw new Error("callMcpTool: dispatcher not initialised — make sure main() has completed.");
  }
  return _dispatcherFn(name, args, signal);
}

interface LoadedCredentials {
  oauth2Client: OAuth2Client;
  authorizedScopes: string[];
  accountId: string | null;
}

async function loadCredentials(): Promise<LoadedCredentials | null> {
  try {
    // Resolve the active account using the M1 precedence chain. Returns
    // legacy-implicit "default" for unmigrated single-account users (which
    // triggers the credentials.json → accounts/default/ copy on first read).
    // Env-driven credentials (GMAIL_CREDENTIALS_JSON / _OP) keep working
    // because the loader chain short-circuits on env before consulting the
    // account id.
    const active = resolveActiveAccount();
    const accountId = active.id ?? undefined;
    // Tag every subsequent log entry with the resolved account so post-mortem
    // grep of MCP_LOG_DIR/*.ndjson can answer "which account triggered this?".
    logInfo("active account", { account: accountId ?? null, source: active.source });

    let keys;
    try {
      keys = loadOAuthKeys({
        oauthPath: OAUTH_PATH,
        cwd: process.cwd(),
        configDir: CONFIG_DIR,
        accountId,
      });
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      await shutdown(1);
      return null;
    }

    const oauth2Client = new OAuth2Client(
      keys.client_id,
      keys.client_secret,
      "http://localhost:3000/oauth2callback",
    );

    // Load stored access/refresh tokens via the multi-source loader chain.
    // Missing tokens are NOT fatal — required for `auth` subcommand bootstrap.
    let authorizedScopes: string[] = DEFAULT_SCOPES;
    try {
      const loaded = await coreLoadCredentials({
        fallbackPath: CREDENTIALS_PATH,
        accountId,
      });
      oauth2Client.setCredentials(loaded.credentials.tokens);
      if (loaded.credentials.scopes) authorizedScopes = loaded.credentials.scopes;
    } catch (err) {
      const e = err as { source?: string; name?: string; message?: string };
      if (e.name === "CredentialLoadError" && e.source === "file") {
        // No file yet — user will run `gmail auth` to create it.
      } else {
        console.error(`Error loading credentials: ${e.message ?? err}`);
        await shutdown(1);
        return null;
      }
    }

    return { oauth2Client, authorizedScopes, accountId: accountId ?? null };
  } catch (error) {
    console.error("Error loading credentials:", error);
    await shutdown(1);
    return null;
  }
}

/**
 * Main entry. `skipTransport: true` runs the full bootstrap (credentials +
 * Gmail client + dispatcher) but does NOT install stdio or HTTP transport —
 * used by the CLI runtime to reach callMcpTool in-process without becoming
 * an MCP server.
 */
export async function main(opts: { skipTransport?: boolean } = {}) {
  installShutdownHandlers();
  registerCleanup(() => logShutdown("normal"));
  startHeapMonitor();
  installWatchdog();
  logStartup("gmail-mcp");

  // Normal MCP path: load credentials, publish session, build server.
  const loaded = await loadCredentials();
  if (!loaded) return;
  const { oauth2Client, authorizedScopes } = loaded;

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  setSession({
    oauth2Client,
    gmail,
    authorizedScopes,
    accountId: loaded.accountId ?? null,
  });

  const { server, dispatch } = buildMcpServer();
  _dispatcherFn = dispatch;

  if (opts.skipTransport) return;

  // Transport selection: --http switches to Streamable HTTP (Phase G).
  if (process.argv.includes("--http")) {
    const port = parseIntFlag("--port", 8080);
    const bind = parseStringFlag("--bind", "127.0.0.1");
    const tokenEnv = parseStringFlag("--token-env", "GMAIL_HTTP_TOKEN");
    const { startHttpServer } = await import("./server/http.js");
    await startHttpServer({
      server,
      port,
      bind,
      tokenEnv,
      getCounters: () => ({
        toolCalls: getToolCallCount(),
        recentErrors: getRecentErrorCount(),
      }),
      log: (line) => {
        logInfo("http", { line });
        process.stderr.write(`${line}\n`);
      },
    });
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  enableStdinEofDetection();
  enableOrphanWatchdog();
}

function parseIntFlag(flag: string, fallback: number): number {
  const arg = process.argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (!arg) return fallback;
  if (arg === flag) {
    const idx = process.argv.indexOf(flag);
    const next = process.argv[idx + 1];
    const n = next !== undefined ? Number.parseInt(next, 10) : Number.NaN;
    return Number.isFinite(n) ? n : fallback;
  }
  const n = Number.parseInt(arg.slice(flag.length + 1), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseStringFlag(flag: string, fallback: string): string {
  const arg = process.argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (!arg) return fallback;
  if (arg === flag) {
    const idx = process.argv.indexOf(flag);
    return process.argv[idx + 1] ?? fallback;
  }
  return arg.slice(flag.length + 1) || fallback;
}
