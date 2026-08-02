/**
 * Sidebar row for an analytics module instance. Matches the visual rhythm of
 * ConversationItem (3 content rows + separator) so cursor math in App.tsx
 * works without a per-module height table.
 */
import { Box, Text } from "ink";
import { useTheme } from "../../themes/ThemeContext.js";
import type { ModuleSidebarItemProps } from "../types.js";
import type { AnalyticsState } from "./module.js";
import { ANALYTIC_LABEL } from "./Pane.js";

export function AnalyticsSidebarItem({
  instance,
  selected,
  focused,
  width,
  lineNum,
  isLast,
}: ModuleSidebarItemProps) {
  const theme = useTheme();
  const state = instance.state as AnalyticsState;
  const accent = instance.accentColor ?? theme.status.accent;

  return (
    <Box flexDirection="column" width={width}>
      <Box
        flexDirection="column"
        width={width}
        backgroundColor={selected ? theme.sidebar.selected : undefined}
      >
        {/* Title row */}
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
            {ANALYTIC_LABEL[state.type]}
          </Text>
        </Box>

        {/* Subtitle row */}
        <Box width={width} paddingLeft={5}>
          <Text color={theme.sidebar.snippet} wrap="truncate">
            range: {state.range}
          </Text>
        </Box>

        {/* Module-id row — matches slug position */}
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
