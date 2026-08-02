/**
 * wait_for_reply interjection semantics: the user's own from-me messages
 * (sent from their phone/other devices into a monitored conversation) are
 * returned by default, while the agent's own just-sent message is suppressed
 * via the SentEchoRegistry.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IMessageMCPServer } from "../src/index.js";
import { OUTPUT_SCHEMAS, WaitForReplySchema } from "../src/mcp-tools.js";
import type { Message } from "../src/types.js";

function makeMsg(id: number, text: string, isFromMe: boolean, dateMs: number): Message {
  return {
    id,
    guid: `guid-${id}`,
    text,
    handle: isFromMe ? "+15550000001" : "+15550000002",
    isFromMe,
    date: new Date(dateMs),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: "iMessage;-;+15550000002",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
  };
}

const CHAT = {
  chatId: "iMessage;-;+15550000002",
  chatIdentifier: "+15550000002",
  displayName: "Test",
  rawIdentifier: "+15550000002",
  participants: ["+15550000002"],
  lastMessageDate: new Date(),
  lastMessageSnippet: null,
  unreadCount: 0,
  threadSlug: "test~imsg~beef",
  isGroupChat: false,
  serviceType: "iMessage" as const,
};

describe("WaitForReplySchema includeSelf", () => {
  it("defaults includeSelf to true", () => {
    const parsed = WaitForReplySchema.parse({ chatIdentifier: "x" });
    expect(parsed.includeSelf).toBe(true);
  });
});

describe("handleWaitForReply with interjections", () => {
  let server: any;

  beforeEach(() => {
    server = new IMessageMCPServer();
    server.db.findChatByHandle = async () => CHAT;
  });

  it("returns the user's own interjection, labeled, with selfCount", async () => {
    const now = Date.now();
    server.db.getMessagesAfter = async (_id: string, _after: number, opts: any) => {
      const rows = [
        makeMsg(11, "actually claude, use the blue theme", true, now), // interjection
        makeMsg(12, "sounds good", false, now + 1),
      ];
      return opts?.includeSelf ? rows : rows.filter((m) => !m.isFromMe);
    };
    const res = await server.handleWaitForReply({
      chatIdentifier: "+15550000002",
      timeoutSeconds: 10,
      pollIntervalSeconds: 5,
      afterMessageId: 10,
    });
    const content = res.structuredContent;
    expect(() => OUTPUT_SCHEMAS.wait_for_reply.parse(content)).not.toThrow();
    expect(content.received).toBe(true);
    expect(content.count).toBe(2);
    expect(content.selfCount).toBe(1);
    expect(res.content[0].text).toContain("sent by the user from their own account");
  });

  it("suppresses the agent's own registered send echo but passes the reply", async () => {
    const now = Date.now();
    // Simulate a prior send_message: fingerprint registered for this chatKey.
    server.sentEchoes.register(CHAT.threadSlug, "agent question?");
    server.db.getMessagesAfter = async () => [
      makeMsg(21, "agent  question?", true, now), // late-landing echo (whitespace differs)
      makeMsg(22, "the human reply", false, now + 1),
    ];
    const res = await server.handleWaitForReply({
      chatIdentifier: "+15550000002",
      timeoutSeconds: 10,
      pollIntervalSeconds: 5,
      afterMessageId: 20,
    });
    const content = res.structuredContent;
    expect(content.count).toBe(1);
    expect(content.selfCount).toBe(0);
    expect(content.messages[0].text).toBe("the human reply");
  });

  it("advances the cursor past an all-echo poll instead of returning", async () => {
    const now = Date.now();
    server.sentEchoes.register(CHAT.threadSlug, "only the echo");
    const calls: number[] = [];
    server.db.getMessagesAfter = async (_id: string, after: number) => {
      calls.push(after);
      if (after === 30) return [makeMsg(31, "only the echo", true, now)];
      if (after === 31) return [makeMsg(32, "real reply", false, now + 1)];
      return [];
    };
    const res = await server.handleWaitForReply({
      chatIdentifier: "+15550000002",
      timeoutSeconds: 10,
      pollIntervalSeconds: 5,
      afterMessageId: 30,
    });
    expect(calls[0]).toBe(30);
    expect(calls[1]).toBe(31); // cursor advanced past the suppressed echo
    expect(res.structuredContent.messages[0].text).toBe("real reply");
  }, 15_000);

  it("includeSelf: false restores incoming-only behavior", async () => {
    const now = Date.now();
    server.db.getMessagesAfter = async (_id: string, _after: number, opts: any) => {
      const rows = [makeMsg(41, "user interjection", true, now)];
      return opts?.includeSelf ? rows : [];
    };
    const res = await server.handleWaitForReply({
      chatIdentifier: "+15550000002",
      timeoutSeconds: 10,
      pollIntervalSeconds: 5,
      afterMessageId: 40,
      includeSelf: false,
    });
    // Nothing incoming → the wait times out rather than returning the from-me row.
    expect(res.structuredContent.timedOut).toBe(true);
  }, 15_000);
});
