import { Box, Text } from "ink";
import { memo } from "react";
import { defaultBindings } from "../keymap.js";
import type { Theme } from "../themes/index.js";

interface Props {
  focus: string;
  theme: Theme;
}

// Context-sensitive footer. The drill ladder mirrors the keymap registry —
// each focus exposes the bindings most useful at that depth.
function HelpBarImpl({ focus, theme }: Props) {
  const hints =
    focus === "view"
      ? "[h] back  [j/k/Ctrl-d/u] scroll  [r] reply  [d] download  [i] preview img  [?] help"
      : focus === "message"
        ? "[j/k] msg  [l/Enter] open  [h/q] back to threads  [r] reply  [?] help"
        : focus === "threads"
          ? "[j/k] navigate  [l/Enter] open  [/] search  [:] command  [?] help  [Q] quit"
          : "[j/k] label  [l/Enter] select  [Tab] focus next  [?] help  [Q] quit";
  void defaultBindings;
  return (
    <Box paddingX={1}>
      <Text color={theme.helpBarFg}>{hints}</Text>
    </Box>
  );
}

export const HelpBar = memo(HelpBarImpl);
