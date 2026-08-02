/**
 * Tapback reaction types
 * 2000-2005: Add reaction, 3000-3005: Remove reaction
 */
export type TapbackType =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question"
  | "emoji" // iOS 18+ custom emoji
  | "sticker"
  | "unknown";

/**
 * Represents a tapback reaction on a message
 */
export interface Reaction {
  type: TapbackType;
  emoji?: string; // For custom emoji reactions (iOS 18+)
  fromHandle: string;
  isRemoval: boolean; // true if this removes a previous reaction
  targetMessageGuid: string;
  targetMessagePart: number; // Which part of a multi-part message
}

/**
 * Represents a reply context
 */
export interface ReplyContext {
  replyToGuid: string;
  replyToText?: string | null; // The text of the message being replied to
  /**
   * Kind of the message being replied to, when it has no text of its own
   * (a voice note, image, video, or other file). Lets the UI render
   * "↩ voice note" instead of a bare "(unknown)" / "image/attachment".
   */
  replyToKind?: "voice-note" | "image" | "video" | "file";
}

/** One historical version of an edited message part. */
export interface EditVersion {
  /** Decoded text of this version (null if the typedstream had none). */
  text: string | null;
  /** When this version was written (null if the date was absent/implausible). */
  date: Date | null;
}

/** Edit / unsend history parsed from `message_summary_info`. */
export interface EditHistory {
  /** Per edited message part, its ordered versions (oldest → newest). */
  parts: Array<{ part: number; versions: EditVersion[] }>;
  /** Indices of parts the sender retracted (unsent). */
  retractedParts: number[];
}

/**
 * Rich message content types
 */
export type RichContentType =
  | "link_preview"
  | "location"
  | "digital_touch"
  | "handwriting"
  | "app_message"
  | "unknown";

/**
 * Represents a message from the iMessage database
 */
export interface Message {
  id: number;
  guid: string;
  text: string | null;
  handle: string; // phone number or email
  displayName?: string; // Resolved contact name (if available)
  isFromMe: boolean;
  date: Date;
  dateRead: Date | null;
  dateDelivered: Date | null;
  isRead: boolean;
  isDelivered: boolean;
  /** chat.db `error` code when a from-me message failed to send (e.g. 22 = wrong-service iMessage attempt). Undefined = sent fine. */
  sendError?: number;
  chatId: string;
  service: "iMessage" | "SMS";

  // Reaction info (if this message is a tapback)
  isReaction: boolean;
  reaction?: Reaction;

  // Reply context (if this message is a reply to another)
  isReply: boolean;
  replyTo?: ReplyContext;

  // Reactions received on this message
  reactions?: Reaction[];

  // Rich content
  richContentType?: RichContentType;
  richContentSummary?: string; // Parsed summary from message_summary_info BLOB

  // Edit/retract status (iOS 16+)
  isEdited: boolean;
  isRetracted: boolean;
  /**
   * Prior versions of an edited message (and retracted-part indices), parsed
   * from `message_summary_info`. Populated for `isEdited` rows; undefined
   * otherwise. See `src/edit-history.ts`.
   */
  editHistory?: EditHistory;

  /**
   * iPhone-generated voice-note transcript (iOS 17+), extracted from the
   * `IMAudioTranscription` typedstream attribute. Present only for received/sent
   * audio messages that Apple has already transcribed on-device; undefined for
   * older `.caf` voice notes (those fall back to local/cloud transcription).
   */
  appleAudioTranscript?: string;

  /**
   * Resolved, inline-safe media interpretation for this message's primary media
   * attachment — a voice-note transcript or an image/video caption. Populated by
   * read surfaces (get_messages, export, TUI) from CACHED or INSTANT (Apple)
   * results ONLY, never a blocking cloud call. Render-only; the mechanism lives
   * in `src/media-intel-runtime.ts`.
   */
  interpretedMedia?: { kind: "audio" | "image" | "video"; text: string; source: string };

  // Attachments
  hasAttachments: boolean;
  attachments?: Attachment[];
}

/**
 * Represents an attachment
 */
export interface Attachment {
  /** attachment table ROWID — feed to get_attachment to fetch/view the file. */
  rowId?: number;
  filename: string;
  mimeType: string | null;
  transferName: string | null;
  totalBytes: number;
  /**
   * Apple-authored short description of a Genmoji image
   * (`attachment.emoji_image_short_description`), e.g. "a smiling cactus".
   * Null/undefined for ordinary attachments.
   */
  emojiDescription?: string | null;
}

/**
 * A thread-wide attachment row (across all merged legs of one conversation),
 * with its send date — used by the TUI per-thread info/attachment drawer.
 */
export interface ConversationAttachment {
  rowId: number;
  filename: string;
  mimeType: string | null;
  transferName: string | null;
  totalBytes: number;
  createdDate: Date;
}

/** Message-count and date-range summary for one conversation. */
export interface ChatStats {
  count: number;
  first: Date | null;
  last: Date | null;
}

/**
 * Represents a conversation/chat thread
 */
export interface Conversation {
  chatId: string;
  chatIdentifier: string; // phone/email or group identifier
  displayName: string | null; // Contact display name or group name
  rawIdentifier: string; // Original phone/email before contact lookup
  participants: string[];
  lastMessageDate: Date | null;
  /** Last message text preview (may be empty if stored in attributedBody only). */
  lastMessageSnippet: string | null;
  unreadCount: number;
  /** Stable human-readable thread slug (e.g. "alice~imsg~a3f2"). */
  threadSlug: string;
  /** True for group conversations (multiple participants). */
  isGroupChat: boolean;
  /** Service type for this conversation. */
  serviceType: "iMessage" | "SMS";
}

/**
 * A ranked match for a free-form conversation query (resolve_conversation).
 * Lets an agent turn "check Selena's messages" into a concrete thread in one
 * call, instead of chaining search_contacts → get_contact.
 */
export interface ResolvedConversation {
  /** Best display name for the match (contact name, group name, or handle). */
  name: string;
  /** Stable thread slug for send_message/wait_for_reply, or null if unknown. */
  threadSlug: string | null;
  /** Phone/email/group identifier for get_messages. */
  chatIdentifier: string;
  lastMessageDate: Date | null;
  /** Which signal produced the match, strongest first. */
  matchType: "contact" | "thread" | "message";
  /** 0-1 relevance score (fuzzy match strength). */
  score: number;
}

/**
 * Result of sending a message
 */
export interface SendMessageResult {
  success: boolean;
  error?: string;
  timestamp?: Date;
  /** Which service actually delivered the message. Populated by reliable-send paths. */
  service?: "iMessage" | "SMS";
}

/**
 * Options for waiting for a reply
 */
export interface WaitForReplyOptions {
  chatId: string;
  afterMessageId?: number;
  timeoutMs: number;
  pollIntervalMs?: number;
}

/**
 * Result of waiting for a reply
 */
export interface WaitForReplyResult {
  received: boolean;
  message?: Message;
  timedOut: boolean;
}

/**
 * Conversation thread context for AI agents
 */
export interface ConversationThread {
  conversationId: string;
  recipient: string;
  messages: Message[];
  lastSentByMe: Message | null;
  lastReceivedFromThem: Message | null;
  awaitingReply: boolean;
}

/**
 * Lowest message id in an array — safe for arbitrarily large inputs.
 *
 * `Math.min(...messages.map(m => m.id))` throws
 * "RangeError: Maximum call stack size exceeded" past ~125k spread args.
 * Callers shouldn't have to remember that — this helper does the loop.
 * Returns `null` for empty input so the caller can decide on the
 * fallback id explicitly.
 */
export function minMessageId(messages: Pick<Message, "id">[]): number | null {
  if (messages.length === 0) return null;
  let lo = messages[0].id;
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].id < lo) lo = messages[i].id;
  }
  return lo;
}
