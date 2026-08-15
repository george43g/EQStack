/**
 * iMessage MCP Server
 * Enables AI agents to send and receive iMessages on macOS
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { checkLocalAccess, formatAccessReport } from "./access-check.js";
import { computeRelationshipLeaderboard, dispatchAnalytic } from "./analytics.js";
import { lookupCache, storeCache } from "./analytics-cache.js";
import { resolveInterpretConfig } from "./app-config.js";
import {
  checkImessageAvailability,
  checkMessagesAvailable,
  type SendService,
  sendAttachment,
  sendMessageAlt,
  sendMessageReliable,
  sendToChat,
  sendToChatId,
} from "./applescript.js";
import { type EnsureDownloadedResult, ensureAttachmentDownloaded } from "./attachment-sync.js";
import { ChangeWatcher } from "./change-watcher.js";
import {
  getContactsDbPaths,
  getHumansDirPath,
  getImsgDbPath,
  getSlugsDbPath,
  getTranscribeCloudConfig,
} from "./config.js";
import { rememberSearch, resolveContactSelector } from "./contact-resolver.js";
import { normalizedPhoneVariants } from "./contacts-db.js";
import { parseUserDate } from "./date-parse.js";
import { type ChangeEvent, EventBus } from "./event-bus.js";
import { ExportInterpretGuardError, streamExport } from "./exportStream.js";
import { rankFuzzy } from "./fuzzy.js";
import { HUMANS_INIT_HINT, HumansIndex, humansHintText } from "./humans-hints.js";
import { HumansScaffold } from "./humans-scaffold.js";
import { buildIdentity, buildIdentityFromHandle } from "./identity.js";
import { IMessageDB } from "./imessage-db.js";
import {
  appendLog,
  enableStderrLogging,
  getFileLogLines,
  getLastSendError,
  getLogDirectory,
  getLogFilePath,
  getLogs,
  info,
  logShutdown,
  logStartup,
  perf,
  setLastSendError,
  startHeapMonitor,
  stopHeapMonitor,
  writeStderrLine,
} from "./logger.js";
import {
  analyticTextSummary,
  engineLabel,
  formatDuration,
  formatMessage,
  formatToolError,
  messageToStructured,
  relativeDate,
  round1,
  toolError,
  toolText,
  validateExportOutputPath,
} from "./mcp-format.js";
import {
  ChatAnalyticsSchema,
  CheckImessageAvailabilitySchema,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEV_TOOL_NAMES,
  ExportMessagesSchema,
  GetAttachmentSchema,
  GetContactSchema,
  GetLogsSchema,
  GetMessagesSchema,
  GetUnreadMessagesSchema,
  getActiveTools,
  InitHumanSchema,
  isDevMode,
  ListContactsSchema,
  ListConversationsSchema,
  ResolveConversationSchema,
  ResolveHandleSchema,
  resolveLimit,
  SearchAttachmentsSchema,
  SearchContactsSchema,
  SearchMessagesSchema,
  SendMessageSchema,
  TOOL_TIMEOUTS_MS,
  type ToolName,
  WaitForChangesSchema,
  WaitForReplySchema,
} from "./mcp-tools.js";
import {
  detectTranscriber,
  imageBlockFromFile,
  mediaMetadata,
  TRANSCRIBE_MAX_BYTES,
  videoPosterFrame,
} from "./media.js";
import {
  applyInlineInterpretations,
  getInterpretRuntime,
  refForAttachment,
  transcriptSourceEnum,
} from "./media-intel-runtime.js";
import { APP_NAME, APP_VERSION } from "./meta.js";
import { wrapUntrusted } from "./prompt-injection.js";
import { defaultCountryFromEnv, resolveRecipient } from "./recipient.js";
import { sanitizeUserText } from "./sanitize.js";
import { normalizeForEcho, type SentEcho, SentEchoRegistry } from "./sent-echo-registry.js";
import {
  enableOrphanWatchdog,
  enableStdinEofDetection,
  getShutdownCause,
  installShutdownHandlers,
  registerCleanup,
  shutdown,
} from "./shutdown.js";
import { type Message, oldestMessageCursor } from "./types.js";
import { installWatchdog, noteActivity, readWatchdogState } from "./watchdog.js";

const execFileAsync = promisify(execFile);

class ToolTimeoutError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `Tool '${toolName}' timed out after ${timeoutMs}ms. The MCP server has unblocked; the underlying query may still be running in the background.`,
    );
    this.name = "ToolTimeoutError";
  }
}

function withTimeout<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
  const ms = TOOL_TIMEOUTS_MS[toolName] ?? DEFAULT_TOOL_TIMEOUT_MS;
  if (ms <= 0) return fn();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeoutError(toolName, ms)), ms);
    timer.unref();
    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Sleep utility
 */
/**
 * Sleep for `ms`, resolving early if `signal` aborts. The caller is
 * expected to re-check `signal.aborted` after — sleep just wakes up
 * promptly so the caller doesn't sit on a 10–60s setTimeout while a
 * cancellation is already in flight. Without this, `wait_for_reply`
 * could take up to a full poll interval to honor a cancel.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Main MCP server class
 */
export class IMessageMCPServer {
  private server: Server;
  private db: IMessageDB;

  // Activity tracking — surfaced via health_check and watchdog
  private toolCallCount = 0;
  private recentErrorCount = 0;
  private lastActivityTs = Date.now();

  // Fingerprints of this process's own sends so wait_for_reply can return
  // the user's interjections without echoing the agent's just-sent message.
  private sentEchoes = new SentEchoRegistry();
  private humansIndex = new HumansIndex();

  // Shared change stream (WAL watcher → typed EventBus), armed lazily by
  // ensureChangeStream() on the first long-poll. Null until then.
  private changeBus: EventBus | null = null;
  private changeWatcher: ChangeWatcher | null = null;

  constructor() {
    this.server = new Server(
      {
        name: APP_NAME,
        version: APP_VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: { subscribe: false, listChanged: false },
        },
      },
    );

    this.db = new IMessageDB(getImsgDbPath(), getContactsDbPaths(), getSlugsDbPath());
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: getActiveTools(),
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      this.lastActivityTs = Date.now();
      this.toolCallCount++;
      noteActivity();

      // The SDK gives us an AbortSignal per request that fires when the host
      // sends notifications/cancelled with this request's id. We pass it down
      // to long-running handlers so they can bail out early.
      const signal = extra?.signal;

      const startedAt = performance.now();
      const stampMeta = <T extends Record<string, unknown>>(result: T): T => {
        const duration_ms = Math.round((performance.now() - startedAt) * 10) / 10;
        return { ...result, _meta: { engine: engineLabel(), duration_ms } } as T;
      };

      try {
        return stampMeta(await withTimeout(name, () => this.dispatchTool(name, args, signal)));
      } catch (error: any) {
        const isTimeout = error instanceof ToolTimeoutError;
        // Format Zod schema errors as a flat human-readable string
        // instead of the default JSON-stringified issues array. Pre-fix,
        // `resolve_handle({handle: ""})` returned the entire Zod issue
        // object as the error message — agents couldn't easily parse it.
        const friendly = formatToolError(error);
        appendLog(isTimeout ? "warn" : "error", isTimeout ? "Tool timed out" : "Tool error", {
          tool: name,
          error: friendly,
        });
        if (!isTimeout) this.recentErrorCount++;
        return stampMeta(
          toolError(`Error: ${friendly}`, {
            tool: name,
            error: friendly,
            timedOut: isTimeout,
          }),
        );
      } finally {
        this.db.scheduleBackgroundRefresh();
      }
    });

    // MCP Resources — let hosts browse/subscribe without an explicit tool call.
    // We advertise templates (parameterized URIs) rather than concrete
    // resources because the user's data is open-ended.
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [],
    }));

    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: [
        {
          uriTemplate: "messages://recent/{hours}",
          name: "Recent messages (last N hours)",
          description: "Read all messages across every chat from the last {hours} hours.",
          mimeType: "application/json",
        },
        {
          uriTemplate: "messages://contact/{handle}/{hours}",
          name: "Messages with a contact (last N hours)",
          description:
            "Read messages from the chat containing {handle} (phone/email) in the last {hours} hours.",
          mimeType: "application/json",
        },
        {
          uriTemplate: "contacts://",
          name: "All loaded contacts",
          description: "Read all contacts from the macOS Address Book sources.",
          mimeType: "application/json",
        },
      ],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      try {
        const result = await this.readResource(uri);
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (e: any) {
        throw new Error(`Resource ${uri} failed: ${e.message ?? e}`);
      }
    });
  }

  private async readResource(uri: string): Promise<unknown> {
    // messages://recent/{hours}
    let m = uri.match(/^messages:\/\/recent\/(\d+)$/);
    if (m?.[1]) {
      const hours = Number(m[1]);
      const cutoffMs = Date.now() - hours * 3600 * 1000;
      // Use existing getRecentMessages then filter by date (cheap; recent is
      // already bounded). For hours > 24 callers should use get_messages
      // tool instead.
      const msgs = await this.db.getRecentMessages(500);
      return {
        windowHours: hours,
        messages: msgs
          .filter((mm: Message) => mm.date.getTime() >= cutoffMs)
          .map(messageToStructured),
      };
    }
    // messages://contact/{handle}/{hours}
    m = uri.match(/^messages:\/\/contact\/([^/]+)\/(\d+)$/);
    if (m?.[1] && m?.[2]) {
      const handle = decodeURIComponent(m[1]);
      const hours = Number(m[2]);
      const cutoffMs = Date.now() - hours * 3600 * 1000;
      const chat = await this.db.findChatByHandle(handle);
      if (!chat) return { handle, windowHours: hours, messages: [] };
      const msgs = await this.db.getMessagesForChat(chat.chatIdentifier, 500);
      return {
        handle,
        chatId: chat.chatIdentifier,
        windowHours: hours,
        messages: msgs
          .filter((mm: Message) => mm.date.getTime() >= cutoffMs)
          .map(messageToStructured),
      };
    }
    // contacts://
    if (uri === "contacts://") {
      const all = this.db.contacts.listContacts(0, 10000);
      return { count: all.contacts.length, contacts: all.contacts };
    }
    throw new Error(`Unknown resource URI: ${uri}`);
  }

  private async dispatchTool(name: string, args: unknown, signal?: AbortSignal) {
    if (DEV_TOOL_NAMES.has(name as ToolName) && !isDevMode()) {
      throw new Error(`Unknown tool: ${name}`);
    }
    switch (name) {
      case "get_messages":
        return await this.handleGetMessages(args);
      case "get_unread_messages":
        return await this.handleGetUnreadMessages(args);
      case "send_message":
        return await this.handleSendMessage(args);
      case "wait_for_reply":
        return await this.handleWaitForReply(args, signal);
      case "wait_for_changes":
        return await this.handleWaitForChanges(args, signal);
      case "list_conversations":
        return await this.handleListConversations(args);
      case "search_messages":
        return await this.handleSearchMessages(args);
      case "get_logs":
        return await this.handleGetLogs(args);
      case "get_last_send_error":
        return await this.handleGetLastSendError();
      case "run_build":
        return await this.handleRunBuild();
      case "request_restart":
        return await this.handleRequestRestart();
      case "health_check":
        return await this.handleHealthCheck();
      case "export_messages":
        return await this.handleExportMessages(args, signal);
      case "list_contacts":
        return await this.handleListContacts(args);
      case "search_contacts":
        return await this.handleSearchContacts(args);
      case "get_contact":
        return await this.handleGetContact(args);
      case "resolve_conversation":
        return await this.handleResolveConversation(args);
      case "resolve_handle":
        return await this.handleResolveHandle(args);
      case "check_imessage_availability":
        return await this.handleCheckImessageAvailability(args);
      case "search_attachments":
        return await this.handleSearchAttachments(args);
      case "get_attachment":
        return await this.handleGetAttachment(args);
      case "chat_analytics":
        return await this.handleChatAnalytics(args);
      case "init_human":
        return await this.handleInitHuman(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async handleGetLogs(args: unknown) {
    const { tail, source } = GetLogsSchema.parse(args ?? {});
    const n = tail ?? 50;
    const sections: string[] = [];

    if (source !== "file") {
      const memLines = getLogs(n);
      sections.push(
        `## In-Memory Logs (${memLines.length} lines)\n${memLines.length === 0 ? "No log lines yet." : memLines.join("\n")}`,
      );
    }

    if (source === "file" || source === "all") {
      const fileLines = getFileLogLines(n);
      const logPath = getLogFilePath() ?? getLogDirectory();
      sections.push(
        `## File Logs (${logPath})\n${fileLines.length === 0 ? "No file log entries." : fileLines.join("\n")}`,
      );
    }

    if (source !== "file" && source !== "all") {
      // Also show log file location for reference
      const logPath = getLogFilePath() ?? getLogDirectory();
      sections.push(`\n📁 Full NDJSON logs: ${logPath}`);
    }

    return toolText(sections.join("\n\n"), { source: source ?? "memory", tail: n, sections });
  }

  private async handleGetLastSendError() {
    const err = getLastSendError();
    if (!err) {
      return toolText(
        "No send failure recorded. Last send either succeeded or occurred before this server run.",
        {
          lastSendError: null,
        },
      );
    }
    const text = [
      "Last send_message failure:",
      `  message: ${err.message}`,
      `  timestamp: ${err.timestamp}`,
      err.stderr != null ? `  stderr: ${err.stderr}` : "",
      err.stdout != null ? `  stdout: ${err.stdout}` : "",
      err.code != null ? `  code: ${err.code}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return toolText(text, { lastSendError: err });
  }

  private async handleRunBuild(): Promise<any> {
    try {
      const { stdout, stderr } = await execFileAsync("pnpm", ["build"], {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        cwd: process.cwd(),
      });
      return toolText(
        `Build succeeded.\n\nstdout:\n${stdout}${stderr ? `\n\nstderr:\n${stderr}` : ""}`,
        {
          ok: true,
          stdout,
          stderr,
        },
      );
    } catch (error: any) {
      const stderr = error.stderr?.toString?.() ?? error.message ?? "";
      const stdout = error.stdout?.toString?.() ?? "";
      appendLog("error", "run_build failed", { stderr, stdout });
      return toolError(`Build failed.\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`, {
        ok: false,
        stdout,
        stderr,
      });
    }
  }

  private async handleRequestRestart(): Promise<any> {
    const msg =
      "Restart requested. Please restart the MCP server in your client (e.g. Cursor) to load new code.";
    setImmediate(() => shutdown(0));
    return toolText(msg, { restartRequested: true });
  }

  /**
   * Returns vital signs in a fixed text format. Designed to never touch the
   * DB so it returns instantly even when SQL is blocked — that's the whole
   * point: this tool verifies "the MCP is alive even though queries are slow".
   */
  private async handleHealthCheck(): Promise<any> {
    const wd = readWatchdogState();
    const uptimeMs = Date.now() - wd.startedAt;
    const idleMs = Date.now() - this.lastActivityTs;

    // Compute status: healthy < degraded < unhealthy
    let status = "healthy";
    const issues: string[] = [];
    if (wd.eventLoopP99Ms > 500) {
      status = "degraded";
      issues.push(`event-loop lag p99 ${wd.eventLoopP99Ms.toFixed(0)}ms`);
    }
    if (wd.eventLoopP99Ms > 5_000) {
      status = "unhealthy";
    }
    if (wd.rssMb > 800) {
      status = status === "healthy" ? "degraded" : status;
      issues.push(`RSS ${wd.rssMb}MB`);
    }
    if (this.recentErrorCount > 5) {
      status = status === "healthy" ? "degraded" : status;
      issues.push(`${this.recentErrorCount} recent errors`);
    }

    const lines = [
      `Status: ${status}`,
      issues.length ? `Issues: ${issues.join("; ")}` : "",
      "",
      `Uptime: ${formatDuration(uptimeMs)}`,
      `Last activity: ${formatDuration(idleMs)} ago`,
      `PID: ${process.pid}`,
      `Node: ${process.version}`,
      "",
      `Heap: ${wd.heapMb || round1(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      `RSS: ${wd.rssMb || round1(process.memoryUsage().rss / 1024 / 1024)}MB`,
      `Event-loop p99: ${wd.eventLoopP99Ms.toFixed(1)}ms`,
      `Event-loop max: ${wd.eventLoopMaxMs.toFixed(1)}ms`,
      "",
      `Total tool calls: ${this.toolCallCount}`,
      `Recent errors: ${this.recentErrorCount}`,
      `Engine: ${engineLabel()}`,
    ].filter((l) => l !== null);

    return toolText(lines.join("\n"), {
      status,
      issues,
      uptimeMs,
      idleMs,
      pid: process.pid,
      node: process.version,
      heapMb: wd.heapMb || round1(process.memoryUsage().heapUsed / 1024 / 1024),
      rssMb: wd.rssMb || round1(process.memoryUsage().rss / 1024 / 1024),
      eventLoopP99Ms: wd.eventLoopP99Ms,
      eventLoopMaxMs: wd.eventLoopMaxMs,
      toolCallCount: this.toolCallCount,
      recentErrorCount: this.recentErrorCount,
      engine: engineLabel(),
    });
  }

  private async handleGetMessages(args: unknown) {
    const span = perf("tool:get_messages");
    const parsed = GetMessagesSchema.parse(args);
    const { chatIdentifier, threadSlug, beforeMessageId } = parsed;
    // Internal cap to prevent OOM regardless of caller's request.
    const HARD_PAGE_CAP = 5000;
    const requested = resolveLimit(parsed.limit);
    const limit = Math.min(requested, HARD_PAGE_CAP);
    const wasCapped = requested > HARD_PAGE_CAP;

    const scoped = Boolean(chatIdentifier || threadSlug);
    let messages: Message[];
    let threadHeader = "";
    let humansHint: ReturnType<HumansIndex["hintFor"]> = null;
    if (chatIdentifier || threadSlug) {
      let targetIdentifier = chatIdentifier;
      if (threadSlug) {
        const slugRecord = this.db.getSlugRecord(threadSlug);
        if (!slugRecord) {
          return toolError(`Unknown thread slug: ${threadSlug}`, { threadSlug });
        }
        targetIdentifier = slugRecord.chatIdentifier;
      }

      messages = await this.db.getMessagesForChat(targetIdentifier!, limit, { beforeMessageId });
      const conv = await this.db.findChatByHandle(targetIdentifier!);
      if (conv) {
        const name = conv.displayName || conv.rawIdentifier;
        const ident = conv.displayName ? ` (${conv.rawIdentifier})` : "";
        const kind = conv.isGroupChat ? "Group" : "1-on-1";
        threadHeader = `Thread: ${conv.threadSlug} | ${name}${ident} | ${conv.serviceType} | ${kind}\n\n`;
        humansHint = this.humansIndex.hintFor(conv.participants);
      }
    } else {
      messages = await this.db.getRecentMessages(limit);
    }

    const durMs = span.end({ limit, returned: messages.length });

    // When neither chatIdentifier nor threadSlug was passed, the result is an
    // interleaved feed across ALL conversations — make that explicit so the
    // caller doesn't mistake it for one person's thread (structured `scope`
    // carries the same signal for programmatic consumers).
    const globalNotice = scoped
      ? ""
      : "⚠ Global timeline: these messages are interleaved across ALL conversations (newest first), not one thread. To read a single conversation, pass chatIdentifier or threadSlug (see list_conversations / resolve_conversation).\n\n";

    if (messages.length === 0) {
      return toolText(`${globalNotice}${threadHeader}No messages found.`, {
        messages: [],
        count: 0,
        hasMore: false,
        scope: scoped ? "conversation" : "global",
      });
    }

    // Inline cached/instant voice-note transcripts + captions (never blocks on a
    // cloud call — interpretation is triggered by get_attachment / TUI / export).
    applyInlineInterpretations(messages);

    const formatted = messages.map((m) => formatMessage(m)).join("\n");
    // MUST be the min by (date, ROWID), not the min ROWID: getMessagesForChat
    // resolves `beforeMessageId` to that message's DATE and pages on the
    // composite. In merged threads (phone + email, SMS + iMessage) ROWID order
    // diverges from date order, so a min-ROWID cursor points at a NEWER message
    // and every message older than it but newer than the true oldest is skipped
    // — silently, on every page turn. Measured on a real DB: 6 of 35 full-page
    // threads diverged, worst case 193 messages lost in a single turn.
    const oldestId = oldestMessageCursor(messages) ?? 0;
    const hasMore = messages.length === limit; // heuristic — full page suggests more
    const paginationLine =
      chatIdentifier || threadSlug
        ? `\n_Pagination: oldestMessageId=${oldestId}, hasMore=${hasMore}${wasCapped ? ` (capped at ${HARD_PAGE_CAP} per call — use beforeMessageId or export_messages)` : ""}_`
        : "";
    const perfLine = `\n_Engine: ${engineLabel()} | Query: ${durMs.toFixed(0)}ms | Messages: ${messages.length}_`;
    const humansLine = humansHint ? humansHintText(humansHint) : "";
    return toolText(
      `${globalNotice}${threadHeader}Found ${messages.length} message(s):\n\n${formatted}${paginationLine}${perfLine}${humansLine}`,
      {
        messages: messages.map(messageToStructured),
        count: messages.length,
        hasMore,
        scope: scoped ? "conversation" : "global",
        oldestMessageId: scoped ? oldestId : undefined,
        ...(humansHint ? { humans: humansHint } : {}),
      },
    );
  }

  private async handleExportMessages(args: unknown, signal?: AbortSignal) {
    const span = perf("tool:export_messages");
    const parsed = ExportMessagesSchema.parse(args);
    const { format, outputPath, since, until, pageSize, interpret, confirmCloudInterpret } = parsed;

    // Resolve target chat
    let chatIdentifier = parsed.chatIdentifier;
    if (parsed.threadSlug) {
      const slugRecord = this.db.getSlugRecord(parsed.threadSlug);
      if (!slugRecord) {
        return toolError(`Unknown thread slug: ${parsed.threadSlug}`, {
          threadSlug: parsed.threadSlug,
        });
      }
      chatIdentifier = slugRecord.chatIdentifier;
    }
    if (!chatIdentifier) {
      return toolError("chatIdentifier or threadSlug required", {});
    }

    const pathError = validateExportOutputPath(outputPath);
    if (pathError) {
      return toolError(pathError, { outputPath });
    }

    // Parse date bounds (reuse the same parser the TUI uses)
    const sinceDate = since ? parseUserDate(since) : null;
    const untilDate = until ? parseUserDate(until) : null;
    if (since && !sinceDate) {
      return toolError(`Could not parse 'since': ${since}`, { since });
    }
    if (until && !untilDate) {
      return toolError(`Could not parse 'until': ${until}`, { until });
    }

    let result: Awaited<ReturnType<typeof streamExport>>;
    try {
      result = await streamExport({
        db: this.db,
        chatIdentifier,
        format,
        outputPath,
        since: sinceDate,
        until: untilDate,
        pageSize,
        signal,
        interpret,
        confirmCloudInterpret,
      });
    } catch (err) {
      if (err instanceof ExportInterpretGuardError) {
        return toolError(err.message, {
          uncachedCloud: err.uncachedCloud,
          threshold: err.threshold,
        });
      }
      throw err;
    }
    const durMs = span.end({ format, count: result.count, sizeBytes: result.sizeBytes });

    const lines = [
      `Exported ${result.count} message(s) to ${result.savedTo}`,
      `Format: ${format}`,
      `Range: ${result.oldest?.toISOString() ?? "(none)"} → ${result.newest?.toISOString() ?? "(none)"}`,
      `Size: ${(result.sizeBytes / 1024).toFixed(1)} KB`,
    ];
    if (result.unmergedSiblings.length > 0) {
      const which = result.unmergedSiblings.map((s) => s.chatIdentifier).join(", ");
      lines.push(
        `⚠️ ${result.unmergedSiblings.length} other chat(s) (${which}) share this contact's identity but were not merged — history may be incomplete.`,
      );
    }
    lines.push(`_Took ${durMs.toFixed(0)}ms_`);

    return toolText(lines.join("\n"), {
      ...result,
      format,
      oldest: result.oldest?.toISOString() ?? null,
      newest: result.newest?.toISOString() ?? null,
      durationMs: durMs,
    });
  }

  private async handleGetUnreadMessages(args: unknown) {
    const { limit } = GetUnreadMessagesSchema.parse(args ?? {});
    // 2000 hard cap on `limit:0`. A user with 5000+ pending unread (real
    // case after a long offline) would otherwise serialise ~1.5MB into
    // the MCP response and overflow the host's token budget.
    const HARD_CAP = 2_000;
    const resolvedLimit = Math.min(resolveLimit(limit, 100), HARD_CAP);
    const messages = await this.db.getUnreadMessages(resolvedLimit + 1);
    const hasMore = messages.length > resolvedLimit;
    const results = messages.slice(0, resolvedLimit);

    if (results.length === 0) {
      return toolText("No unread messages.", {
        messages: [],
        count: 0,
        hasMore: false,
        truncated: false,
      });
    }

    // Add conversation context per message (slug or display name)
    const formatted = results
      .map((msg) => {
        const slug = this.db.getSlugForChatIdentifier(msg.chatId);
        const label = slug ?? msg.chatId;
        return formatMessage(msg, label);
      })
      .join("\n");
    return toolText(`Found ${results.length} unread message(s):\n\n${formatted}`, {
      messages: results.map(messageToStructured),
      count: results.length,
      hasMore,
      truncated: hasMore,
    });
  }

  private async handleSendMessage(args: unknown) {
    const { recipient, threadSlug, message, attachments } = SendMessageSchema.parse(args);

    // Wrapper so every validation early-exit also records to
    // `lastSendError`. Pre-fix, get_last_send_error returned null after
    // a failed send because validation errors never reached the
    // AppleScript layer where the only setLastSendError call lived.
    const failValidation = (msg: string, data: Record<string, unknown> = {}) => {
      setLastSendError({ message: msg, code: "validation", stderr: undefined, stdout: undefined });
      return toolError(msg, data);
    };

    if (!recipient && !threadSlug) {
      return failValidation("Either recipient or threadSlug is required.", {});
    }

    // Pre-validate attachment paths so we fail fast (before sending the
    // text body) when a path is bogus.
    if (attachments?.length) {
      for (const p of attachments) {
        if (!isAbsolute(p)) {
          return failValidation(`Attachment path must be absolute: ${p}`, { attachment: p });
        }
        if (!existsSync(p)) {
          return failValidation(`Attachment file not found: ${p}`, { attachment: p });
        }
      }
    }

    const available = await checkMessagesAvailable();
    if (!available) {
      return failValidation("Messages.app is not running or accessible.", {
        messagesAvailable: false,
      });
    }

    let result: { success: boolean; error?: string; timestamp?: Date };
    let resolvedTarget = recipient ?? threadSlug ?? "";

    // Normalize `recipient` if provided. Accepts E.164 / local phone /
    // iMessage email / contact name. The pre-existing path only worked
    // for E.164 + email (AppleScript layer's expectation) — now any of
    // the 4 forms route through one normalizer + the contact:N selector
    // for ambiguous lookups.
    let normalizedRecipient = recipient;
    if (recipient && !threadSlug) {
      const resolution = resolveRecipient(recipient, {
        contacts: this.db.contacts,
        defaultCountry: defaultCountryFromEnv(),
      });
      if (resolution.kind === "error") {
        return failValidation(resolution.message, { recipient });
      }
      if (resolution.kind === "ambiguous") {
        // Surface the same disambiguation list the contact:N selector uses.
        const lines = resolution.candidates
          .map((c, i) => `  contact:${i + 1}  ${c.displayName}  →  ${c.handle}`)
          .join("\n");
        return failValidation(
          `Ambiguous recipient "${recipient}" — multiple matches:\n${lines}\n\nCall again with one of the contact:N labels.`,
          {
            recipient,
            candidates: resolution.candidates,
          },
        );
      }
      normalizedRecipient = resolution.handle;
      resolvedTarget = resolution.handle;
    }

    // Service routing ground truth: AppleScript cannot detect a wrong-service
    // send (lazy participant resolution — an SMS-only number "sends" fine via
    // the iMessage service and just never delivers). chat.db CAN tell us: the
    // slug store persists each thread's service, and any existing conversation
    // knows which service carries it. Resolve that BEFORE sending so the first
    // attempt uses the service the thread actually lives on.
    let preferredService: SendService | undefined;

    if (threadSlug) {
      const slugRecord = this.db.getSlugRecord(threadSlug);
      if (!slugRecord) {
        return failValidation(
          `Unknown thread slug: ${threadSlug}. Use list_conversations to see available slugs.`,
          {
            threadSlug,
          },
        );
      }
      // Delivery evidence beats the slug store's canonical service: a failed
      // wrong-service send mints a phantom leg that can flip the canonical
      // service, and blindly trusting it would repeat the failure forever.
      preferredService =
        this.db.getPreferredSendService(slugRecord.chatIdentifier) ??
        (slugRecord.service === "SMS" ? "SMS" : "iMessage");

      if (slugRecord.isGroup) {
        if (slugRecord.displayName && !slugRecord.displayName.startsWith("chat")) {
          result = await sendToChat(slugRecord.displayName, message);
        } else {
          result = await sendToChatId(slugRecord.chatGuid, message);
        }
      } else {
        // Route 1:1 sends through the temp-file path on the thread's known
        // service. Falls back to sendMessageAlt only if the reliable path
        // itself errors before AppleScript runs (e.g. tmp-file write failure).
        result = await sendMessageReliable(slugRecord.chatIdentifier, message, preferredService);
        if (!result.success) {
          result = await sendMessageAlt(slugRecord.chatIdentifier, message);
        }
      }
      resolvedTarget = slugRecord.displayName || slugRecord.chatIdentifier;
    } else {
      // Raw recipient: an existing conversation is the only reliable service
      // signal. New recipients (no history) default to iMessage-first.
      const existingChat = await this.db.findChatByHandle(normalizedRecipient!);
      if (existingChat && !existingChat.isGroupChat) {
        preferredService =
          this.db.getPreferredSendService(existingChat.chatIdentifier) ??
          (existingChat.serviceType === "SMS" ? "SMS" : "iMessage");
      }
      result = await sendMessageReliable(normalizedRecipient!, message, preferredService);
      if (!result.success) {
        result = await sendMessageAlt(normalizedRecipient!, message);
      }
    }

    if (result.success) {
      // Ship attachments as follow-up sends. 1:1 only — Messages.app's
      // `send (POSIX file …) to chat …` form is unreliable, so for slug-based
      // group sends we surface the limitation in the response rather than
      // attempting it.
      const attachmentResults: Array<{ path: string; success: boolean; error?: string }> = [];
      if (attachments?.length) {
        const targetHandle = threadSlug
          ? this.db.getSlugRecord(threadSlug)?.chatIdentifier
          : normalizedRecipient;
        const isGroupTarget = threadSlug
          ? Boolean(this.db.getSlugRecord(threadSlug)?.isGroup)
          : false;

        if (isGroupTarget) {
          for (const p of attachments) {
            attachmentResults.push({
              path: p,
              success: false,
              error: "Attachment send to group chats not supported (Messages.app limitation).",
            });
          }
        } else if (targetHandle) {
          for (const p of attachments) {
            // Same service routing as the text body — an SMS thread's
            // attachment goes out as MMS, not a dead-end iMessage attempt.
            const r = await sendAttachment(targetHandle, p, preferredService);
            attachmentResults.push({
              path: p,
              success: r.success,
              error: r.error,
            });
          }
        }
      }

      const chat = await this.db.findChatByHandle(
        threadSlug ? (this.db.getSlugRecord(threadSlug)?.chatIdentifier ?? "") : recipient!,
      );
      let lastMessageId: number | undefined;
      let sendConfirmed = false;

      if (chat) {
        // Register the send's fingerprint (echo suppression for
        // wait_for_reply's includeSelf mode), then wait — bounded — for our
        // own row to land in chat.db so lastMessageId points AT the sent
        // message. chat.db lags Messages.app by 1–2s; the previous one-shot
        // getLastMessage could return a stale pre-send row, and the echo
        // would later read as a "new" message.
        const chatKey = chat.threadSlug ?? chat.chatIdentifier;
        const echo = this.sentEchoes.register(chatKey, message);
        for (const a of attachmentResults) {
          if (a.success) this.sentEchoes.register(chatKey, "", "attachment");
        }
        const confirmed = await this.confirmSendLanded(chat.chatIdentifier, echo);
        lastMessageId = confirmed.lastMessageId;
        sendConfirmed = confirmed.confirmed;
      }

      const attSummary =
        attachmentResults.length > 0
          ? `\nAttachments: ${attachmentResults.filter((a) => a.success).length}/${attachmentResults.length} delivered`
          : "";

      return toolText(
        `Message sent to ${resolvedTarget} at ${result.timestamp?.toLocaleString()}${chat ? `\nThread: ${chat.threadSlug}` : ""}${lastMessageId ? `\nLast message ID: ${lastMessageId} (use with wait_for_reply)` : ""}${attSummary}`,
        {
          success: true,
          target: resolvedTarget,
          timestamp: result.timestamp?.toISOString() ?? null,
          threadSlug: chat?.threadSlug,
          lastMessageId,
          sendConfirmed,
          attachments: attachmentResults.length > 0 ? attachmentResults : undefined,
        },
      );
    } else {
      appendLog("error", "send_message failed", { recipient: resolvedTarget, error: result.error });
      return toolError(
        `Failed to send message: ${result.error}. Use get_last_send_error for details.`,
        {
          success: false,
          target: resolvedTarget,
          error: result.error,
        },
      );
    }
  }

  /**
   * Bounded poll for the just-sent message's own from-me row in chat.db.
   * Scans the last few messages (not just the newest — an incoming reply can
   * land AFTER our send) for a from-me row matching the echo's normalized
   * text with a plausible date. On hit, pins the echo's ROWID so wait_for_reply
   * suppression is exact. On timeout, falls back to the last message id
   * (previous behavior) with confirmed: false.
   */
  private async confirmSendLanded(
    chatIdentifier: string,
    echo: SentEcho,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ lastMessageId: number | undefined; confirmed: boolean }> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const pollMs = opts.pollMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    const skewMs = 15_000;
    for (;;) {
      const recent = await this.db.getMessagesForChat(chatIdentifier, 5);
      for (let i = recent.length - 1; i >= 0; i--) {
        const m = recent[i];
        if (
          m.isFromMe &&
          normalizeForEcho(m.text) === echo.normalizedText &&
          m.date.getTime() >= echo.sentAt - skewMs
        ) {
          echo.matchedMessageId = m.id;
          return { lastMessageId: m.id, confirmed: true };
        }
      }
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
    }
    const lastMsg = await this.db.getLastMessage(chatIdentifier);
    return { lastMessageId: lastMsg?.id, confirmed: false };
  }

  private async handleWaitForReply(args: unknown, signal?: AbortSignal): Promise<any> {
    const {
      chatIdentifier,
      threadSlug,
      timeoutSeconds,
      pollIntervalSeconds,
      afterMessageId,
      includeSelf,
    } = WaitForReplySchema.parse(args);

    if (!chatIdentifier && !threadSlug) {
      return toolError("Either chatIdentifier or threadSlug is required.", {});
    }

    const timeoutMs = timeoutSeconds * 1000;
    const pollIntervalMs = pollIntervalSeconds * 1000;
    const startTime = Date.now();

    let chat: Awaited<ReturnType<typeof this.db.findChatByHandle>>;
    if (threadSlug) {
      const slugRecord = this.db.getSlugRecord(threadSlug);
      if (!slugRecord) {
        return toolError(`Unknown thread slug: ${threadSlug}`, { threadSlug });
      }
      chat = await this.db.findChatByHandle(slugRecord.chatIdentifier);
    } else {
      chat = await this.db.findChatByHandle(chatIdentifier!);
    }
    if (!chat) {
      return toolError(`Could not find conversation for: ${threadSlug || chatIdentifier}`, {
        threadSlug,
        chatIdentifier,
      });
    }

    // Get the current last message ID if not provided
    let lastKnownId = afterMessageId;
    if (!lastKnownId) {
      const lastMsg = await this.db.getLastMessage(chat.chatIdentifier);
      lastKnownId = lastMsg?.id || 0;
    }

    // Canonical thread key — must match what handleSendMessage registered.
    const chatKey = chat.threadSlug ?? chat.chatIdentifier;

    // Event-driven wake: subscribe to the shared change stream so a chat.db
    // write ends the wait immediately instead of on the next poll tick. The
    // AUTHORITATIVE read stays getMessagesAfter below (cursor semantics, the
    // 1-2s chat.db write-lag tolerance, and echo suppression are unchanged) —
    // the bus only wakes the loop, and any conversation's write may wake it
    // (the scoped delta read is cheap). pollIntervalSeconds is now the
    // FALLBACK cadence for when watch events are missed or unavailable.
    const { bus } = this.ensureChangeStream();
    let busWake: (() => void) | null = null;
    let busPending = false;
    const unsubscribeBus = bus.subscribe(() => {
      busPending = true;
      busWake?.();
    });

    try {
      // Poll for new messages — bail out early on cancellation
      while (Date.now() - startTime < timeoutMs) {
        if (signal?.aborted) {
          return toolError(
            `Cancelled by client after ${Math.round((Date.now() - startTime) / 1000)}s`,
            {
              cancelled: true,
              elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
            },
          );
        }
        const newMessages = await this.db.getMessagesAfter(chat.chatIdentifier, lastKnownId, {
          includeSelf,
        });
        // In includeSelf mode, drop this process's own send echoes — a from-me
        // row is only a genuine interjection if the registry doesn't claim it.
        const visible = includeSelf
          ? newMessages.filter((m) => !m.isFromMe || !this.sentEchoes.consume(chatKey, m))
          : newMessages;

        if (visible.length > 0) {
          const selfCount = visible.filter((m) => m.isFromMe).length;
          const header =
            selfCount > 0
              ? `Received ${visible.length} new message(s) — ${selfCount} sent by the user from their own account (another device), ${visible.length - selfCount} from the other party:`
              : `Received ${visible.length} new message(s):`;
          const formatted = visible.map((m) => formatMessage(m)).join("\n");
          const humansHint = this.humansIndex.hintFor(chat.participants);
          const humansLine = humansHint ? humansHintText(humansHint) : "";
          return toolText(`${header}\n\n${formatted}${humansLine}`, {
            received: true,
            messages: visible.map(messageToStructured),
            count: visible.length,
            selfCount,
            ...(humansHint ? { humans: humansHint } : {}),
          });
        }
        if (newMessages.length > 0) {
          // Everything new was our own echo — advance the cursor past it so
          // subsequent polls stay cheap (the echo row is a real row in
          // (date, ROWID) order).
          lastKnownId = newMessages[newMessages.length - 1].id;
        }

        if (busPending) {
          // A write landed while we were reading — re-poll immediately.
          busPending = false;
          continue;
        }
        // Wait for: a bus wake (instant), the fallback poll tick, or abort —
        // whichever comes first. Mirrors sleep()'s abort semantics: resolve
        // promptly and let the loop-top check produce the cancel result.
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            busWake = null;
            resolve();
          };
          const timer = setTimeout(done, pollIntervalMs);
          busWake = done;
          signal?.addEventListener("abort", done, { once: true });
        });
        busPending = false;
      }
    } finally {
      unsubscribeBus();
      busWake = null;
    }

    // Timeout reached
    return toolText(
      `Timeout reached (${timeoutSeconds}s) - no new messages received in conversation with ${threadSlug || chatIdentifier}`,
      {
        received: false,
        timedOut: true,
        timeoutSeconds,
        threadSlug,
        chatIdentifier: chat.chatIdentifier,
      },
    );
  }

  /**
   * Lazily construct the shared change stream: one EventBus fed by one WAL
   * ChangeWatcher, reusing this server's IMessageDB (one parser, N callers).
   * Armed on FIRST use rather than at startup — most sessions never long-poll,
   * so we don't pay for an fs.watch on ~/Library/Messages (or the high-water
   * seed query) until a tool actually needs the stream. The watcher's stop()
   * is registered with the shutdown cleanup registry; if fs.watch is
   * unavailable the watcher degrades to its built-in slow-poll fallback and
   * never throws into the handler.
   */
  private ensureChangeStream(): { bus: EventBus; watcher: ChangeWatcher } {
    if (this.changeBus && this.changeWatcher) {
      return { bus: this.changeBus, watcher: this.changeWatcher };
    }
    const bus = new EventBus();
    const watcher = new ChangeWatcher({ dbPath: getImsgDbPath(), db: this.db, bus });
    watcher.start();
    registerCleanup(() => watcher.stop());
    this.changeBus = bus;
    this.changeWatcher = watcher;
    return { bus, watcher };
  }

  /**
   * Long-poll the change stream for typed events. Unlike wait_for_reply there
   * is no cursor and no echo suppression — this is the raw event feed,
   * optionally filtered to one merged conversation and/or event types.
   * Semantics: without maxEvents, return on the first batch containing a
   * matching event; with maxEvents, keep collecting until that many arrived
   * (a timeout returns the partial set). A quiet timeout is a clean
   * non-error result.
   */
  private async handleWaitForChanges(args: unknown, signal?: AbortSignal): Promise<any> {
    const { chatIdentifier, threadSlug, types, timeoutSeconds, maxEvents } =
      WaitForChangesSchema.parse(args ?? {});

    // Optional conversation filter — resolved exactly like wait_for_reply.
    let chat: Awaited<ReturnType<typeof this.db.findChatByHandle>> = null;
    if (threadSlug) {
      const slugRecord = this.db.getSlugRecord(threadSlug);
      if (!slugRecord) {
        return toolError(`Unknown thread slug: ${threadSlug}`, { threadSlug });
      }
      chat = await this.db.findChatByHandle(slugRecord.chatIdentifier);
    } else if (chatIdentifier) {
      chat = await this.db.findChatByHandle(chatIdentifier);
    }
    if ((threadSlug || chatIdentifier) && !chat) {
      return toolError(`Could not find conversation for: ${threadSlug || chatIdentifier}`, {
        threadSlug,
        chatIdentifier,
      });
    }

    const { bus, watcher } = this.ensureChangeStream();
    const wanted = new Set<string>(types);
    const startTime = Date.now();

    // Merge-aware conversation match: an event belongs to the monitored
    // thread when its chat_identifier maps to the same per-identity slug
    // (covers the phone/email/SMS/iMessage legs of one contact — see
    // docs/CONTACT_MERGE_AND_SLUGS.md), or equals the resolved identifier.
    const matchesChat = (event: ChangeEvent): boolean => {
      if (!chat) return true;
      if (!("message" in event)) return false; // group.* events carry no message (reserved)
      const eventChatId = event.message.chatId;
      if (eventChatId === chat.chatIdentifier) return true;
      if (!eventChatId) return false;
      const slug = this.db.getSlugForChatIdentifier(eventChatId);
      return slug !== null && slug === chat.threadSlug;
    };

    const collected: ChangeEvent[] = [];
    const target = maxEvents ?? 1;
    // Object property (not a bare `let`): the mutations happen inside the
    // subscriber/abort closures, which TS's flow analysis can't track.
    const outcome = { cause: "timeout" as "events" | "timeout" | "abort" };

    await new Promise<void>((resolve) => {
      let finished = false;
      let unsubscribe: () => void = () => {};
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        resolve();
      };
      const onAbort = () => {
        outcome.cause = "abort";
        finish();
      };
      const timer = setTimeout(finish, timeoutSeconds * 1000);
      unsubscribe = bus.subscribe((events) => {
        for (const event of events) {
          if (!wanted.has(event.type) || !matchesChat(event)) continue;
          collected.push(event);
          if (maxEvents !== undefined && collected.length >= maxEvents) break;
        }
        if (collected.length >= target) {
          outcome.cause = "events";
          finish();
        }
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });

    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
    if (outcome.cause === "abort") {
      return toolError(`Cancelled by client after ${elapsedSeconds}s`, {
        cancelled: true,
        elapsedSeconds,
      });
    }

    const watcherMode = watcher.isPolling() ? ("poll" as const) : ("fs-watch" as const);
    const scope = chat ? { threadSlug: chat.threadSlug, chatIdentifier: chat.chatIdentifier } : {};
    const scopeLabel = chat ? ` in conversation ${chat.threadSlug ?? chat.chatIdentifier}` : "";

    if (collected.length === 0) {
      return toolText(`No changes within ${timeoutSeconds}s${scopeLabel}.`, {
        events: [],
        count: 0,
        timedOut: true,
        timeoutSeconds,
        ...scope,
        watcherMode,
      });
    }

    const structuredEvents = collected.map((event) =>
      "message" in event
        ? { type: event.type, message: messageToStructured(event.message) }
        : { type: event.type, chatIdentifier: event.chatIdentifier },
    );
    const partial = outcome.cause === "timeout";
    const header = `Received ${collected.length} change event(s)${scopeLabel}${
      partial ? ` (timeout after ${timeoutSeconds}s before maxEvents=${maxEvents} arrived)` : ""
    }:`;
    const lines = collected
      .map((event) =>
        "message" in event ? `[${event.type}] ${formatMessage(event.message)}` : `[${event.type}]`,
      )
      .join("\n");
    return toolText(`${header}\n\n${lines}`, {
      events: structuredEvents,
      count: collected.length,
      ...(partial ? { timedOut: true, timeoutSeconds } : {}),
      ...scope,
      watcherMode,
    });
  }

  private async handleListConversations(args: unknown) {
    const { limit, offset } = ListConversationsSchema.parse(args);
    // Sane upper cap on `0 = unlimited` PER PAGE. A user with 5000+ chats sees
    // each conversation row serialise to ~400 bytes of JSON, so an unbounded
    // response hit ~1.8MB — well past most MCP host token caps. 500 keeps a
    // page under ~200KB; `offset` + `nextOffset` let callers reach the rest.
    const HARD_CAP = 500;
    const resolvedLimit = Math.min(resolveLimit(limit), HARD_CAP);
    const startAfter = offset + resolvedLimit;
    // Fetch one page past the offset (+1 to detect more) and slice the window.
    const limited = await this.db.listConversations(startAfter + 1);
    const hasMore = limited.length > startAfter;
    const results = limited.slice(offset, startAfter);

    if (results.length === 0) {
      return toolText("No conversations found.", {
        conversations: [],
        count: 0,
        hasMore: false,
        truncated: false,
        nextOffset: null,
      });
    }

    const formatted = results
      .map((conv) => {
        const slug = conv.threadSlug ?? conv.chatIdentifier;
        let name = conv.displayName || conv.chatIdentifier;
        // For group chats without a display name, show resolved participant names
        if (conv.isGroupChat && !conv.displayName) {
          const resolved = this.db.resolveParticipantNames(conv.participants);
          const names = resolved.filter((n, i) => n !== conv.participants[i]);
          if (names.length > 0) {
            name =
              names.length <= 3
                ? names.join(", ")
                : `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
          }
        }
        const ident =
          conv.displayName && conv.displayName !== conv.rawIdentifier
            ? ` (${conv.rawIdentifier})`
            : "";
        const svc = conv.serviceType === "SMS" ? " [SMS]" : "";
        const group = conv.isGroupChat ? " [Group]" : "";
        const lastDate = conv.lastMessageDate ? ` - ${relativeDate(conv.lastMessageDate)}` : "";
        let snippetText = conv.lastMessageSnippet;
        if (snippetText) {
          snippetText = sanitizeUserText(snippetText);
        }
        const snippet = snippetText
          ? ` - "${wrapUntrusted(snippetText.length > 50 ? `${snippetText.slice(0, 47)}...` : snippetText)}"`
          : "";
        const unread = conv.unreadCount > 0 ? ` [${conv.unreadCount} unread]` : "";
        return `• [${slug}] ${name}${ident}${svc}${group}${lastDate}${snippet}${unread}`;
      })
      .join("\n");

    return toolText(`Found ${results.length} conversation(s):\n\n${formatted}`, {
      conversations: results.map((conversation) => {
        const humanFiles = this.humansIndex.lookup(conversation.participants).map((f) => f.path);
        return {
          ...conversation,
          lastMessageDate: conversation.lastMessageDate?.toISOString() ?? null,
          lastMessageSnippet: sanitizeUserText(conversation.lastMessageSnippet),
          ...(humanFiles.length > 0 ? { humansFiles: humanFiles } : {}),
        };
      }),
      count: results.length,
      hasMore,
      truncated: hasMore,
      nextOffset: hasMore ? startAfter : null,
    });
  }

  private async handleSearchMessages(args: unknown) {
    const { query, limit, mode, minScore } = SearchMessagesSchema.parse(args);
    const resolvedLimit = resolveLimit(limit);

    // Fuzzy mode: pull a wider candidate set via LIKE on individual tokens
    // (so the DB doesn't return the entire history), then score+rank in TS.
    // Pure LIKE for literal mode.
    const SOFT_CAP = 10_000;
    let messages: Message[];
    let softCapWarning: string | undefined;
    if (mode === "fuzzy") {
      const candidates = await this.db.searchMessages(query, SOFT_CAP);
      const ranked = rankFuzzy(query, candidates, (m) => m.text ?? "", minScore);
      messages = ranked.slice(0, resolvedLimit + 1).map((r) => r.item);
      if (candidates.length >= SOFT_CAP) {
        softCapWarning = `Candidate pool capped at ${SOFT_CAP} pre-scoring. Tighten the query for more reliable ranking.`;
      }
    } else {
      messages = await this.db.searchMessages(query, resolvedLimit + 1);
    }

    const hasMore = messages.length > resolvedLimit;
    const results = messages.slice(0, resolvedLimit);

    if (results.length === 0) {
      return toolText(`No messages found matching "${query}".`, {
        query,
        mode,
        messages: [],
        count: 0,
        hasMore: false,
        truncated: false,
        softCapWarning,
      });
    }

    const formatted = results
      .map((msg) => {
        const slug = this.db.getSlugForChatIdentifier(msg.chatId);
        const label = slug ?? msg.chatId;
        return formatMessage(msg, label);
      })
      .join("\n");
    return toolText(`Found ${results.length} message(s) matching "${query}":\n\n${formatted}`, {
      query,
      mode,
      messages: results.map(messageToStructured),
      count: results.length,
      hasMore,
      truncated: hasMore,
      softCapWarning,
    });
  }

  // ── Contact tools ──────────────────────────────────────────────────────

  private async handleListContacts(args: unknown) {
    const { limit, offset } = ListContactsSchema.parse(args);
    const resolvedLimit = resolveLimit(limit);
    // Internal cap mirrors get_messages safety bound.
    const SAFETY_CAP = 5_000;
    const effectiveLimit = Math.min(resolvedLimit, SAFETY_CAP);
    const { contacts, total } = this.db.contacts.listContacts(offset, effectiveLimit);
    const hasMore = offset + contacts.length < total;

    if (contacts.length === 0) {
      return toolText(`No contacts found${offset > 0 ? ` (offset ${offset})` : ""}.`, {
        contacts: [],
        count: 0,
        hasMore: false,
        truncated: false,
        totalAvailable: total,
        totalCount: total,
      });
    }

    const formatted = contacts
      .map((c) => {
        const phones = c.phoneNumbers.length > 0 ? ` 📱 ${c.phoneNumbers.join(", ")}` : "";
        const emails = c.emails.length > 0 ? ` ✉ ${c.emails.join(", ")}` : "";
        return `• ${sanitizeUserText(c.displayName)}${phones}${emails}`;
      })
      .join("\n");
    return toolText(`Showing ${contacts.length} of ${total} contact(s):\n\n${formatted}`, {
      contacts,
      count: contacts.length,
      hasMore,
      truncated: hasMore,
      totalAvailable: total,
      totalCount: total,
    });
  }

  private async handleSearchContacts(args: unknown) {
    const { query, limit } = SearchContactsSchema.parse(args);
    // 1000 hard cap on `limit:0`. A pathological broad query (e.g. "")
    // matching every contact would otherwise serialise the entire
    // address book into the response — same UX failure as the
    // unbounded list_conversations path.
    const HARD_CAP = 1_000;
    const resolvedLimit = Math.min(resolveLimit(limit), HARD_CAP);
    // Ranked best-first (score + which field matched) so close matches are
    // disambiguated instead of returned in address-book order.
    const ranked = this.db.contacts.searchContactsRanked(query);
    const results = ranked.slice(0, resolvedLimit);

    if (results.length === 0) {
      return toolText(`No contacts match "${query}".`, {
        query,
        contacts: [],
        count: 0,
        truncated: false,
        totalAvailable: 0,
      });
    }

    // Remember this result set so the next call can re-select by `contact:N`.
    // Use the first phone or email as the canonical "handle" for the selector.
    rememberSearch(
      query,
      results.map((m) => ({
        handle: m.contact.phoneNumbers[0] ?? m.contact.emails[0] ?? m.contact.displayName,
        displayName: m.contact.displayName,
      })),
    );

    const formatted = results
      .map((m, i) => {
        const c = m.contact;
        const phones = c.phoneNumbers.length > 0 ? ` 📱 ${c.phoneNumbers.join(", ")}` : "";
        const emails = c.emails.length > 0 ? ` ✉ ${c.emails.join(", ")}` : "";
        const why = ` — ${m.matchedField} ${m.score.toFixed(2)}`;
        return `[contact:${i + 1}] ${sanitizeUserText(c.displayName)}${why}${phones}${emails}`;
      })
      .join("\n");
    const hint =
      results.length > 1
        ? `\n\nRe-select by index in any contact-accepting tool: handle: "contact:1" … "contact:${results.length}".`
        : "";
    return toolText(
      `Found ${results.length} contact(s) matching "${query}":\n\n${formatted}${hint}`,
      {
        query,
        contacts: results.map((m) => ({
          ...m.contact,
          score: m.score,
          matchedField: m.matchedField,
        })),
        count: results.length,
        truncated: ranked.length > results.length,
        totalAvailable: ranked.length,
      },
    );
  }

  private async handleGetContact(args: unknown) {
    const { handle, id } = GetContactSchema.parse(args);
    let contact = null;
    if (handle !== undefined) {
      const selectorHit = resolveContactSelector(handle);
      const effectiveHandle = selectorHit?.handle ?? handle;
      const lookup = this.db.contacts.lookupContact(effectiveHandle);
      contact = lookup ? this.db.contacts.getContact(lookup.contactId) : null;
    } else if (id !== undefined) {
      contact = this.db.contacts.getContact(id);
    }
    if (!contact) {
      return toolText("Contact not found.", { contact: null, threads: [] });
    }
    const phones =
      contact.phoneNumbers.length > 0 ? `\nPhones: ${contact.phoneNumbers.join(", ")}` : "";
    const emails = contact.emails.length > 0 ? `\nEmails: ${contact.emails.join(", ")}` : "";
    const org = contact.organization ? `\nOrganization: ${contact.organization}` : "";

    // Contact → conversations: map each handle to its thread slug so agents can
    // go straight from a contact search to send_message/get_messages. Resolved
    // guid-level via findChatByHandle so every leg of a merged identity reports
    // the canonical slug (identifier-level lookup misses email legs). Cards
    // often store phones in local format ("0408 315 498") while chat
    // identifiers are E.164 — try each normalized variant until one matches.
    const resolveThreadSlug = async (handle: string): Promise<string | null> => {
      const candidates = handle.includes("@") ? [handle] : normalizedPhoneVariants(handle);
      for (const candidate of candidates) {
        const conv = await this.db.findChatByHandle(candidate);
        if (conv?.threadSlug) return conv.threadSlug;
      }
      return null;
    };
    const threads = await Promise.all(
      [...contact.phoneNumbers, ...contact.emails].map(async (h) => ({
        handle: h,
        threadSlug: await resolveThreadSlug(h),
      })),
    );
    const withThreads = threads.filter((t) => t.threadSlug);
    const threadLines =
      withThreads.length > 0
        ? `\nThreads:\n${withThreads.map((t) => `  ${t.handle} → ${t.threadSlug}`).join("\n")}`
        : "";

    const humansHint = this.humansIndex.hintFor([...contact.phoneNumbers, ...contact.emails]);
    const humansFile = humansHint?.files[0]?.path ?? null;
    const humansLine = humansHint ? humansHintText(humansHint) : `\n\n_${HUMANS_INIT_HINT}_`;

    const identity = buildIdentity(
      contact.displayName,
      contact.phoneNumbers,
      contact.emails,
      defaultCountryFromEnv(),
    );

    return toolText(
      `${sanitizeUserText(contact.displayName)} (id ${contact.id})${phones}${emails}${org}${threadLines}${humansLine}`,
      {
        contact,
        identity,
        threads,
        humansFile,
        humansGuidance: humansHint?.guidance ?? HUMANS_INIT_HINT,
      },
    );
  }

  private async handleResolveConversation(args: unknown) {
    const { query, limit } = ResolveConversationSchema.parse(args);
    const HARD_CAP = 50;
    const resolvedLimit = Math.min(resolveLimit(limit) || HARD_CAP, HARD_CAP);
    const matches = await this.db.resolveConversation(query, resolvedLimit);

    const structured = {
      query,
      matches: matches.map((m) => ({
        name: sanitizeUserText(m.name),
        threadSlug: m.threadSlug,
        chatIdentifier: m.chatIdentifier,
        lastMessageDate: m.lastMessageDate?.toISOString() ?? null,
        matchType: m.matchType,
        score: Math.round(m.score * 1000) / 1000,
      })),
      count: matches.length,
    };

    if (matches.length === 0) {
      return toolText(
        `No conversation matches "${query}". Try search_contacts for a broader name search.`,
        structured,
      );
    }

    const TYPE_LABEL: Record<string, string> = {
      contact: "contact",
      thread: "thread",
      message: "message match",
    };
    const lines = matches
      .map((m, i) => {
        const when = m.lastMessageDate ? ` · last ${relativeDate(m.lastMessageDate)}` : "";
        const slug = m.threadSlug ? ` [${m.threadSlug}]` : ` (${m.chatIdentifier})`;
        return `[${i + 1}] ${sanitizeUserText(m.name)}${slug} — ${TYPE_LABEL[m.matchType]}${when}`;
      })
      .join("\n");
    const top = matches[0];
    const hint = top.threadSlug
      ? `\n\nBest match: send with threadSlug "${top.threadSlug}", or read with get_messages chatIdentifier "${top.chatIdentifier}".`
      : `\n\nBest match: read with get_messages chatIdentifier "${top.chatIdentifier}".`;
    return toolText(
      `Resolved "${query}" to ${matches.length} conversation(s):\n\n${lines}${hint}`,
      structured,
    );
  }

  private async handleResolveHandle(args: unknown) {
    const { handle } = ResolveHandleSchema.parse(args);
    const selectorHit = resolveContactSelector(handle);
    const effectiveHandle = selectorHit?.handle ?? handle;
    const lookup = this.db.contacts.lookupContact(effectiveHandle);
    const country = defaultCountryFromEnv();
    if (lookup) {
      // Prefer the full contact's handles; fall back to the single input handle.
      const contact = this.db.contacts.getContact(lookup.contactId);
      const identity = contact
        ? buildIdentity(contact.displayName, contact.phoneNumbers, contact.emails, country)
        : buildIdentityFromHandle(effectiveHandle, lookup.displayName, country);
      return toolText(`${handle} → ${sanitizeUserText(lookup.displayName)}`, {
        handle,
        displayName: lookup.displayName,
        contactId: lookup.contactId,
        label: lookup.label ?? null,
        resolved: true,
        identity,
      });
    }
    return toolText(`No contact for ${handle}.`, {
      handle,
      displayName: handle,
      contactId: null,
      label: null,
      resolved: false,
      identity: buildIdentityFromHandle(effectiveHandle, null, country),
    });
  }

  private async handleCheckImessageAvailability(args: unknown) {
    const { handle } = CheckImessageAvailabilitySchema.parse(args);
    const selectorHit = resolveContactSelector(handle);
    const effectiveHandle = selectorHit?.handle ?? handle;

    // DB-first: an existing conversation is authoritative for both
    // reachability and service — messages have actually flowed on it. The
    // AppleScript probe below can't distinguish services (Messages.app's
    // buddy resolution is lazy and reports iMessage for any well-formed
    // handle), so it's only a best-effort fallback for never-messaged handles.
    const existingChat = await this.db.findChatByHandle(effectiveHandle);
    if (existingChat && !existingChat.isGroupChat) {
      const service = existingChat.serviceType === "SMS" ? "SMS" : "iMessage";
      return toolText(`${handle} reachable via ${service} (existing conversation).`, {
        handle,
        service,
        reachable: true,
        hint: "Derived from existing conversation history — authoritative. send_message will route on this service.",
      });
    }

    const result = await checkImessageAvailability(effectiveHandle);
    const text = result.reachable
      ? `${handle} reachable via ${result.service} (best-effort probe — no conversation history for this handle; Messages.app cannot verify iMessage registration without sending).`
      : `${handle} not reachable. ${result.hint ?? ""}`.trim();
    return toolText(text, {
      handle,
      service: result.service,
      reachable: result.reachable,
      hint: result.hint,
    });
  }

  private async handleSearchAttachments(args: unknown) {
    const { mimePrefix, chatIdentifier, since, until, limit } = SearchAttachmentsSchema.parse(args);
    const sinceMs = since ? parseUserDate(since)?.getTime() : undefined;
    const untilMs = until ? parseUserDate(until)?.getTime() : undefined;
    const resolvedLimit = resolveLimit(limit);
    // Over-fetch one row (when bounded) so we can honestly report `truncated`
    // without a second COUNT query. limit:0 → UNLIMITED, so nothing is cut.
    const bounded = resolvedLimit < Number.MAX_SAFE_INTEGER;
    const opts: Parameters<typeof this.db.searchAttachments>[0] = {
      limit: bounded ? resolvedLimit + 1 : resolvedLimit,
    };
    if (mimePrefix !== undefined) opts.mimePrefix = mimePrefix;
    if (chatIdentifier !== undefined) opts.chatIdentifier = chatIdentifier;
    if (sinceMs !== undefined) opts.sinceMs = sinceMs;
    if (untilMs !== undefined) opts.untilMs = untilMs;
    const raw = this.db.searchAttachments(opts);
    const truncated = raw.length > resolvedLimit;
    const results = raw.slice(0, resolvedLimit);

    const formatted = results
      .map(
        (a) =>
          `[${a.rowId}] ${a.mimeType ?? "?"} · ${a.totalBytes}B · ${a.createdDate.toISOString().slice(0, 10)} · ${a.transferName ?? a.filename}`,
      )
      .join("\n");
    return toolText(`Found ${results.length} attachment(s):\n\n${formatted}`, {
      attachments: results.map((a) => ({
        rowId: a.rowId,
        filename: a.filename,
        mimeType: a.mimeType,
        transferName: a.transferName,
        totalBytes: a.totalBytes,
        createdDate: a.createdDate.toISOString(),
        chatId: a.chatId,
      })),
      count: results.length,
      truncated,
    });
  }

  private async handleGetAttachment(args: unknown) {
    const { readFileSync } = await import("node:fs");
    const { rowId, inlineMaxBytes, interpret } = GetAttachmentSchema.parse(args);
    const rec = this.db.getAttachmentByRowId(rowId);
    if (!rec) return toolError(`Attachment ROWID ${rowId} not found.`, { rowId });

    const resolvedPath = rec.filename.replace(/^~/, process.env.HOME ?? "~");
    if (!existsSync(resolvedPath)) {
      // Not on disk (transfer_state -1 / purged). Best-effort sync nudge: open
      // the conversation in Messages so it pulls the file from iCloud, then
      // re-check. Honors the `nudge` config; skipped entirely when disabled.
      let sync: EnsureDownloadedResult | undefined;
      const nudge = resolveInterpretConfig().nudge;
      if (nudge.enabled) {
        const info = this.db.getAttachmentDownloadInfo(rowId);
        sync = await ensureAttachmentDownloaded(
          {
            filePath: resolvedPath,
            chatId: info?.chatIdentifier,
            transferState: info?.transferState,
          },
          {
            enabled: nudge.enabled,
            tier2SyncNow: nudge.tier2SyncNow,
            timeoutSeconds: nudge.timeoutSeconds,
          },
        );
      }
      if (!existsSync(resolvedPath)) {
        return toolError(
          sync
            ? `Attachment not downloaded after sync nudge (tier ${sync.tier}): ${resolvedPath}.${
                sync.hint ? ` ${sync.hint}` : ""
              }`
            : `Attachment file does not exist: ${resolvedPath}`,
          { rowId, resolvedPath, sync },
        );
      }
    }

    const stat = statSync(resolvedPath);
    const sizeBytes = stat.size;
    const mime = (rec.mimeType ?? "").toLowerCase();
    const isHeic = mime.includes("heic") || resolvedPath.toLowerCase().endsWith(".heic");
    const isImage = mime.startsWith("image/") || isHeic;
    const isVideo = mime.startsWith("video/");
    const isAudio = mime.startsWith("audio/") || /\.(caf|amr|m4a|mp3|wav|aac)$/i.test(resolvedPath);

    // Inline if small AND not too large to base64-encode (base64 inflates ~33%).
    const inline = isImage && sizeBytes <= inlineMaxBytes;

    let base64: string | undefined;
    let convertedNote: string | undefined;
    let finalMime = rec.mimeType;
    let finalPath = resolvedPath;
    let mediaInfo: string | undefined;
    let transcript: string | undefined;
    let transcriptSource: "local" | "cloud" | undefined;
    // Image/video caption from the vision chain (audio uses transcript above).
    let interpretation: string | undefined;
    let interpretSource: string | undefined;
    let interpretSkipped = false;
    // A real MCP image content block (base64 ≤ ~1MB, ≤1536px) so the MODEL
    // sees the image, not just JSON metadata. Emitted for images (always a
    // downscaled preview, even when the original exceeds inlineMaxBytes) and
    // for videos (QuickLook poster frame).
    let imageBlock: { base64: string; mimeType: string; note?: string } | null = null;

    if (isImage) {
      imageBlock = imageBlockFromFile(resolvedPath);
      if (inline) {
        if (isHeic) {
          // Full-size HEIC → PNG via macOS sips (zero-dep) for the
          // structuredContent.base64 back-compat field.
          try {
            const { execFileSync } = await import("node:child_process");
            const { tmpdir } = await import("node:os");
            const { join: pjoin } = await import("node:path");
            const out = pjoin(tmpdir(), `imsg-att-${rowId}.png`);
            execFileSync("sips", ["-s", "format", "png", resolvedPath, "--out", out], {
              stdio: "ignore",
            });
            finalPath = out;
            finalMime = "image/png";
            convertedNote = "HEIC → PNG via sips";
            base64 = readFileSync(out).toString("base64");
          } catch (e: any) {
            return toolError(`HEIC→PNG conversion failed: ${e.message ?? e}`, { rowId });
          }
        } else {
          base64 = readFileSync(resolvedPath).toString("base64");
        }
      }
    } else if (isVideo) {
      imageBlock = videoPosterFrame(resolvedPath);
      mediaInfo = mediaMetadata(resolvedPath) ?? undefined;
      convertedNote = imageBlock ? "poster frame via QuickLook" : undefined;
    } else if (isAudio) {
      mediaInfo = mediaMetadata(resolvedPath) ?? undefined;
    }

    // Media interpretation via the shared chain (Apple → local → cloud provider).
    // `interpret:false` skips it; `interpret:true` forces it (bypasses the
    // auto-mode gate + cached failures). Results are cached forever.
    if (interpret !== false) {
      const ref = refForAttachment(rec);
      const tooBigAudio = ref?.kind === "audio" && sizeBytes > TRANSCRIBE_MAX_BYTES;
      if (ref && !tooBigAudio) {
        const r = await getInterpretRuntime().service.interpret(ref, {
          force: interpret === true,
        });
        interpretSkipped = r.status === "skipped";
        if (r.status === "done" && r.text) {
          interpretSource = r.source ?? undefined;
          if (ref.kind === "audio") {
            transcript = r.text;
            transcriptSource = transcriptSourceEnum(r.source);
          } else {
            interpretation = r.text;
          }
        }
      }
    }

    // A caption line for image/video, sourced from the vision chain when produced.
    const captionLines = interpretation
      ? [
          "",
          interpretSource?.startsWith("provider:")
            ? "Description (via cloud provider):"
            : "Description:",
          wrapUntrusted(sanitizeUserText(interpretation) ?? ""),
        ]
      : [];

    const lines: string[] = [];
    if (isVideo) {
      lines.push(
        `Video attachment ${rowId} (${sizeBytes}B${mediaInfo ? `, ${mediaInfo}` : ""}).`,
        imageBlock
          ? "Poster frame attached as an image; full video at the path below."
          : "Poster frame unavailable; use the path below.",
        ...captionLines,
        `Path: ${resolvedPath}`,
      );
    } else if (isAudio) {
      lines.push(`Audio attachment ${rowId} (${sizeBytes}B${mediaInfo ? `, ${mediaInfo}` : ""}).`);
      if (transcript) {
        lines.push(
          "",
          transcriptSource === "cloud" ? "Transcript (via cloud provider):" : "Transcript:",
          wrapUntrusted(sanitizeUserText(transcript) ?? ""),
        );
      } else if (interpretSkipped) {
        lines.push(
          "Transcription skipped by the current auto-mode. Pass interpret:true to force it.",
        );
      } else if (detectTranscriber()) {
        lines.push("Transcription produced no text.");
      } else if (getTranscribeCloudConfig()) {
        lines.push("Cloud transcription produced no text.");
      } else {
        lines.push(
          "No transcriber installed — `brew install yap` (macOS 26+) or `brew install sveinbjornt/hear/hear` enables on-device transcription; run `imsg setup --interactive` to add a cloud provider (audio leaves this device).",
        );
      }
      lines.push(`Path: ${resolvedPath}`);
    } else if (inline) {
      lines.push(
        `Attachment ${rowId} (${sizeBytes}B, ${finalMime ?? "?"}) returned inline.`,
        ...captionLines,
      );
    } else if (isImage) {
      lines.push(
        `Attachment ${rowId} too large to inline (${sizeBytes}B > ${inlineMaxBytes}B); a downscaled preview is attached${imageBlock ? "" : " (preview failed)"}. Full file: ${resolvedPath}`,
        ...captionLines,
      );
    } else {
      lines.push(
        `Attachment ${rowId} (${sizeBytes}B, ${finalMime ?? "?"}) — not an inlineable type. Path: ${resolvedPath}`,
      );
    }

    const content: Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    > = [{ type: "text", text: lines.join("\n") }];
    if (imageBlock) {
      content.push({ type: "image", data: imageBlock.base64, mimeType: imageBlock.mimeType });
    }

    return {
      content,
      structuredContent: {
        rowId,
        filename: rec.filename,
        resolvedPath: finalPath,
        mimeType: finalMime,
        totalBytes: sizeBytes,
        inline,
        base64,
        converted: convertedNote,
        mediaInfo,
        transcript,
        transcriptSource,
        interpretation,
        interpretSource,
        imageBlockIncluded: imageBlock != null,
      },
    };
  }

  /**
   * Scaffold humans/v1 relationship file(s). Identity comes from the Address
   * Book; message stats from chat.db across the person's merged legs. Never
   * overwrites. The agent does all summarization afterwards (humans skill).
   */
  private async handleInitHuman(args: unknown) {
    const { contact, threadSlug, top } = InitHumanSchema.parse(args);
    const scaffold = new HumansScaffold();

    interface Target {
      name: string;
      aliases: string[];
      handles: string[];
    }
    const targets: Target[] = [];

    const targetFromHandle = (handle: string, fallbackName?: string): Target => {
      const lookup = this.db.contacts.lookupContact(handle);
      const card = lookup ? this.db.contacts.getContact(lookup.contactId) : null;
      if (card) {
        return {
          name: card.displayName,
          aliases: card.nickname && card.nickname !== card.displayName ? [card.nickname] : [],
          handles: [...card.phoneNumbers, ...card.emails],
        };
      }
      return { name: fallbackName ?? handle, aliases: [], handles: [handle] };
    };

    if (threadSlug) {
      const slugRecord = this.db.getSlugRecord(threadSlug);
      if (!slugRecord) {
        return toolError(`Unknown thread slug: ${threadSlug}`, { threadSlug });
      }
      if (slugRecord.isGroup) {
        return toolError("Humans files are per-person — pick a 1:1 thread (or use contact/top).", {
          threadSlug,
        });
      }
      targets.push(
        targetFromHandle(slugRecord.chatIdentifier, slugRecord.displayName ?? undefined),
      );
    } else if (contact) {
      const selectorHit = resolveContactSelector(contact);
      const resolution = resolveRecipient(selectorHit?.handle ?? contact, {
        contacts: this.db.contacts,
        defaultCountry: defaultCountryFromEnv(),
      });
      if (resolution.kind === "error") {
        return toolError(resolution.message, { contact });
      }
      if (resolution.kind === "ambiguous") {
        const lines = resolution.candidates
          .map((c, i) => `  contact:${i + 1}  ${c.displayName}  →  ${c.handle}`)
          .join("\n");
        return toolError(
          `Ambiguous contact "${contact}" — multiple matches:\n${lines}\n\nCall again with one of the contact:N labels.`,
          { contact, candidates: resolution.candidates },
        );
      }
      targets.push(targetFromHandle(resolution.handle, contact));
    } else if (top !== undefined) {
      // 5-year window, not 1: the score already decays on recency, so the
      // window only needs to be wide enough that long-quiet relationships
      // (the ones most worth a relationship file) still rank at all. Bounded
      // so a decade-deep chat.db doesn't get loaded wholesale into memory.
      const cutoffMs = Date.now() - 5 * 365 * 86_400_000;
      const messages = await this.db.getMessagesInWindow(cutoffMs);
      const { leaderboard } = computeRelationshipLeaderboard(messages);
      for (const entry of leaderboard.slice(0, top)) {
        targets.push(targetFromHandle(entry.handle, entry.contact));
      }
      if (targets.length === 0) {
        return toolError("No ranked relationships found in the last 5 years.", { top });
      }
    }

    const results: Array<{
      slug: string;
      name: string;
      path: string;
      created: boolean;
      messageCount?: number;
    }> = [];
    for (const t of targets) {
      // Stats: any handle resolves to the merged conversation, so take the
      // handle that yields the richest history. Cards store phones in local
      // format ("0408 …") while chats are E.164 — expand variants first.
      let stats = { count: 0, first: null as Date | null, last: null as Date | null };
      for (const h of t.handles) {
        const candidates = h.includes("@") ? [h] : normalizedPhoneVariants(h);
        for (const candidate of candidates) {
          const s = this.db.getChatStats(candidate);
          if (s.count > stats.count) stats = s;
        }
      }
      const r = scaffold.scaffold({
        name: t.name,
        aliases: t.aliases,
        handles: t.handles,
        firstContact: stats.first,
        lastContact: stats.last,
        messageCount: stats.count,
      });
      results.push({ ...r, name: t.name, messageCount: stats.count });
    }

    const lines = results.map(
      (r) =>
        `${r.created ? "created" : "exists "}  ${r.slug}  (${r.name}, ${r.messageCount?.toLocaleString() ?? "?"} msgs)  ${r.path}`,
    );
    lines.push(
      "",
      "Next: export history (export_messages), summarize it YOURSELF into the file's sections, and append a Log entry — see the humans skill. File contents are privacy: never-share.",
    );
    return toolText(lines.join("\n"), {
      results,
      count: results.length,
      humansDir: getHumansDirPath(),
    });
  }

  private async handleChatAnalytics(args: unknown) {
    const { type, windowDays } = ChatAnalyticsSchema.parse(args);
    // year_in_review pins to 365 days regardless of caller; otherwise use the
    // requested window.
    const effectiveDays = type === "year_in_review_wrapped" ? 365 : windowDays;
    const cutoffMs = Date.now() - effectiveDays * 86_400_000;

    // Cache lookup. Key includes effectiveDays + the DB's max message ROWID,
    // so a recent send/receive invalidates the cache.
    const maxRowId = this.db.getMaxMessageRowId();
    const cacheArgs = { type, windowDays: effectiveDays };
    const hit = lookupCache(type, cacheArgs, maxRowId);
    if (hit) {
      return toolText(
        `Cached ${type} (computed at ${new Date(hit.computedAt).toISOString()}).${analyticTextSummary(type, hit.data)}`,
        {
          type,
          windowDays: effectiveDays,
          computedAtIso: new Date(hit.computedAt).toISOString(),
          fromCache: true,
          data: hit.data,
        },
      );
    }

    const messages = await this.db.getMessagesInWindow(cutoffMs);
    const result = dispatchAnalytic(type, messages);
    const computedAtIso = new Date().toISOString();
    storeCache(type, cacheArgs, maxRowId, result.data);

    return toolText(
      `Computed ${type} over ${messages.length} messages in the last ${effectiveDays}d.${analyticTextSummary(type, result.data)}`,
      {
        type,
        windowDays: effectiveDays,
        computedAtIso,
        fromCache: false,
        data: result.data,
      },
    );
  }

  async run(): Promise<void> {
    // Install process lifecycle handlers
    installShutdownHandlers();
    // Not a literal "normal": the cause is whatever the shutdown controller or
    // watchdog recorded (signal:SIGTERM, watchdog:rss_exceeded, stdin_eof, …),
    // falling back to "normal" for a genuine clean exit.
    registerCleanup(() => logShutdown(getShutdownCause()));
    registerCleanup(() => stopHeapMonitor());
    registerCleanup(() => this.db.close());
    enableStdinEofDetection();
    enableOrphanWatchdog();
    installWatchdog();
    logStartup("mcp-server", { engine: engineLabel() });

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    info("iMessage MCP Server running on stdio");
    startHeapMonitor();
    console.error(`iMessage MCP Server running on stdio (logs: ${getLogDirectory()})`);
  }
}

export async function runMcpServer(): Promise<void> {
  // Mirror structured logs to stderr so the MCP host (Claude Desktop, Cursor, …)
  // surfaces them in its own connection log — the TUI never enables this.
  enableStderrLogging();

  // FIRST line, written synchronously to stderr: it appears in the host log even
  // if we die microseconds later. This is the "which build is actually running?"
  // marker — confirm the version here matches the bundle you installed.
  writeStderrLine(
    `[imsg-mcp] boot v${APP_VERSION} · node ${process.version} ${process.arch} · abi ${process.versions.modules} · pid ${process.pid}`,
  );

  try {
    const server = new IMessageMCPServer();
    await server.run();
  } catch (error) {
    // A startup crash (commonly: missing better-sqlite3 native binding, or no
    // Full Disk Access) happens before run()'s handlers are installed. Surface
    // the full stack synchronously so it is never a silent exit again.
    writeStderrLine(
      `[imsg-mcp] fatal during startup: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    try {
      const report = await checkLocalAccess();
      writeStderrLine("");
      writeStderrLine(formatAccessReport(report));
    } catch (secondary) {
      // checkLocalAccess also opens a DB — if the native binding is the problem
      // it throws too. Don't let that mask the primary error above.
      writeStderrLine(
        `[imsg-mcp] (access check unavailable: ${secondary instanceof Error ? secondary.message : String(secondary)})`,
      );
    }
    await shutdown(1);
  }
}
