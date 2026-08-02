import { Box, Text } from "ink";
import type React from "react";
import type { Conversation } from "../../types.js";
import { useTheme } from "../themes/ThemeContext.js";

interface Props {
  totalUnread: number;
  selected: Conversation | undefined;
  status: string;
  loading: boolean;
  children?: React.ReactNode;
}

export function StatusBar({ totalUnread, selected, status, loading, children }: Props) {
  const theme = useTheme();
  return (
    <Box backgroundColor={theme.status.bg} paddingX={1} height={1} justifyContent="space-between">
      {/* Each segment uses flexShrink={0} so the row's `gap={2}` separators
       * don't collapse when the status toast on the right side grows —
       * pre-fix you'd see "Mum SMSRust parser + TS 0%0MB" glued together.
       * The status text on the right truncates to a single line instead of
       * wrapping onto a second row. */}
      <Box gap={2} flexShrink={0}>
        {totalUnread > 0 && (
          <Text color={theme.status.accent} bold>
            ● {totalUnread} unread
          </Text>
        )}
        {selected && (
          <Text color={theme.status.fg}>{selected.displayName ?? selected.chatIdentifier}</Text>
        )}
        {selected && (
          <Text color={selected.serviceType === "SMS" ? theme.sms : theme.info.label}>
            {selected.serviceType}
          </Text>
        )}
      </Box>
      <Box gap={2} flexShrink={1} overflow="hidden">
        {children}
        <Text color={theme.status.fg} wrap="truncate">
          {loading ? "loading..." : status}
        </Text>
      </Box>
    </Box>
  );
}
