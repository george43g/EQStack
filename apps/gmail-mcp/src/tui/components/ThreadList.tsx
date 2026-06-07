import { Box, Text } from "ink";
import { memo } from "react";
import type { ThreadList as ThreadListT } from "../reducer.js";
import type { Theme } from "../themes/index.js";

interface Props {
  threads: ThreadListT | null;
  cursor: number;
  focused: boolean;
  theme: Theme;
  title: string;
}

function ThreadListImpl({ threads, cursor, focused, theme, title }: Props) {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      paddingX={1}
      paddingY={1}
      borderStyle="single"
      borderColor={focused ? theme.accent : theme.border}
    >
      <Text color={theme.accent} bold>
        {title}
      </Text>
      <Box height={1} />
      {!threads ? (
        <Text color={theme.dim}>(loading)</Text>
      ) : threads.threads.length === 0 ? (
        <Text color={theme.dim}>(no threads)</Text>
      ) : (
        threads.threads.map((t, i) => {
          const selected = focused && i === cursor;
          const from = truncate(senderName(t.latestMessage.from), 22);
          const account =
            "accountId" in t && t.accountId
              ? `[${t.accountId}${t.emailAddress ? ` ${t.emailAddress}` : ""}] `
              : "";
          const subject = `${account}${t.latestMessage.subject || "(no subject)"}`;
          const dateStr = relativeDate(t.latestMessage.date);
          const indicator = t.messageCount > 1 ? `(${t.messageCount})` : "";
          // Selected rows lead with an arrow marker so the focused row is
          // unmistakable even on monochrome terminals or muted themes.
          // Two-line rows would land more snippet preview but Ink 7's
          // flex layout drops sibling text rows when the column is
          // overfilled, so we hold at one row per thread; a scroll
          // window + dense rows is a follow-up.
          const cursorMark = selected ? "❯" : " ";
          const raw = `${cursorMark} ${dateStr.padEnd(8)} ${from.padEnd(22)} ${subject} ${indicator}`;
          const ROW_TARGET = 120;
          const padded = raw.padEnd(ROW_TARGET);
          return (
            <Text
              key={t.threadId}
              color={selected ? theme.selectedFg : theme.fg}
              backgroundColor={selected ? theme.selectedBg : undefined}
              wrap="truncate"
            >
              {padded}
            </Text>
          );
        })
      )}
    </Box>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}…`;
}

// Strip the `<addr>` half of an RFC-5322 `Name <addr>` form so the thread
// row leads with the human-readable name. Falls back to the raw address
// when no name is present (still useful for noreply-style senders).
function senderName(raw: string): string {
  const m = raw.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  return m ? m[1].trim() : raw.trim();
}

function relativeDate(raw: string): string {
  // Gmail returns RFC 5322 dates. Best-effort format: "Mon 13" or "13:45".
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const sameYear = d.getFullYear() === now.getFullYear();
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
  if (sameYear) return `${months[d.getMonth()]} ${d.getDate().toString().padStart(2, " ")}`;
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d.getDate().toString().padStart(2, "0")}`;
}

export const ThreadList = memo(ThreadListImpl);
