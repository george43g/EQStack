import { Box, Text } from "ink";
import { memo } from "react";
import type { DevStats } from "../hooks/useDevStats.js";
import type { Theme } from "../themes/index.js";

interface Props {
  stats: DevStats | null;
  theme: Theme;
}

// Screenshot mode: `GMAIL_TUI_STATIC_STATS=1` masks the volatile rows
// (heap / RSS / uptime / loop p99 / tool calls / cache / renders) with
// "—" so the VHS screenshot tape produces a byte-stable PNG. Stable rows
// (status / theme / editor) still render their real values.
const STATIC = process.env.GMAIL_TUI_STATIC_STATS === "1";
const MASK = STATIC ? "—" : null;

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
      {/* Under STATIC mode we always render the table layout — even on the
          first paint when the 1Hz hook hasn't populated yet — so the
          screenshot never alternates between the "(collecting…)" state
          and the loaded state depending on which React tick lands first. */}
      {!stats && !STATIC ? (
        <Text color={theme.dim}>(collecting…)</Text>
      ) : !stats ? (
        <StaticPlaceholder theme={theme} />
      ) : (
        <>
          {/* In STATIC mode pin the status to "healthy" — the real value
              swings between runs if the watchdog sees a transient event-loop
              spike, which would re-flap the screenshot drift gate. */}
          <Row label="status" value={STATIC ? "healthy" : stats.health.status} theme={theme} />
          <Row
            label="uptime"
            value={MASK ?? `${stats.health.uptime_s.toFixed(0)} s`}
            theme={theme}
          />
          <Row label="heap" value={MASK ?? `${stats.health.heap_mb.toFixed(1)} MB`} theme={theme} />
          <Row label="rss" value={MASK ?? `${stats.health.rss_mb.toFixed(1)} MB`} theme={theme} />
          <Row
            label="loop p99"
            value={MASK ?? `${stats.health.event_loop_p99_ms.toFixed(0)} ms`}
            theme={theme}
          />
          <Row label="tool calls" value={MASK ?? String(stats.health.tool_calls)} theme={theme} />
          <Row label="errors" value={MASK ?? String(stats.health.recent_errors)} theme={theme} />
          <Row
            label="cache"
            value={
              MASK ?? `${stats.cacheEntries} entries / ${(stats.cacheBytes / 1024).toFixed(0)} KB`
            }
            theme={theme}
          />
          <Row label="renders" value={MASK ?? String(stats.renderCount)} theme={theme} />
          <Row label="theme" value={stats.themeName} theme={theme} />
          <Row label="editor" value={stats.editor} theme={theme} />
          {/* STATIC mode suppresses the issues list too — its membership is
              event-loop-state-dependent and would flap the screenshot gate. */}
          {!STATIC && stats.health.issues.length > 0 ? (
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

/** Pre-populate the Row layout with mask values so the screenshot is
    layout-stable from the very first render. Only rendered in STATIC mode. */
function StaticPlaceholder({ theme }: { theme: Theme }) {
  return (
    <>
      <Row label="status" value="healthy" theme={theme} />
      <Row label="uptime" value="—" theme={theme} />
      <Row label="heap" value="—" theme={theme} />
      <Row label="rss" value="—" theme={theme} />
      <Row label="loop p99" value="—" theme={theme} />
      <Row label="tool calls" value="—" theme={theme} />
      <Row label="errors" value="—" theme={theme} />
      <Row label="cache" value="—" theme={theme} />
      <Row label="renders" value="—" theme={theme} />
      <Row label="theme" value="default" theme={theme} />
      <Row label="editor" value="vi" theme={theme} />
    </>
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
