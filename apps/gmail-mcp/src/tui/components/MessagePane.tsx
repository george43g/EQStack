import { Box, Text } from "ink";
import { memo } from "react";
import type { ThreadView } from "../reducer.js";
import type { Theme } from "../themes/index.js";

interface Props {
  thread: ThreadView | null;
  cursor: number;
  focused: boolean;
  theme: Theme;
}

function MessagePaneImpl({ thread, cursor, focused, theme }: Props) {
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
        Message
      </Text>
      <Box height={1} />
      {!thread ? (
        <Text color={theme.dim}>(no thread open — press Enter on a thread)</Text>
      ) : (
        thread.messages.map((msg, i) => {
          const isCursor = focused && i === cursor;
          const account =
            "accountId" in msg && msg.accountId
              ? ` [${msg.accountId}${msg.emailAddress ? ` <${msg.emailAddress}>` : ""}]`
              : "";
          const header = `${msg.from}${account}   ${msg.date}`;
          const subject = msg.subject || "(no subject)";
          return (
            <Box key={msg.messageId} flexDirection="column" marginBottom={1}>
              <Text
                color={isCursor ? theme.selectedFg : theme.accent}
                backgroundColor={isCursor ? theme.selectedBg : undefined}
                bold
              >
                {subject}
              </Text>
              <Text color={theme.dim}>{header}</Text>
              <Box marginTop={1}>
                <Text color={theme.fg}>{truncateBody(msg.body)}</Text>
              </Box>
              {msg.attachments.length > 0 ? (
                <Box marginTop={1}>
                  <Text color={theme.warning}>
                    {`* ${msg.attachments.length} attachment(s): ${msg.attachments
                      .map((a) => a.filename)
                      .join(", ")}`}
                  </Text>
                </Box>
              ) : null}
            </Box>
          );
        })
      )}
    </Box>
  );
}

function truncateBody(body: string): string {
  // Show a viewport-sized chunk. Real scroll comes in Session 2.
  const lines = body.split(/\r?\n/).slice(0, 40);
  const truncated = lines.join("\n");
  if (body.length > truncated.length) return `${truncated}\n…`;
  return truncated;
}

export const MessagePane = memo(MessagePaneImpl);
