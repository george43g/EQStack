/**
 * Direct unit tests for the pure conversation-merge logic extracted from
 * IMessageDB (src/conversation-merge.ts). Previously this preference cascade
 * was only exercisable through the whole class + a fixture DB; these tests
 * pin each rung of the cascade and the merge semantics on their own.
 */
import { describe, expect, it } from "vitest";
import {
  mergeConversationEntries,
  mergeDuplicateConversations,
  type PreparedConversationEntry,
  pickPreferredConversationEntry,
} from "../src/conversation-merge.js";
import type { Conversation } from "../src/types.js";

function conv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    chatId: "guid-1",
    chatIdentifier: "+15550100100",
    displayName: null,
    rawIdentifier: "+15550100100",
    participants: ["+15550100100"],
    lastMessageDate: new Date("2025-01-01T12:00:00Z"),
    lastMessageSnippet: null,
    unreadCount: 0,
    threadSlug: "alice~imsg~a3f2",
    isGroupChat: false,
    serviceType: "iMessage",
    ...overrides,
  };
}

function entry(
  overrides: Partial<Conversation> = {},
  opts: { mergeKey?: string; lastService?: string | null; noLast?: boolean } = {},
): PreparedConversationEntry {
  return {
    mergeKey: opts.mergeKey ?? "contact:1",
    ...(opts.noLast ? {} : { last: { lastService: opts.lastService ?? null } }),
    conversation: conv(overrides),
  };
}

describe("pickPreferredConversationEntry cascade", () => {
  it("newer lastMessageDate wins, in both positions", () => {
    const older = entry({ lastMessageDate: new Date("2025-01-01T00:00:00Z") });
    const newer = entry({ lastMessageDate: new Date("2025-06-01T00:00:00Z") });
    expect(pickPreferredConversationEntry(older, newer)).toBe(newer);
    expect(pickPreferredConversationEntry(newer, older)).toBe(newer);
  });

  it("equal dates: the leg matching the last message's real service wins (SMS)", () => {
    const sms = entry({ serviceType: "SMS" }, { lastService: "SMS" });
    const imsg = entry({ serviceType: "iMessage" }, { noLast: true });
    expect(pickPreferredConversationEntry(sms, imsg)).toBe(sms);
    expect(pickPreferredConversationEntry(imsg, sms)).toBe(sms);
  });

  it("equal dates: the leg matching the last message's real service wins (iMessage)", () => {
    const sms = entry({ serviceType: "SMS" }, { lastService: "iMessage" });
    const imsg = entry({ serviceType: "iMessage" }, { noLast: true });
    expect(pickPreferredConversationEntry(sms, imsg)).toBe(imsg);
  });

  it("equal dates, no service signal: displayName presence wins", () => {
    const named = entry({ displayName: "Alice" });
    const unnamed = entry({ displayName: null });
    expect(pickPreferredConversationEntry(unnamed, named)).toBe(named);
    expect(pickPreferredConversationEntry(named, unnamed)).toBe(named);
  });

  it("equal dates, both named: iMessage beats SMS", () => {
    const imsg = entry({ displayName: "Alice", serviceType: "iMessage" });
    const sms = entry({ displayName: "Alice", serviceType: "SMS" });
    expect(pickPreferredConversationEntry(sms, imsg)).toBe(imsg);
    expect(pickPreferredConversationEntry(imsg, sms)).toBe(imsg);
  });

  it("full tie: left wins (stable)", () => {
    const a = entry();
    const b = entry();
    expect(pickPreferredConversationEntry(a, b)).toBe(a);
  });
});

describe("mergeConversationEntries", () => {
  it("unions participants without duplicates", () => {
    const phone = entry({ participants: ["+15550100100"] });
    const email = entry({
      chatIdentifier: "alice@example.com",
      participants: ["alice@example.com", "+15550100100"],
    });
    const merged = mergeConversationEntries(phone, email);
    expect(merged.conversation.participants).toEqual(["+15550100100", "alice@example.com"]);
  });

  it("coalesces displayName from the non-preferred leg", () => {
    // Preferred by date, but nameless; the older leg carries the name.
    const nameless = entry({
      displayName: null,
      lastMessageDate: new Date("2025-06-01T00:00:00Z"),
    });
    const named = entry({
      displayName: "Alice",
      lastMessageDate: new Date("2025-01-01T00:00:00Z"),
    });
    expect(mergeConversationEntries(nameless, named).conversation.displayName).toBe("Alice");
  });

  it("unreadCount: max for the same chatIdentifier (same chat seen twice)", () => {
    const a = entry({ unreadCount: 3 });
    const b = entry({ unreadCount: 5 });
    expect(mergeConversationEntries(a, b).conversation.unreadCount).toBe(5);
  });

  it("unreadCount: sum across different identifiers (distinct legs)", () => {
    const phone = entry({ unreadCount: 3 });
    const email = entry({ chatIdentifier: "alice@example.com", unreadCount: 5 });
    expect(mergeConversationEntries(phone, email).conversation.unreadCount).toBe(8);
  });

  it("keeps the preferred leg's last row, falling back to the other's", () => {
    const withLast = entry({}, { lastService: "iMessage" });
    const withoutLast = entry(
      { lastMessageDate: new Date("2025-06-01T00:00:00Z") },
      { noLast: true },
    );
    // withoutLast is preferred (newer) but has no last row -> falls back.
    const merged = mergeConversationEntries(withLast, withoutLast);
    expect(merged.last).toEqual({ lastService: "iMessage" });
  });
});

describe("mergeDuplicateConversations", () => {
  it("collapses same-key entries, keeps distinct keys, preserves first-seen order", () => {
    const a1 = entry({ unreadCount: 1 }, { mergeKey: "contact:1" });
    const b = entry(
      { chatIdentifier: "+15550100199", threadSlug: "bob~imsg~b1b1" },
      { mergeKey: "contact:2" },
    );
    const a2 = entry(
      { chatIdentifier: "alice@example.com", unreadCount: 2 },
      { mergeKey: "contact:1" },
    );
    const merged = mergeDuplicateConversations([a1, b, a2]);
    expect(merged).toHaveLength(2);
    expect(merged[0].mergeKey).toBe("contact:1");
    expect(merged[1].mergeKey).toBe("contact:2");
    expect(merged[0].conversation.unreadCount).toBe(3); // cross-identifier sum
  });

  it("chains three legs of one identity into a single entry", () => {
    const legs = [
      entry({ participants: ["+15550100100"] }, { mergeKey: "contact:1" }),
      entry(
        { chatIdentifier: "alice@example.com", participants: ["alice@example.com"] },
        { mergeKey: "contact:1" },
      ),
      entry(
        { chatIdentifier: "alice@icloud.com", participants: ["alice@icloud.com"] },
        { mergeKey: "contact:1" },
      ),
    ];
    const merged = mergeDuplicateConversations(legs);
    expect(merged).toHaveLength(1);
    expect(merged[0].conversation.participants).toEqual([
      "+15550100100",
      "alice@example.com",
      "alice@icloud.com",
    ]);
  });

  it("empty input -> empty output", () => {
    expect(mergeDuplicateConversations([])).toEqual([]);
  });
});
