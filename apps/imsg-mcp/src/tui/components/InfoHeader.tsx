import { Box, Text } from "ink";
import type { Conversation } from "../../types.js";
import { useTheme } from "../themes/ThemeContext.js";

interface Props {
  conversation: Conversation | undefined;
  resolvedNames: string[];
}

export function InfoHeader({ conversation: c, resolvedNames }: Props) {
  const theme = useTheme();
  if (!c) return <Text color={theme.info.label}>No conversation selected</Text>;

  const name = c.displayName ?? c.chatIdentifier;
  const members: string[] = [];
  for (let i = 0; i < c.participants.length; i++) {
    const handle = c.participants[i];
    const display = resolvedNames[i] ?? handle;
    members.push(display !== handle ? `${display} (${handle})` : handle);
  }

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderColor={theme.border}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    >
      <Box gap={2}>
        <Text bold color={theme.info.value}>
          {name}
        </Text>
        {c.displayName && <Text color={theme.info.label}>({c.rawIdentifier})</Text>}
        <Text color={c.serviceType === "SMS" ? theme.sms : theme.info.label}>{c.serviceType}</Text>
        {c.isGroupChat && <Text color={theme.info.label}>Group</Text>}
      </Box>
      <Text color={theme.info.label}>
        Members: <Text color={theme.info.value}>{members.join(", ")}</Text>
      </Text>
      <Text color={theme.sidebar.slug} italic>
        ~{c.threadSlug}
      </Text>
    </Box>
  );
}
