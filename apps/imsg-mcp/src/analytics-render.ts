/**
 * Human-readable text rendering for every chat_analytics type, shared by the
 * MCP tool output and the CLI/console. Keeping it in one place means the agent
 * (via the tool's text block) and a person (via `imsg analytics …`) see the
 * same summary, and adding an analytic only needs one renderer.
 */

import type {
  AnalyticType,
  DoubleTextResult,
  HeatmapResult,
  RelationshipScore,
  ResponseTimeStats,
  StreakResult,
  TapbackResult,
  WrappedResult,
} from "./analytics.js";

/** ms → compact human duration (e.g. 4m, 2h, 3d). */
function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const TOP = 20;

function renderStreaks(rows: StreakResult[]): string {
  if (rows.length === 0) return "(no streaks in window)";
  return rows
    .slice(0, TOP)
    .map((r, i) => {
      const span =
        r.longestStreakStart && r.longestStreakEnd
          ? ` (${r.longestStreakStart}→${r.longestStreakEnd})`
          : "";
      const cur = r.currentStreakDays > 0 ? `, current ${r.currentStreakDays}d` : "";
      return `${String(i + 1).padStart(2)}. ${r.contact} — longest ${r.longestStreakDays}d${span}${cur}`;
    })
    .join("\n");
}

function renderDoubleTexts(rows: DoubleTextResult[]): string {
  if (rows.length === 0) return "(no double-texts in window)";
  return rows
    .slice(0, TOP)
    .map(
      (r, i) =>
        `${String(i + 1).padStart(2)}. ${r.contact} — you ${r.doubleTextsFromMe}×, them ${r.doubleTextsFromThem}×`,
    )
    .join("\n");
}

function renderResponseTimes(rows: ResponseTimeStats[]): string {
  if (rows.length === 0) return "(no response-time data in window)";
  return rows
    .slice(0, TOP)
    .map(
      (r, i) =>
        `${String(i + 1).padStart(2)}. ${r.contact} — median ${humanDuration(r.medianMs)}, p95 ${humanDuration(r.p95Ms)}, mean ${humanDuration(r.meanMs)} (n=${r.count})`,
    )
    .join("\n");
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEAT = " ░▒▓█";

function renderHeatmap(result: HeatmapResult): string {
  if (result.total === 0) return "(no activity in window)";
  const max = Math.max(...result.grid.flat());
  const header = `      ${Array.from({ length: 24 }, (_, h) => String(h % 10)).join("")}`;
  const rows = result.grid.map((row, dow) => {
    const cells = row
      .map((v) => {
        if (v === 0) return HEAT[0];
        const level = Math.min(HEAT.length - 1, 1 + Math.floor((v / max) * (HEAT.length - 2)));
        return HEAT[level];
      })
      .join("");
    return `${DOW[dow]}   ${cells}`;
  });
  return `${header}\n${rows.join("\n")}\n(${result.total} messages; each column = hour 0–23)`;
}

function renderTapbacks(rows: TapbackResult[]): string {
  if (rows.length === 0) return "(no tapbacks in window)";
  return rows
    .slice(0, TOP)
    .map((r, i) => {
      const parts = [
        r.heart && `❤️${r.heart}`,
        r.thumbsUp && `👍${r.thumbsUp}`,
        r.thumbsDown && `👎${r.thumbsDown}`,
        r.haha && `😂${r.haha}`,
        r.exclaim && `‼️${r.exclaim}`,
        r.question && `❓${r.question}`,
        r.emoji && `🙂${r.emoji}`,
      ].filter(Boolean);
      return `${String(i + 1).padStart(2)}. ${r.contact} — ${parts.join(" ")} (total ${r.total})`;
    })
    .join("\n");
}

function renderWrapped(w: WrappedResult): string {
  const lines = [
    `Window: ${w.windowStart} → ${w.windowEnd}`,
    `Sent: ${w.totalSent.toLocaleString()}   Received: ${w.totalReceived.toLocaleString()}   Reactions: ${w.totalReactions.toLocaleString()}`,
    w.peakDay ? `Peak day: ${w.peakDay.date} (${w.peakDay.count} messages)` : "Peak day: —",
    w.longestStreakContact
      ? `Longest streak: ${w.longestStreakDays}d with ${w.longestStreakContact}`
      : `Longest streak: ${w.longestStreakDays}d`,
    "",
    "Top contacts:",
    ...w.topContacts
      .slice(0, 10)
      .map(
        (c, i) =>
          `${String(i + 1).padStart(2)}. ${c.contact} — ${c.total} (↑${c.sent} / ↓${c.received})`,
      ),
  ];
  return lines.join("\n");
}

function renderLeaderboard(rows: RelationshipScore[]): string {
  if (rows.length === 0) return "(no ranked relationships in window)";
  const max = rows[0]?.score || 0;
  return rows
    .slice(0, TOP)
    .map((r, i) => {
      const rel = max > 0 ? Math.round((r.score / max) * 100) : 0;
      return `${String(i + 1).padStart(2)}. ${r.contact} — ${r.total} msgs, ${Math.round(
        r.reciprocity * 100,
      )}% reciprocity, last ${Math.round(r.daysSinceLast)}d ago (score ${rel})`;
    })
    .join("\n");
}

/** Render any analytic's `data` payload as human-readable text. */
export function renderAnalyticText(type: AnalyticType, data: unknown): string {
  switch (type) {
    case "messaging_streaks":
      return renderStreaks(
        (data as { streaks?: StreakResult[] }).streaks ?? (data as StreakResult[]),
      );
    case "double_texts":
      return renderDoubleTexts(
        (data as { doubleTexts?: DoubleTextResult[] }).doubleTexts ?? (data as DoubleTextResult[]),
      );
    case "response_time_stats":
      return renderResponseTimes(
        (data as { responseTimes?: ResponseTimeStats[] }).responseTimes ??
          (data as ResponseTimeStats[]),
      );
    case "daily_heatmap":
      return renderHeatmap(data as HeatmapResult);
    case "tapback_summary":
      return renderTapbacks(
        (data as { tapbacks?: TapbackResult[] }).tapbacks ?? (data as TapbackResult[]),
      );
    case "year_in_review_wrapped":
      return renderWrapped(data as WrappedResult);
    case "relationship_leaderboard":
      return renderLeaderboard((data as { leaderboard?: RelationshipScore[] }).leaderboard ?? []);
  }
}

/**
 * Minimal YAML serializer for analytic output (`--yaml`). Zero-dep on purpose;
 * handles the shapes analytics produce — nested objects, arrays, strings,
 * numbers, booleans, null. Not a general-purpose emitter.
 */
export function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return yamlScalar(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        const rendered = toYaml(item, indent + 1);
        if (isComposite(item)) {
          // Nested block: put the first key inline after "- ", rest indented.
          return `${pad}-\n${rendered}`;
        }
        return `${pad}- ${rendered}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        if (isComposite(v)) {
          return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        }
        return `${pad}${k}: ${toYaml(v, indent)}`;
      })
      .join("\n");
  }
  return yamlScalar(String(value));
}

function isComposite(v: unknown): boolean {
  return typeof v === "object" && v !== null && (Array.isArray(v) ? v.length > 0 : true);
}

function yamlScalar(s: string): string {
  // Conservatively quote any string a YAML parser could misread as a non-string.
  // Critically this includes phone numbers ("+15550000119" would otherwise
  // parse as the integer 15550000119, dropping the "+") and keyword-ish values.
  const needsQuote =
    s === "" ||
    /^\s|\s$/.test(s) || // leading/trailing whitespace
    /[\n"\\]/.test(s) || // control / quote / backslash
    /^[-?:,[\]{}&*!|>%@`#'"]/.test(s) || // starts with a YAML indicator
    /:(\s|$)|\s#/.test(s) || // ": " (mapping) or " #" (comment) in structural position
    /^[+-]?(\d|\.\d)/.test(s) || // number-ish, incl. "+61…" phone numbers
    /^(true|false|yes|no|on|off|null|~)$/i.test(s) || // YAML keywords
    /^[+-]?\.?(inf|nan)$/i.test(s);
  return needsQuote
    ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`
    : s;
}
