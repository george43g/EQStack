/**
 * iMessage SQLite database schema constants and helpers.
 * Single source of truth for chat.db structure (synced with Messages.app / SMS).
 * See docs/IMESSAGE_DB_SCHEMA.md for full reference.
 */

/** Seconds between Unix epoch (1970-01-01) and Mac epoch (2001-01-01). */
export const MAC_EPOCH_OFFSET = 978307200;

/** Timestamps in DB are nanoseconds since 2001-01-01. */
export const NANOS_PER_SECOND = 1_000_000_000;

export const Tables = {
  MESSAGE: "message",
  HANDLE: "handle",
  CHAT: "chat",
  CHAT_MESSAGE_JOIN: "chat_message_join",
  CHAT_HANDLE_JOIN: "chat_handle_join",
  ATTACHMENT: "attachment",
  MESSAGE_ATTACHMENT_JOIN: "message_attachment_join",
  RECOVERABLE_MESSAGE_PART: "recoverable_message_part",
} as const;

/** associated_message_type: 0 = normal message; 2,3 = business; 1000 = sticker; 2000–3006 = tapbacks. */
export const AssociatedMessageType = {
  NORMAL: 0,
  STICKER: 1000,
  LOVE_ADD: 2000,
  LIKE_ADD: 2001,
  DISLIKE_ADD: 2002,
  LAUGH_ADD: 2003,
  EMPHASIZE_ADD: 2004,
  QUESTION_ADD: 2005,
  EMOJI_ADD: 2006,
  LOVE_REMOVE: 3000,
  LIKE_REMOVE: 3001,
  DISLIKE_REMOVE: 3002,
  LAUGH_REMOVE: 3003,
  EMPHASIZE_REMOVE: 3004,
  QUESTION_REMOVE: 3005,
  EMOJI_REMOVE: 3006,
} as const;

/** Minimum type value for tapback/reaction messages (add). */
export const TAPBACK_ADD_MIN = 2000;

/** Minimum type value for reaction messages we query (adds). */
export const TAPBACK_QUERY_MIN = 2000;

/** Format: p:PART_INDEX/MESSAGE_GUID. */
export const ASSOCIATED_MESSAGE_GUID_REGEX = /^p:(\d+)\/(.+)$/;

/** Object replacement character used as placeholder for inline attachments / rich content. */
export const OBJECT_REPLACEMENT_CHAR = "\uFFFC";

/**
 * Convert macOS timestamp (nanoseconds since 2001-01-01) to JS Date.
 */
export function macTimestampToDate(timestamp: number | null): Date | null {
  if (timestamp == null || timestamp === 0) return null;
  const unixSeconds = timestamp / NANOS_PER_SECOND + MAC_EPOCH_OFFSET;
  return new Date(unixSeconds * 1000);
}

/**
 * Convert a macOS timestamp where the storage unit isn't guaranteed.
 *
 * `message.date` is nanoseconds on modern macOS, but other columns
 * (notably `attachment.created_date`) store **seconds** since the
 * Mac epoch. Same baseline, different magnitude — and the two ranges
 * don't overlap for any reasonable date:
 *   - "now" in seconds: ~8 × 10⁸
 *   - "now" in nanoseconds: ~8 × 10¹⁷
 *
 * Anything below `SECONDS_NS_BOUNDARY` (10¹⁵) is treated as seconds;
 * anything at or above is treated as nanoseconds. Values of 0 or null
 * return null (no recorded timestamp).
 */
export const SECONDS_NS_BOUNDARY = 1e15;

export function macAutoTimestampToDate(timestamp: number | null): Date | null {
  if (timestamp == null || timestamp === 0) return null;
  const unitDivisor = timestamp < SECONDS_NS_BOUNDARY ? 1 : NANOS_PER_SECOND;
  const unixSeconds = timestamp / unitDivisor + MAC_EPOCH_OFFSET;
  return new Date(unixSeconds * 1000);
}

/**
 * Parse associated_message_guid to extract target message GUID and part index.
 * Format: "p:PART_INDEX/MESSAGE_GUID"
 */
export function parseAssociatedMessageGuid(
  guid: string | null,
): { targetGuid: string; partIndex: number } | null {
  if (!guid) return null;
  const match = guid.match(ASSOCIATED_MESSAGE_GUID_REGEX);
  if (match) {
    return { partIndex: parseInt(match[1], 10), targetGuid: match[2] };
  }
  return null;
}

/** Whether associated_message_type represents a reaction/tapback (excludes normal and business). */
export function isReactionType(associatedMessageType: number): boolean {
  return associatedMessageType >= 1000 && associatedMessageType !== 0;
}
