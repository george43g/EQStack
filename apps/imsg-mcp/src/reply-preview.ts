import type { ReplyContext } from "./types.js";

/** Human noun for a reply-to kind ("voice note", "image", …). */
export function replyKindNoun(kind: ReplyContext["replyToKind"]): string {
  switch (kind) {
    case "voice-note":
      return "voice note";
    case "image":
      return "image";
    case "video":
      return "video";
    case "file":
      return "file";
    default:
      return "message";
  }
}

/**
 * One-line, human-readable preview of the message being replied to. Pure — the
 * same helper backs the MCP text formatter and the TUI so a future web UI reuses
 * it verbatim.
 *
 * - voice note with transcript → `voice note: "transcript…"`
 * - voice note without transcript → `voice note`
 * - image/video/file without text → `image` / `video` / `file`
 * - anything with text → the text
 * - nothing known → `null` (caller renders its own placeholder)
 *
 * `fallbackText` is a last-resort text (e.g. a runtime GUID→text lookup) used
 * only when the reply context itself has no text.
 */
export function formatReplyPreview(
  replyTo: ReplyContext | undefined,
  fallbackText?: string | null,
): string | null {
  if (!replyTo) return fallbackText || null;
  const text = replyTo.replyToText ?? fallbackText ?? null;
  const kind = replyTo.replyToKind;
  if (kind === "voice-note") {
    return text ? `voice note: "${text}"` : "voice note";
  }
  if (text) return text;
  if (kind) return replyKindNoun(kind);
  return null;
}
