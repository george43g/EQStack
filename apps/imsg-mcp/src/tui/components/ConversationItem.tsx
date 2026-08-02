import { Box, Text } from "ink";
import type { Conversation } from "../../types.js";
import { truncateToWidth, visualWidth } from "../../visual-width.js";
import { useTheme } from "../themes/ThemeContext.js";

function relativeDate(date: Date | null): string {
  if (!date) return "";
  const now = new Date();
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  if (date.toDateString() === now.toDateString()) return time;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return "Yest";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

interface Props {
  conversation: Conversation;
  selected: boolean;
  width: number;
  lineNum?: string;
  focused?: boolean;
  isLast?: boolean;
}

/**
 * Width budget for the conversation row. Returning a precise budget for the
 * name text prevents the time/icons from wrapping onto the next row and
 * obscuring the snippet below — the original symptom of the layout bug.
 *
 * Layout (single row):
 *   [lineNum 4][cursor 2][envelope 2?][group 2?][NAME ...truncated...] (count?) icon time
 *                                                ^^^^^^^^^^^^^^^^^^^^
 *                                                this is what we budget
 */
function nameBudget(
  width: number,
  hasUnread: boolean,
  unreadCount: number,
  isGroup: boolean,
): number {
  const lineNumW = 4; // "123 "
  const cursorW = 2; // "▸ " or "  "
  const envelopeW = hasUnread ? 2 : 0;
  const groupW = isGroup ? 2 : 0;
  const countW = hasUnread ? ` (${unreadCount})`.length : 0;
  const iconW = 2; // " 💬"
  const timeW = 9; // max " 12:34 PM"
  const padding = 2; // safety margin
  return Math.max(
    width - lineNumW - cursorW - envelopeW - groupW - countW - iconW - timeW - padding,
    8,
  );
}

export function ConversationItem({
  conversation: c,
  selected,
  width,
  lineNum,
  focused,
  isLast,
}: Props) {
  const theme = useTheme();
  const hasUnread = c.unreadCount > 0;
  const name = c.displayName ?? c.chatIdentifier;
  const time = relativeDate(c.lastMessageDate);
  const snippet = c.lastMessageSnippet ?? "";
  const serviceIcon = c.serviceType === "SMS" ? theme.glyphs.sms : theme.glyphs.iMessage;

  const nameW = nameBudget(width, hasUnread, c.unreadCount, c.isGroupChat);
  // Grapheme-aware truncation — never splits a surrogate pair (emoji)
  // and budgets each emoji as 2 terminal cells. See src/visual-width.ts.
  const truncatedName = truncateToWidth(name, nameW);
  const snippetW = Math.max(width - 6, 8); // -5 for left padding, -1 safety
  const truncatedSnippet = truncateToWidth(snippet, snippetW, "");
  // Slug row must fit ONE line — a long slug used to wrap and orphan its
  // tail onto the next row, breaking the sidebar layout. Truncate the NAME
  // part and keep the identifying "~svc~hash" tail intact.
  const slugText = truncateSlugForRow(c.threadSlug ?? "", Math.max(width - 3, 10));

  return (
    <Box flexDirection="column" width={width}>
      <Box
        flexDirection="column"
        width={width}
        backgroundColor={selected ? theme.sidebar.selected : undefined}
      >
        {/* Name row — left+right split so time can't wrap */}
        <Box width={width} justifyContent="space-between">
          {/* Left side */}
          <Box flexShrink={1}>
            {lineNum !== undefined && (
              <Text color={selected && focused ? theme.sent.bg : theme.lineNum}>
                {lineNum.padStart(3)}{" "}
              </Text>
            )}
            <Text color={selected && focused ? theme.sent.bg : undefined}>
              {selected && focused ? "▸" : " "}
            </Text>
            {hasUnread && <Text color={theme.dot}>{theme.glyphs.envelope} </Text>}
            {c.isGroupChat && <Text color={theme.info.label}>{theme.glyphs.group} </Text>}
            <Text
              color={
                selected
                  ? theme.sidebar.selectedFg
                  : hasUnread
                    ? theme.sidebar.unread
                    : theme.sidebar.read
              }
              bold={hasUnread}
              wrap="truncate"
            >
              {truncatedName}
            </Text>
          </Box>

          {/* Right side: count + service icon + time, fixed-width */}
          <Box flexShrink={0}>
            {hasUnread && <Text color={theme.sidebar.unread}> ({c.unreadCount})</Text>}
            <Text color={c.serviceType === "SMS" ? theme.sms : theme.info.label}>
              {" "}
              {serviceIcon}
            </Text>
            <Text color={theme.sidebar.time}> {time}</Text>
          </Box>
        </Box>

        {/* Snippet row — explicit width so it can't bleed into adjacent rows */}
        <Box width={width} paddingLeft={5}>
          <Text color={theme.sidebar.snippet} wrap="truncate">
            {truncatedSnippet}
          </Text>
        </Box>

        {/* Slug row — right-justified, italic, dim, subtle bg */}
        <Box
          width={width}
          justifyContent="flex-end"
          paddingRight={1}
          backgroundColor={theme.sidebar.slugBg}
        >
          <Text color={theme.sidebar.slug} dimColor italic wrap="truncate">
            ~{slugText}
          </Text>
        </Box>
      </Box>

      {/* Separator between items */}
      {!isLast && (
        <Box paddingX={1}>
          <Text color={theme.sidebar.separator} dimColor>
            {theme.glyphs.separator.repeat(Math.max(width - 4, 1))}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Fit a thread slug into `maxCols` cells by squeezing the name part while
 * preserving the "~service~hash" tail (the part that identifies the thread).
 * Falls back to plain tail-truncation for non-slug-shaped strings.
 * Exported for tests.
 */
export function truncateSlugForRow(slug: string, maxCols: number): string {
  if (visualWidth(slug) <= maxCols) return slug;
  const m = slug.match(/^(.*)(~[a-z]+~[0-9a-f]+)$/);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    const tailW = visualWidth(m[2]);
    const nameCols = Math.max(maxCols - tailW, 3);
    return `${truncateToWidth(m[1], nameCols)}${m[2]}`;
  }
  return truncateToWidth(slug, maxCols);
}

// Exported for tests
export { nameBudget };
