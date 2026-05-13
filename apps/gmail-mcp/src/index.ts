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

    async function handleEmailAction(action: "send" | "draft", validatedArgs: any) {
      let message: string;

      try {
        // Auto-resolve threading headers when threadId is provided but inReplyTo is missing
        if (validatedArgs.threadId && !validatedArgs.inReplyTo) {
          try {
            const threadResponse = await gmail.users.threads.get({
              userId: "me",
              id: validatedArgs.threadId,
              format: "metadata",
              metadataHeaders: ["Message-ID"],
            });

            const threadMessages = threadResponse.data.messages || [];
            if (threadMessages.length > 0) {
              // Collect all Message-ID values for the References chain
              const allMessageIds: string[] = [];
              for (const msg of threadMessages) {
                const msgHeaders = msg.payload?.headers || [];
                const messageIdHeader = msgHeaders.find(
                  (h) => h.name?.toLowerCase() === "message-id",
                );
                if (messageIdHeader?.value) {
                  allMessageIds.push(messageIdHeader.value);
                }
              }

              // Last message's Message-ID becomes In-Reply-To
              const lastMessage = threadMessages[threadMessages.length - 1];
              const lastHeaders = lastMessage.payload?.headers || [];
              const lastMessageId = lastHeaders.find(
                (h) => h.name?.toLowerCase() === "message-id",
              )?.value;

              if (lastMessageId) {
                validatedArgs.inReplyTo = lastMessageId;
              }
              if (allMessageIds.length > 0) {
                validatedArgs.references = allMessageIds.join(" ");
              }
            }
          } catch (threadError: any) {
            console.warn(
              `Warning: Could not fetch thread ${validatedArgs.threadId} for header resolution: ${threadError.message}`,
            );
            // Continue without threading headers - degraded but not broken
          }
        }

        // Check if we have attachments
        if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
          // Use Nodemailer to create properly formatted RFC822 message
          message = await createEmailWithNodemailer(validatedArgs);

          if (action === "send") {
            const encodedMessage = Buffer.from(message)
              .toString("base64")
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, "");

            const result = await gmail.users.messages.send({
              userId: "me",
              requestBody: {
                raw: encodedMessage,
                ...(validatedArgs.threadId && { threadId: validatedArgs.threadId }),
              },
            });

            return {
              content: [
                {
                  type: "text",
                  text: `Email sent successfully with ID: ${result.data.id}`,
                },
              ],
            };
          } else {
            // For drafts with attachments, use the raw message
            const encodedMessage = Buffer.from(message)
              .toString("base64")
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, "");

            const messageRequest = {
              raw: encodedMessage,
              ...(validatedArgs.threadId && { threadId: validatedArgs.threadId }),
            };

            const response = await gmail.users.drafts.create({
              userId: "me",
              requestBody: {
                message: messageRequest,
              },
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Email draft created successfully with ID: ${response.data.id}`,
                },
              ],
            };
          }
        } else {
          // For emails without attachments, use the existing simple method
          message = createEmailMessage(validatedArgs);

          const encodedMessage = Buffer.from(message)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");

          // Define the type for messageRequest
          interface GmailMessageRequest {
            raw: string;
            threadId?: string;
          }

          const messageRequest: GmailMessageRequest = {
            raw: encodedMessage,
          };

          // Add threadId if specified
          if (validatedArgs.threadId) {
            messageRequest.threadId = validatedArgs.threadId;
          }

          if (action === "send") {
            const response = await gmail.users.messages.send({
              userId: "me",
              requestBody: messageRequest,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Email sent successfully with ID: ${response.data.id}`,
                },
              ],
            };
          } else {
            const response = await gmail.users.drafts.create({
              userId: "me",
              requestBody: {
                message: messageRequest,
              },
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Email draft created successfully with ID: ${response.data.id}`,
                },
              ],
            };
          }
        }
      } catch (error: any) {
        // Log attachment-related errors for debugging
        if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
          console.error(
            `Failed to send email with ${validatedArgs.attachments.length} attachments:`,
            error.message,
          );
        }
        throw error;
      }
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
          switch (name) {
            case "send_email":
            case "draft_email": {
              const validatedArgs = SendEmailSchema.parse(args);
              const action = name === "send_email" ? "send" : "draft";
              return await handleEmailAction(action, validatedArgs);
            }

            case "download_email": {
              const validatedArgs = DownloadEmailSchema.parse(args);
              const { messageId, savePath, format } = validatedArgs;

              try {
                // Ensure save directory exists
                if (!fs.existsSync(savePath)) {
                  fs.mkdirSync(savePath, { recursive: true });
                }

                // Always fetch full message for metadata (needed for attachments list)
                const fullResponse = await gmail.users.messages.get({
                  userId: "me",
                  id: messageId,
                  format: "full",
                });

                const { subject, from, date } = extractHeaders(fullResponse.data.payload);
                const attachments = extractAttachments(
                  fullResponse.data.payload as GmailMessagePart,
                );

                let content: string;

                if (format === "eml") {
                  // For EML format, fetch raw RFC822 message
                  const rawResponse = await gmail.users.messages.get({
                    userId: "me",
                    id: messageId,
                    format: "raw",
                  });
                  content = Buffer.from(rawResponse.data.raw || "", "base64url").toString("utf-8");
                } else {
                  // Extract email content for json/txt/html
                  const emailContent = extractEmailContent(
                    (fullResponse.data.payload as GmailMessagePart) || {},
                  );

                  if (format === "json") {
                    const jsonData = gmailMessageToJson(
                      fullResponse.data,
                      emailContent,
                      attachments,
                    );
                    content = JSON.stringify(jsonData, null, 2);
                  } else if (format === "txt") {
                    content = emailToTxt(fullResponse.data, emailContent, attachments);
                  } else {
                    // html - just return the raw HTML content
                    content = emailToHtml(emailContent);
                  }
                }

                const fullPath = safeJoinWithinBase(savePath, `${messageId}.${format}`);
                fs.writeFileSync(fullPath, content, "utf-8");
                const stats = fs.statSync(fullPath);

                // Return metadata with attachments
                const result = {
                  status: "saved",
                  path: fullPath,
                  size: stats.size,
                  messageId,
                  subject,
                  from,
                  date,
                  attachments,
                };

                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(result, null, 2),
                    },
                  ],
                };
              } catch (error: any) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Failed to download email: ${error.message}`,
                    },
                  ],
                };
              }
            }

            case "batch_modify_emails": {
              const validatedArgs = BatchModifyEmailsSchema.parse(args);
              const messageIds = validatedArgs.messageIds;
              const batchSize = validatedArgs.batchSize || 50;

              // Prepare request body
              const requestBody: any = {};

              if (validatedArgs.addLabelIds) {
                requestBody.addLabelIds = validatedArgs.addLabelIds;
              }

              if (validatedArgs.removeLabelIds) {
                requestBody.removeLabelIds = validatedArgs.removeLabelIds;
              }

              // Process messages in batches
              const { successes, failures } = await processBatches(
                messageIds,
                batchSize,
                async (batch) => {
                  const results = await Promise.all(
                    batch.map(async (messageId) => {
                      const _result = await gmail.users.messages.modify({
                        userId: "me",
                        id: messageId,
                        requestBody: requestBody,
                      });
                      return { messageId, success: true };
                    }),
                  );
                  return results;
                },
                { toolName: name, signal },
              );

              // Generate summary of the operation
              const successCount = successes.length;
              const failureCount = failures.length;

              let resultText = `Batch label modification complete.\n`;
              resultText += `Successfully processed: ${successCount} messages\n`;

              if (failureCount > 0) {
                resultText += `Failed to process: ${failureCount} messages\n\n`;
                resultText += `Failed message IDs:\n`;
                resultText += failures
                  .map((f) => `- ${(f.item as string).substring(0, 16)}... (${f.error.message})`)
                  .join("\n");
              }

              return {
                content: [
                  {
                    type: "text",
                    text: resultText,
                  },
                ],
              };
            }

            case "batch_delete_emails": {
              const validatedArgs = BatchDeleteEmailsSchema.parse(args);
              const messageIds = validatedArgs.messageIds;
              const batchSize = validatedArgs.batchSize || 50;

              // Process messages in batches
              const { successes, failures } = await processBatches(
                messageIds,
                batchSize,
                async (batch) => {
                  const results = await Promise.all(
                    batch.map(async (messageId) => {
                      await gmail.users.messages.delete({
                        userId: "me",
                        id: messageId,
                      });
                      return { messageId, success: true };
                    }),
                  );
                  return results;
                },
                { toolName: name, signal },
              );

              // Generate summary of the operation
              const successCount = successes.length;
              const failureCount = failures.length;

              let resultText = `Batch delete operation complete.\n`;
              resultText += `Successfully deleted: ${successCount} messages\n`;

              if (failureCount > 0) {
                resultText += `Failed to delete: ${failureCount} messages\n\n`;
                resultText += `Failed message IDs:\n`;
                resultText += failures
                  .map((f) => `- ${(f.item as string).substring(0, 16)}... (${f.error.message})`)
                  .join("\n");
              }

              return {
                content: [
                  {
                    type: "text",
                    text: resultText,
                  },
                ],
              };
            }

            case "create_filter": {
              const validatedArgs = CreateFilterSchema.parse(args);
              const result = await createFilter(
                gmail,
                validatedArgs.criteria,
                validatedArgs.action,
              );

              // Format criteria for display
              const criteriaText = Object.entries(validatedArgs.criteria)
                .filter(([_, value]) => value !== undefined)
                .map(([key, value]) => `${key}: ${value}`)
                .join(", ");

              // Format actions for display
              const actionText = Object.entries(validatedArgs.action)
                .filter(
                  ([_, value]) =>
                    value !== undefined && (Array.isArray(value) ? value.length > 0 : true),
                )
                .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
                .join(", ");

              return {
                content: [
                  {
                    type: "text",
                    text: `Filter created successfully:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
                  },
                ],
              };
            }

            case "list_filters": {
              const result = await listFilters(gmail);
              const filters = result.filters;

              if (filters.length === 0) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "No filters found.",
                    },
                  ],
                };
              }

              const filtersText = filters
                .map((filter: any) => {
                  const criteriaEntries = Object.entries(filter.criteria || {})
                    .filter(([_, value]) => value !== undefined)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(", ");

                  const actionEntries = Object.entries(filter.action || {})
                    .filter(
                      ([_, value]) =>
                        value !== undefined && (Array.isArray(value) ? value.length > 0 : true),
                    )
                    .map(
                      ([key, value]) =>
                        `${key}: ${Array.isArray(value) ? value.join(", ") : value}`,
                    )
                    .join(", ");

                  return `ID: ${filter.id}\nCriteria: ${criteriaEntries}\nActions: ${actionEntries}\n`;
                })
                .join("\n");

              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${result.count} filters:\n\n${filtersText}`,
                  },
                ],
              };
            }

            case "get_filter": {
              const validatedArgs = GetFilterSchema.parse(args);
              const result = await getFilter(gmail, validatedArgs.filterId);

              const criteriaText = Object.entries(result.criteria || {})
                .filter(([_, value]) => value !== undefined)
                .map(([key, value]) => `${key}: ${value}`)
                .join(", ");

              const actionText = Object.entries(result.action || {})
                .filter(
                  ([_, value]) =>
                    value !== undefined && (Array.isArray(value) ? value.length > 0 : true),
                )
                .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
                .join(", ");

              return {
                content: [
                  {
                    type: "text",
                    text: `Filter details:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
                  },
                ],
              };
            }

            case "delete_filter": {
              const validatedArgs = DeleteFilterSchema.parse(args);
              const result = await deleteFilter(gmail, validatedArgs.filterId);

              return {
                content: [
                  {
                    type: "text",
                    text: result.message,
                  },
                ],
              };
            }

            case "create_filter_from_template": {
              const validatedArgs = CreateFilterFromTemplateSchema.parse(args);
              const template = validatedArgs.template;
              const params = validatedArgs.parameters;

              let filterConfig;

              switch (template) {
                case "fromSender":
                  if (!params.senderEmail)
                    throw new Error("senderEmail is required for fromSender template");
                  filterConfig = filterTemplates.fromSender(
                    params.senderEmail,
                    params.labelIds,
                    params.archive,
                  );
                  break;
                case "withSubject":
                  if (!params.subjectText)
                    throw new Error("subjectText is required for withSubject template");
                  filterConfig = filterTemplates.withSubject(
                    params.subjectText,
                    params.labelIds,
                    params.markAsRead,
                  );
                  break;
                case "withAttachments":
                  filterConfig = filterTemplates.withAttachments(params.labelIds);
                  break;
                case "largeEmails":
                  if (!params.sizeInBytes)
                    throw new Error("sizeInBytes is required for largeEmails template");
                  filterConfig = filterTemplates.largeEmails(params.sizeInBytes, params.labelIds);
                  break;
                case "containingText":
                  if (!params.searchText)
                    throw new Error("searchText is required for containingText template");
                  filterConfig = filterTemplates.containingText(
                    params.searchText,
                    params.labelIds,
                    params.markImportant,
                  );
                  break;
                case "mailingList":
                  if (!params.listIdentifier)
                    throw new Error("listIdentifier is required for mailingList template");
                  filterConfig = filterTemplates.mailingList(
                    params.listIdentifier,
                    params.labelIds,
                    params.archive,
                  );
                  break;
                default:
                  throw new Error(`Unknown template: ${template}`);
              }

              const result = await createFilter(gmail, filterConfig.criteria, filterConfig.action);

              return {
                content: [
                  {
                    type: "text",
                    text: `Filter created from template '${template}':\nID: ${result.id}\nTemplate used: ${template}`,
                  },
                ],
              };
            }
            case "download_attachment": {
              const validatedArgs = DownloadAttachmentSchema.parse(args);

              try {
                // Get the attachment data from Gmail API
                const attachmentResponse = await gmail.users.messages.attachments.get({
                  userId: "me",
                  messageId: validatedArgs.messageId,
                  id: validatedArgs.attachmentId,
                });

                if (!attachmentResponse.data.data) {
                  throw new Error("No attachment data received");
                }

                // Decode the base64 data
                const data = attachmentResponse.data.data;
                const buffer = Buffer.from(data, "base64url");

                // Determine save path and filename
                const savePath = validatedArgs.savePath || process.cwd();
                let filename = validatedArgs.filename;

                if (!filename) {
                  // Get original filename from message if not provided
                  const messageResponse = await gmail.users.messages.get({
                    userId: "me",
                    id: validatedArgs.messageId,
                    format: "full",
                  });

                  // Find the attachment part to get original filename
                  const findAttachment = (part: any): string | null => {
                    if (part.body && part.body.attachmentId === validatedArgs.attachmentId) {
                      return part.filename || `attachment-${validatedArgs.attachmentId}`;
                    }
                    if (part.parts) {
                      for (const subpart of part.parts) {
                        const found = findAttachment(subpart);
                        if (found) return found;
                      }
                    }
                    return null;
                  };

                  filename =
                    findAttachment(messageResponse.data.payload) ||
                    `attachment-${validatedArgs.attachmentId}`;
                }

                // Ensure save directory exists
                if (!fs.existsSync(savePath)) {
                  fs.mkdirSync(savePath, { recursive: true });
                }

                // safeJoinWithinBase strips traversal + verifies boundary.
                const fullPath = safeJoinWithinBase(savePath, filename);
                // Update the user-facing filename to the sanitized basename.
                filename = path.basename(filename);
                fs.writeFileSync(fullPath, buffer);

                return {
                  content: [
                    {
                      type: "text",
                      text: `Attachment downloaded successfully:\nFile: ${filename}\nSize: ${buffer.length} bytes\nSaved to: ${fullPath}`,
                    },
                  ],
                };
              } catch (error: any) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Failed to download attachment: ${error.message}`,
                    },
                  ],
                };
              }
            }

            case "reply_all": {
              const validatedArgs = ReplyAllSchema.parse(args);

              // Fetch the original email to get headers
              const originalEmail = await gmail.users.messages.get({
                userId: "me",
                id: validatedArgs.messageId,
                format: "full",
              });

              const headers = originalEmail.data.payload?.headers || [];
              const threadId = originalEmail.data.threadId || "";

              // Extract relevant headers
              const originalFrom =
                headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
              const originalTo = headers.find((h) => h.name?.toLowerCase() === "to")?.value || "";
              const originalCc = headers.find((h) => h.name?.toLowerCase() === "cc")?.value || "";
              const originalSubject =
                headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
              const originalMessageId =
                headers.find((h) => h.name?.toLowerCase() === "message-id")?.value || "";
              const originalReferences =
                headers.find((h) => h.name?.toLowerCase() === "references")?.value || "";

              // Get authenticated user's email to exclude from recipients
              const profile = await gmail.users.getProfile({ userId: "me" });
              const myEmail = profile.data.emailAddress?.toLowerCase() || "";

              // Build recipient list using helper functions
              const { to: replyTo, cc: replyCc } = buildReplyAllRecipients(
                originalFrom,
                originalTo,
                originalCc,
                myEmail,
              );

              if (replyTo.length === 0) {
                throw new Error("Could not determine recipient for reply");
              }

              // Build subject with "Re:" prefix if not already present
              const replySubject = addRePrefix(originalSubject);

              // Build References header (original References + original Message-ID)
              const _references = buildReferencesHeader(originalReferences, originalMessageId);

              // Prepare the email arguments for handleEmailAction
              const emailArgs = {
                to: replyTo,
                cc: replyCc.length > 0 ? replyCc : undefined,
                subject: replySubject,
                body: validatedArgs.body,
                htmlBody: validatedArgs.htmlBody,
                mimeType: validatedArgs.mimeType,
                threadId: threadId,
                inReplyTo: originalMessageId,
                attachments: validatedArgs.attachments,
              };

              // Use the existing handleEmailAction to send the reply
              const _result = await handleEmailAction("send", emailArgs);

              // Enhance the response with reply-all specific info
              return {
                content: [
                  {
                    type: "text",
                    text: `Reply-all sent successfully!\nTo: ${replyTo.join(", ")}${replyCc.length > 0 ? `\nCC: ${replyCc.join(", ")}` : ""}\nSubject: ${replySubject}\nThread ID: ${threadId}`,
                  },
                ],
              };
            }

            default:
              throw new Error(`Unknown tool: ${name}`);
          }
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
