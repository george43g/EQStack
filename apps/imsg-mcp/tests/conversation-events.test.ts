/**
 * Group-system events (STATUS §9 gap): renames, member adds/removes, and
 * leaves live in `message` rows with `item_type != 0`, which every message
 * query filters out — they were invisible everywhere. Decoded via the
 * dedicated `getConversationEvents` accessor so default queries and
 * analytics stay untouched. Row shape verified on the real DB 2026-08-16.
 *
 * Fixture shared with the `get_conversation_events` tool test:
 * tests/helpers/group-events-fixture.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";
import {
  BOB,
  cleanupGroupEventFixtures,
  GROUP_ID,
  makeGroupEventsFixture,
} from "./helpers/group-events-fixture.js";

afterEach(() => {
  cleanupGroupEventFixtures();
});

describe("getConversationEvents", () => {
  it("decodes add / rename / remove / left, newest first, names resolved", async () => {
    const { chatDb, contactDb, slugsDb } = makeGroupEventsFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      const events = db.getConversationEvents(GROUP_ID);
      expect(events.map((e) => e.kind)).toEqual([
        "left",
        "member_removed",
        "renamed",
        "member_added",
      ]);
      const [left, removed, renamed, added] = events;
      expect(left.actorName).toBe("Alice A");
      expect(removed.target).toBe(BOB);
      expect(removed.targetName).toBe(BOB); // Bob is not in contacts — honest handle
      expect(renamed.actor).toBeNull(); // is_from_me → the user
      expect(renamed.newName).toBe("Weekend Crew");
      expect(added.kind).toBe("member_added");
      expect(added.actorName).toBe("Alice A");
    } finally {
      await db.close();
    }
  });

  it("never surfaces normal messages, and message queries never surface events", async () => {
    const { chatDb, contactDb, slugsDb } = makeGroupEventsFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      const events = db.getConversationEvents(GROUP_ID);
      expect(events).toHaveLength(4);
      const messages = await db.getMessagesForChat(GROUP_ID, 50);
      expect(messages.map((m) => m.guid)).toEqual(["n1"]);
    } finally {
      await db.close();
    }
  });

  it("returns empty for an unknown conversation", async () => {
    const { chatDb, contactDb, slugsDb } = makeGroupEventsFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      expect(db.getConversationEvents("chat000000000000000000")).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
