// End-to-end cross-account unread summary against the fixture corpus.
//
// Proves unread_summary (Milestone C) aggregates unread counts across BOTH
// fixture accounts (work + personal) in a single call, and — critically — does
// NOT change the active account (it never calls setSession). A follow-up
// dispatch must still hit the original account's fixture.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetForTests as resetSession, getCurrentAccountId } from "../../src/core/session.js";
import { _resetDispatcherForTests, bootstrapSession, callMcpTool } from "../../src/index.js";

beforeEach(() => {
  resetSession();
  _resetDispatcherForTests();
  process.env.GMAIL_ACCOUNT = "work";
});

afterEach(() => {
  resetSession();
  _resetDispatcherForTests();
});

interface SummaryAccount {
  id: string;
  emailAddress: string | null;
  unreadInbox: number | null;
  unreadTotal: number | null;
  error?: string;
  skippedReason?: string;
}
interface Summary {
  activeAccountId: string | null;
  totalUnread: number;
  accounts: SummaryAccount[];
  truncated: boolean;
  total_available: number;
}

describe("e2e: unread_summary aggregates across accounts without switching", () => {
  it("reports per-account unread + aggregate and leaves the active account unchanged", async () => {
    await bootstrapSession();
    expect(getCurrentAccountId()).toBe("work");

    const result = await callMcpTool("unread_summary", {});
    expect(result.isError).not.toBe(true);
    const struct = result.structuredContent as Summary;

    expect(struct.activeAccountId).toBe("work");

    // Both fixture accounts carry a read scope (work: gmail.modify, personal:
    // gmail.readonly), so both are summarised — none skipped or errored.
    const work = struct.accounts.find((a) => a.id === "work");
    const personal = struct.accounts.find((a) => a.id === "personal");
    expect(work).toMatchObject({ unreadInbox: 3, unreadTotal: 5 });
    expect(personal).toMatchObject({ unreadInbox: 1, unreadTotal: 2 });
    expect(work?.error).toBeUndefined();
    expect(personal?.error).toBeUndefined();

    // Aggregate = sum of per-account inbox unread (3 + 1).
    expect(struct.totalUnread).toBe(4);
    expect(struct.truncated).toBe(false);
    expect(struct.total_available).toBe(struct.accounts.length);

    // The summary must NOT have swapped the active account.
    expect(getCurrentAccountId()).toBe("work");

    // …and a subsequent dispatch still hits the work fixture, not personal.
    const inbox = await callMcpTool("list_inbox_threads", { maxResults: 5 });
    const threads = (
      inbox.structuredContent as { threads: Array<{ threadId: string }> }
    ).threads.map((t) => t.threadId);
    expect(threads).toContain("w_thr_001");
    expect(threads).not.toContain("p_thr_001");
  });
});
