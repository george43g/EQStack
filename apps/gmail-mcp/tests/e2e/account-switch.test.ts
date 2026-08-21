// End-to-end account switching against the fixture corpus.
//
// Flow:
//   1. bootstrapSession against fixtures/gmail/work/.
//   2. list_inbox_threads returns work-account threads.
//   3. switch_account → "personal".
//   4. list_inbox_threads returns personal-account threads.
//
// Proves the TUI's account-switcher contract: the dispatch path actually
// changes which fixture is consulted after the swap.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDispatcherForTests, bootstrapSession, callMcpTool } from "../../src/index.js";
import { _resetForTests as resetSession } from "../../src/core/session.js";

beforeEach(() => {
  resetSession();
  _resetDispatcherForTests();
  process.env.GMAIL_ACCOUNT = "work";
});

afterEach(() => {
  resetSession();
  _resetDispatcherForTests();
});

describe("e2e: switch_account swaps which fixture serves the next dispatch", () => {
  it("inbox threads differ between work and personal accounts", async () => {
    const bundle = await bootstrapSession();
    expect(bundle.accountId).toBe("work");

    const workInbox = await callMcpTool("list_inbox_threads", { maxResults: 50 });
    const workThreads = (
      workInbox.structuredContent as { threads: Array<{ threadId: string }> }
    ).threads.map((t) => t.threadId);
    expect(workThreads).toContain("w_thr_001");
    expect(workThreads).toContain("w_thr_002");
    expect(workThreads).not.toContain("p_thr_001");

    const swap = await callMcpTool("switch_account", { accountId: "personal" });
    expect(swap.isError).not.toBe(true);
    const swapped = swap.structuredContent as {
      previousAccountId: string | null;
      newAccountId: string;
      scopes: string[];
    };
    expect(swapped.previousAccountId).toBe("work");
    expect(swapped.newAccountId).toBe("personal");
    expect(swapped.scopes).toEqual(["gmail.readonly"]);

    const personalInbox = await callMcpTool("list_inbox_threads", { maxResults: 50 });
    const personalThreads = (
      personalInbox.structuredContent as { threads: Array<{ threadId: string }> }
    ).threads.map((t) => t.threadId);
    expect(personalThreads).toContain("p_thr_001");
    expect(personalThreads).toContain("p_thr_002");
    expect(personalThreads).not.toContain("w_thr_001");
  });

  it("list_accounts reports work + personal with the active flag honouring the swap", async () => {
    await bootstrapSession();

    const before = await callMcpTool("list_accounts", {});
    const beforeStruct = before.structuredContent as {
      active: { id: string };
      accounts: Array<{ id: string; isActive: boolean }>;
    };
    expect(beforeStruct.active.id).toBe("work");
    expect(beforeStruct.accounts.find((a) => a.id === "work")?.isActive).toBe(true);
    expect(beforeStruct.accounts.find((a) => a.id === "personal")?.isActive).toBe(false);

    await callMcpTool("switch_account", { accountId: "personal" });

    const after = await callMcpTool("list_accounts", {});
    const afterStruct = after.structuredContent as {
      active: { id: string };
      accounts: Array<{ id: string; isActive: boolean }>;
    };
    expect(afterStruct.active.id).toBe("personal");
    expect(afterStruct.accounts.find((a) => a.id === "personal")?.isActive).toBe(true);
    expect(afterStruct.accounts.find((a) => a.id === "work")?.isActive).toBe(false);
  });
});
