import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ChatAnalyticsOutputSchema,
  CheckImessageAvailabilityOutputSchema,
  ExportMessagesOutputSchema,
  GetAttachmentOutputSchema,
  GetContactOutputSchema,
  GetConversationEventsOutputSchema,
  GetLastSendErrorOutputSchema,
  GetLogsOutputSchema,
  GetMessagesOutputSchema,
  GetUnreadMessagesOutputSchema,
  HealthCheckOutputSchema,
  InitHumanOutputSchema,
  ListContactsOutputSchema,
  ListConversationsOutputSchema,
  RequestRestartOutputSchema,
  ResolveConversationOutputSchema,
  ResolveHandleOutputSchema,
  RunBuildOutputSchema,
  SearchAttachmentsOutputSchema,
  SearchContactsOutputSchema,
  SearchMessagesOutputSchema,
  SendMessageOutputSchema,
  type ToolName,
  WaitForChangesOutputSchema,
  WaitForReplyOutputSchema,
} from "./mcp-schemas.js";

// Everything schema-shaped lives in ./mcp-schemas.ts but is re-exported here
// so importers keep a single import point.
export * from "./mcp-schemas.js";

export const UNLIMITED = Number.MAX_SAFE_INTEGER;
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

type JsonSchema = Tool["inputSchema"];

const noArgsSchema: JsonSchema = { type: "object", properties: {} };

/**
 * The one impedance mismatch in this file: zod-to-json-schema returns a broad
 * JsonSchema7Type union, while the MCP SDK's Tool["outputSchema"] wants a
 * narrower object shape. The emitted JSON satisfies it at runtime; this is the
 * single documented cast (previously 22 blanket per-line suppressions).
 */
type OutputSchema = Tool["outputSchema"];
const toOutputSchema = (schema: z.ZodType): OutputSchema => zodToJsonSchema(schema) as OutputSchema;

const annotations = {
  read: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  status: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  send: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  export: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  build: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
} satisfies Record<string, ToolAnnotations>;

export const TOOL_TIMEOUTS_MS: Record<string, number> = {
  wait_for_reply: 0,
  wait_for_changes: 0, // long-poll — bounded by its own timeoutSeconds arg
  init_human: 120_000, // top-N path runs a year-window analytic

  run_build: 120_000,
  search_messages: 60_000,
  get_messages: 60_000,
  list_conversations: 60_000,
  get_unread_messages: 60_000,
  send_message: 60_000,
  health_check: 5_000,
  export_messages: 600_000,
  get_logs: 10_000,
  get_last_send_error: 5_000,
  request_restart: 5_000,
  list_contacts: 10_000,
  search_contacts: 10_000,
  get_contact: 5_000,
  resolve_conversation: 10_000,
  resolve_handle: 5_000,
  check_imessage_availability: 10_000,
  search_attachments: 30_000,
  get_attachment: 30_000,
  chat_analytics: 60_000,
};

export function resolveLimit(limit: number | undefined, defaultValue = 20): number {
  if (limit === undefined) return defaultValue;
  if (limit === 0) return UNLIMITED;
  return limit;
}

export const TOOLS: Tool[] = [
  {
    name: "get_messages",
    description:
      "Get recent iMessages. To read ONE conversation, pass chatIdentifier OR threadSlug (get either from list_conversations / resolve_conversation). Omit both ONLY for a global overview: you get an interleaved newest-first timeline spanning ALL conversations (response `scope: \"global\"`), NOT one person's thread. Response footer includes oldestMessageId for beforeMessageId pagination; use export_messages for very large histories. When a humans/v1 relationship file exists for the conversation's participants, the response includes its path and usage guidance (`humans`).",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 20, description: "Number of messages. 0 = unlimited." },
        chatIdentifier: {
          type: "string",
          description:
            "Scope to one conversation by phone number, email, or chat ID. Omit (with no threadSlug) for the global cross-conversation timeline.",
        },
        threadSlug: {
          type: "string",
          description: "Scope to one conversation by thread slug from list_conversations.",
        },
        beforeMessageId: {
          type: "number",
          description: "Fetch messages older than this message id",
        },
      },
    },
    outputSchema: toOutputSchema(GetMessagesOutputSchema),
  },
  {
    name: "export_messages",
    description:
      "Stream-export a conversation to markdown, csv, json, or ndjson without loading all history into memory.",
    annotations: annotations.export,
    inputSchema: {
      type: "object",
      required: ["outputPath"],
      properties: {
        chatIdentifier: { type: "string", description: "Phone number, email, or chat ID" },
        threadSlug: { type: "string", description: "Thread slug from list_conversations" },
        format: {
          type: "string",
          enum: ["markdown", "csv", "json", "ndjson"],
          default: "markdown",
        },
        outputPath: {
          type: "string",
          description: "Absolute output path. Existing files are overwritten.",
        },
        since: { type: "string", description: "Earliest date, ISO or relative" },
        until: { type: "string", description: "Latest date, ISO or relative" },
        pageSize: { type: "number", default: 1000, description: "Internal page size, 100-5000" },
      },
    },
    outputSchema: toOutputSchema(ExportMessagesOutputSchema),
  },
  {
    name: "get_unread_messages",
    description: "Get unread iMessages across all conversations, newest first.",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max unread messages. 0 = unlimited. Default 100." },
      },
    },
    outputSchema: toOutputSchema(GetUnreadMessagesOutputSchema),
  },
  {
    name: "send_message",
    description:
      "Send an iMessage or SMS. Use recipient for 1-on-1 or threadSlug for existing threads, including groups. The response carries honest delivery truth from a bounded post-send chat.db poll: `status` is delivered | failed | pending and `sendMethod` is the pathway actually used — a `pending` status means delivery is UNCONFIRMED, do not assume it landed. Optional `attachments` is an array of absolute file paths sent as follow-up messages (1-on-1 only — Messages.app does not reliably accept file sends to group chats).",
    annotations: annotations.send,
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        recipient: { type: "string", description: "Phone number or email" },
        threadSlug: { type: "string", description: "Thread slug from list_conversations" },
        message: { type: "string", description: "Message text to send" },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: "Optional absolute file paths to send after the text. 1-on-1 only.",
        },
      },
    },
    outputSchema: toOutputSchema(SendMessageOutputSchema),
  },
  {
    name: "wait_for_reply",
    description:
      "Wait for new messages in a conversation until timeout or client cancellation. Returns the other party's replies AND (by default) messages the user sends from their own account on other devices — marked isFromMe: true, counted in selfCount — since the user may be interjecting to address the agent. The agent's own just-sent message never echoes back. Pass includeSelf: false for incoming-only. When a humans/v1 relationship file exists for the participants, the response includes its path and usage guidance (`humans`) — consult it before composing a reply.",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      properties: {
        chatIdentifier: { type: "string", description: "Phone number, email, or chat ID" },
        threadSlug: { type: "string", description: "Thread slug from list_conversations" },
        timeoutSeconds: {
          type: "number",
          default: 300,
          description: "Timeout in seconds, 10-3600",
        },
        pollIntervalSeconds: {
          type: "number",
          default: 10,
          description:
            "Fallback poll cadence in seconds, 5-60 (kept for compatibility). New chat.db writes wake the wait immediately via the change watcher; this only bounds the re-check interval when watch events are missed or unavailable.",
        },
        afterMessageId: { type: "number", description: "Only return messages after this id" },
        includeSelf: {
          type: "boolean",
          default: true,
          description:
            "Also return the user's own messages sent from other devices (the agent's own sends are always excluded). false = incoming-only.",
        },
      },
    },
    outputSchema: toOutputSchema(WaitForReplyOutputSchema),
  },
  {
    name: "wait_for_changes",
    description:
      "Long-poll for typed change events (message.new | reaction) across ALL conversations, or one conversation via threadSlug/chatIdentifier. Push-fed by the chat.db WAL watcher, so events surface within ~1s of the write (slow-poll fallback where fs.watch is unavailable). Without maxEvents, returns as soon as the first matching batch of events arrives; with maxEvents, keeps collecting until that many events were seen (a timeout then returns the partial set). A quiet timeout is a clean non-error result. Unlike wait_for_reply this streams raw events — from-me rows and the agent's own sends included, no echo suppression — so prefer wait_for_reply when awaiting a human answer in one thread.",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      properties: {
        chatIdentifier: {
          type: "string",
          description:
            "Only return events for this conversation (phone, email, or chat ID). Merged-identity aware: other legs of the same contact match too.",
        },
        threadSlug: {
          type: "string",
          description: "Only return events for this conversation (slug from list_conversations).",
        },
        types: {
          type: "array",
          items: { type: "string", enum: ["message.new", "reaction"] },
          description: "Event types to return. Default: every emitted type.",
        },
        timeoutSeconds: {
          type: "number",
          default: 60,
          description: "Give up after this many seconds (1-3600) with a clean empty result.",
        },
        maxEvents: {
          type: "number",
          description:
            "Collect until this many events arrived, then return early. Omit to return on the first matching batch.",
        },
      },
    },
    outputSchema: toOutputSchema(WaitForChangesOutputSchema),
  },
  {
    name: "get_conversation_events",
    description:
      "Group-system events for ONE conversation: renames, members added/removed, people leaving (message-table rows with item_type 1/2/3, which get_messages deliberately filters out). Groups only in practice — a 1:1 thread returns an empty list. Newest first. Handles resolve to contact names; each event carries a ready-made `summary` line.",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      properties: {
        chatIdentifier: {
          type: "string",
          description:
            "Conversation to read events from (phone, email, or raw chat id). Merged-identity aware.",
        },
        threadSlug: {
          type: "string",
          description: "Conversation slug from list_conversations.",
        },
        limit: {
          type: "number",
          description: "Max events to return (default 20). 0 = all.",
        },
      },
    },
    outputSchema: toOutputSchema(GetConversationEventsOutputSchema),
  },
  {
    name: "list_conversations",
    description:
      "List recent conversations (newest first) with thread slugs, snippets, unread counts, participants, and service metadata. Paginate with `offset` + the returned `nextOffset` to page past the per-call cap.",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          default: 20,
          description: "Conversations per page. 0 = as many as fit (capped at 500 per call).",
        },
        offset: {
          type: "number",
          default: 0,
          description: "Skip this many conversations (for pagination; pass the prior nextOffset).",
        },
      },
    },
    outputSchema: toOutputSchema(ListConversationsOutputSchema),
  },
  {
    name: "search_messages",
    description:
      "Search message text across all conversations. Default mode is fuzzy (token-based with typo tolerance + emoji/literal substring); 'literal' = strict LIKE substring.",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", default: 20, description: "Number of results. 0 = unlimited." },
        mode: {
          type: "string",
          enum: ["literal", "fuzzy"],
          default: "fuzzy",
          description:
            "'literal' = SQL LIKE substring match. 'fuzzy' = token-based scoring with typo tolerance plus a raw-substring fast path that matches emoji + punctuation queries verbatim.",
        },
        minScore: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0.6,
          description:
            "Fuzzy mode: minimum normalized score (0-1) for a match to be returned. Lower = more results, more noise. Ignored in literal mode.",
        },
      },
    },
    outputSchema: toOutputSchema(SearchMessagesOutputSchema),
  },
  {
    name: "get_logs",
    description: "Return debug logs from memory, file, or both.",
    annotations: annotations.status,
    inputSchema: {
      type: "object",
      properties: {
        tail: { type: "number", description: "Return last N lines. Default 50." },
        source: { type: "string", enum: ["memory", "file", "all"], description: "Log source" },
      },
    },
    outputSchema: toOutputSchema(GetLogsOutputSchema),
  },
  {
    name: "get_last_send_error",
    description: "Return details for the last send_message failure.",
    annotations: annotations.status,
    inputSchema: noArgsSchema,
    outputSchema: toOutputSchema(GetLastSendErrorOutputSchema),
  },
  {
    name: "run_build",
    description: "Run pnpm build in the project directory and return stdout/stderr.",
    annotations: annotations.build,
    inputSchema: noArgsSchema,
    outputSchema: toOutputSchema(RunBuildOutputSchema),
  },
  {
    name: "request_restart",
    description: "Exit the MCP server process so the client can restart it and load new code.",
    annotations: annotations.build,
    inputSchema: noArgsSchema,
    outputSchema: toOutputSchema(RequestRestartOutputSchema),
  },
  {
    name: "health_check",
    description: "Return in-memory MCP vital signs without touching SQLite.",
    annotations: annotations.status,
    inputSchema: noArgsSchema,
    outputSchema: toOutputSchema(HealthCheckOutputSchema),
  },
  {
    name: "list_contacts",
    description:
      "List loaded contacts (from macOS Address Book + iCloud sources), sorted by name. Use search_contacts for substring matching.",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 20, description: "Max contacts. 0 = unlimited." },
        offset: { type: "number", default: 0, description: "Offset for pagination." },
      },
    },
    outputSchema: toOutputSchema(ListContactsOutputSchema),
  },
  {
    name: "search_contacts",
    description:
      "Substring-match contacts by display name, phone number, or email, ranked best-first (score + matchedField). Response reports `truncated` and `totalAvailable` so you know when more matched than were returned — raise `limit` to widen.",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Substring (case-insensitive for name/email)." },
        limit: { type: "number", default: 20, description: "Max results. 0 = unlimited." },
      },
    },
    outputSchema: toOutputSchema(SearchContactsOutputSchema),
  },
  {
    name: "get_contact",
    description:
      "Fetch a single contact by handle (phone/email) or by numeric id, including each handle's thread slug (for send_message/get_messages) and an `identity` block (canonicalName + E.164-normalized phones + lowercased emails + deduped handles). Returns null if not found. Includes `humansFile` — the path to this person's humans/v1 relationship file if one exists (read it for relationship context; init_human scaffolds one otherwise).",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string", description: "Phone number or email to look up." },
        id: { type: "number", description: "Numeric contact id." },
      },
    },
    outputSchema: toOutputSchema(GetContactOutputSchema),
  },
  {
    name: "resolve_conversation",
    description:
      "Resolve a free-form name or phrase (e.g. \"check Selena's messages\") to ranked conversations in ONE call — fuses contacts, recent-thread names, and message content. Returns `[{name, threadSlug, chatIdentifier, lastMessageDate, matchType, score}]` (strongest first). Use the top match's threadSlug with send_message/wait_for_reply or chatIdentifier with get_messages, instead of chaining search_contacts → get_contact.",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: 'Free-form name/phrase, e.g. "Selena" or "the plumber".',
        },
        limit: { type: "number", default: 10, description: "Max ranked matches. 0 = unlimited." },
      },
    },
    outputSchema: toOutputSchema(ResolveConversationOutputSchema),
  },
  {
    name: "resolve_handle",
    description:
      "Resolve a phone number or email to its contact display name. Pass-through if unknown. Always returns an `identity` block (canonicalName + E.164-normalized phones + lowercased emails + deduped handles) — even for an unknown handle, so you get it in canonical form.",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      required: ["handle"],
      properties: {
        handle: { type: "string", description: "Phone number or email." },
      },
    },
    outputSchema: toOutputSchema(ResolveHandleOutputSchema),
  },
  {
    name: "check_imessage_availability",
    description:
      "Preflight check: is this handle reachable via iMessage or SMS? Authoritative when a conversation with the handle already exists (service comes from chat.db history); best-effort otherwise (Messages.app cannot verify iMessage registration without sending). send_message routes on the same ground truth automatically, so this is mainly useful for never-messaged handles and format validation.",
    annotations: annotations.status,
    inputSchema: {
      type: "object",
      required: ["handle"],
      properties: {
        handle: {
          type: "string",
          description: "Phone number (E.164 preferred) or email to preflight.",
        },
      },
    },
    outputSchema: toOutputSchema(CheckImessageAvailabilityOutputSchema),
  },
  {
    name: "search_attachments",
    description:
      "Search attachments (images, videos, files) by MIME type prefix, date range, and/or chat. Returns metadata only — use get_attachment to fetch bytes. Excludes stickers and Apple plugin payloads. Response reports `truncated` (more matched than returned — raise `limit`).",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      properties: {
        mimePrefix: { type: "string", description: "e.g. 'image/', 'video/', 'application/pdf'." },
        chatIdentifier: { type: "string", description: "Restrict to one chat." },
        since: { type: "string", description: "ISO date or relative ('1 week ago')." },
        until: { type: "string", description: "ISO date or relative." },
        limit: {
          type: "number",
          default: 20,
          description: "Max results. 0 = unlimited (cap 1000).",
        },
      },
    },
    outputSchema: toOutputSchema(SearchAttachmentsOutputSchema),
  },
  {
    name: "get_attachment",
    description:
      "Fetch an attachment by ROWID (from search_attachments or a message's attachments[].rowId). IMAGES: returned as a real MCP image content block (downscaled ≤1536px, HEIC auto-converted) so the model can SEE it — plus full-size base64 in structuredContent when ≤ inlineMaxBytes (default 5MB). VIDEO: QuickLook poster frame as an image block + duration/resolution metadata + file path. AUDIO (voice memos): metadata + file path, and a transcript when a local transcriber (hear, yap, or whisper-cli) is installed on PATH, or via an opt-in OpenAI-compatible cloud endpoint (set IMSG_TRANSCRIBE_PROVIDER + IMSG_TRANSCRIBE_API_KEY — audio leaves the device; local always preferred).",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      required: ["rowId"],
      properties: {
        rowId: { type: "number", description: "Attachment ROWID from search_attachments." },
        inlineMaxBytes: { type: "number", default: 5_000_000, description: "Inline byte cap." },
      },
    },
    outputSchema: toOutputSchema(GetAttachmentOutputSchema),
  },
  {
    name: "chat_analytics",
    description:
      "Compute analytics over your chat history. Pick a `type`: messaging_streaks, double_texts, response_time_stats, daily_heatmap, tapback_summary, year_in_review_wrapped, or relationship_leaderboard (top relationships by volume, reciprocity, and recency). Results are cached at ~/.imsg-mcp/analytics-cache.db keyed on (type, args, MAX(message.rowid)) so subsequent calls without new messages hit cache. 20 additional analytic types are reserved for future versions.",
    annotations: annotations.read,
    inputSchema: {
      type: "object",
      required: ["type"],
      properties: {
        type: {
          type: "string",
          enum: [
            "messaging_streaks",
            "double_texts",
            "response_time_stats",
            "daily_heatmap",
            "tapback_summary",
            "year_in_review_wrapped",
            "relationship_leaderboard",
          ],
        },
        windowDays: {
          type: "number",
          default: 90,
          description: "Days of history to scan (1-3650). year_in_review pins to 365.",
        },
      },
    },
    outputSchema: toOutputSchema(ChatAnalyticsOutputSchema),
  },
  {
    name: "init_human",
    description:
      "Scaffold a humans/v1 relationship file (~/.agents/humans/<person>.md — see the humans skill) for a contact, a thread slug, or the user's top N relationships. Prefills identity (name, aliases, handles) from the Address Book and first/last contact + message counts from chat.db. NEVER overwrites an existing file — returns its path with created: false. The calling agent fills the sections (export_messages → summarize → edit the file directly); the file's contents are privacy: never-share.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        contact: {
          type: "string",
          description: "Contact name, phone, email, or contact:N selector.",
        },
        threadSlug: { type: "string", description: "Thread slug from list_conversations." },
        top: {
          type: "number",
          description: "Scaffold the top N relationships (1-25) by importance.",
        },
      },
    },
    outputSchema: toOutputSchema(InitHumanOutputSchema),
  },
];

// Tools that only make sense when the server is driven by mcp-dev-proxy.ts
// against the repo checkout. End users running `imsg mcp` directly should
// never see these in tools/list.
export const DEV_TOOL_NAMES = new Set<ToolName>([
  "health_check",
  "get_logs",
  "get_last_send_error",
  "run_build",
  "request_restart",
]);

export function isDevMode(): boolean {
  return process.env.IMSG_DEV === "1";
}

export function getActiveTools(): Tool[] {
  if (isDevMode()) return TOOLS;
  return TOOLS.filter((t) => !DEV_TOOL_NAMES.has(t.name as ToolName));
}
