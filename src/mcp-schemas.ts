/**
 * Zod schemas for every MCP tool's input and output, plus the name-keyed
 * TOOL_SCHEMAS / OUTPUT_SCHEMAS lookup maps. Pure data — no runtime logic.
 * Tool metadata (the TOOLS array, timeouts, annotations, dev gating) lives in
 * ./mcp-tools.ts, which re-exports this module so existing importers keep a
 * single import point.
 */
import { z } from "zod";

const nonEmptyString = (description: string) => z.string().trim().min(1).describe(description);

export const ReactionSchema = z.object({
  type: z.string(),
  emoji: z.string().optional(),
  fromHandle: z.string(),
  isRemoval: z.boolean(),
  targetMessageGuid: z.string(),
  targetMessagePart: z.number().int(),
});

export const ReplyContextSchema = z.object({
  replyToGuid: z.string(),
  replyToText: z.string().nullable().optional(),
});

export const AttachmentSchema = z.object({
  rowId: z.number().int().optional().describe("Feed to get_attachment to fetch/view the file."),
  filename: z.string(),
  mimeType: z.string().nullable(),
  transferName: z.string().nullable(),
  totalBytes: z.number().int(),
});

export const MessageSchema = z.object({
  id: z.number().int(),
  guid: z.string(),
  text: z.string().nullable(),
  handle: z.string(),
  displayName: z.string().optional(),
  isFromMe: z.boolean(),
  date: z.string(),
  dateRead: z.string().nullable(),
  dateDelivered: z.string().nullable(),
  isRead: z.boolean(),
  isDelivered: z.boolean(),
  sendError: z
    .number()
    .int()
    .optional()
    .describe("Non-zero chat.db error code — this from-me message FAILED to send."),
  chatId: z.string(),
  service: z.enum(["iMessage", "SMS"]),
  isReaction: z.boolean(),
  reaction: ReactionSchema.optional(),
  isReply: z.boolean(),
  replyTo: ReplyContextSchema.optional(),
  reactions: z.array(ReactionSchema).optional(),
  richContentType: z.string().optional(),
  richContentSummary: z.string().optional(),
  isEdited: z.boolean(),
  isRetracted: z.boolean(),
  appleAudioTranscript: z
    .string()
    .optional()
    .describe("iOS-synced voice-note transcript (instant, on-device) when present."),
  interpretedMedia: z
    .object({
      kind: z.enum(["audio", "image", "video"]),
      text: z.string(),
      source: z.string(),
    })
    .optional()
    .describe(
      "Inline media interpretation (voice-note transcript / caption) from a cached or instant result — never a blocking cloud call.",
    ),
  hasAttachments: z.boolean(),
  attachments: z.array(AttachmentSchema).optional(),
});

export const ConversationSchema = z.object({
  chatId: z.string(),
  chatIdentifier: z.string(),
  displayName: z.string().nullable(),
  rawIdentifier: z.string(),
  participants: z.array(z.string()),
  lastMessageDate: z.string().nullable(),
  lastMessageSnippet: z.string().nullable(),
  unreadCount: z.number().int(),
  threadSlug: z.string(),
  isGroupChat: z.boolean(),
  serviceType: z.enum(["iMessage", "SMS"]),
  humansFiles: z
    .array(z.string())
    .optional()
    .describe(
      "Paths to humans/v1 relationship files for participants of this conversation, when they exist. Read for context; see skills/humans/SKILL.md.",
    ),
});

/** Agent-facing pointer to humans/v1 relationship files (skills/humans/SKILL.md). */
export const HumansHintSchema = z.object({
  files: z.array(
    z.object({
      handle: z.string(),
      name: z.string(),
      path: z.string(),
    }),
  ),
  guidance: z.string(),
});

export const GetMessagesSchema = z.object({
  limit: z
    .number()
    .int()
    .min(0)
    .default(20)
    .describe(
      "Number of messages to retrieve. 0 = unlimited (bounded by tool safety limits). Default 20.",
    ),
  chatIdentifier: nonEmptyString("Phone number, email, or chat ID to filter by").optional(),
  threadSlug: nonEmptyString("Thread slug from list_conversations").optional(),
  beforeMessageId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Pagination cursor. Pass `oldestMessageId` from a previous response."),
});

export const GetMessagesOutputSchema = z.object({
  messages: z.array(MessageSchema),
  count: z.number().int(),
  hasMore: z.boolean(),
  scope: z
    .enum(["conversation", "global"])
    .optional()
    .describe(
      "`conversation` = messages from the single thread you scoped by chatIdentifier/threadSlug. `global` = an interleaved newest-first feed across ALL conversations (returned when neither was passed).",
    ),
  oldestMessageId: z.number().int().optional(),
  humans: HumansHintSchema.optional(),
});

export const ExportMessagesSchema = z.object({
  chatIdentifier: nonEmptyString("Phone number, email, or chat ID").optional(),
  threadSlug: nonEmptyString("Thread slug from list_conversations").optional(),
  format: z.enum(["markdown", "csv", "json", "ndjson"]).default("markdown"),
  outputPath: nonEmptyString(
    "Absolute path. Parent directory must exist; file will be created/overwritten.",
  ),
  since: nonEmptyString("Earliest date, ISO or relative like '1 year ago'").optional(),
  until: nonEmptyString("Latest date, ISO or relative like 'yesterday'").optional(),
  pageSize: z.number().int().min(100).max(5000).default(1000),
  interpret: z
    .boolean()
    .default(false)
    .describe(
      "Actively interpret media during export (transcribe voice notes, caption images/videos) and embed the text. Off by default; already-cached and instant Apple transcripts are ALWAYS embedded regardless. Honors the configured auto-mode + provider chains.",
    ),
  confirmCloudInterpret: z
    .boolean()
    .default(false)
    .describe(
      "Skip the paid-call guard. When `interpret` is true and the export would trigger more than `interpret.exportConfirmThreshold` uncached cloud calls, the tool refuses and reports the count unless this is set.",
    ),
});

export const ExportMessagesOutputSchema = z.object({
  count: z.number().int(),
  sizeBytes: z.number().int(),
  savedTo: z.string(),
  format: z.string(),
  oldest: z.string().nullable(),
  newest: z.string().nullable(),
  durationMs: z.number(),
});

export const GetUnreadMessagesSchema = z.object({
  limit: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Max unread messages. 0 = unlimited. Default 100."),
});

export const GetUnreadMessagesOutputSchema = z.object({
  messages: z.array(MessageSchema),
  count: z.number().int(),
  hasMore: z.boolean(),
  truncated: z
    .boolean()
    .describe(
      "True if more unread messages exist than were returned — raise `limit` to get the rest.",
    ),
});

export const SendMessageSchema = z.object({
  recipient: nonEmptyString("Phone number or email address to send to").optional(),
  threadSlug: nonEmptyString("Thread slug from list_conversations").optional(),
  message: nonEmptyString("Message text to send"),
  attachments: z
    .array(nonEmptyString("Absolute file path to attach"))
    .optional()
    .describe(
      "Absolute file paths to attach. Each is sent in a follow-up AppleScript call after the text. Use sparingly — large files may be silently rate-limited by Messages.app.",
    ),
});

export const SendMessageOutputSchema = z.object({
  success: z.boolean(),
  target: z.string().optional(),
  error: z.string().optional(),
  timestamp: z.string().nullable().optional(),
  threadSlug: z.string().optional(),
  lastMessageId: z.number().int().optional(),
  sendConfirmed: z
    .boolean()
    .optional()
    .describe(
      "True when the sent message was observed in chat.db before returning — lastMessageId then points exactly at the sent message.",
    ),
  attachments: z
    .array(
      z.object({
        path: z.string(),
        success: z.boolean(),
        error: z.string().optional(),
      }),
    )
    .optional(),
});

export const WaitForReplySchema = z.object({
  chatIdentifier: nonEmptyString("Phone number, email, or chat ID to monitor").optional(),
  threadSlug: nonEmptyString("Thread slug from list_conversations to monitor").optional(),
  timeoutSeconds: z.number().min(10).max(3600).default(300),
  pollIntervalSeconds: z.number().min(5).max(60).default(10),
  afterMessageId: z.number().int().positive().optional(),
  includeSelf: z
    .boolean()
    .default(true)
    .describe(
      "Also return messages the user sends from their own account (other devices) — they may be addressing the agent. The agent's own just-sent messages are always excluded. false = incoming-only (legacy behavior).",
    ),
});

export const WaitForReplyOutputSchema = z.object({
  received: z.boolean().optional(),
  messages: z.array(MessageSchema).optional(),
  count: z.number().int().optional(),
  selfCount: z.number().int().optional(),
  humans: HumansHintSchema.optional(),
  timedOut: z.boolean().optional(),
  timeoutSeconds: z.number().optional(),
  threadSlug: z.string().optional(),
  chatIdentifier: z.string().optional(),
  cancelled: z.boolean().optional(),
  elapsedSeconds: z.number().optional(),
});

export const ListConversationsSchema = z.object({
  // Coerce: some MCP hosts serialise numeric tool args as strings.
  limit: z.coerce.number().int().min(0).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ListConversationsOutputSchema = z.object({
  conversations: z.array(ConversationSchema),
  count: z.number().int(),
  hasMore: z.boolean(),
  truncated: z
    .boolean()
    .describe(
      "True if more conversations exist beyond this page — page on with `offset` + `nextOffset`.",
    ),
  nextOffset: z.number().int().nullable(),
});

export const SearchMessagesSchema = z.object({
  query: nonEmptyString("Search query"),
  limit: z.number().int().min(0).default(20),
  mode: z
    .enum(["literal", "fuzzy"])
    .default("fuzzy")
    .describe(
      "Search mode. 'literal' = SQL LIKE substring match. 'fuzzy' = token-based scoring with typo tolerance; ranks by WRatio-style score.",
    ),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe(
      "Fuzzy mode: minimum normalized score (0-1) for a match to be returned. Ignored in literal mode.",
    ),
});

export const SearchMessagesOutputSchema = z.object({
  query: z.string().optional(),
  mode: z.enum(["literal", "fuzzy"]).optional(),
  messages: z.array(MessageSchema),
  count: z.number().int(),
  hasMore: z.boolean(),
  truncated: z
    .boolean()
    .describe("True if more matches exist than were returned — raise `limit` or narrow the query."),
  softCapWarning: z.string().optional(),
});

export const GetLogsSchema = z.object({
  tail: z.number().int().min(1).max(500).optional(),
  source: z.enum(["memory", "file", "all"]).optional(),
});

export const GetLogsOutputSchema = z.object({
  source: z.string(),
  tail: z.number().int(),
  sections: z.array(z.string()),
});

export const RunBuildSchema = z.object({});
export const RunBuildOutputSchema = z.object({
  ok: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});

export const RequestRestartSchema = z.object({});
export const RequestRestartOutputSchema = z.object({
  restartRequested: z.boolean(),
});

export const HealthCheckSchema = z.object({});
export const HealthCheckOutputSchema = z.object({
  status: z.string(),
  issues: z.array(z.string()),
  uptimeMs: z.number(),
  idleMs: z.number(),
  pid: z.number(),
  node: z.string(),
  heapMb: z.number(),
  rssMb: z.number(),
  eventLoopP99Ms: z.number(),
  eventLoopMaxMs: z.number(),
  toolCallCount: z.number(),
  recentErrorCount: z.number(),
  engine: z.string(),
});

export const GetLastSendErrorSchema = z.object({});
export const GetLastSendErrorOutputSchema = z.object({
  lastSendError: z
    .object({
      message: z.string(),
      timestamp: z.string(),
      stderr: z.string().optional(),
      stdout: z.string().optional(),
      code: z.number().optional(),
    })
    .nullable(),
});

// ── Contact tools ────────────────────────────────────────────────────────

export const ContactSchema = z.object({
  id: z.number().int(),
  displayName: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  middleName: z.string().nullable(),
  nickname: z.string().nullable(),
  organization: z.string().nullable(),
  phoneNumbers: z.array(z.string()),
  emails: z.array(z.string()),
});

export const ListContactsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(0)
    .default(20)
    .describe("Max contacts. 0 = unlimited (bounded by safety cap)."),
  offset: z.number().int().min(0).default(0).describe("Offset for pagination."),
});
export const ListContactsOutputSchema = z.object({
  contacts: z.array(ContactSchema),
  count: z.number().int(),
  hasMore: z.boolean(),
  truncated: z
    .boolean()
    .describe("True if more contacts exist beyond this page — page on with `offset`."),
  totalAvailable: z.number().int().describe("Total contacts available across all pages."),
  totalCount: z.number().int().describe("Alias of `totalAvailable` (kept for back-compat)."),
});

/** A contact plus its relevance score + which field matched (search ranking). */
export const RankedContactSchema = ContactSchema.extend({
  score: z.number().describe("Relevance in [0,1]; higher = better. Results are sorted best-first."),
  matchedField: z
    .enum(["displayName", "firstName", "lastName", "nickname", "organization", "phone", "email"])
    .describe("Which contact field the query matched best."),
});

export const SearchContactsSchema = z.object({
  query: nonEmptyString("Substring to match against name, phone, or email."),
  limit: z.number().int().min(0).default(20).describe("Max results. 0 = unlimited."),
});
export const SearchContactsOutputSchema = z.object({
  query: z.string(),
  contacts: z.array(RankedContactSchema),
  count: z.number().int(),
  truncated: z
    .boolean()
    .describe("True if more contacts matched than were returned — raise `limit`."),
  totalAvailable: z.number().int().describe("Total contacts that matched the query."),
});

export const GetContactSchema = z
  .object({
    handle: z.string().optional().describe("Phone number or email to look up."),
    id: z.number().int().optional().describe("Numeric contact id."),
  })
  .refine((v) => v.handle !== undefined || v.id !== undefined, {
    message: "Provide either `handle` or `id`.",
  });
/**
 * A normalized, cross-tool view of a person's reachable handles — phones in
 * E.164 where derivable, emails lowercased, and a deduped union. Attached by
 * the contact-resolving tools so agents key off one consistent shape.
 */
export const IdentitySchema = z.object({
  canonicalName: z.string().describe("Best display name for this person (or the handle itself)."),
  phones: z.array(z.string()).describe("Phone handles, E.164-normalized where derivable."),
  emails: z.array(z.string()).describe("Email handles, trimmed + lowercased."),
  handles: z
    .array(z.string())
    .describe("Every reachable handle, deduped — phones first, then emails."),
});

export const GetContactOutputSchema = z.object({
  contact: ContactSchema.nullable(),
  /** Normalized cross-tool handle view (E.164 phones, lowercased emails). */
  identity: IdentitySchema.optional(),
  /** Per-handle conversation mapping: which thread slug each handle chats under. */
  threads: z.array(
    z.object({
      handle: z.string(),
      threadSlug: z.string().nullable(),
    }),
  ),
  /** Path to this person's humans/v1 relationship file, when one exists. */
  humansFile: z.string().nullable().optional(),
  /** Standing instruction for using (or creating) the relationship file. */
  humansGuidance: z.string().optional(),
});

export const ResolveConversationSchema = z.object({
  query: nonEmptyString('Free-form name/phrase to match, e.g. "Selena" or "the plumber".'),
  limit: z.number().int().min(0).default(10).describe("Max ranked matches. 0 = unlimited."),
});
export const ResolveConversationOutputSchema = z.object({
  query: z.string(),
  matches: z.array(
    z.object({
      name: z.string(),
      threadSlug: z.string().nullable(),
      chatIdentifier: z.string(),
      lastMessageDate: z.string().nullable(),
      matchType: z.enum(["contact", "thread", "message"]),
      score: z.number(),
    }),
  ),
  count: z.number().int(),
});

export const ResolveHandleSchema = z.object({
  handle: nonEmptyString("Phone number or email to resolve to a contact name."),
});
export const ResolveHandleOutputSchema = z.object({
  handle: z.string(),
  displayName: z.string(),
  contactId: z.number().int().nullable(),
  label: z.string().nullable(),
  resolved: z.boolean(),
  /** Normalized cross-tool handle view — populated even when unresolved. */
  identity: IdentitySchema.optional(),
});

export const CheckImessageAvailabilitySchema = z.object({
  handle: nonEmptyString("Phone number or email to preflight-check for reachability."),
});
export const CheckImessageAvailabilityOutputSchema = z.object({
  handle: z.string(),
  service: z.enum(["iMessage", "SMS", "unknown"]),
  reachable: z.boolean(),
  hint: z.string().optional(),
});

export const AttachmentRecordSchema = z.object({
  rowId: z.number().int(),
  filename: z.string(),
  mimeType: z.string().nullable(),
  transferName: z.string().nullable(),
  totalBytes: z.number().int(),
  createdDate: z.string(),
  chatId: z.string(),
});

export const SearchAttachmentsSchema = z.object({
  mimePrefix: z
    .string()
    .optional()
    .describe("Filter by MIME type prefix, e.g. 'image/', 'video/', 'application/pdf'."),
  chatIdentifier: z
    .string()
    .optional()
    .describe("Restrict to a single chat (use chat_identifier from list_conversations)."),
  since: z
    .string()
    .optional()
    .describe("ISO date or relative ('1 week ago'). Lower bound on attachment creation."),
  until: z.string().optional().describe("ISO date or relative. Upper bound on creation."),
  limit: z.number().int().min(0).default(20).describe("Max results. 0 = unlimited."),
});
export const SearchAttachmentsOutputSchema = z.object({
  attachments: z.array(AttachmentRecordSchema),
  count: z.number().int(),
  truncated: z
    .boolean()
    .describe("True if more attachments matched than were returned — raise `limit`."),
});

export const InitHumanSchema = z
  .object({
    contact: nonEmptyString(
      "Contact name, phone, email, or contact:N selector from a prior search_contacts",
    ).optional(),
    threadSlug: nonEmptyString("Thread slug from list_conversations").optional(),
    top: z.coerce
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe(
        "Scaffold files for the user's top N relationships (ranked by the relationship_leaderboard analytic over the last year).",
      ),
  })
  .refine((d) => [d.contact, d.threadSlug, d.top].filter((v) => v !== undefined).length === 1, {
    message: "Provide exactly one of: contact, threadSlug, or top.",
  });

export const InitHumanOutputSchema = z.object({
  results: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      path: z.string(),
      created: z.boolean(),
      messageCount: z.number().int().optional(),
    }),
  ),
  count: z.number().int(),
  humansDir: z.string(),
});

export const ChatAnalyticsSchema = z.object({
  type: z
    .enum([
      "messaging_streaks",
      "double_texts",
      "response_time_stats",
      "daily_heatmap",
      "tapback_summary",
      "year_in_review_wrapped",
      "relationship_leaderboard",
    ])
    .describe(
      "Which analytic to compute. Six priority types are implemented; 20 more are reserved for future versions and return a structured 'not_yet_implemented' error.",
    ),
  windowDays: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(90)
    .describe("Days of history to analyze. Defaults to 90; year_in_review pin to 365 internally."),
});

export const ChatAnalyticsOutputSchema = z.object({
  type: z.string(),
  windowDays: z.number().int(),
  computedAtIso: z.string(),
  fromCache: z.boolean(),
  data: z.unknown(),
});

export const GetAttachmentSchema = z.object({
  rowId: z.number().int().describe("Attachment ROWID (from search_attachments)."),
  inlineMaxBytes: z
    .number()
    .int()
    .default(5_000_000)
    .describe("If file is ≤ this size, return base64 content inline; otherwise return path only."),
  interpret: z
    .boolean()
    .optional()
    .describe(
      "Override media interpretation. `true` forces a run (bypasses the auto-mode gate and any cached failure); `false` skips it; omit for the configured default (honors the `interpret.auto` mode). Interpretation walks the per-media chain (Apple → local → cloud provider) and caches forever.",
    ),
});
export const GetAttachmentOutputSchema = z.object({
  rowId: z.number().int(),
  filename: z.string(),
  resolvedPath: z.string(),
  mimeType: z.string().nullable(),
  totalBytes: z.number().int(),
  inline: z.boolean(),
  base64: z.string().optional(),
  converted: z.string().optional().describe("Set when source was HEIC and we converted to PNG."),
  mediaInfo: z
    .string()
    .optional()
    .describe("Compact duration/dimensions/codec summary for audio/video (via mdls)."),
  transcript: z
    .string()
    .optional()
    .describe(
      "Audio transcript. Local on-device transcriber (hear/yap/whisper-cli) when installed; otherwise the opt-in cloud fallback (IMSG_TRANSCRIBE_PROVIDER + IMSG_TRANSCRIBE_API_KEY) if configured.",
    ),
  transcriptSource: z
    .enum(["local", "cloud"])
    .optional()
    .describe("Where the transcript came from: on-device (local) or the opt-in cloud provider."),
  interpretation: z
    .string()
    .optional()
    .describe("Image/video caption from the media-intel chain (vision provider), when produced."),
  interpretSource: z
    .string()
    .optional()
    .describe("Granular interpretation source: 'apple' | 'local' | 'provider:<name>'."),
  imageBlockIncluded: z
    .boolean()
    .optional()
    .describe("True when the tool result carries a real MCP image content block."),
});

export type ToolName = keyof typeof TOOL_SCHEMAS;

export const TOOL_SCHEMAS = {
  get_messages: GetMessagesSchema,
  export_messages: ExportMessagesSchema,
  get_unread_messages: GetUnreadMessagesSchema,
  send_message: SendMessageSchema,
  wait_for_reply: WaitForReplySchema,
  list_conversations: ListConversationsSchema,
  search_messages: SearchMessagesSchema,
  get_logs: GetLogsSchema,
  get_last_send_error: GetLastSendErrorSchema,
  run_build: RunBuildSchema,
  request_restart: RequestRestartSchema,
  health_check: HealthCheckSchema,
  list_contacts: ListContactsSchema,
  search_contacts: SearchContactsSchema,
  get_contact: GetContactSchema,
  resolve_conversation: ResolveConversationSchema,
  resolve_handle: ResolveHandleSchema,
  check_imessage_availability: CheckImessageAvailabilitySchema,
  search_attachments: SearchAttachmentsSchema,
  get_attachment: GetAttachmentSchema,
  chat_analytics: ChatAnalyticsSchema,
  init_human: InitHumanSchema,
} as const;

export const OUTPUT_SCHEMAS = {
  get_messages: GetMessagesOutputSchema,
  export_messages: ExportMessagesOutputSchema,
  get_unread_messages: GetUnreadMessagesOutputSchema,
  send_message: SendMessageOutputSchema,
  wait_for_reply: WaitForReplyOutputSchema,
  list_conversations: ListConversationsOutputSchema,
  search_messages: SearchMessagesOutputSchema,
  get_logs: GetLogsOutputSchema,
  get_last_send_error: GetLastSendErrorOutputSchema,
  run_build: RunBuildOutputSchema,
  request_restart: RequestRestartOutputSchema,
  health_check: HealthCheckOutputSchema,
  list_contacts: ListContactsOutputSchema,
  search_contacts: SearchContactsOutputSchema,
  get_contact: GetContactOutputSchema,
  resolve_conversation: ResolveConversationOutputSchema,
  resolve_handle: ResolveHandleOutputSchema,
  check_imessage_availability: CheckImessageAvailabilityOutputSchema,
  search_attachments: SearchAttachmentsOutputSchema,
  get_attachment: GetAttachmentOutputSchema,
  chat_analytics: ChatAnalyticsOutputSchema,
  init_human: InitHumanOutputSchema,
} as const;
