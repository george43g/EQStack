/**
 * Analytics contact-name resolution (re-swarm finding after v1.21.14).
 *
 * Every contact-listing analytic printed the raw bucket key — a phone number
 * for DMs, a `chat…` id for groups — across TUI, CLI, and MCP output. Same
 * "handle where a person belongs" class as the drawer reaction fix (#93).
 * `dispatchAnalytic` now takes an optional resolver and attaches
 * `contactName` when it produces something better than the raw key; the raw
 * key stays for agents that need the identifier. `relationship_leaderboard`
 * already self-resolves (keys by display name to merge phone+email legs) and
 * is deliberately untouched.
 */
import { describe, expect, it } from "vitest";
import { type ContactResolver, dispatchAnalytic, type StreakResult } from "../src/analytics.js";
import { renderAnalyticText } from "../src/analytics-render.js";
import type { Message } from "../src/types.js";

const ALICE = "+15555550100";
const GROUP = "chat926208792874094370";

function msg(p: Partial<Message> & { id: number; date: Date }): Message {
  return {
    id: p.id,
    guid: `g-${p.id}`,
    text: p.text ?? "hello",
    handle: p.handle ?? ALICE,
    isFromMe: p.isFromMe ?? false,
    date: p.date,
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: p.chatId ?? ALICE,
    service: "iMessage",
    isReaction: p.isReaction ?? false,
    reaction: p.reaction,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
  };
}

const resolver: ContactResolver = (key) =>
  key === ALICE ? "Alice Anderson" : key === GROUP ? "Alice, Bob" : key;

function sampleMessages(): Message[] {
  const base = new Date("2026-05-01T12:00:00Z");
  return [
    msg({ id: 1, date: base, chatId: ALICE }),
    msg({ id: 2, date: new Date(base.getTime() + 1000), chatId: ALICE, isFromMe: true }),
    msg({ id: 3, date: new Date(base.getTime() + 2000), chatId: GROUP }),
    msg({ id: 4, date: new Date(base.getTime() + 3000), chatId: "+19998887777" }),
  ];
}

describe("dispatchAnalytic contact resolution", () => {
  it("attaches contactName for resolvable DM and group buckets", () => {
    const { data } = dispatchAnalytic("messaging_streaks", sampleMessages(), resolver);
    const rows = data as StreakResult[];
    const alice = rows.find((r) => r.contact === ALICE);
    const group = rows.find((r) => r.contact === GROUP);
    expect(alice?.contactName).toBe("Alice Anderson");
    expect(group?.contactName).toBe("Alice, Bob");
  });

  it("keeps the raw key and omits contactName when nothing resolves", () => {
    const { data } = dispatchAnalytic("messaging_streaks", sampleMessages(), resolver);
    const stranger = (data as StreakResult[]).find((r) => r.contact === "+19998887777");
    expect(stranger).toBeDefined();
    expect(stranger?.contactName).toBeUndefined();
  });

  it("is unchanged without a resolver (cache/back-compat shape)", () => {
    const { data } = dispatchAnalytic("messaging_streaks", sampleMessages());
    for (const r of data as StreakResult[]) expect(r.contactName).toBeUndefined();
  });

  it("resolves wrapped topContacts and the longest-streak contact", () => {
    const { data } = dispatchAnalytic("year_in_review_wrapped", sampleMessages(), resolver);
    const w = data as {
      topContacts: Array<{ contact: string; contactName?: string }>;
      longestStreakContact: string | null;
      longestStreakContactName?: string;
    };
    const alice = w.topContacts.find((c) => c.contact === ALICE);
    expect(alice?.contactName).toBe("Alice Anderson");
    if (w.longestStreakContact === ALICE) {
      expect(w.longestStreakContactName).toBe("Alice Anderson");
    }
  });

  it("covers double_texts, response_time_stats, and tapback_summary too", () => {
    const base = new Date("2026-05-01T12:00:00Z");
    const convo = [
      msg({ id: 1, date: base }),
      msg({ id: 2, date: new Date(base.getTime() + 1000) }),
      msg({ id: 3, date: new Date(base.getTime() + 5000), isFromMe: true }),
      msg({
        id: 4,
        date: new Date(base.getTime() + 6000),
        isReaction: true,
        reaction: { type: "love", fromHandle: ALICE, isRemoval: false },
      } as Partial<Message> & { id: number; date: Date }),
    ];
    for (const type of ["double_texts", "response_time_stats", "tapback_summary"] as const) {
      const { data } = dispatchAnalytic(type, convo, resolver);
      const rows = data as Array<{ contact: string; contactName?: string }>;
      for (const r of rows.filter((r) => r.contact === ALICE)) {
        expect(r.contactName, type).toBe("Alice Anderson");
      }
    }
  });
});

describe("renderer prefers contactName", () => {
  it("prints the name, not the phone number, when resolved", () => {
    const { data } = dispatchAnalytic("messaging_streaks", sampleMessages(), resolver);
    const text = renderAnalyticText("messaging_streaks", data);
    expect(text).toContain("Alice Anderson");
    expect(text).not.toContain(ALICE);
  });

  it("falls back to the raw key when unresolved", () => {
    const { data } = dispatchAnalytic("messaging_streaks", sampleMessages(), resolver);
    const text = renderAnalyticText("messaging_streaks", data);
    expect(text).toContain("+19998887777");
  });
});
