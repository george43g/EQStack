import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMessageMCPServer } from "../src/index.js";
import type { Message } from "../src/types.js";

/**
 * `get_messages` advertises `oldestMessageId` and documents it as the value to
 * feed back as `beforeMessageId`. `getMessagesForChat` resolves that id to the
 * message's DATE and pages on the composite `(date, ROWID)` — so the advertised
 * cursor MUST be the min by `(date, ROWID)`, never the min ROWID.
 *
 * In MERGED threads (phone + email, SMS + iMessage) the two orders diverge: a
 * newer-dated message can carry a lower ROWID. Advertising min-ROWID then hands
 * the agent a cursor NEWER than the page's true oldest, and every message in
 * between is skipped — silently, on every page turn. Measured against a real
 * chat.db: 6 of 35 full-page threads diverged, worst case 193 messages lost in
 * a single turn with the cursor date jumping forward two years.
 */

function msg(id: number, iso: string): Message {
  return {
    id,
    guid: `guid-${id}`,
    text: `message ${id}`,
    handle: "+15551234567",
    isFromMe: false,
    date: new Date(iso),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    isReaction: false,
  } as unknown as Message;
}

/**
 * A merged-thread page: ROWID order and date order disagree. The oldest message
 * by date (2015) carries a HIGH rowid, because it arrived on a leg that was
 * imported later; the low-rowid message is from 2017.
 */
const MERGED_PAGE: Message[] = [
  msg(9001, "2017-12-02T10:00:00Z"), // lowest ROWID, but NOT the oldest
  msg(9500, "2016-04-18T10:00:00Z"),
  msg(9999, "2015-07-05T10:00:00Z"), // highest ROWID, and the true oldest
];

describe("get_messages pagination cursor", () => {
  let server: any;

  beforeAll(() => {
    process.env.IMSG_DEV = "1";
    server = new IMessageMCPServer();
  });

  afterAll(async () => {
    delete process.env.IMSG_DEV;
    await server.db?.close();
  });

  it("advertises the min-by-(date,ROWID) id, not the min ROWID", async () => {
    server.db.getMessagesForChat = async () => MERGED_PAGE;
    server.db.findChatByHandle = async () => null;

    const res = await server.handleGetMessages({ chatIdentifier: "+15551234567", limit: 3 });

    // 9999 is the oldest by date; 9001 is the min ROWID and would skip 2015-2017.
    expect(res.structuredContent?.oldestMessageId).toBe(9999);
    expect(res.structuredContent?.oldestMessageId).not.toBe(9001);

    const text: string = res.content?.[0]?.text ?? "";
    expect(text).toMatch(/oldestMessageId=9999/);
  });

  it("round-trips: the advertised cursor reaches the page's oldest message", async () => {
    server.db.getMessagesForChat = async () => MERGED_PAGE;
    server.db.findChatByHandle = async () => null;

    const res = await server.handleGetMessages({ chatIdentifier: "+15551234567", limit: 3 });
    const cursor = res.structuredContent?.oldestMessageId as number;

    // Feeding the cursor back must not strand any message in the page: every
    // message is at-or-after the cursor's date, so nothing older was skipped.
    const cursorDate = MERGED_PAGE.find((m) => m.id === cursor)?.date as Date;
    for (const m of MERGED_PAGE) {
      expect(m.date.getTime()).toBeGreaterThanOrEqual(cursorDate.getTime());
    }
  });

  it("degenerate page (single message) still reports that message", async () => {
    server.db.getMessagesForChat = async () => [msg(42, "2020-01-01T00:00:00Z")];
    server.db.findChatByHandle = async () => null;

    const res = await server.handleGetMessages({ chatIdentifier: "+15551234567", limit: 3 });
    expect(res.structuredContent?.oldestMessageId).toBe(42);
  });

  it("ties on date fall back to the lower ROWID", async () => {
    const sameInstant = "2021-06-01T12:00:00Z";
    server.db.getMessagesForChat = async () => [
      msg(700, sameInstant),
      msg(500, sameInstant),
      msg(900, sameInstant),
    ];
    server.db.findChatByHandle = async () => null;

    const res = await server.handleGetMessages({ chatIdentifier: "+15551234567", limit: 3 });
    expect(res.structuredContent?.oldestMessageId).toBe(500);
  });
});
