/**
 * Default sidebar row renderer used when a feature module doesn't supply its
 * own. Visually mirrors `ConversationItem` (3 rows + separator) so the
 * sidebar cursor math is unchanged.
 */
import { Box, Text } from "ink";
import type { ModuleSidebarItemProps } from "../modules/types.js";
import { useTheme } from "../themes/ThemeContext.js";

export function DefaultModuleSidebarItem({
  instance,
  selected,
  focused,
  width,
  lineNum,
  isLast,
}: ModuleSidebarItemProps) {
  const theme = useTheme();
  const accent = instance.accentColor ?? theme.status.accent;

  return (
    <Box flexDirection="column" width={width}>
      <Box
        flexDirection="column"
        width={width}
        backgroundColor={selected ? theme.sidebar.selected : undefined}
      >
        <Box width={width}>
          {lineNum !== undefined && (
            <Text color={selected && focused ? theme.sent.bg : theme.lineNum}>
              {lineNum.padStart(3)}{" "}
            </Text>
          )}
          <Text color={selected && focused ? theme.sent.bg : accent}>
            {selected && focused ? "▸" : "✦"}
          </Text>
          <Text color={selected ? theme.sidebar.selectedFg : accent} bold>
            {" "}
            {instance.title}
          </Text>
        </Box>

        <Box width={width} paddingLeft={5}>
          <Text color={theme.sidebar.snippet} wrap="truncate">
            {instance.subtitle ?? ""}
          </Text>
        </Box>

        <Box
          width={width}
          justifyContent="flex-end"
          paddingRight={1}
          backgroundColor={theme.sidebar.slugBg}
        >
          <Text color={theme.sidebar.slug} dimColor italic>
            ✦{instance.moduleId}
          </Text>
        </Box>
      </Box>

      {!isLast && (
        <Box paddingX={1}>
          <Text color={theme.sidebar.separator} dimColor>
            {theme.glyphs.separator.repeat(Math.max(width - 4, 1))}
          </Text>
        </Box>
      )}
    </Box>
  );
}
