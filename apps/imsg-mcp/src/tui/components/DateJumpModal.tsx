/**
 * Date-jump modal — two input modes:
 *   - picker (default): three-field YYYY-MM-DD picker, arrow-keys for navigation.
 *   - text: free-form text input, parsed via `parseUserDate` (handles ISO,
 *     keywords like "yesterday", relative phrases like "2 weeks ago",
 *     compact "5d/2w/3m/1y", etc).
 *
 * `Tab` (when the inner field doesn't claim it) toggles between modes. The
 * existing caller path is preserved: `onSubmit` always receives a string,
 * either a free-form expression (text mode) or a normalized ISO date
 * (picker mode). Both flow through `parseUserDate` downstream.
 */
import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useTheme } from "../themes/ThemeContext.js";
import { DatePicker } from "./DatePicker.js";

type Mode = "picker" | "text";

interface Props {
  value: string;
  error: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
}

export function DateJumpModal({ value, error, onChange, onSubmit }: Props) {
  const theme = useTheme();
  const [mode, setMode] = useState<Mode>("picker");

  // Tab swaps modes. Listen at the modal level so the swap fires regardless
  // of which inner widget has focus.
  useInput((_input, key) => {
    if (key.tab && !key.shift) {
      setMode((m) => (m === "picker" ? "text" : "picker"));
    }
  });

  // Opaque background + flexShrink={0} on every row matches the modal
  // discipline used by ComposeRecipientModal / SendViaModal — without
  // these, conversation-list slugs from the sidebar leak through the
  // modal's interior (visible bug in live tmux tests).
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.status.accent}
      backgroundColor={theme.header.dim.bg}
      paddingX={1}
      flexShrink={0}
    >
      <Box flexShrink={0}>
        <Text color={theme.status.accent} bold>
          Jump to date
        </Text>
        <Text color={theme.help.desc}>
          {"  "}[{mode}] · Tab to switch
        </Text>
      </Box>

      {mode === "picker" ? (
        <DatePicker
          focused
          onSubmit={onSubmit}
          onCancel={() => {
            // Esc handled by the App's date-jump exit branch — DatePicker
            // forwards it via onCancel but we leave actual exit to the parent.
          }}
        />
      ) : (
        <Box flexDirection="column" flexShrink={0}>
          <Box flexShrink={0}>
            <Text color={theme.info.label}>Date: </Text>
            <TextInput
              defaultValue={value}
              onChange={onChange}
              onSubmit={onSubmit}
              placeholder="2024-03-15  |  3/15  |  yesterday  |  2 weeks ago  |  1y"
            />
          </Box>
          <Box flexShrink={0}>
            <Text color={theme.help.desc}>
              Formats: YYYY-MM-DD · M/D · today · yesterday · N days/weeks/months/years ago · 5d /
              2w / 3m / 1y
            </Text>
          </Box>
        </Box>
      )}

      {error && (
        <Box flexShrink={0}>
          <Text color={theme.edited}>{error}</Text>
        </Box>
      )}

      <Box flexShrink={0}>
        <Text color={theme.help.desc}>Enter: jump · Esc: cancel · Tab: switch mode</Text>
      </Box>
    </Box>
  );
}
