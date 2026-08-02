import { Box, Text } from "ink";
import type { ChatStats, Conversation, ConversationAttachment } from "../../types.js";
import { useTheme } from "../themes/ThemeContext.js";

interface Props {
  conversation: Conversation;
  /** Participant handles resolved to contact display names (App.tsx). */
  resolvedNames: string[];
  stats: ChatStats | null;
  attachments: ConversationAttachment[];
  /** Cursor within `attachments` (j/k). */
  selectedAttachmentIdx: number;
  width: number;
  height: number;
}

/** Drawer-row label, mirrors MessageDrawer's Label (flexShrink so it never squeezes). */
function Label({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Box flexShrink={0}>
      <Text color={theme.drawer.label}>{children}: </Text>
    </Box>
  );
}

function formatBytes(n: number): string {
  if (n <= 0) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 && u > 0 ? 1 : 0)}${units[u]}`;
}

function shortDate(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime()) || d.getTime() === 0) return "—";
  return d.toISOString().slice(0, 10);
}

export function InfoDrawer({
  conversation,
  resolvedNames,
  stats,
  attachments,
  selectedAttachmentIdx,
  width,
  height,
}: Props) {
  const theme = useTheme();
  const names = resolvedNames.length > 0 ? resolvedNames : conversation.participants;
  const title =
    conversation.displayName ||
    (conversation.isGroupChat ? `Group (${conversation.participants.length})` : names[0]) ||
    conversation.chatIdentifier;

  // Attachment list viewport: 2 rows per item, kept centered on the selection so
  // j/k can scroll through hundreds of rows within a fixed-height drawer.
  const perItem = 2;
  const listRows = Math.max(perItem, height - 16);
  const maxItems = Math.max(1, Math.floor(listRows / perItem));
  const start = Math.max(
    0,
    Math.min(
      selectedAttachmentIdx - Math.floor(maxItems / 2),
      Math.max(0, attachments.length - maxItems),
    ),
  );
  const visible = attachments.slice(start, start + maxItems);
  const hiddenAbove = start;
  const hiddenBelow = Math.max(0, attachments.length - (start + visible.length));

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderColor={theme.drawer.border}
      overflow="hidden"
    >
      {/* Header */}
      <Box paddingX={1} backgroundColor={theme.header.focused.bg}>
        <Text color={theme.header.focused.fg} bold>
          Thread Info
        </Text>
      </Box>

      {/* Metadata */}
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Label>Name</Label>
          <Text color={theme.drawer.value} wrap="truncate">
            {title}
          </Text>
        </Box>
        <Box>
          <Label>Slug</Label>
          <Text color={theme.drawer.value} wrap="truncate">
            {conversation.threadSlug}
          </Text>
        </Box>
        <Box>
          <Label>Service</Label>
          <Text color={theme.drawer.value}>{conversation.serviceType}</Text>
        </Box>
        <Box>
          <Label>Type</Label>
          <Text color={theme.drawer.value}>{conversation.isGroupChat ? "Group" : "Direct"}</Text>
        </Box>
        <Box>
          <Label>People</Label>
          <Text color={theme.drawer.value} wrap="truncate">
            {conversation.isGroupChat
              ? `${conversation.participants.length} participants`
              : names.join(", ")}
          </Text>
        </Box>
        <Box>
          <Label>Messages</Label>
          <Text color={theme.drawer.value}>{stats ? stats.count.toLocaleString() : "…"}</Text>
        </Box>
        <Box>
          <Label>Range</Label>
          <Text color={theme.drawer.value} wrap="truncate">
            {stats ? `${shortDate(stats.first)} → ${shortDate(stats.last)}` : "…"}
          </Text>
        </Box>
      </Box>

      {/* Attachments */}
      <Box flexDirection="column" paddingX={1} marginTop={1} flexGrow={1}>
        <Text color={theme.attachment} bold>
          Attachments ({attachments.length})
        </Text>
        {attachments.length === 0 && (
          <Text color={theme.drawer.label}>No attachments in this thread.</Text>
        )}
        {hiddenAbove > 0 && <Text color={theme.drawer.label}> ▲ {hiddenAbove} more</Text>}
        {visible.map((att, i) => {
          const idx = start + i;
          const isSel = idx === selectedAttachmentIdx;
          const name = att.transferName ?? att.filename.split("/").pop() ?? att.filename;
          const kind = (att.mimeType ?? "unknown").replace(/^.*\//, "");
          return (
            <Box key={att.rowId} flexDirection="column">
              <Box>
                <Box flexShrink={0}>
                  <Text color={isSel ? theme.sent.bg : theme.drawer.label}>
                    {isSel ? "▸" : " "}
                  </Text>
                </Box>
                <Text color={theme.drawer.value} bold={isSel} wrap="truncate">
                  {name}
                </Text>
              </Box>
              <Box paddingLeft={1}>
                <Text color={theme.drawer.label}>
                  {kind} · {formatBytes(att.totalBytes)} · {shortDate(att.createdDate)}
                </Text>
              </Box>
            </Box>
          );
        })}
        {hiddenBelow > 0 && <Text color={theme.drawer.label}> ▼ {hiddenBelow} more</Text>}
      </Box>

      {/* Key hints + footer */}
      <Box flexDirection="column" paddingX={1}>
        {attachments.length > 1 && (
          <Text color={theme.help.desc}>
            <Text color={theme.help.key}>j/k</Text>: select attachment
          </Text>
        )}
        {attachments.length > 0 && (
          <Text color={theme.help.desc}>
            <Text color={theme.help.key}>o</Text> open{"  "}
            <Text color={theme.help.key}>s</Text> save{"  "}
            <Text color={theme.help.key}>y</Text> copy{"  "}
            <Text color={theme.help.key}>f</Text> reveal{"  "}
            <Text color={theme.help.key}>a</Text> export all
          </Text>
        )}
        <Text color={theme.drawer.label}>Esc/q to close</Text>
      </Box>
    </Box>
  );
}
