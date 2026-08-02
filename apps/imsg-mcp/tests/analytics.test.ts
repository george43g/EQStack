import { describe, expect, it } from "vitest";
import {
  computeDoubleTexts,
  computeHeatmap,
  computeResponseTimes,
  computeStreaks,
  computeTapbacks,
  computeWrapped,
  dispatchAnalytic,
} from "../src/analytics.js";
import type { Message } from "../src/types.js";

function msg(p: Partial<Message> & { id: number; date: Date }): Message {
  return {
    id: p.id,
    guid: `g-${p.id}`,
    text: p.text ?? "hello",
    handle: p.handle ?? "+15555550100",
    isFromMe: p.isFromMe ?? false,
    date: p.date,
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: p.chatId ?? "iMessage;-;+15555550100",
    service: "iMessage",
    isReaction: p.isReaction ?? false,
    reaction: p.reaction,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
  };
}

describe("computeDoubleTexts", () => {
  it("counts consecutive sends per side", () => {
    const base = new Date("2026-05-01T12:00:00Z");
    const msgs: Message[] = [
      msg({ id: 1, date: new Date(base.getTime() + 0), isFromMe: false }),
      msg({ id: 2, date: new Date(base.getTime() + 1000), isFromMe: false }),
      msg({ id: 3, date: new Date(base.getTime() + 2000), isFromMe: false }),
      msg({ id: 4, date: new Date(base.getTime() + 3000), isFromMe: true }),
      msg({ id: 5, date: new Date(base.getTime() + 4000), isFromMe: true }),
    ];
    const r = computeDoubleTexts(msgs);
    expect(r).toHaveLength(1);
    expect(r[0]?.doubleTextsFromThem).toBe(2); // ids 2 + 3
    expect(r[0]?.doubleTextsFromMe).toBe(1); // id 5
  });
});

describe("computeHeatmap", () => {
  it("buckets messages into 7×24 grid", () => {
    const msgs = [
      msg({ id: 1, date: new Date("2026-05-04T10:30:00") }), // Monday 10am
      msg({ id: 2, date: new Date("2026-05-04T10:45:00") }), // Monday 10am
      msg({ id: 3, date: new Date("2026-05-04T22:15:00") }), // Monday 10pm
    ];
    const h = computeHeatmap(msgs);
    expect(h.total).toBe(3);
    expect(h.grid).toHaveLength(7);
    expect(h.grid[0]).toHaveLength(24);
    expect(h.grid[1]?.[10]).toBe(2);
    expect(h.grid[1]?.[22]).toBe(1);
  });
});

describe("computeResponseTimes", () => {
  it("computes median + p95 of me-after-them deltas", () => {
    const base = new Date("2026-05-01T00:00:00Z");
    const msgs: Message[] = [
      msg({ id: 1, date: new Date(base.getTime() + 0), isFromMe: false }),
      msg({ id: 2, date: new Date(base.getTime() + 5_000), isFromMe: true }), // 5s
      msg({ id: 3, date: new Date(base.getTime() + 60_000), isFromMe: false }),
      msg({ id: 4, date: new Date(base.getTime() + 90_000), isFromMe: true }), // 30s
    ];
    const r = computeResponseTimes(msgs);
    expect(r).toHaveLength(1);
    expect(r[0]?.count).toBe(2);
    expect(r[0]?.medianMs).toBe(30_000); // 50th of [5000, 30000] = idx 1 → 30000
  });
});

describe("computeStreaks", () => {
  it("finds longest unbroken daily run", () => {
    const msgs = [
      msg({ id: 1, date: new Date("2026-05-01T12:00") }),
      msg({ id: 2, date: new Date("2026-05-02T12:00") }),
      msg({ id: 3, date: new Date("2026-05-03T12:00") }),
      msg({ id: 4, date: new Date("2026-05-05T12:00") }), // break
      msg({ id: 5, date: new Date("2026-05-06T12:00") }),
    ];
    const s = computeStreaks(msgs);
    expect(s[0]?.longestStreakDays).toBe(3);
  });
});

describe("computeTapbacks", () => {
  it("counts tapbacks by emoji semantic", () => {
    const msgs = [
      msg({
        id: 1,
        date: new Date("2026-05-01"),
        isReaction: true,
        reaction: {
          type: "heart",
          fromHandle: "x",
          isRemoval: false,
          targetMessageGuid: "g",
          targetMessagePart: 0,
        },
      }),
      msg({
        id: 2,
        date: new Date("2026-05-01"),
        isReaction: true,
        reaction: {
          type: "thumbs_up",
          fromHandle: "x",
          isRemoval: false,
          targetMessageGuid: "g",
          targetMessagePart: 0,
        },
      }),
    ];
    const r = computeTapbacks(msgs);
    expect(r[0]?.heart).toBe(1);
    expect(r[0]?.thumbsUp).toBe(1);
    expect(r[0]?.total).toBe(2);
  });
});

describe("dispatchAnalytic", () => {
  it("routes to the right computer", () => {
    const msgs = [msg({ id: 1, date: new Date() })];
    expect(dispatchAnalytic("daily_heatmap", msgs).type).toBe("daily_heatmap");
    expect(dispatchAnalytic("messaging_streaks", msgs).type).toBe("messaging_streaks");
  });
});

describe("computeWrapped", () => {
  it("handles empty input gracefully", () => {
    const w = computeWrapped([]);
    expect(w.totalSent).toBe(0);
    expect(w.topContacts).toEqual([]);
    expect(w.peakDay).toBeNull();
  });
});
