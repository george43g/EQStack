import { Box, Text } from "ink";
import { memo } from "react";
import type { Theme } from "../themes/index.js";

interface Props {
  prompt: string;
  theme: Theme;
}

function ConfirmModalImpl({ prompt, theme }: Props) {
  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      borderStyle="double"
      borderColor={theme.warning}
    >
      <Text color={theme.warning} bold>
        Confirm
      </Text>
      <Box marginTop={1}>
        <Text color={theme.fg}>{prompt}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>{`[y] yes   [n / Esc] no`}</Text>
      </Box>
    </Box>
  );
}

export const ConfirmModal = memo(ConfirmModalImpl);
