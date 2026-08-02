import { Box, Text } from "ink";
import type { DevStatsData } from "../hooks/useDevStats.js";
import { useTheme } from "../themes/ThemeContext.js";

interface Props {
  stats: DevStatsData;
  width: number;
}

export function DevStats({ stats, width }: Props) {
  const theme = useTheme();
  const engineColor = stats.engine.startsWith("Rust") ? theme.rustEngine : theme.status.accent;
  const cpuColor =
    stats.cpuPercent > 50 ? theme.cpuHigh : stats.cpuPercent > 20 ? theme.edited : theme.info.value;

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderColor={theme.border}
      overflow="hidden"
    >
      <Box paddingX={1} backgroundColor={theme.header.dim.bg}>
        <Text color={theme.header.dim.fg} bold>
          Stats
        </Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {/*
         * Engine row is the only stat whose value ("Rust parser + TS DB") is
         * wider than the narrow stats column. With `justifyContent="space-between"`
         * Ink wraps the value mid-string and interleaves it with the label
         * (showing `EngiRust parser` / `e   + TS DB`). Stack label-above-value
         * for this row so the value gets the full column width.
         */}
        <Text color={theme.info.label}>Engine</Text>
        <Text color={engineColor} bold>
          {stats.engine}
        </Text>
        <Box justifyContent="space-between">
          <Text color={theme.info.label}>CPU</Text>
          <Text color={cpuColor}>{stats.cpuPercent}%</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color={theme.info.label}>Mem</Text>
          <Text color={theme.info.value}>{stats.memMB}MB</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color={theme.info.label}>PID</Text>
          <Text color={theme.info.value}>{stats.pid}</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color={theme.info.label}>Up</Text>
          <Text color={theme.info.value}>{stats.uptime}</Text>
        </Box>
        {stats.lastQueryMs !== null && (
          <Box justifyContent="space-between">
            <Text color={theme.info.label}>Query</Text>
            <Text color={stats.lastQueryMs > 500 ? theme.edited : theme.sms}>
              {stats.lastQueryMs}ms
            </Text>
          </Box>
        )}
        <Box justifyContent="space-between">
          <Text color={theme.info.label}>Lag</Text>
          <Text
            color={
              stats.eventLoopP99Ms > 500
                ? theme.cpuHigh
                : stats.eventLoopP99Ms > 100
                  ? theme.edited
                  : theme.info.value
            }
          >
            {stats.eventLoopP99Ms}ms
          </Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color={theme.info.label}>Active</Text>
          <Text color={theme.info.value}>{stats.lastActivityAgo}</Text>
        </Box>
      </Box>
    </Box>
  );
}

/** Compact inline stats for the status bar (when full panel is hidden).
 *
 * Engine label is abbreviated (full "Rust parser + TS DB" → "Rust+TS")
 * so the bar fits on standard 80-col terminals without colliding with
 * the left-side service/handle segment. The full panel (toggled with
 * `d`) keeps the verbose label.
 *
 * flexShrink={0} keeps the gap={1} separators intact even when the
 * parent StatusBar's right-side Box is being squeezed by a long toast
 * — without it the row would render as "TS0%0MB" instead of "TS 0% 0MB".
 */
export function CompactStats({ stats }: { stats: DevStatsData }) {
  const theme = useTheme();
  const engineColor = stats.engine.startsWith("Rust") ? theme.rustEngine : theme.status.accent;
  const compactEngine = stats.engine
    .replace("Rust parser + TS DB", "Rust+TS")
    .replace("Rust parser + Rust DB", "Rust")
    .replace("TS parser + TS DB", "TS");
  return (
    <Box gap={1} flexShrink={0}>
      <Text color={engineColor}>{compactEngine}</Text>
      <Text color={theme.info.label}>{stats.cpuPercent}%</Text>
      <Text color={theme.info.label}>{stats.memMB}MB</Text>
      <Text color={theme.info.label}>PID:{stats.pid}</Text>
    </Box>
  );
}
