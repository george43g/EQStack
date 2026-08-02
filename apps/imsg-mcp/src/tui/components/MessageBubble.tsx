import { Box, Text } from "ink";
import { formatReplyPreview } from "../../reply-preview.js";
import type { Message, Reaction } from "../../types.js";
import { TAPBACK_EMOJI } from "../theme.js";
import { useTheme } from "../themes/ThemeContext.js";

function relativeDate(date: Date): string {
  const now = new Date();
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  if (date.toDateString() === now.toDateString()) return time;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return `Yest ${time}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function formatReactions(reactions: Reaction[]): string {
  const counts = new Map<string, number>();
  for (const r of reactions) {
    if (r.isRemoval) continue;
    const emoji = r.emoji ?? TAPBACK_EMOJI[r.type] ?? r.type;
    counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  return [...counts.entries()].map(([e, c]) => (c > 1 ? `${e}${c}` : e)).join("");
}

/** Check if two dates are on different calendar days */
export function isDifferentDay(a: Date, b: Date): boolean {
  return a.toDateString() !== b.toDateString();
}

/** Format a date separator label */
export function dateSeparator(date: Date): string {
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Determine if a message is the first in a group from the same sender */
export function isGroupStart(msg: Message, prev: Message | undefined): boolean {
  if (!prev) return true;
  return msg.isFromMe !== prev.isFromMe || msg.handle !== prev.handle;
}

/** Determine if a message is the last in a group from the same sender */
export function isGroupEnd(msg: Message, next: Message | undefined): boolean {
  if (!next) return true;
  return msg.isFromMe !== next.isFromMe || msg.handle !== next.handle;
}

interface Props {
  message: Message;
  maxWidth: number;
  showSender?: boolean;
  senderName?: string;
  selected?: boolean;
  lineNum?: string;
  isFirstInGroup?: boolean; // first message from this sender in a consecutive run
  isLastInGroup?: boolean; // last message from this sender in a consecutive run
  bgTint?: string; // alternating background for sender groups
  /**
   * Optional resolver for reply target text by GUID. When `m.isReply` is
   * true but `m.replyTo.replyToText` is null/undefined (the iMessage DB
   * sometimes leaves it unpopulated even when the link metadata exists),
   * we fall back to looking up the target message in the currently loaded
   * messages array via this callback. If still not found, render a
   * placeholder so the reader at least sees the reply indicator.
   */
  lookupReplyText?: (guid: string) => string | null;
  /** True when this message is inside an active visual selection range. */
  inSelection?: boolean;
}

/**
 * Compact message row — no borders, minimal vertical space.
 * Sender groups get alternating background tints.
 * First message in group shows sender name; subsequent ones are indented.
 */
export function MessageBubble({
  message: m,
  maxWidth,
  showSender,
  senderName,
  selected,
  lineNum,
  isFirstInGroup,
  isLastInGroup,
  bgTint,
  lookupReplyText,
  inSelection,
}: Props) {
  const theme = useTheme();
  const isSent = m.isFromMe;
  const text = m.text ?? (m.isRetracted ? "(unsent)" : "(attachment)");
  const timestamp = relativeDate(m.date);
  const reactions = m.reactions ? formatReactions(m.reactions) : "";
  const hasAttachments = m.hasAttachments;
  // Voice note = an audio attachment or a synced Apple transcript. Drives the
  // 🎤 transcript row (rendered below the bubble body).
  const isVoiceNote =
    Boolean(m.appleAudioTranscript) ||
    (m.attachments ?? []).some(
      (a) =>
        (a.mimeType ?? "").startsWith("audio/") ||
        /\.(caf|amr|m4a|mp3|wav|aac)$/i.test(a.filename ?? ""),
    );

  // Cursor indicator
  const cursor = selected ? "▸" : " ";
  const cursorColor = selected ? theme.sent.bg : undefined;

  // Only show sender on first message in a group
  const sender = isFirstInGroup
    ? showSender && !isSent && senderName
      ? senderName
      : isSent
        ? "Me"
        : undefined
    : undefined;

  // Group separator: thin line between groups
  const groupSepChar = isFirstInGroup ? "┌" : isLastInGroup ? "└" : "│";
  const groupColor = isSent ? theme.sent.border : theme.received.border;

  return (
    <Box
      flexDirection="column"
      backgroundColor={selected ? theme.sidebar.selected : inSelection ? theme.selectionBg : bgTint}
    >
      <Box>
        {/*
         * Prefix block — line number, cursor, group gutter, timestamp,
         * direction glyph, sender. Rendered as a SINGLE <Text> with nested
         * colored spans so Ink treats the whole prefix as one atomic
         * shrink-unit. Splitting it into separate <Text> siblings made
         * Ink's flex-shrink chop one char off each on overflow rows —
         * e.g. `9:49 PM ◀` rendered as `9:49 P◀` (M and trailing space
         * eaten), `Me: ` rendered as `Me:` (running into the message body).
         * Wrapped in a Box with flexShrink={0} so the prefix never loses
         * a char; the message <Text> below (wrap="wrap") is the sole
         * shrinkable element on the row.
         */}
        <Box flexShrink={0}>
          <Text>
            {lineNum !== undefined && (
              <Text color={selected ? theme.sent.bg : theme.lineNum}>{lineNum.padStart(3)} </Text>
            )}
            <Text color={cursorColor}>{cursor}</Text>
            <Text color={groupColor}>{groupSepChar} </Text>
            {isFirstInGroup ? (
              // pad to 14 (not 13) so even the widest natural timestamp
              // (`MM/DD HH:MM PM` = 13 chars, or `Yest 12:37 PM` = 13)
              // always has at least one trailing space before the glyph —
              // otherwise the row renders as `10:39 PM◀ Hey` with no gap.
              <Text color={theme.timestamp}>{timestamp.padEnd(14)}</Text>
            ) : (
              <Text color={theme.timestamp}>{"              "}</Text>
            )}
            {isFirstInGroup ? (
              <>
                {isSent ? (
                  <Text color={theme.sent.bg} bold>
                    {theme.glyphs.sent}{" "}
                  </Text>
                ) : (
                  <Text color={theme.received.border} bold>
                    {theme.glyphs.received}{" "}
                  </Text>
                )}
                {sender && (
                  <Text color={isSent ? theme.sent.bg : theme.senderName} bold>
                    {sender.length > 12 ? `${sender.slice(0, 11)}…` : sender}
                    {": "}
                  </Text>
                )}
              </>
            ) : (
              // Continuation: indent to align with first message text
              <Text>
                {"  "}
                {sender ? "                " : ""}
              </Text>
            )}
          </Text>
        </Box>

        {/* Message text — the only shrinkable element on the row. Wraps to
            the remaining row width (hanging indent falls out of the flex
            layout: every wrapped line starts at this box's left edge).
            ThreadPane's lineHeight() budgets the wrap rows so the visible
            window stays clip-free. */}
        <Text color={isSent ? theme.sentText : theme.receivedText} wrap="wrap">
          {text}
        </Text>

        {/* Reactions */}
        {reactions && <Text> {reactions}</Text>}

        {/* Attachment indicator */}
        {hasAttachments && <Text color={theme.attachment}> 📎</Text>}

        {/* Edited indicator */}
        {m.isEdited && <Text color={theme.edited}> ✎</Text>}

        {/* Unsent / retracted indicator — the sender took the message back. */}
        {m.isRetracted && (
          <Text color={theme.edited} dimColor>
            {" "}
            ⊘ unsent
          </Text>
        )}

        {/* Send-failure indicator — Messages.app shows "Not Delivered"; a
            failed from-me message must not render like a normal sent one. */}
        {m.sendError !== undefined && (
          <Text color={theme.edited} bold>
            {" "}
            ✗ not delivered
          </Text>
        )}
      </Box>

      {/* Reply context — always render the indicator when isReply, even if
          replyToText is missing. iMessage sometimes leaves the text NULL
          even when the GUID link is present, so we try a runtime lookup
          and fall back to a placeholder so the user knows it IS a reply. */}
      {m.isReply &&
        (() => {
          let fallback: string | null = null;
          if (!m.replyTo?.replyToText && m.replyTo?.replyToGuid && lookupReplyText) {
            fallback = lookupReplyText(m.replyTo.replyToGuid);
          }
          const preview = formatReplyPreview(m.replyTo, fallback);
          const display = preview
            ? preview.slice(0, maxWidth - 12)
            : "(replied to earlier message)";
          return (
            <Box>
              {lineNum !== undefined && <Text>{"    "}</Text>}
              <Text>{"  "}</Text>
              <Text color={theme.replyContext} italic wrap="truncate">
                {"  ↩ "}
                {display}
              </Text>
            </Box>
          );
        })()}

      {/* Voice-note / interpreted-media row. Shows the resolved transcript or
          caption when one is cached/instant (msg.interpretedMedia), otherwise a
          hint that `R` will interpret it. Cloud transcription is triggered on
          demand — never inline in a read. */}
      {(m.interpretedMedia || isVoiceNote) &&
        (() => {
          const interp = m.interpretedMedia;
          const glyph = interp
            ? interp.kind === "audio"
              ? "🎤"
              : interp.kind === "video"
                ? "🎬"
                : "🖼"
            : "🎤";
          const body = interp?.text ?? "(voice note — press R to transcribe)";
          return (
            <Box>
              {lineNum !== undefined && <Text>{"    "}</Text>}
              <Text>{"  "}</Text>
              <Text
                color={interp ? theme.receivedText : theme.timestamp}
                italic={!interp}
                wrap="wrap"
              >
                {`  ${glyph} `}
                {body}
              </Text>
            </Box>
          );
        })()}
    </Box>
  );
}

interface PendingBubbleProps {
  text: string;
  status: "sending" | "sent" | "failed";
  maxWidth: number;
}

export function PendingBubble({ text, status }: PendingBubbleProps) {
  const theme = useTheme();
  const indicator = status === "sending" ? "⏳" : status === "failed" ? "⚠" : "✓";
  const color = status === "failed" ? theme.edited : theme.pending.fg;

  return (
    <Box backgroundColor={theme.groupBg.sent}>
      <Text>{"    "}</Text>
      <Text color={color}>{indicator} </Text>
      <Text color={theme.timestamp}>{"now".padEnd(14)}</Text>
      <Text color={theme.sent.bg} bold>
        {`${theme.glyphs.sent} Me: `}
      </Text>
      <Text color={theme.pending.fg} wrap="wrap">
        {text}
      </Text>
    </Box>
  );
}
