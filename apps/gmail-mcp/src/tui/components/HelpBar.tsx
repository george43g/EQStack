import { Box, Text } from "ink";
import { memo } from "react";
import { defaultBindings } from "../keymap.js";
import type { Theme } from "../themes/index.js";

interface Props {
  focus: string;
  theme: Theme;
}

// Context-sensitive footer. For Session 1 we just surface the most-used keys.
function HelpBarImpl({ focus, theme }: Props) {
  const hints =
    focus === "message"
      ? "[j/k] msg  [q] back  [r] reply  [R] reply-all  [?] help  [Q] quit"
      : focus === "threads"
        ? "[j/k] navigate  [Enter] open  [/] search  [:] command  [?] help  [Q] quit"
        : "[j/k] label  [Enter] select  [Tab] focus next  [?] help  [Q] quit";
  void defaultBindings;
  return (
    <Box paddingX={1}>
      <Text color={theme.helpBarFg}>{hints}</Text>
    </Box>
  );
}

export const HelpBar = memo(HelpBarImpl);
