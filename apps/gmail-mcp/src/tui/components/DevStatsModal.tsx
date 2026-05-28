import { Box, Text } from "ink";
import { memo } from "react";
import type { DevStats } from "../hooks/useDevStats.js";
import type { Theme } from "../themes/index.js";

interface Props {
  stats: DevStats | null;
  theme: Theme;
}

function DevStatsModalImpl({ stats, theme }: Props) {
  return (
    <Box
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      borderStyle="round"
      borderColor={theme.accent}
      width={40}
    >
      <Text color={theme.accent} bold>
        Dev stats
      </Text>
      {!stats ? (
        <Text color={theme.dim}>(collecting…)</Text>
      ) : (
        <>
          <Row label="status" value={stats.health.status} theme={theme} />
          <Row label="uptime" value={`${stats.health.uptime_s.toFixed(0)} s`} theme={theme} />
          <Row label="heap" value={`${stats.health.heap_mb.toFixed(1)} MB`} theme={theme} />
          <Row label="rss" value={`${stats.health.rss_mb.toFixed(1)} MB`} theme={theme} />
          <Row
            label="loop p99"
            value={`${stats.health.event_loop_p99_ms.toFixed(0)} ms`}
            theme={theme}
          />
          <Row label="tool calls" value={String(stats.health.tool_calls)} theme={theme} />
          <Row label="errors" value={String(stats.health.recent_errors)} theme={theme} />
          <Row
            label="cache"
            value={`${stats.cacheEntries} entries / ${(stats.cacheBytes / 1024).toFixed(0)} KB`}
            theme={theme}
          />
          <Row label="renders" value={String(stats.renderCount)} theme={theme} />
          <Row label="theme" value={stats.themeName} theme={theme} />
          <Row label="editor" value={stats.editor} theme={theme} />
          {stats.health.issues.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.warning}>issues:</Text>
              {stats.health.issues.map((i) => (
                <Text key={i} color={theme.warning}>{`  ${i}`}</Text>
              ))}
            </Box>
          ) : null}
        </>
      )}
      <Box marginTop={1}>
        <Text color={theme.dim}>{`press ~ or :stats to close`}</Text>
      </Box>
    </Box>
  );
}

function Row({ label, value, theme }: { label: string; value: string; theme: Theme }) {
  return (
    <Box flexDirection="row">
      <Text color={theme.dim}>{`${label.padEnd(11)} `}</Text>
      <Text color={theme.fg}>{value}</Text>
    </Box>
  );
}

export const DevStatsModal = memo(DevStatsModalImpl);
