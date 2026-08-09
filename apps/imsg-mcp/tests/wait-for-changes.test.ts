/**
 * wait_for_changes MCP tool: long-polls the EventBus for typed change events.
 *
 * The bus is driven directly (the ChangeWatcher's own detection is covered by
 * change-watcher.test.ts): tests pre-seed the server's lazy change stream
 * with a fresh EventBus + an UNSTARTED watcher so no real fs.watch is armed
 * and no real chat.db is ever touched — fixture/env-data only, per repo law.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChangeWatcher } from "../src/change-watcher.js";
import { type ChangeEvent, EventBus } from "../src/event-bus.js";
import { IMessageMCPServer } from "../src/index.js";
import { OUTPUT_SCHEMAS, TOOL_TIMEOUTS_MS, WaitForChangesSchema } from "../src/mcp-tools.js";
import type { Message } from "../src/types.js";

function makeMsg(id: number, text: string, chatId: string, isReaction = false): Message {
  return {
    id,
    guid: `guid-${id}`,
    text,
    handle: "+15550000002",
    isFromMe: false,
    date: new Date(),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId,
    service: "iMessage",
    isReaction,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
  };
}

function newEvent(id: number, chatId = "+15550000002"): ChangeEvent {
  return { type: "message.new", message: makeMsg(id, `msg ${id}`, chatId) };
}

function reactionEvent(id: number, chatId = "+15550000002"): ChangeEvent {
  return { type: "reaction", message: makeMsg(id, "Loved a message", chatId, true) };
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

describe("WaitForChangesSchema", () => {
  it("defaults types to every emitted type and timeoutSeconds to 60", () => {
    const parsed = WaitForChangesSchema.parse({});
    expect(parsed.types).toEqual(["message.new", "reaction"]);
    expect(parsed.timeoutSeconds).toBe(60);
    expect(parsed.maxEvents).toBeUndefined();
  });

  it("skips the generic per-tool timeout wrapper (has its own timeoutSeconds)", () => {
    expect(TOOL_TIMEOUTS_MS.wait_for_changes).toBe(0);
  });
});

describe("handleWaitForChanges", () => {
  // ONE server for the whole file (like mcp-output-schema.test.ts) — every
  // construction opens the shared fixture DBs, and parallel test files
  // already contend on them.
  let server: any;
  let bus: EventBus;

  beforeAll(() => {
    server = new IMessageMCPServer();
  });

  afterAll(() => {
    server.db?.close();
  });

  beforeEach(() => {
    bus = new EventBus();
    // Pre-seed the lazy stream: ensureChangeStream() reuses these and never
    // arms a real fs.watch (the watcher is constructed but NOT started).
    server.changeBus = bus;
    server.changeWatcher = new ChangeWatcher({
      dbPath: "/nonexistent-dir-xyz/chat.db",
      db: { getMaxMessageRowId: () => 0, getMessagesAfterRowid: async () => [] },
      bus,
    });
  });

  it("returns the first matching batch of events", async () => {
    const resP = server.handleWaitForChanges({ timeoutSeconds: 5 });
    setTimeout(() => bus.emit([newEvent(101), reactionEvent(102)]), 10);
    const res = await resP;

    expect(res.isError).toBeUndefined();
    const content = res.structuredContent;
    expect(() => OUTPUT_SCHEMAS.wait_for_changes.parse(content)).not.toThrow();
    expect(content.count).toBe(2);
    expect(content.events.map((e: any) => e.type)).toEqual(["message.new", "reaction"]);
    // Message payloads are shaped like other tool responses (ISO dates).
    expect(content.events[0].message.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(content.timedOut).toBeUndefined();
    expect(content.watcherMode).toBe("fs-watch");
    expect(res.content[0].text).toContain("2 change event(s)");
  });

  it("types filter returns only the requested event types", async () => {
    const resP = server.handleWaitForChanges({ timeoutSeconds: 5, types: ["reaction"] });
    setTimeout(() => bus.emit([newEvent(201), reactionEvent(202), newEvent(203)]), 10);
    const res = await resP;

    expect(res.structuredContent.count).toBe(1);
    expect(res.structuredContent.events[0].type).toBe("reaction");
    expect(res.structuredContent.events[0].message.id).toBe(202);
  });

  it("threadSlug filter matches direct + merged legs and drops other chats", async () => {
    server.db.getSlugRecord = () => ({ chatIdentifier: "+15550000002", slug: CHAT.threadSlug });
    server.db.findChatByHandle = async () => CHAT;
    server.db.getSlugForChatIdentifier = (chatIdentifier: string) =>
      ({ "alice@example.com": CHAT.threadSlug, "+15559999999": "other~imsg~dead" })[
        chatIdentifier
      ] ?? null;

    const resP = server.handleWaitForChanges({ timeoutSeconds: 5, threadSlug: CHAT.threadSlug });
    setTimeout(
      () =>
        bus.emit([
          newEvent(301, "+15550000002"), // direct identifier match
          newEvent(302, "alice@example.com"), // merged email leg of the same identity
          newEvent(303, "+15559999999"), // different conversation — dropped
        ]),
      10,
    );
    const res = await resP;

    expect(res.structuredContent.count).toBe(2);
    expect(res.structuredContent.events.map((e: any) => e.message.id)).toEqual([301, 302]);
    expect(res.structuredContent.threadSlug).toBe(CHAT.threadSlug);
    expect(res.structuredContent.chatIdentifier).toBe(CHAT.chatIdentifier);
  });

  it("unknown thread slug is an error", async () => {
    server.db.getSlugRecord = () => null;
    const res = await server.handleWaitForChanges({ threadSlug: "nope~imsg~0000" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown thread slug");
  });

  it("timeout with no events is a clean non-error result", async () => {
    const res = await server.handleWaitForChanges({ timeoutSeconds: 1 });
    expect(res.isError).toBeUndefined();
    const content = res.structuredContent;
    expect(() => OUTPUT_SCHEMAS.wait_for_changes.parse(content)).not.toThrow();
    expect(content.timedOut).toBe(true);
    expect(content.count).toBe(0);
    expect(content.events).toEqual([]);
    expect(res.content[0].text).toContain("No changes within 1s");
  }, 5_000);

  it("maxEvents keeps collecting across batches and returns early once reached", async () => {
    const resP = server.handleWaitForChanges({ timeoutSeconds: 5, maxEvents: 2 });
    setTimeout(() => bus.emit([newEvent(401)]), 10); // 1 of 2 — keeps waiting
    setTimeout(() => bus.emit([newEvent(402)]), 40); // 2 of 2 — returns
    const started = Date.now();
    const res = await resP;

    expect(res.structuredContent.count).toBe(2);
    expect(res.structuredContent.events.map((e: any) => e.message.id)).toEqual([401, 402]);
    expect(res.structuredContent.timedOut).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(4_000); // early, not the full timeout
  });

  it("maxEvents truncates an oversized batch", async () => {
    const resP = server.handleWaitForChanges({ timeoutSeconds: 5, maxEvents: 2 });
    setTimeout(() => bus.emit([newEvent(501), newEvent(502), newEvent(503)]), 10);
    const res = await resP;

    expect(res.structuredContent.count).toBe(2);
    expect(res.structuredContent.events.map((e: any) => e.message.id)).toEqual([501, 502]);
  });

  it("abort returns isError 'Cancelled by client' promptly", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const resP = server.handleWaitForChanges({ timeoutSeconds: 60 }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const res = await resP;

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Cancelled by client");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
