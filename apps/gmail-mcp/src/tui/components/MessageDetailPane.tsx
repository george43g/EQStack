import { Box, Text, useStdout } from "ink";
import { memo } from "react";
import type { ThreadView } from "../reducer.js";
import type { Theme } from "../themes/index.js";
import { normalize, senderColor, senderDisplayName } from "../util/sender-color.js";

interface Props {
  thread: ThreadView | null;
  cursor: number;
  focused: boolean;
  theme: Theme;
  /** Number of body lines hidden above the visible window (j/k/Ctrl-d scroll). */
  bodyScroll: number;
}

// Full-body single-message view — the rightmost drill-down pane. Renders
// every line of the body as its own `<Text>` with an explicit
// `backgroundColor` so cell content from the previous frame can't leak
// through Ink 7's diff renderer (the same `Box backgroundColor` no-op that
// hit the modals — this pane lives outside the modal takeover so it has
// to defend itself).

// Pane geometry consumed by the bleed-fix row padding. These constants must
// match the App.tsx layout: sidebar default ~22 cols + MessageListPane fixed
// 56 cols (width prop) + 4 borders + padding on each side + this pane's
// border + padding. Empirically tuned against the live tmux capture.
const SIDEBAR_COLS = 22;
const MESSAGE_LIST_COLS = 56;

function MessageDetailPaneImpl({ thread, cursor, focused, theme, bodyScroll }: Props) {
  const { stdout } = useStdout();
  const terminalCols = stdout?.columns ?? 180;
  // Reserve ~9 rows for borders + header block + spacer + status bar + helpbar.
  // The remaining vertical real estate is the body viewport. With a 50-row
  // terminal that's typically 41 body lines visible at once.
  const terminalRows = stdout?.rows ?? 50;
  const bodyViewportRows = Math.max(6, terminalRows - 9);
  // Pad generously past the visible pane width — truncate clips to the
  // actual visible cells. The `…` ellipsis appears at the row end but every
  // interior cell still gets a bg-coloured write, so prior-frame content
  // can't peek through. Cleaner than fighting Ink's flex layout to compute
  // the exact width.
  const paneInner = Math.max(40, terminalCols - SIDEBAR_COLS - MESSAGE_LIST_COLS);
  if (!thread || thread.messages.length === 0) {
    return (
      <Box
        flexDirection="column"
        flexGrow={1}
        paddingX={1}
        paddingY={1}
        borderStyle="single"
        borderColor={focused ? theme.accent : theme.border}
      >
        <Text color={theme.dim}>(no message selected — press l on a thread)</Text>
      </Box>
    );
  }
  const idx = Math.min(Math.max(0, cursor), thread.messages.length - 1);
  const msg = thread.messages[idx];
  if (!msg) {
    return (
      <Box
        flexDirection="column"
        flexGrow={1}
        paddingX={1}
        paddingY={1}
        borderStyle="single"
        borderColor={focused ? theme.accent : theme.border}
      >
        <Text color={theme.dim}>(message not found)</Text>
      </Box>
    );
  }
  const accountTag =
    "accountId" in msg && msg.accountId
      ? ` [${msg.accountId}${msg.emailAddress ? ` <${msg.emailAddress}>` : ""}]`
      : "";
  const senderHue = senderColor(theme, msg.from);
  const fromAddr = normalize(msg.from);
  const fromName = senderDisplayName(msg.from);
  const allBodyLines = (msg.body || "").split(/\r?\n/);
  const totalBodyLines = allBodyLines.length;
  // Clamp the scroll: if the message has shrunk under us, snap to the last
  // possible "page-top" rather than rendering past the end.
  const maxScroll = Math.max(0, totalBodyLines - bodyViewportRows);
  const clampedScroll = Math.min(Math.max(0, bodyScroll), maxScroll);
  const bodyLines = allBodyLines.slice(clampedScroll, clampedScroll + bodyViewportRows);
  // Scroll indicator — shown only when the body actually overflows. Mirrors
  // vim's `↓ <line>/<total>` status line; less.
  const scrollIndicator =
    totalBodyLines > bodyViewportRows
      ? ` · body ${clampedScroll + 1}–${Math.min(clampedScroll + bodyLines.length, totalBodyLines)} / ${totalBodyLines}`
      : "";
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      paddingX={1}
      borderStyle="single"
      borderColor={focused ? theme.accent : theme.border}
    >
      {/* Explicit spacer row instead of paddingY — when paddingY is set, the
          first child Row mysteriously fails to render under Ink 7's flex
          column layout (root cause unclear; appears related to padding-box
          collapsing with the first text node). The spacer Row also has a
          backgroundColor write to keep the bleed contract intact. */}
      <Row theme={theme} color={theme.dim} width={paneInner}>
        {" "}
      </Row>
      {/* Header block — each row is its own Text so Ink writes every cell.
          Subject leads (accent colour) so the email is immediately readable;
          position + metadata follow. */}
      <Row theme={theme} color={theme.accent} width={paneInner}>
        {msg.subject || "(no subject)"}
      </Row>
      <Row theme={theme} color={theme.dim} width={paneInner}>
        {`Message ${idx + 1} of ${thread.messages.length}${accountTag}${scrollIndicator}`}
      </Row>
      <Row theme={theme} color={senderHue} width={paneInner}>
        {`From: ${fromName} <${fromAddr}>`}
      </Row>
      <Row theme={theme} color={theme.dim} width={paneInner}>
        {`Date: ${formatFullDate(msg.date)}`}
      </Row>
      <Box height={1} />
      {/* Body */}
      {bodyLines.length === 0 ? (
        <Row theme={theme} color={theme.dim} width={paneInner}>
          (empty body)
        </Row>
      ) : (
        // Stable key: messageId-scoped offset. Body lines for a given
        // message render in a fixed order, so `${messageId}:<offset>` is
        // stable across rerenders without falling back to the index. We
        // pass `startIndex` so keys reflect the absolute line position
        // even when the user has scrolled — otherwise keys collide as
        // scroll moves a different slice of lines into the visible window.
        bodyLineRows(msg.messageId, bodyLines, theme, paneInner, clampedScroll)
      )}
      {/* Attachments */}
      {msg.attachments.length > 0 ? (
        <>
          <Box height={1} />
          <Row theme={theme} color={theme.warning} width={paneInner}>
            {`Attachments (${msg.attachments.length}):`}
          </Row>
          {attachmentRows(msg.messageId, msg.attachments, theme, paneInner)}
        </>
      ) : null}
    </Box>
  );
}

// Pane is widthflex-bound by App.tsx but body text varies wildly. To stop
// prior-frame cell content leaking through (Ink 7's diff renderer doesn't
// paint cells past a row's text length), every row is right-padded with
// spaces to a fixed safe-large width and wrap="truncate" clips it back
// to the visible pane. The bg-colored padding writes every interior cell,
// so the previous frame's content can't peek through anywhere.
//
// Caveat: `bold` is intentionally avoided on header rows — Ink-7 + this
// pane's flex layout drops bold rows entirely under some conditions
// (observed: switching threads where one msg has a long sender address
// renders the subject + From rows as completely blank). Plain text always
// renders.
function Row({
  theme,
  color,
  width,
  children,
}: {
  theme: Theme;
  color: string;
  width: number;
  children: React.ReactNode;
}) {
  const text = typeof children === "string" ? children : String(children ?? "");
  return (
    <Text color={color} backgroundColor={theme.bg} wrap="truncate">
      {text.padEnd(width)}
    </Text>
  );
}

function bodyLineRows(
  messageId: string,
  lines: string[],
  theme: Theme,
  width: number,
  startIndex: number,
): React.ReactNode {
  // Absolute line index → key. Stable across scroll positions so React
  // doesn't reshuffle DOM/Ink nodes when the user pages through the body.
  return lines.map((line, i) => {
    const key = `${messageId}:line-${startIndex + i}`;
    return (
      <Row key={key} theme={theme} color={theme.fg} width={width}>
        {line || " "}
      </Row>
    );
  });
}

function attachmentRows(
  messageId: string,
  attachments: Array<{ filename: string; mimeType: string; size: number }>,
  theme: Theme,
  width: number,
): React.ReactNode {
  return attachments.map((a) => {
    // `get_thread` doesn't include the attachment id — only `read_email`
    // does (Phase D2 follow-up). Compose a key from messageId + filename so
    // a re-fetched thread keeps the same React identity per row.
    const key = `${messageId}:${a.filename}`;
    return (
      <Row key={key} theme={theme} color={theme.warning} width={width}>
        {`  · ${a.filename}${a.mimeType ? ` (${a.mimeType})` : ""}${a.size ? ` · ${formatBytes(a.size)}` : ""}`}
      </Row>
    );
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function formatFullDate(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const day = days[d.getDay()];
  const dd = d.getDate().toString().padStart(2, "0");
  const month = months[d.getMonth()];
  const yyyy = d.getFullYear();
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${day}, ${dd} ${month} ${yyyy} ${hh}:${mm}`;
}

export const MessageDetailPane = memo(MessageDetailPaneImpl);
