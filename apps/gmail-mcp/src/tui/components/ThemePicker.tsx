import { Box, Text } from "ink";
import { memo } from "react";
import { listThemeNames, type Theme, themes } from "../themes/index.js";

interface Props {
  cursor: number;
  current: string;
  theme: Theme;
}

function ThemePickerImpl({ cursor, current, theme }: Props) {
  const names = listThemeNames();
  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      borderStyle="single"
      borderColor={theme.accent}
    >
      <Text color={theme.accent} bold>
        Theme
      </Text>
      <Box height={1} />
      {names.map((name, i) => {
        const selected = i === cursor;
        const active = name === current;
        const meta = themes[name];
        const note = meta?.nerd ? "  (requires Nerd Font)" : "";
        return (
          <Text
            key={name}
            color={selected ? theme.selectedFg : theme.fg}
            backgroundColor={selected ? theme.selectedBg : undefined}
            bold={active}
          >
            {`${active ? "*" : " "} ${name}${note}`}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text color={theme.dim}>{`[j/k] navigate  [Enter] apply  [Esc] close`}</Text>
      </Box>
    </Box>
  );
}

export const ThemePicker = memo(ThemePickerImpl);
