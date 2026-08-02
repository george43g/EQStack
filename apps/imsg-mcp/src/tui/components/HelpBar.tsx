import { Box, Text } from "ink";
import { useTheme } from "../themes/ThemeContext.js";
import type { FocusPane, Mode } from "../types.js";

interface Props {
  mode: Mode;
  focus?: FocusPane;
}

const PALETTE_HINT: [string, string] = ["^P", "palette"];

const SIDEBAR_KEYS = [
  ["j/k", "move"],
  ["#j/k", "jump"],
  ["gg/G", "top/btm"],
  ["^d/u", "½page"],
  ["y", "copy slug"],
  ["N", "new msg"],
  ["Tab", "→msgs"],
  ["/", "filter"],
  [",", "settings"],
  ["d", "stats"],
  ["r", "refresh"],
  PALETTE_HINT,
  ["q", "quit"],
];

const THREAD_KEYS = [
  ["j/k", "move"],
  ["#j/k", "jump"],
  ["{/}", "grp jump"],
  ["gg/G", "top/btm"],
  ["^d/u", "½page"],
  ["V", "select"],
  [":", "date jump"],
  ["Enter", "details"],
  ["i", "info/att"],
  ["o", "open att"],
  ["O", "open in Msgs"],
  ["S", "send-via"],
  ["c", "compose"],
  PALETTE_HINT,
  ["Tab", "→list"],
];

const PALETTE_KEYS = [
  ["type", "filter"],
  ["↑↓", "move"],
  ["Enter", "run"],
  ["Esc", "close"],
];

const SEND_VIA_KEYS = [
  ["1-9", "pick app"],
  ["Esc", "cancel"],
];

const SELECT_KEYS = [
  ["j/k", "extend"],
  ["{/}", "grp"],
  ["gg/G", "top/btm"],
  ["^d/u", "½page"],
  ["e", "export"],
  ["y", "copy text"],
  ["Esc", "exit select"],
];

const EXPORT_KEYS = [
  ["Tab", "fmt: md/csv/json"],
  ["Enter", "save"],
  ["Esc", "cancel"],
];

const DATE_JUMP_KEYS = [
  ["Tab", "picker↔text"],
  ["←/→", "field"],
  ["↑/↓", "adjust"],
  ["Enter", "jump"],
  ["Esc", "cancel"],
];

const COMPOSE_KEYS = [
  ["Enter", "send"],
  ["Esc", "cancel"],
];

const COMPOSE_NEW_KEYS = [
  ["type", "phone/email/contact"],
  ["Enter", "next"],
  ["Esc", "cancel"],
];

const FILTER_KEYS = [["Enter/Esc", "exit filter"]];

const DRAWER_KEYS = [
  ["j/k", "select attachment"],
  ["o", "open"],
  ["s", "save"],
  ["y", "copy path"],
  ["Esc/q", "close"],
];

const INFO_KEYS = [
  ["j/k", "select"],
  ["o", "open"],
  ["s", "save"],
  ["y", "copy path"],
  ["a", "export all"],
  ["Esc/q", "close"],
];

const SETTINGS_KEYS = [
  ["j/k", "move"],
  ["␣", "toggle"],
  ["←/→", "adjust"],
  ["K/J", "reorder"],
  ["Esc/q", "close"],
];

export function HelpBar({ mode, focus }: Props) {
  const theme = useTheme();
  let keys: string[][];
  if (mode === "compose-new") keys = COMPOSE_NEW_KEYS;
  else if (mode === "compose" || mode === "confirm") keys = COMPOSE_KEYS;
  else if (mode === "filter") keys = FILTER_KEYS;
  else if (mode === "drawer") keys = DRAWER_KEYS;
  else if (mode === "info") keys = INFO_KEYS;
  else if (mode === "settings") keys = SETTINGS_KEYS;
  else if (mode === "select") keys = SELECT_KEYS;
  else if (mode === "export") keys = EXPORT_KEYS;
  else if (mode === "date-jump") keys = DATE_JUMP_KEYS;
  else if (mode === "send-via") keys = SEND_VIA_KEYS;
  else if (mode === "palette") keys = PALETTE_KEYS;
  else keys = focus === "thread" ? THREAD_KEYS : SIDEBAR_KEYS;

  return (
    <Box paddingX={1} height={1} gap={1}>
      {keys.map(([key, desc]) => (
        // Render each hint as a SINGLE <Text> with nested colored spans.
        // Splitting `<Text>{key}</Text>` and `<Text>:desc</Text>` into separate
        // <Text> siblings inside a row Box makes Ink's flex-shrink consider
        // each individually — when the hints overflow the terminal width (which
        // happens in thread mode with 14 entries) flex-shrink trims ONE
        // character off each child's last <Text>, eating the final char of the
        // key label (e.g. `j/k` → `j/`, `Enter` → `Ente`, `V` → ``).
        // A single <Text> with nested color spans is treated as one atomic
        // string for shrink purposes — it either fits or wraps the whole
        // hint, never partial.
        // Also `flexShrink={0}` so overflow doesn't truncate at all; if the
        // row is too narrow the trailing hints drop off the right edge
        // instead of being silently clipped char-by-char.
        <Box key={key} flexShrink={0}>
          <Text>
            <Text color={theme.help.key}>{key}</Text>
            <Text color={theme.help.desc}>:{desc} </Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}
