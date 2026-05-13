#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import path from "path";
import { fileURLToPath } from "url";
import { wrapToolError } from "./auth-errors.js";
import { isBareAuthInvocation, parseLegacyAuthArgv, runAuthCommand } from "./cli/commands/auth.js";
import { printAuthSourcesHelp } from "./cli/help.js";
import { loadOAuthKeys } from "./core/auth-flow.js";
import { processBatches } from "./core/batch.js";
import { getConfigDir, getCredentialsPath, getOAuthPath } from "./core/config-paths.js";
import { createContext } from "./core/context.js";
import { loadCredentials as coreLoadCredentials } from "./core/credentials.js";
// Side-effect import: each op file under core/ops/ registers itself with the
// registry at module load time. Adding an import here exposes the op to the
// dispatcher in main().
import "./core/ops/index.js";
import {
  extractAttachments,
  extractEmailContent,
  extractHeaders,
  type GmailMessagePart,
} from "./core/email-helpers.js";
import { registry } from "./core/registry.js";
import {
  getAuthorizedScopes,
  getRecentErrorCount,
  getToolCallCount,
  incrementToolCallCount,
  recordToolError,
  setSession,
} from "./core/session.js";
import { EmailAttachment, emailToHtml, emailToTxt, gmailMessageToJson } from "./email-export.js";
import {
  createFilter,
  deleteFilter,
  filterTemplates,
  getFilter,
  listFilters,
} from "./filter-manager.js";
import {
  createLabel,
  deleteLabel,
  GmailLabel,
  getOrCreateLabel,
  listLabels,
  updateLabel,
} from "./label-manager.js";
import {
  addRePrefix,
  buildReferencesHeader,
  buildReplyAllRecipients,
} from "./reply-all-helpers.js";
import {
  enableOrphanWatchdog,
  enableStdinEofDetection,
  envNum,
  formatHealthText,
  installShutdownHandlers,
  installWatchdog,
  error as logError,
  info as logInfo,
  logShutdown,
  logStartup,
  noteActivity,
  rateLimitAcquire,
  registerCleanup,
  shutdown,
  snapshotHealth,
  startHeapMonitor,
  ToolTimeoutError,
  withRetry,
  withTimeout,
} from "./robustness/index.js";
import { safeJoinWithinBase } from "./safe-path.js";
import { DEFAULT_SCOPES, hasScope } from "./scopes.js";
import {
  BatchDeleteEmailsSchema,
  BatchModifyEmailsSchema,
  CreateFilterFromTemplateSchema,
  CreateFilterSchema,
  CreateLabelSchema,
  DeleteEmailSchema,
  DeleteFilterSchema,
  DeleteLabelSchema,
  DownloadAttachmentSchema,
  DownloadEmailSchema,
  GetFilterSchema,
  GetInboxWithThreadsSchema,
  GetOrCreateLabelSchema,
  GetThreadSchema,
  getToolByName,
  HealthCheckSchema,
  ListInboxThreadsSchema,
  ModifyEmailSchema,
  ModifyThreadSchema,
  ReadEmailSchema,
  ReplyAllSchema,
  SearchEmailsSchema,
  SendEmailSchema,
  toMcpTools,
  toolDefinitions,
  UpdateLabelSchema,
} from "./tools.js";
import { createEmailMessage, createEmailWithNodemailer } from "./utl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration paths — all overridable via GMAIL_CONFIG_DIR / GMAIL_OAUTH_PATH /
// GMAIL_CREDENTIALS_PATH env vars. See src/core/config-paths.ts.
const CONFIG_DIR = getConfigDir();
const OAUTH_PATH = getOAuthPath();
const CREDENTIALS_PATH = getCredentialsPath();

// Per-tool timeout overrides (ms). Default applied to anything not listed.
// Tunable via MCP_TOOL_TIMEOUT_DEFAULT_MS. Per-tool overrides keep
// long-running batch/send operations from being prematurely killed while
// keeping reads tight. Set a value to 0 to disable the wrapper for a tool.
const DEFAULT_TOOL_TIMEOUT_MS = envNum("MCP_TOOL_TIMEOUT_DEFAULT_MS", 30_000);
const TOOL_TIMEOUTS_MS: Record<string, number> = {
  // Reads — tight
  read_email: 30_000,
  search_emails: 30_000,
  list_inbox_threads: 30_000,
  get_thread: 30_000,
  get_inbox_with_threads: 60_000,
  list_email_labels: 15_000,
  list_filters: 15_000,
  get_filter: 15_000,
  download_email: 60_000,
  download_attachment: 60_000,
  // Writes — slightly looser
  send_email: 60_000,
  draft_email: 60_000,
  reply_all: 60_000,
  modify_email: 30_000,
  delete_email: 30_000,
  modify_thread: 30_000,
  create_label: 15_000,
  update_label: 15_000,
  delete_label: 15_000,
  get_or_create_label: 15_000,
  create_filter: 15_000,
  delete_filter: 15_000,
  create_filter_from_template: 15_000,
  // Batch — long
  batch_modify_emails: 120_000,
  batch_delete_emails: 120_000,
  // Robustness — fast canary, no API call
  health_check: 5_000,
};

// Session state (counters, OAuth client, Gmail API client, authorized scopes)
// lives in src/core/session.ts. main() populates it via setSession() once
// credentials load completes; the dispatcher and other in-process callers
// read via the session getters.

// In-process dispatcher reference. Populated at the end of `bootstrap()` so
// that other surfaces (CLI / TUI / HTTP wrappers) can call tool handlers
// directly without going through StdioServerTransport. See callMcpTool below.
type CallToolFn = (
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}>;
let _dispatcherFn: CallToolFn | null = null;

/**
 * Call a tool by name with structured arguments, in-process. Throws if
 * `bootstrap()` (or `main()`) hasn't run yet — the dispatcher closes over
 * `gmail`, `oauth2Client`, etc., which are only initialised after credential
 * loading. CLI subcommands and the TUI use this to avoid spawning a child
 * MCP process per call.
 */
export async function callMcpTool(
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<ReturnType<CallToolFn>> {
  if (!_dispatcherFn) {
    throw new Error(
      "callMcpTool: dispatcher not initialised — make sure main()/bootstrap() has completed.",
    );
  }
  return _dispatcherFn(name, args, signal);
}

interface LoadedCredentials {
  oauth2Client: OAuth2Client;
  authorizedScopes: string[];
}

async function loadCredentials(): Promise<LoadedCredentials | null> {
  try {
    // Load OAuth client keys via the multi-source loader (env or disk).
    // Resolution order (see src/core/auth-flow.ts::loadOAuthKeys):
    //   1. GMAIL_OAUTH_KEYS_JSON env  — full inline JSON (Docker / Cloud Run / .mcp.json env)
    //   2. File at OAUTH_PATH (with cwd → CONFIG_DIR copy convenience for first-run UX)
    // Errors here are fatal — without OAuth client keys we can't construct
    // the OAuth2Client at all.
    let keys;
    try {
      keys = loadOAuthKeys({
        oauthPath: OAUTH_PATH,
        cwd: process.cwd(),
        configDir: CONFIG_DIR,
      });
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      await shutdown(1);
      return null;
    }

    // Standard loopback callback. Custom callbacks for the auth flow are
    // handled by runAuthCommand — that branch in main() returns before
    // reaching loadCredentials.
    const oauth2Client = new OAuth2Client(
      keys.client_id,
      keys.client_secret,
      "http://localhost:3000/oauth2callback",
    );

    // Load stored access/refresh tokens via the multi-source loader chain.
    // Resolution order (see src/core/credentials.ts):
    //   1. GMAIL_CREDENTIALS_JSON env (CI / Docker / k8s secrets)
    //   2. GMAIL_CREDENTIALS_OP env  (1Password CLI shell-out)
    //   3. GMAIL_CREDENTIALS_PATH file or default ~/.gmail-mcp/credentials.json
    // Missing tokens are not fatal — required for `auth` subcommand bootstrap.
    let authorizedScopes: string[] = DEFAULT_SCOPES;
    try {
      const loaded = await coreLoadCredentials({ fallbackPath: CREDENTIALS_PATH });
      oauth2Client.setCredentials(loaded.credentials.tokens);
      if (loaded.credentials.scopes) {
        authorizedScopes = loaded.credentials.scopes;
      }
    } catch (err) {
      // Not finding credentials is OK on first run; other errors are fatal.
      const e = err as { source?: string; name?: string; message?: string };
      if (e.name === "CredentialLoadError" && e.source === "file") {
        // No file yet — user will run `gmail-cli auth` to create it.
      } else {
        console.error(`Error loading credentials: ${e.message ?? err}`);
        await shutdown(1);
        return null;
      }
    }

    return { oauth2Client, authorizedScopes };
  } catch (error) {
    console.error("Error loading credentials:", error);
    await shutdown(1);
    return null;
  }
}

// Main function
//
// `skipTransport: true` runs the bootstrap (credentials + Gmail client +
// dispatcher closure) but does NOT install stdio/HTTP transport — used by
// CLI subcommands that want to call `callMcpTool` in-process without
// becoming an MCP server. Returns once the dispatcher is reachable.
export async function main(opts: { skipTransport?: boolean } = {}) {
  installShutdownHandlers();
  registerCleanup(() => logShutdown("normal"));
  startHeapMonitor();
  installWatchdog();
  logStartup("gmail-mcp");

  if (process.argv[2] === "auth") {
    // Legacy `gmail-mcp auth` entry. Delegates to the same implementation
    // `gmail-cli auth` uses (src/cli/commands/auth.ts::runAuthCommand) so
    // both bins behave identically. Preserves two long-standing quirks:
    //   - URL as positional arg (`gmail-mcp auth https://my.callback/`)
    //     → mapped to --callback by parseLegacyAuthArgv.
    //   - Bare `gmail-mcp auth` (no flags) → renders the scope-source
    //     precedence table first as a teaching moment.
    const authArgv = process.argv.slice(3);
    const opts = parseLegacyAuthArgv(authArgv);
    if (isBareAuthInvocation(authArgv)) {
      printAuthSourcesHelp();
    }
    try {
      await runAuthCommand(opts);
      await shutdown(0);
    } catch (err) {
      const e = err as Error & { code?: string };
      process.stderr.write(`Error: ${e.message}\n`);
      await shutdown(e.code === "INVALID_SCOPE" ? 3 : 2);
    }
    return;
  }

  // Normal MCP path: load credentials and construct the dispatcher closure.
  const loaded = await loadCredentials();
  if (!loaded) return; // loadCredentials already called shutdown()
  const { oauth2Client, authorizedScopes } = loaded;

  // Initialize Gmail API and publish session to the core/session module so
  // in-process callers (CLI / TUI / HTTP wrapper) reach the same OAuth2Client
  // and Gmail instance through getOAuth2Client() / getGmail() / etc.
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  setSession({ oauth2Client, gmail, authorizedScopes });

  // Server implementation
  const server = new Server(
    {
      name: "gmail",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Tool handlers
  // Filter available tools based on authorized scopes
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const availableTools = toolDefinitions.filter((tool) =>
      hasScope(getAuthorizedScopes(), tool.scopes),
    );
    return { tools: toMcpTools(availableTools) };
  });

  // Dispatcher body — extracted so it's also reachable in-process via
  // callMcpTool(). The closure captures `gmail`, `oauth2Client`, and the
  // counter helpers from the surrounding main() scope.
  const dispatcherImpl: CallToolFn = async (name, args, signal) => {
    noteActivity();
    incrementToolCallCount();

    // Verify the tool is authorized for the current scopes
    // This guards against direct tool calls that bypass ListTools
    const toolDef = getToolByName(name);
    if (!toolDef || !hasScope(getAuthorizedScopes(), toolDef.scopes)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Tool "${name}" is not available. You may need to re-authenticate with additional scopes.`,
          },
        ],
      };
    }

    // MCP_TOOL_TIMEOUT_FORCE_MS overrides every tool's timeout when set
    // (>0). Useful for testing the wrapper and emergency throttling without
    // a redeploy. Falls back to per-tool map then global default.
    const forced = envNum("MCP_TOOL_TIMEOUT_FORCE_MS", 0);
    const timeoutMs = forced > 0 ? forced : (TOOL_TIMEOUTS_MS[name] ?? DEFAULT_TOOL_TIMEOUT_MS);

    try {
      return await withTimeout(
        name,
        async () => {
          // Registry path: ops migrated to src/core/ops/<cat>.ts dispatch
          // here. The switch below handles only the not-yet-migrated tools.
          // Progressive migration — eventually the switch goes away.
          if (registry.has(name)) {
            return await registry.dispatch(name, args, createContext({ toolName: name, signal }));
          }
          // Every tool is registered in src/core/ops/. The dispatcher above
          // already routed registered ops via registry.dispatch(); reaching
          // this line means the registry lookup missed — surface as a tool
          // error so the host gets a clear message instead of a hang.
          throw new Error(`Unknown tool: ${name}`);
        },
        timeoutMs,
      );
    } catch (error: any) {
      recordToolError();
      if (error instanceof ToolTimeoutError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool "${name}" timed out after ${error.timeoutMs}ms`,
            },
          ],
        };
      }
      return await wrapToolError(error, name, oauth2Client);
    }
  };

  // Expose the dispatcher to in-process callers (CLI / TUI / HTTP wrapper).
  _dispatcherFn = dispatcherImpl;

  // The MCP transport handler is a thin wrapper that destructures the
  // request envelope and delegates to the shared dispatcher.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    return dispatcherImpl(request.params.name, request.params.arguments, extra.signal);
  });

  // CLI / TUI callers stop here — they get an in-process dispatcher via
  // callMcpTool() but don't want the transport to grab stdin/stdout.
  if (opts.skipTransport) {
    return;
  }

  // Transport selection: --http switches to Streamable HTTP (Phase G).
  // Default remains stdio for compatibility with every MCP host.
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
    // HTTP mode keeps the process alive via the listening server. No stdio
    // EOF detection — exit happens on signal or shutdown registry.
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // After the SDK is reading stdin, attach EOF detection (parent host died)
  // and the orphan watchdog (parent reparented to launchd/init).
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

// Auto-run main() only when this file is the process entry point (e.g.
// `node dist/index.js` or `gmail-mcp` bin). When imported by another module
// (CLI subcommands, tests, the dev MCP proxy in some setups), main() is
// invoked explicitly via `main({ skipTransport: true })`.
const _entryPoint = process.argv[1] ?? "";
const _isMain =
  _entryPoint.endsWith("/dist/index.js") ||
  _entryPoint.endsWith("/src/index.ts") ||
  _entryPoint.endsWith("\\dist\\index.js") ||
  _entryPoint.endsWith("\\src\\index.ts") ||
  _entryPoint.endsWith("/gmail-mcp");

if (_isMain) {
  main().catch((error) => {
    logError("server error", { message: error?.message, stack: error?.stack });
    console.error("Server error:", error);
    void shutdown(1);
  });
}
