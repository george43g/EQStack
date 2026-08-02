import { TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useTheme } from "../themes/ThemeContext.js";
import type { Mode } from "../types.js";

interface Props {
  mode: Mode;
  recipientName: string;
  onChangeText: (text: string) => void;
  onSubmit: (text: string) => void;
}

export function ComposeBar({ mode, recipientName, onChangeText, onSubmit }: Props) {
  const theme = useTheme();
  if (mode === "confirm") {
    return (
      <Box backgroundColor={theme.compose.bg} paddingX={1} height={1}>
        <Text color={theme.status.accent} bold>
          Send to {recipientName}?{" "}
        </Text>
        <Text color={theme.compose.fg}>Enter: send Esc: cancel</Text>
      </Box>
    );
  }

  if (mode === "compose") {
    return (
      <Box backgroundColor={theme.compose.bg} paddingX={1} height={1}>
        <Text color={theme.compose.fg}>&gt; </Text>
        <TextInput onChange={onChangeText} onSubmit={onSubmit} placeholder="Type a message..." />
      </Box>
    );
  }

  return null;
}
