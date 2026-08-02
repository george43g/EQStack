import { Box, Text } from "ink";
import React, { useMemo } from "react";
import type { Conversation, Message } from "../../types.js";
import { visualWidth } from "../../visual-width.js";
import { useTheme } from "../themes/ThemeContext.js";
import type { Mode, PendingMessage } from "../types.js";
import { ComposeBar } from "./ComposeBar.js";
import {
  dateSeparator,
  isDifferentDay,
  isGroupEnd,
  isGroupStart,
  MessageBubble,
  PendingBubble,
} from "./MessageBubble.js";

interface Props {
  conversation: Conversation | undefined;
  messages: Message[];
  pending: PendingMessage[];
  resolvedNames: string[];
  scrollOffset: number;
  selectedMsgIdx: number;
  /** Anchor index for visual selection (set when V is pressed). null = no selection. */
  selectionAnchor: number | null;
  /** Eviction gap markers — placeholders showing "N more messages — scroll to load". */
  gapMarkers: Array<{ atIdx: number; oldestId: number; newestId: number; count: number }>;
  focused: boolean;
  width: number;
  height: number;
  mode: Mode;
  onChangeCompose: (text: string) => void;
  onSubmitCompose: (text: string) => void;
}

export function ThreadPane({
  conversation,
  messages,
  pending,
  resolvedNames: _resolvedNames,
  scrollOffset: _scrollOffset,
  selectedMsgIdx,
  selectionAnchor,
  gapMarkers,
  focused,
  width,
  height,
  mode,
  onChangeCompose,
  onSubmitCompose,
}: Props) {
  const theme = useTheme();
  const isGroup = conversation?.isGroupChat ?? false;
  const maxBubbleW = Math.max(width - 8, 20);
  const composing = mode === "compose" || mode === "confirm";

  // Available height for messages
  const headerH = 1;
  const composeH = composing ? 1 : 0;
  const borderH = 2;
  const msgAreaHeight = Math.max(height - headerH - composeH - borderH, 3);

  // Compute visible window anchored on selectedMsgIdx.
  // Account for multi-line items: replies take 2 lines, date separators take 1 extra line.
  const { visibleStart, visibleEnd } = useMemo(() => {
    const total = messages.length + pending.length;
    if (total === 0) return { visibleStart: 0, visibleEnd: 0 };

    let cursorIdx = selectedMsgIdx >= 0 ? selectedMsgIdx : total - 1;
    cursorIdx = Math.max(0, Math.min(cursorIdx, total - 1));

    // Bottom-anchor: when the cursor is at or near the last real message, walk
    // UP from the end accumulating real heights until we fill msgAreaHeight.
    // Fixes the clip where the last 1-3 messages run past Ink's overflow="hidden"
    // because the downward fill loop never executes (end === total - 1 already).
    const NEAR_END = 2;
    if (cursorIdx >= messages.length - NEAR_END && pending.length === 0) {
      const end = messages.length - 1;
      let start = end;
      let totalLines = lineHeight(messages, end, maxBubbleW, isGroup);
      while (
        start > 0 &&
        totalLines + lineHeight(messages, start - 1, maxBubbleW, isGroup) <= msgAreaHeight
      ) {
        start--;
        totalLines += lineHeight(messages, start, maxBubbleW, isGroup);
      }
      return { visibleStart: start, visibleEnd: end + 1 };
    }

    // Walk outward from cursor, counting actual lines consumed
    // Start by going upward from cursor
    let start = cursorIdx;
    let linesAbove = 0;
    const targetAbove = Math.floor(msgAreaHeight * 0.4);
    while (start > 0 && linesAbove < targetAbove) {
      start--;
      linesAbove += lineHeight(messages, start, maxBubbleW, isGroup);
    }

    // Then go downward from cursor
    let end = cursorIdx;
    let totalLines = linesAbove + lineHeight(messages, cursorIdx, maxBubbleW, isGroup);
    while (end < total - 1 && totalLines < msgAreaHeight) {
      end++;
      if (end < messages.length) {
        totalLines += lineHeight(messages, end, maxBubbleW, isGroup);
      } else {
        totalLines += 1; // pending messages
      }
    }

    // If we have room, extend upward more
    while (start > 0 && totalLines < msgAreaHeight) {
      start--;
      totalLines += lineHeight(messages, start, maxBubbleW, isGroup);
    }

    return { visibleStart: start, visibleEnd: end + 1 };
    // `messages` reference is preserved across non-messages reducer cases
    // (see types.ts reducer), so depending on length is sufficient for the
    // common fast path. Content-mutating actions (SET_MESSAGES /
    // PREPEND_MESSAGES) replace the whole array, which also flips length.
  }, [messages, pending.length, selectedMsgIdx, msgAreaHeight, maxBubbleW, isGroup]);

  const visibleMessages = messages.slice(visibleStart, Math.min(visibleEnd, messages.length));

  // Build a GUID → text lookup so MessageBubble can resolve missing replyToText
  // from the loaded message set when iMessage didn't populate it. Memoized to
  // avoid rebuilding on every render.
  const messagesByGuid = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages) {
      if (!m.guid) continue;
      // Prefer the message text; fall back to a synced voice-note transcript so
      // a reply to a voice note resolves to its words, not "(unknown)".
      if (m.text) map.set(m.guid, m.text);
      else if (m.appleAudioTranscript) map.set(m.guid, m.appleAudioTranscript);
    }
    return map;
  }, [messages]);

  const lookupReplyText = (guid: string): string | null => messagesByGuid.get(guid) ?? null;

  // Visual selection range — derived from anchor + cursor.
  const selRange: [number, number] | null =
    selectionAnchor != null && selectedMsgIdx >= 0
      ? [Math.min(selectionAnchor, selectedMsgIdx), Math.max(selectionAnchor, selectedMsgIdx)]
      : null;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderColor={focused ? theme.header.focused.fg : theme.border}
      overflow="hidden"
    >
      {/* Header.
       * flexShrink discipline: the LEFT side (name) shrinks first; "(N
       * msgs)" + the right column (identifier + service) keep their
       * width. Without these, narrowing the pane (e.g. opening dev
       * stats) wraps the header mid-character — "iMessa\nge". */}
      <Box
        paddingX={1}
        backgroundColor={focused ? theme.header.focused.bg : theme.header.dim.bg}
        justifyContent="space-between"
        flexShrink={0}
      >
        <Box flexShrink={1} overflow="hidden">
          <Text
            color={focused ? theme.header.focused.fg : theme.header.dim.fg}
            bold={focused}
            wrap="truncate"
          >
            {conversation?.displayName ?? conversation?.chatIdentifier ?? "Thread"}
          </Text>
          {conversation && (
            <Text color={theme.info.label} wrap="truncate">{` (${messages.length} msgs)`}</Text>
          )}
        </Box>
        {conversation && (
          <Box gap={1} flexShrink={0}>
            {conversation.displayName && (
              <Text color={theme.info.label} wrap="truncate">
                {conversation.rawIdentifier}
              </Text>
            )}
            <Text color={conversation.serviceType === "SMS" ? theme.sms : theme.info.label}>
              {conversation.serviceType}
            </Text>
            {conversation.isGroupChat && <Text color={theme.info.label}>Group</Text>}
          </Box>
        )}
      </Box>

      {/* Messages — compact rows with sender grouping */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {messages.length === 0 && pending.length === 0 ? (
          <Box paddingX={1}>
            <Text color={theme.sidebar.snippet}>No messages</Text>
          </Box>
        ) : (
          <>
            {/* Scroll indicator top */}
            {visibleStart > 0 && (
              <Box justifyContent="center">
                <Text color={theme.dateSep}>── ↑ {visibleStart} more ──</Text>
              </Box>
            )}

            {visibleMessages.map((msg, i) => {
              const realIdx = visibleStart + i;
              const prevMsg = realIdx > 0 ? messages[realIdx - 1] : undefined;
              const nextMsg = realIdx < messages.length - 1 ? messages[realIdx + 1] : undefined;
              const showDateSep = !prevMsg || isDifferentDay(prevMsg.date, msg.date);
              const firstInGroup = isGroupStart(msg, prevMsg);
              const lastInGroup = isGroupEnd(msg, nextMsg);

              // Alternating background tint based on sender
              const bgTint = msg.isFromMe ? theme.groupBg.sent : theme.groupBg.received;

              // Relative line number: distance from cursor
              const relNum =
                selectedMsgIdx >= 0
                  ? realIdx === selectedMsgIdx
                    ? `${realIdx}`
                    : `${Math.abs(realIdx - selectedMsgIdx)}`
                  : `${realIdx}`;

              return (
                <React.Fragment key={msg.id}>
                  {(() => {
                    // Gap marker — show "N more messages" before the first
                    // message after an evicted region.
                    const gap = gapMarkers.find((g) => g.atIdx === realIdx);
                    if (!gap) return null;
                    return (
                      <Box justifyContent="center" marginTop={1} marginBottom={1}>
                        <Text color={theme.edited}>
                          ─── {gap.count.toLocaleString()} older messages evicted (scroll back to
                          reload) ───
                        </Text>
                      </Box>
                    );
                  })()}
                  {showDateSep && (
                    // Always 1 row of breathing room above date separators so the
                    // visual rhythm is consistent — without this, separators that
                    // appear after a same-sender continuation feel cramped while
                    // ones after a different-sender row feel fine.
                    <Box justifyContent="center" marginTop={realIdx === 0 ? 0 : 1}>
                      <Text color={theme.dateSep}>─── {dateSeparator(msg.date)} ───</Text>
                    </Box>
                  )}
                  <MessageBubble
                    message={msg}
                    maxWidth={maxBubbleW}
                    showSender={isGroup}
                    senderName={msg.displayName ?? msg.handle}
                    selected={realIdx === selectedMsgIdx && focused}
                    lineNum={relNum}
                    isFirstInGroup={firstInGroup || showDateSep}
                    isLastInGroup={lastInGroup}
                    bgTint={bgTint}
                    lookupReplyText={lookupReplyText}
                    inSelection={
                      selRange != null && realIdx >= selRange[0] && realIdx <= selRange[1]
                    }
                  />
                  {/* Group separator line between different senders */}
                  {lastInGroup && nextMsg && !isDifferentDay(msg.date, nextMsg.date) && (
                    <Box height={0} />
                  )}
                </React.Fragment>
              );
            })}

            {/* Pending messages */}
            {pending.map((pm) => (
              <PendingBubble
                key={pm.text}
                text={pm.text}
                status={pm.status}
                maxWidth={maxBubbleW}
              />
            ))}

            {/* Scroll indicator bottom */}
            {visibleEnd < messages.length && (
              <Box justifyContent="center">
                <Text color={theme.dateSep}>── ↓ {messages.length - visibleEnd} more ──</Text>
              </Box>
            )}
          </>
        )}
      </Box>

      {/* Compose bar */}
      {composing && (
        <ComposeBar
          mode={mode}
          recipientName={conversation?.displayName ?? conversation?.chatIdentifier ?? ""}
          onChangeText={onChangeCompose}
          onSubmit={onSubmitCompose}
        />
      )}
    </Box>
  );
}

/** Wrap rows a text consumes at a given inner width (grapheme-aware). */
function wrapRows(text: string, innerW: number): number {
  let rows = 0;
  for (const line of text.split("\n")) {
    rows += Math.max(1, Math.ceil(visualWidth(line) / innerW));
  }
  return rows;
}

/**
 * Estimate how many terminal lines a message at index `i` will consume.
 * MessageBubble wraps the body text, so this must match the REAL wrapped
 * height: under-counts trigger bottom-of-thread clipping (Ink's
 * overflow="hidden" silently drops rows past the box edge). The prefix
 * block (lineNum 4 + cursor 1 + gutter 2 + timestamp 14 + glyph 2 = 23
 * cells, plus up to 14 for a group sender label) is flexShrink=0, so the
 * text box width = pane content width − prefix. bubbleWidth is width−8,
 * pane content is width−2 → text width ≈ bubbleWidth − 17 (1:1) or
 * bubbleWidth − 31 (group first-in-group rows with a sender label).
 */
function lineHeight(messages: Message[], i: number, bubbleWidth: number, isGroup: boolean): number {
  if (i < 0 || i >= messages.length) return 1;
  const msg = messages[i];
  const firstInGroup = isGroupStart(msg, i > 0 ? messages[i - 1] : undefined);
  const senderPad = isGroup && firstInGroup && !msg.isFromMe ? 14 : 0;
  // −17 for the prefix, −8 slack for inline indicators (reactions 📎 ✎)
  // that share the row and narrow the text box. Over-counting only costs a
  // slightly smaller window; under-counting clips the bottom row.
  const innerW = Math.max(16, bubbleWidth - 25 - senderPad);
  const text = msg.text ?? "";
  let h = wrapRows(text, innerW);
  // Reply preview row(s) — preview itself is truncated to one line.
  if (msg.isReply) h += 1;
  // Date separator. Rendered with marginTop={1} when realIdx > 0
  // (ThreadPane.tsx ~line 216), so it actually occupies TWO terminal rows in
  // that case: 1 blank margin + 1 separator content. Under-counting this
  // pushes the last message past the box edge.
  if (i === 0) {
    h += 1;
  } else if (isDifferentDay(messages[i - 1].date, msg.date)) {
    h += 2;
  }
  return h;
}

/**
 * Find the index of the next sender-group boundary from the given position.
 * A group boundary is where the sender changes (isFromMe flips or handle changes).
 */
export function nextGroupBoundary(messages: Message[], fromIdx: number): number {
  if (fromIdx >= messages.length - 1) return messages.length - 1;
  const current = messages[fromIdx];
  // Skip to end of current group
  let i = fromIdx + 1;
  while (i < messages.length) {
    const m = messages[i];
    if (m.isFromMe !== current.isFromMe || m.handle !== current.handle) {
      return i;
    }
    i++;
  }
  return messages.length - 1;
}

/**
 * Find the index of the previous sender-group boundary from the given position.
 */
export function prevGroupBoundary(messages: Message[], fromIdx: number): number {
  if (fromIdx <= 0) return 0;
  const current = messages[fromIdx];
  // If we're at the start of a group, go to start of previous group
  const prev = messages[fromIdx - 1];
  if (prev.isFromMe !== current.isFromMe || prev.handle !== current.handle) {
    // We're at a boundary — find start of previous group
    let i = fromIdx - 1;
    while (i > 0) {
      const m = messages[i - 1];
      if (m.isFromMe !== prev.isFromMe || m.handle !== prev.handle) {
        return i;
      }
      i--;
    }
    return 0;
  }
  // We're in the middle of a group — go to start of current group
  let i = fromIdx - 1;
  while (i > 0) {
    const m = messages[i - 1];
    if (m.isFromMe !== current.isFromMe || m.handle !== current.handle) {
      return i;
    }
    i--;
  }
  return 0;
}
