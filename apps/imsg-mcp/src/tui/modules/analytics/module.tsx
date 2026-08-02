/**
 * Analytics module — surfaces the six implemented analytics from
 * `src/analytics.ts` as palette commands. Each command opens a virtual
 * sidebar row whose pane lets the user flip between analytic types and
 * date ranges without leaving the row.
 */
import type { AnalyticType } from "../../../analytics.js";
import { IMPLEMENTED_TYPES } from "../../../analytics.js";
import type { FeatureModule, ModuleCommand, ModuleInstance } from "../types.js";
import { ANALYTIC_LABEL, AnalyticsPane } from "./Pane.js";
import { AnalyticsSidebarItem } from "./SidebarItem.js";

export type AnalyticsRange = "30d" | "90d" | "1y" | "all";

export interface AnalyticsState {
  type: AnalyticType;
  range: AnalyticsRange;
  /** When set, the pane scopes its dataset to that chat identifier. */
  chatIdentifier: string | null;
}

export const ANALYTIC_DESCRIPTION: Record<AnalyticType, string> = {
  messaging_streaks: "Longest and current daily-message streaks per contact",
  double_texts: "Consecutive messages without a reply",
  response_time_stats: "Reply latency (median, p95, mean)",
  daily_heatmap: "7×24 grid of activity by weekday × hour",
  tapback_summary: "Tapback reactions sent per contact",
  year_in_review_wrapped: "Wrapped summary: top contacts, peak day, totals",
  relationship_leaderboard: "Top relationships by volume, reciprocity, and recency",
};

let instanceCounter = 0;

function makeInstance(type: AnalyticType): ModuleInstance {
  instanceCounter += 1;
  // The leaderboard bakes recency into its score (exp decay on last contact),
  // so windowing it to 30d is redundant and usually starves it of data —
  // default that one to all-time; [/] still cycles ranges.
  const range: AnalyticsRange = type === "relationship_leaderboard" ? "all" : "30d";
  const state: AnalyticsState = { type, range, chatIdentifier: null };
  return {
    id: `analytics.${type}-${Date.now()}-${instanceCounter}`,
    moduleId: "analytics",
    title: `Analytics: ${ANALYTIC_LABEL[type]}`,
    subtitle: `range: ${range}`,
    state,
  };
}

const commands: ModuleCommand[] = IMPLEMENTED_TYPES.map((type) => ({
  id: `analytics.${type}`,
  title: `Analytics: ${ANALYTIC_LABEL[type]}`,
  description: ANALYTIC_DESCRIPTION[type],
  open: () => makeInstance(type),
}));

export const analyticsModule: FeatureModule = {
  id: "analytics",
  name: "Analytics",
  commands,
  SidebarItem: AnalyticsSidebarItem,
  Pane: AnalyticsPane,
};
