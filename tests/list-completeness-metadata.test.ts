import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMessageMCPServer } from "../src/index.js";

/**
 * Every list-returning tool must carry a uniform completeness signal so an
 * agent can tell when it's missing data: a boolean `truncated` everywhere, a
 * numeric `totalAvailable` where the full count is cheaply known, and NO dead
 * `nextOffset` (it was hardcoded `null` on non-paginable tools). Runs the real
 * handlers against the bundled dev DB.
 */
describe("list-response completeness metadata", () => {
  let server: any;

  beforeAll(() => {
    process.env.IMSG_DEV = "1";
    server = new IMessageMCPServer();
  });

  afterAll(async () => {
    delete process.env.IMSG_DEV;
    await server.db?.close();
  });

  const sc = (r: any) => r.structuredContent;

  it("every list tool reports a boolean `truncated`", async () => {
    const calls: [string, Promise<any>][] = [
      ["list_conversations", server.handleListConversations({ limit: 1 })],
      ["search_messages", server.handleSearchMessages({ query: "a", limit: 1 })],
      ["get_unread_messages", server.handleGetUnreadMessages({ limit: 1 })],
      ["list_contacts", server.handleListContacts({ limit: 1 })],
      ["search_contacts", server.handleSearchContacts({ query: "a", limit: 1 })],
      ["search_attachments", server.handleSearchAttachments({ limit: 1 })],
    ];
    for (const [name, p] of calls) {
      const r = await p;
      expect(typeof sc(r)?.truncated, `${name}.truncated`).toBe("boolean");
    }
  });

  it("removes the dead nextOffset from search_messages and get_unread_messages", async () => {
    const sm = sc(await server.handleSearchMessages({ query: "a", limit: 1 }));
    expect(sm).not.toHaveProperty("nextOffset");
    const un = sc(await server.handleGetUnreadMessages({ limit: 1 }));
    expect(un).not.toHaveProperty("nextOffset");
  });

  it("keeps the live nextOffset cursor on list_conversations", async () => {
    const r = sc(await server.handleListConversations({ limit: 1 }));
    // nextOffset is present: a number when more pages exist, else null.
    expect(r).toHaveProperty("nextOffset");
    if (r.truncated) expect(typeof r.nextOffset).toBe("number");
  });

  it("exposes totalAvailable on the contact tools (list aliases totalCount)", async () => {
    const lc = sc(await server.handleListContacts({ limit: 1 }));
    expect(typeof lc.totalAvailable).toBe("number");
    expect(lc.totalAvailable).toBe(lc.totalCount);
    const scn = sc(await server.handleSearchContacts({ query: "a", limit: 1 }));
    expect(typeof scn.totalAvailable).toBe("number");
  });

  it("flags truncation when more matched than the limit (search_contacts)", async () => {
    // Learn the true match count with an unbounded call, then verify a limit-1
    // call reports truncation iff there really are >1 matches.
    const all = sc(await server.handleSearchContacts({ query: "a", limit: 0 }));
    const one = sc(await server.handleSearchContacts({ query: "a", limit: 1 }));
    if (all.totalAvailable > 1) {
      expect(one.truncated).toBe(true);
      expect(one.count).toBe(1);
      expect(one.totalAvailable).toBe(all.totalAvailable);
    } else {
      expect(one.truncated).toBe(false);
    }
  });

  it("flags truncation via over-fetch (search_attachments)", async () => {
    const all = sc(await server.handleSearchAttachments({ limit: 0 }));
    expect(all.truncated).toBe(false); // unbounded returns everything
    if (all.count > 1) {
      const one = sc(await server.handleSearchAttachments({ limit: 1 }));
      expect(one.count).toBe(1);
      expect(one.truncated).toBe(true);
    }
  });
});
