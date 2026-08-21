/**
 * `get_conversation_events` MCP tool (STATUS §9 — the accessor that was
 * deferred to "the next tool-surface change"; this is that change).
 *
 * The DB decode is pinned by conversation-events.test.ts; this pins the TOOL
 * contract: slug-or-identifier resolution, newest-first structured events
 * with a ready-made summary, and — the security-relevant line — the new
 * group title (`renamed`) is USER-CONTROLLED text, so the human-readable
 * output wraps it in <untrusted> exactly like message bodies, while
 * structuredContent keeps the raw stored string for exact-match consumers.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";
import { IMessageMCPServer } from "../src/index.js";
import {
  cleanupGroupEventFixtures,
  GROUP_ID,
  makeGroupEventsFixture,
} from "./helpers/group-events-fixture.js";

// Reaching private handlers, same pattern as get-messages-scope.test.ts.
let server: any;
const swappedDbs: IMessageDB[] = [];

beforeAll(() => {
  process.env.IMSG_DEV = "1";
  server = new IMessageMCPServer();
});

afterEach(async () => {
  for (const db of swappedDbs.splice(0)) await db.close();
  cleanupGroupEventFixtures();
});

/** Point the server at a fresh synthetic fixture DB. */
async function useFixtureDb(): Promise<void> {
  const { chatDb, contactDb, slugsDb } = makeGroupEventsFixture();
  const db = new IMessageDB(chatDb, [contactDb], slugsDb);
  swappedDbs.push(db);
  server.db = db;
}

describe("get_conversation_events tool", () => {
  it("returns newest-first events with summaries via chatIdentifier", async () => {
    await useFixtureDb();
    const res = await server.handleGetConversationEvents({ chatIdentifier: GROUP_ID, limit: 0 });
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent;
    expect(sc.count).toBe(4);
    expect(sc.isGroupChat).toBe(true);
    expect(sc.chatIdentifier).toBe(GROUP_ID);
    expect(sc.events.map((e: { kind: string }) => e.kind)).toEqual([
      "left",
      "member_removed",
      "renamed",
      "member_added",
    ]);
    // Bob is deliberately absent from the contacts fixture → honest handle.
    expect(sc.events[3].summary).toBe("Alice added +15550002222");
    // Dates serialise as ISO strings for the wire.
    expect(sc.events[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("wraps the renamed title <untrusted> in text, raw in structuredContent", async () => {
    await useFixtureDb();
    const res = await server.handleGetConversationEvents({ chatIdentifier: GROUP_ID });
    const text: string = res.content?.[0]?.text ?? "";
    expect(text).toContain("renamed to “<untrusted>Weekend Crew</untrusted>”");
    const renamed = res.structuredContent.events.find(
      (e: { kind: string }) => e.kind === "renamed",
    );
    expect(renamed.newName).toBe("Weekend Crew"); // raw for exact-match consumers
    expect(renamed.summary).toBe("You renamed to “Weekend Crew”"); // structured summary raw too
  });

  it("resolves a threadSlug from list_conversations", async () => {
    await useFixtureDb();
    const list = await server.handleListConversations({});
    const crew = list.structuredContent.conversations.find(
      (c: { chatIdentifier: string }) => c.chatIdentifier === GROUP_ID,
    );
    expect(crew?.threadSlug).toBeTruthy();
    const res = await server.handleGetConversationEvents({ threadSlug: crew.threadSlug });
    expect(res.structuredContent.count).toBe(4);
    expect(res.structuredContent.threadSlug).toBe(crew.threadSlug);
  });

  it("errors on an unknown slug and an unknown identifier", async () => {
    await useFixtureDb();
    const badSlug = await server.handleGetConversationEvents({ threadSlug: "nope~imsg~0000" });
    expect(badSlug.isError).toBe(true);
    const badId = await server.handleGetConversationEvents({
      chatIdentifier: "chat000000000000000000",
    });
    expect(badId.isError).toBe(true);
  });

  it("requires one of chatIdentifier / threadSlug", async () => {
    await useFixtureDb();
    await expect(server.handleGetConversationEvents({})).rejects.toThrow();
  });
});
