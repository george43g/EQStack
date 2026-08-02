/**
 * Chat analytics — pure functions over Message[] arrays.
 *
 * The handler in src/index.ts pulls a bounded message window via
 * IMessageDB.getMessagesInWindow() and dispatches to one of these computeXxx
 * functions based on the analytic `type`. Each returns a structured object
 * the LLM can render or chart.
 *
 * Six priority types are implemented here (P2.5). The remaining 20 from the
 * full enum are listed in mcp-tools.ts as ANALYTICS_TYPES but throw
 * `not_yet_implemented` if requested.
 */

import { isGroupChatIdentifier } from "./thread-slug.js";
import type { Message } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/** Local-date YYYY-MM-DD for grouping. */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Identifier for "the other side" of a message — the chatId so DMs and groups both bucket correctly. */
function contactKey(m: Message): string {
  return m.chatId;
}

/** Sort helper. */
function byDate(a: Message, b: Message): number {
  return a.date.getTime() - b.date.getTime();
}

// ── 1. messaging_streaks ─────────────────────────────────────────────────

export interface StreakResult {
  contact: string;
  longestStreakDays: number;
  longestStreakStart: string | null;
  longestStreakEnd: string | null;
  currentStreakDays: number;
}

export function computeStreaks(messages: Message[]): StreakResult[] {
  const byContact = new Map<string, Set<string>>();
  for (const m of messages) {
    if (m.isReaction) continue;
    const c = contactKey(m);
    if (!byContact.has(c)) byContact.set(c, new Set());
    byContact.get(c)!.add(localDateKey(m.date));
  }

  const today = localDateKey(new Date());
  const results: StreakResult[] = [];

  for (const [contact, dayset] of byContact) {
    const days = Array.from(dayset).sort();
    let longest = 0;
    let longestStart: string | null = null;
    let longestEnd: string | null = null;
    let runLen = 0;
    let runStart: string | null = null;

    for (let i = 0; i < days.length; i++) {
      if (
        i === 0 ||
        new Date(days[i]!).getTime() - new Date(days[i - 1]!).getTime() !== MS_PER_DAY
      ) {
        runLen = 1;
        runStart = days[i]!;
      } else {
        runLen++;
      }
      if (runLen > longest) {
        longest = runLen;
        longestStart = runStart;
        longestEnd = days[i]!;
      }
    }

    // Current streak — count back from today.
    let curLen = 0;
    const cursor = new Date();
    while (dayset.has(localDateKey(cursor))) {
      curLen++;
      cursor.setDate(cursor.getDate() - 1);
    }

    results.push({
      contact,
      longestStreakDays: longest,
      longestStreakStart: longestStart,
      longestStreakEnd: longestEnd,
      currentStreakDays: curLen,
    });
    void today;
  }

  results.sort((a, b) => b.longestStreakDays - a.longestStreakDays);
  return results;
}

// ── 2. double_texts ──────────────────────────────────────────────────────

export interface DoubleTextResult {
  contact: string;
  doubleTextsFromMe: number;
  doubleTextsFromThem: number;
}

export function computeDoubleTexts(messages: Message[]): DoubleTextResult[] {
  const byContact = new Map<string, Message[]>();
  for (const m of messages) {
    if (m.isReaction) continue;
    const c = contactKey(m);
    if (!byContact.has(c)) byContact.set(c, []);
    byContact.get(c)!.push(m);
  }

  const results: DoubleTextResult[] = [];
  for (const [contact, msgs] of byContact) {
    msgs.sort(byDate);
    let mineRun = 0;
    let theirsRun = 0;
    let mineDoubles = 0;
    let theirsDoubles = 0;
    for (const m of msgs) {
      if (m.isFromMe) {
        mineRun++;
        theirsRun = 0;
        if (mineRun >= 2) mineDoubles++;
      } else {
        theirsRun++;
        mineRun = 0;
        if (theirsRun >= 2) theirsDoubles++;
      }
    }
    results.push({
      contact,
      doubleTextsFromMe: mineDoubles,
      doubleTextsFromThem: theirsDoubles,
    });
  }
  results.sort(
    (a, b) =>
      b.doubleTextsFromMe + b.doubleTextsFromThem - (a.doubleTextsFromMe + a.doubleTextsFromThem),
  );
  return results;
}

// ── 3. response_time_stats ───────────────────────────────────────────────

export interface ResponseTimeStats {
  contact: string;
  count: number;
  medianMs: number;
  p95Ms: number;
  meanMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

export function computeResponseTimes(messages: Message[]): ResponseTimeStats[] {
  const byContact = new Map<string, Message[]>();
  for (const m of messages) {
    if (m.isReaction) continue;
    const c = contactKey(m);
    if (!byContact.has(c)) byContact.set(c, []);
    byContact.get(c)!.push(m);
  }
  const results: ResponseTimeStats[] = [];
  for (const [contact, msgs] of byContact) {
    msgs.sort(byDate);
    const deltas: number[] = [];
    for (let i = 1; i < msgs.length; i++) {
      const prev = msgs[i - 1]!;
      const curr = msgs[i]!;
      // Only count "me → them" reply: prev is from them, curr is from me.
      if (!prev.isFromMe && curr.isFromMe) {
        deltas.push(curr.date.getTime() - prev.date.getTime());
      }
    }
    if (deltas.length === 0) continue;
    deltas.sort((a, b) => a - b);
    const mean = deltas.reduce((s, n) => s + n, 0) / deltas.length;
    results.push({
      contact,
      count: deltas.length,
      medianMs: percentile(deltas, 50),
      p95Ms: percentile(deltas, 95),
      meanMs: Math.round(mean),
    });
  }
  results.sort((a, b) => a.medianMs - b.medianMs);
  return results;
}

// ── 4. daily_heatmap ─────────────────────────────────────────────────────

export interface HeatmapResult {
  /** 7×24 grid, [dow][hour] = count. dow is 0=Sun..6=Sat. */
  grid: number[][];
  total: number;
}

export function computeHeatmap(messages: Message[]): HeatmapResult {
  const grid: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  let total = 0;
  for (const m of messages) {
    if (m.isReaction) continue;
    const dow = m.date.getDay();
    const hr = m.date.getHours();
    const dowRow = grid[dow];
    if (dowRow && hr >= 0 && hr < 24) {
      dowRow[hr] = (dowRow[hr] ?? 0) + 1;
      total++;
    }
  }
  return { grid, total };
}

// ── 5. tapback_summary ───────────────────────────────────────────────────

export interface TapbackResult {
  contact: string;
  heart: number;
  thumbsUp: number;
  thumbsDown: number;
  haha: number;
  exclaim: number;
  question: number;
  emoji: number; // freeform sticker reactions
  total: number;
}

const TAPBACK_TYPE = {
  HEART: 2000,
  THUMBS_UP: 2001,
  THUMBS_DOWN: 2002,
  HAHA: 2003,
  EXCLAIM: 2004,
  QUESTION: 2005,
  EMOJI: 2006,
} as const;

export function computeTapbacks(messages: Message[]): TapbackResult[] {
  const byContact = new Map<string, TapbackResult>();
  for (const m of messages) {
    if (!m.isReaction || !m.reaction) continue;
    const c = contactKey(m);
    if (!byContact.has(c)) {
      byContact.set(c, {
        contact: c,
        heart: 0,
        thumbsUp: 0,
        thumbsDown: 0,
        haha: 0,
        exclaim: 0,
        question: 0,
        emoji: 0,
        total: 0,
      });
    }
    const r = byContact.get(c)!;
    // m.reaction.type is the textual tag like "heart" / "thumbs_up" — string
    // mapping rather than the numeric associated_message_type to keep this
    // resilient to type changes.
    const t = (m.reaction.type || "").toLowerCase();
    if (t.includes("heart") || t === "love") r.heart++;
    else if ((t.includes("thumb") && t.includes("up")) || t === "like") r.thumbsUp++;
    else if ((t.includes("thumb") && t.includes("down")) || t === "dislike") r.thumbsDown++;
    else if (t.includes("haha") || t === "laugh") r.haha++;
    else if (t.includes("exclaim") || t === "emphasis") r.exclaim++;
    else if (t.includes("question")) r.question++;
    else r.emoji++;
    r.total++;
    void TAPBACK_TYPE;
  }
  const out = Array.from(byContact.values());
  out.sort((a, b) => b.total - a.total);
  return out;
}

// ── 6. year_in_review_wrapped ────────────────────────────────────────────

export interface WrappedResult {
  windowStart: string;
  windowEnd: string;
  totalSent: number;
  totalReceived: number;
  totalReactions: number;
  topContacts: Array<{ contact: string; sent: number; received: number; total: number }>;
  peakDay: { date: string; count: number } | null;
  longestStreakDays: number;
  longestStreakContact: string | null;
}

export function computeWrapped(messages: Message[]): WrappedResult {
  if (messages.length === 0) {
    return {
      windowStart: "",
      windowEnd: "",
      totalSent: 0,
      totalReceived: 0,
      totalReactions: 0,
      topContacts: [],
      peakDay: null,
      longestStreakDays: 0,
      longestStreakContact: null,
    };
  }
  let sent = 0;
  let received = 0;
  let reactions = 0;
  const perContact = new Map<string, { sent: number; received: number; total: number }>();
  const perDay = new Map<string, number>();
  for (const m of messages) {
    if (m.isReaction) {
      reactions++;
      continue;
    }
    if (m.isFromMe) sent++;
    else received++;
    const c = contactKey(m);
    if (!perContact.has(c)) perContact.set(c, { sent: 0, received: 0, total: 0 });
    const pc = perContact.get(c)!;
    if (m.isFromMe) pc.sent++;
    else pc.received++;
    pc.total++;
    const dk = localDateKey(m.date);
    perDay.set(dk, (perDay.get(dk) ?? 0) + 1);
  }

  const topContacts = Array.from(perContact.entries())
    .map(([contact, v]) => ({ contact, ...v }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  let peakDay: { date: string; count: number } | null = null;
  for (const [d, count] of perDay) {
    if (!peakDay || count > peakDay.count) peakDay = { date: d, count };
  }

  // Longest streak across all contacts (reuse computeStreaks logic).
  const streaks = computeStreaks(messages);
  const top = streaks[0];

  return {
    windowStart: localDateKey(messages[0]!.date),
    windowEnd: localDateKey(messages[messages.length - 1]!.date),
    totalSent: sent,
    totalReceived: received,
    totalReactions: reactions,
    topContacts,
    peakDay,
    longestStreakDays: top?.longestStreakDays ?? 0,
    longestStreakContact: top?.contact ?? null,
  };
}

// ── Relationship leaderboard ─────────────────────────────────────────────

export interface RelationshipScore {
  /** Contact display name when resolved, else the raw handle. */
  contact: string;
  /** A representative handle for the contact (feeds init_human / get_contact). */
  handle: string;
  total: number;
  sent: number;
  received: number;
  /** min(sent,received)/max(sent,received) — 1.0 = perfectly balanced. */
  reciprocity: number;
  daysSinceLast: number;
  /** Weighted importance score — see computeRelationshipLeaderboard. */
  score: number;
}

/**
 * Rank 1:1 relationships by fuzzy importance within the analytic window.
 *
 * Score = log2(1 + total) — volume with diminishing returns
 *       × (0.4 + 0.6 × reciprocity) — real conversations beat broadcasts
 *       × exp(-daysSinceLast / 45) — recency decay (half-ish life ~1 month)
 *
 * Group chats are excluded (a person's group activity says little about the
 * 1:1 relationship, and humans files are per-person). Contacts are keyed by
 * resolved display name so phone+email legs of one person merge; unresolved
 * handles key by the handle itself.
 */
export function computeRelationshipLeaderboard(messages: Message[]): {
  leaderboard: RelationshipScore[];
} {
  interface Acc {
    contact: string | null;
    handle: string;
    sent: number;
    received: number;
    lastMs: number;
  }
  // Group by CONVERSATION (chatId), not by sender — from-me rows carry the
  // user's own handle ("me"), so sender-keyed grouping put every sent message
  // under one giant "me" bucket and zeroed reciprocity for every contact.
  const byChat = new Map<string, Acc>();
  for (const m of messages) {
    if (m.isReaction) continue;
    if (!m.chatId || isGroupChatIdentifier(m.chatId)) continue;
    let acc = byChat.get(m.chatId);
    if (!acc) {
      acc = { contact: null, handle: m.chatId, sent: 0, received: 0, lastMs: 0 };
      byChat.set(m.chatId, acc);
    }
    if (m.isFromMe) {
      acc.sent++;
    } else {
      acc.received++;
      // The other party names the conversation.
      if (!acc.contact && m.displayName) acc.contact = m.displayName;
      if (m.handle && m.handle !== "unknown") acc.handle = m.handle;
    }
    if (m.date.getTime() > acc.lastMs) acc.lastMs = m.date.getTime();
  }

  // Merge phone+email legs of the same person: same resolved contact name →
  // one entry.
  const byContact = new Map<string, Acc>();
  for (const acc of byChat.values()) {
    const key = acc.contact ?? acc.handle;
    if (!key || key === "unknown") continue;
    const merged = byContact.get(key);
    if (merged) {
      merged.sent += acc.sent;
      merged.received += acc.received;
      merged.lastMs = Math.max(merged.lastMs, acc.lastMs);
    } else {
      byContact.set(key, { ...acc });
    }
  }

  const now = Date.now();
  const leaderboard: RelationshipScore[] = [];
  for (const [contact, acc] of byContact) {
    const total = acc.sent + acc.received;
    // One-sided "conversations" (promos, OTP senders) score near zero via
    // the reciprocity term; skip trivial volumes outright.
    if (total < 3) continue;
    const reciprocity =
      Math.min(acc.sent, acc.received) / Math.max(Math.max(acc.sent, acc.received), 1);
    const daysSinceLast = Math.max(0, (now - acc.lastMs) / 86_400_000);
    const score = Math.log2(1 + total) * (0.4 + 0.6 * reciprocity) * Math.exp(-daysSinceLast / 45);
    leaderboard.push({
      contact,
      handle: acc.handle,
      total,
      sent: acc.sent,
      received: acc.received,
      reciprocity: Math.round(reciprocity * 100) / 100,
      daysSinceLast: Math.round(daysSinceLast * 10) / 10,
      score,
    });
  }
  // Sort on the RAW score, round only for output. The exp recency decay
  // pushes old-history scores below 1e-3 — rounding before the sort made
  // every long-quiet relationship tie at 0 and the ranking arbitrary.
  leaderboard.sort((a, b) => b.score - a.score);
  for (const row of leaderboard) row.score = Math.round(row.score * 1e6) / 1e6;
  return { leaderboard: leaderboard.slice(0, 50) };
}

// ── Dispatch ─────────────────────────────────────────────────────────────

export type AnalyticType =
  | "messaging_streaks"
  | "double_texts"
  | "response_time_stats"
  | "daily_heatmap"
  | "tapback_summary"
  | "year_in_review_wrapped"
  | "relationship_leaderboard";

/** Full enum including the 20 deferred types — agents get a friendly error. */
export const FUTURE_TYPES = [
  "silences",
  "ghost_storms",
  "conversation_half_life",
  "sent_received_imbalance",
  "tapback_per_person",
  "read_receipt_latency",
  "most_used_words",
  "emoji_leaderboard",
  "attachment_volume",
  "media_share_breakdown",
  "group_chat_activity",
  "chat_age_distribution",
  "first_messages_log",
  "last_messages_log",
  "quietest_chats",
  "loudest_chats",
  "weekend_vs_weekday",
  "night_owl_score",
  "most_edited_messages",
  "retraction_rate",
] as const;

export const IMPLEMENTED_TYPES: AnalyticType[] = [
  "messaging_streaks",
  "double_texts",
  "response_time_stats",
  "daily_heatmap",
  "tapback_summary",
  "year_in_review_wrapped",
  "relationship_leaderboard",
];

/** Label + one-line description + sensible default window, per analytic. Shared
 * by the CLI/console (help text) and the TUI palette so they never drift. */
export const ANALYTIC_INFO: Record<
  AnalyticType,
  { label: string; description: string; defaultWindowDays: number }
> = {
  messaging_streaks: {
    label: "Messaging Streaks",
    description: "Longest and current daily-message streaks per contact",
    defaultWindowDays: 365,
  },
  double_texts: {
    label: "Double Texts",
    description: "Consecutive messages sent without a reply",
    defaultWindowDays: 90,
  },
  response_time_stats: {
    label: "Response Times",
    description: "Reply latency per contact (median, p95, mean)",
    defaultWindowDays: 90,
  },
  daily_heatmap: {
    label: "Daily Heatmap",
    description: "7×24 grid of activity by weekday × hour",
    defaultWindowDays: 90,
  },
  tapback_summary: {
    label: "Tapback Summary",
    description: "Tapback reactions sent per contact",
    defaultWindowDays: 365,
  },
  year_in_review_wrapped: {
    label: "Year in Review (Wrapped)",
    description: "Wrapped summary: top contacts, peak day, totals (pinned to 365d)",
    defaultWindowDays: 365,
  },
  relationship_leaderboard: {
    label: "Relationship Leaderboard",
    description: "Top relationships by volume × reciprocity × recency",
    defaultWindowDays: 1825,
  },
};

export function dispatchAnalytic(
  type: AnalyticType,
  messages: Message[],
): {
  type: AnalyticType;
  data: unknown;
} {
  switch (type) {
    case "messaging_streaks":
      return { type, data: computeStreaks(messages) };
    case "double_texts":
      return { type, data: computeDoubleTexts(messages) };
    case "response_time_stats":
      return { type, data: computeResponseTimes(messages) };
    case "daily_heatmap":
      return { type, data: computeHeatmap(messages) };
    case "tapback_summary":
      return { type, data: computeTapbacks(messages) };
    case "year_in_review_wrapped":
      return { type, data: computeWrapped(messages) };
    case "relationship_leaderboard":
      return { type, data: computeRelationshipLeaderboard(messages) };
  }
}
