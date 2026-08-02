/**
 * Analytics pane — renders one of six analytic types over a chosen time
 * window, computed against the unified `dispatchAnalytic` from
 * `src/analytics.ts`. Owns its own keyboard handlers via `useInput`.
 */
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { AnalyticType } from "../../../analytics.js";
import {
  type DoubleTextResult,
  dispatchAnalytic,
  type HeatmapResult,
  IMPLEMENTED_TYPES,
  type RelationshipScore,
  type ResponseTimeStats,
  type StreakResult,
  type TapbackResult,
  type WrappedResult,
} from "../../../analytics.js";
import type { Message } from "../../../types.js";
import { useTheme } from "../../themes/ThemeContext.js";
import type { ModulePaneProps } from "../types.js";
import type { AnalyticsRange, AnalyticsState } from "./module.js";

export const ANALYTIC_LABEL: Record<AnalyticType, string> = {
  messaging_streaks: "Messaging Streaks",
  double_texts: "Double Texts",
  response_time_stats: "Response Times",
  daily_heatmap: "Daily Heatmap",
  tapback_summary: "Tapback Summary",
  year_in_review_wrapped: "Year in Review (Wrapped)",
  relationship_leaderboard: "Relationship Leaderboard",
};

const RANGE_LABEL: Record<AnalyticsRange, string> = {
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "1y": "Last year",
  all: "All time",
};

const RANGE_ORDER: AnalyticsRange[] = ["30d", "90d", "1y", "all"];

/** Convert a range key to a cutoff Date. `"all"` returns the Unix epoch. */
function rangeCutoff(range: AnalyticsRange): Date {
  const now = Date.now();
  switch (range) {
    case "30d":
      return new Date(now - 30 * 86_400_000);
    case "90d":
      return new Date(now - 90 * 86_400_000);
    case "1y":
      return new Date(now - 365 * 86_400_000);
    case "all":
      return new Date(0);
  }
}

export function AnalyticsPane({
  instance,
  imsg,
  width,
  height,
  focused,
  onUpdateState,
  onClose,
  setStatus,
}: ModulePaneProps) {
  const theme = useTheme();
  const state = instance.state as AnalyticsState;
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ data: unknown } | null>(null);

  // Load messages whenever the range cutoff changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    const cutoff = rangeCutoff(state.range);
    imsg
      .loadMessagesInWindow(cutoff)
      .then((m) => {
        if (cancelled) return;
        setMessages(m);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state.range, imsg]);

  // Compute the analytic OUT of the render path. `dispatchAnalytic` on
  // 30 days of messages takes 1-3 seconds — running it in a useMemo blocked
  // the render so "Loading…" never appeared and the pane sat empty during
  // the wait. Deferring via `setTimeout(0)` lets React paint loading state
  // before the heavy compute starts on the next macrotask.
  useEffect(() => {
    if (!messages) return;
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      if (cancelled) return;
      try {
        const { data } = dispatchAnalytic(state.type, messages);
        setResult({ data });
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setResult(null);
      }
      setLoading(false);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [messages, state.type]);

  // Keyboard: Tab cycles analytic type, [/] cycles range, Esc closes.
  useInput(
    (input, key) => {
      if (key.escape) {
        onClose();
        return;
      }
      if (key.tab) {
        const cur = IMPLEMENTED_TYPES.indexOf(state.type);
        const next = IMPLEMENTED_TYPES[(cur + 1) % IMPLEMENTED_TYPES.length]!;
        onUpdateState({ ...state, type: next });
        setStatus(`Analytics: ${ANALYTIC_LABEL[next]}`);
        return;
      }
      if (input === "]" || input === ">") {
        const cur = RANGE_ORDER.indexOf(state.range);
        const next = RANGE_ORDER[(cur + 1) % RANGE_ORDER.length]!;
        onUpdateState({ ...state, range: next });
        return;
      }
      if (input === "[" || input === "<") {
        const cur = RANGE_ORDER.indexOf(state.range);
        const next = RANGE_ORDER[(cur - 1 + RANGE_ORDER.length) % RANGE_ORDER.length]!;
        onUpdateState({ ...state, range: next });
        return;
      }
    },
    { isActive: focused },
  );

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderColor={focused ? theme.status.accent : theme.border}
      overflow="hidden"
    >
      <Box
        paddingX={1}
        backgroundColor={focused ? theme.header.focused.bg : theme.header.dim.bg}
        flexShrink={0}
      >
        <Text color={focused ? theme.header.focused.fg : theme.header.dim.fg} bold={focused}>
          {ANALYTIC_LABEL[state.type]}
        </Text>
        <Text color={theme.help.desc}> · {RANGE_LABEL[state.range]}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
        {loading && <Text color={theme.help.desc}>Loading…</Text>}
        {error && <Text color={theme.edited}>Error: {error}</Text>}
        {!loading && !error && result && (
          <AnalyticsResultView
            type={state.type}
            data={result.data}
            messages={messages ?? []}
            width={width - 2}
            height={height - 4}
            resolveNames={imsg.resolveNames}
          />
        )}
      </Box>

      <Box paddingX={1} height={1} flexShrink={0}>
        <Text color={theme.help.key}>Tab</Text>
        <Text color={theme.help.desc}>:type </Text>
        <Text color={theme.help.key}>[ ]</Text>
        <Text color={theme.help.desc}>:range </Text>
        <Text color={theme.help.key}>Esc</Text>
        <Text color={theme.help.desc}>:close</Text>
      </Box>
    </Box>
  );
}

// ── Result renderers ────────────────────────────────────────────────────

interface ResultViewProps {
  type: AnalyticType;
  data: unknown;
  messages: Message[];
  width: number;
  height: number;
  resolveNames: (handles: string[]) => string[];
}

function AnalyticsResultView({
  type,
  data,
  messages,
  width,
  height,
  resolveNames,
}: ResultViewProps) {
  if (data == null) return <NoData />;
  switch (type) {
    case "messaging_streaks":
      return <StreaksView rows={data as StreakResult[]} height={height} />;
    case "double_texts":
      return <DoubleTextsView rows={data as DoubleTextResult[]} height={height} />;
    case "response_time_stats":
      return <ResponseTimesView rows={data as ResponseTimeStats[]} height={height} />;
    case "daily_heatmap":
      return <HeatmapView result={data as HeatmapResult} width={width} />;
    case "tapback_summary":
      return <TapbacksView rows={data as TapbackResult[]} height={height} />;
    case "year_in_review_wrapped":
      return <WrappedView result={data as WrappedResult} />;
    case "relationship_leaderboard":
      return (
        <LeaderboardView result={data as { leaderboard: RelationshipScore[] }} height={height} />
      );
  }
  void messages;
  void resolveNames;
}

function LeaderboardView({
  result,
  height,
}: {
  result: { leaderboard: RelationshipScore[] };
  height: number;
}) {
  const theme = useTheme();
  const rows = result.leaderboard.slice(0, Math.max(height - 3, 5));
  if (rows.length === 0) return <NoData />;
  // Raw scores are exp-decayed floats that collapse toward 0 for old data —
  // display them relative to the leader (top = 100) so ranking stays legible.
  const max = rows[0]?.score || 0;
  return (
    <Box flexDirection="column">
      {rows.map((r, i) => (
        <Box key={r.contact} gap={1}>
          <Text color={theme.lineNum}>{String(i + 1).padStart(2)}</Text>
          <Text color={theme.senderName} bold>
            {r.contact.length > 24 ? `${r.contact.slice(0, 23)}…` : r.contact}
          </Text>
          <Text color={theme.info.label}>
            {r.total} msgs · {Math.round(r.reciprocity * 100)}% recip ·{" "}
            {Math.round(r.daysSinceLast)}d ago · score{" "}
            {max > 0 ? Math.round((r.score / max) * 100) : 0}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function NoData() {
  const theme = useTheme();
  return <Text color={theme.help.desc}>No data in this window.</Text>;
}

function StreaksView({ rows, height }: { rows: StreakResult[]; height: number }) {
  const theme = useTheme();
  if (rows.length === 0) return <NoData />;
  const visible = rows.slice(0, Math.max(1, height - 2));
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.info.label}>{"Contact".padEnd(28)}</Text>
        <Text color={theme.info.label}>{"Longest".padStart(10)}</Text>
        <Text color={theme.info.label}>{"Current".padStart(10)}</Text>
        <Text color={theme.info.label}>{"  Start..End".padEnd(30)}</Text>
      </Box>
      {visible.map((r) => (
        <Box key={r.contact}>
          <Text wrap="truncate">{trunc(r.contact, 27).padEnd(28)}</Text>
          <Text color={theme.status.accent}>{`${r.longestStreakDays}d`.padStart(10)}</Text>
          <Text>{`${r.currentStreakDays}d`.padStart(10)}</Text>
          <Text color={theme.help.desc}>
            {"  "}
            {r.longestStreakStart ?? "—"}..{r.longestStreakEnd ?? "—"}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function DoubleTextsView({ rows, height }: { rows: DoubleTextResult[]; height: number }) {
  const theme = useTheme();
  if (rows.length === 0) return <NoData />;
  const visible = rows.slice(0, Math.max(1, height - 2));
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.info.label}>{"Contact".padEnd(28)}</Text>
        <Text color={theme.info.label}>{"From me".padStart(10)}</Text>
        <Text color={theme.info.label}>{"From them".padStart(12)}</Text>
      </Box>
      {visible.map((r) => (
        <Box key={r.contact}>
          <Text wrap="truncate">{trunc(r.contact, 27).padEnd(28)}</Text>
          <Text color={theme.status.accent}>{String(r.doubleTextsFromMe).padStart(10)}</Text>
          <Text>{String(r.doubleTextsFromThem).padStart(12)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function ResponseTimesView({ rows, height }: { rows: ResponseTimeStats[]; height: number }) {
  const theme = useTheme();
  if (rows.length === 0) return <NoData />;
  const visible = rows.slice(0, Math.max(1, height - 2));
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.info.label}>{"Contact".padEnd(28)}</Text>
        <Text color={theme.info.label}>{"Count".padStart(8)}</Text>
        <Text color={theme.info.label}>{"Median".padStart(12)}</Text>
        <Text color={theme.info.label}>{"p95".padStart(12)}</Text>
        <Text color={theme.info.label}>{"Mean".padStart(12)}</Text>
      </Box>
      {visible.map((r) => (
        <Box key={r.contact}>
          <Text wrap="truncate">{trunc(r.contact, 27).padEnd(28)}</Text>
          <Text>{String(r.count).padStart(8)}</Text>
          <Text color={theme.status.accent}>{formatDuration(r.medianMs).padStart(12)}</Text>
          <Text>{formatDuration(r.p95Ms).padStart(12)}</Text>
          <Text>{formatDuration(r.meanMs).padStart(12)}</Text>
        </Box>
      ))}
    </Box>
  );
}

const HEATMAP_SHADES = [" ", "·", "░", "▒", "▓", "█"];
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS_24 = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
] as const;

function HeatmapView({ result, width }: { result: HeatmapResult; width: number }) {
  const theme = useTheme();
  const grid = result.grid;
  let peak = 0;
  for (const row of grid) for (const cell of row) if (cell > peak) peak = cell;

  // Each hour gets 2 cells of width (so the grid is readable on narrow panes).
  const cellW = width >= 24 * 2 + 6 ? 2 : 1;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.info.label}>{"    "}</Text>
        {HOURS_24.map((h) => (
          <Text key={`h-${h}`} color={theme.help.desc}>
            {h % 6 === 0 ? `${h}`.padStart(cellW) : "".padStart(cellW, " ")}
          </Text>
        ))}
      </Box>
      {DOW_LABELS.map((label, dow) => {
        const row = grid[dow] ?? [];
        return (
          <Box key={label}>
            <Text color={theme.info.label}>{label} </Text>
            {HOURS_24.map((h) => {
              const count = row[h] ?? 0;
              const ratio = peak > 0 ? count / peak : 0;
              const idx = Math.min(
                HEATMAP_SHADES.length - 1,
                Math.round(ratio * (HEATMAP_SHADES.length - 1)),
              );
              const shade = HEATMAP_SHADES[idx]!;
              return (
                <Text
                  key={`c-${label}-${h}`}
                  color={ratio > 0.66 ? theme.status.accent : undefined}
                >
                  {shade.repeat(cellW)}
                </Text>
              );
            })}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={theme.help.desc}>
          {result.total.toLocaleString()} messages · peak hour count: {peak}
        </Text>
      </Box>
    </Box>
  );
}

function TapbacksView({ rows, height }: { rows: TapbackResult[]; height: number }) {
  const theme = useTheme();
  if (rows.length === 0) return <NoData />;
  const visible = rows.slice(0, Math.max(1, height - 2));
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.info.label}>{"Contact".padEnd(28)}</Text>
        <Text color={theme.info.label}>{"❤".padStart(4)}</Text>
        <Text color={theme.info.label}>{"👍".padStart(4)}</Text>
        <Text color={theme.info.label}>{"👎".padStart(4)}</Text>
        <Text color={theme.info.label}>{"ha".padStart(4)}</Text>
        <Text color={theme.info.label}>{"‼".padStart(4)}</Text>
        <Text color={theme.info.label}>{"?".padStart(4)}</Text>
        <Text color={theme.info.label}>{"😀".padStart(4)}</Text>
        <Text color={theme.info.label}>{"Σ".padStart(6)}</Text>
      </Box>
      {visible.map((r) => (
        <Box key={r.contact}>
          <Text wrap="truncate">{trunc(r.contact, 27).padEnd(28)}</Text>
          <Text>{String(r.heart).padStart(4)}</Text>
          <Text>{String(r.thumbsUp).padStart(4)}</Text>
          <Text>{String(r.thumbsDown).padStart(4)}</Text>
          <Text>{String(r.haha).padStart(4)}</Text>
          <Text>{String(r.exclaim).padStart(4)}</Text>
          <Text>{String(r.question).padStart(4)}</Text>
          <Text>{String(r.emoji).padStart(4)}</Text>
          <Text color={theme.status.accent}>{String(r.total).padStart(6)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function WrappedView({ result }: { result: WrappedResult }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.help.desc}>
          {result.windowStart || "—"} → {result.windowEnd || "—"}
        </Text>
      </Box>
      <Box marginTop={1} gap={2}>
        <KV label="Sent" value={result.totalSent.toLocaleString()} />
        <KV label="Received" value={result.totalReceived.toLocaleString()} />
        <KV label="Reactions" value={result.totalReactions.toLocaleString()} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.info.label}>Top contacts</Text>
        {result.topContacts.length === 0 ? (
          <Text color={theme.help.desc}>(none)</Text>
        ) : (
          result.topContacts.map((c) => (
            <Box key={c.contact}>
              <Text wrap="truncate">{trunc(c.contact, 28).padEnd(30)}</Text>
              <Text color={theme.status.accent}>{String(c.total).padStart(6)}</Text>
              <Text color={theme.help.desc}>
                {"  "}sent {c.sent} / received {c.received}
              </Text>
            </Box>
          ))
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <KV
          label="Peak day"
          value={result.peakDay ? `${result.peakDay.date} (${result.peakDay.count})` : "—"}
        />
        <KV
          label="Longest streak"
          value={`${result.longestStreakDays}d${result.longestStreakContact ? ` with ${result.longestStreakContact}` : ""}`}
        />
      </Box>
    </Box>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <Box>
      <Text color={theme.info.label}>{label}: </Text>
      <Text color={theme.info.value}>{value}</Text>
    </Box>
  );
}

function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}
