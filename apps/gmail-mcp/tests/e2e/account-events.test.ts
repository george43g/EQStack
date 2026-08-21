// E2E: switch_account fires sessionEvents.accountChanged once per real swap.
// Pins the TUI's refresh-on-swap subscription contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDispatcherForTests, bootstrapSession, callMcpTool } from "../../src/index.js";
import { _resetForTests as resetSession, sessionEvents } from "../../src/core/session.js";

beforeEach(() => {
  resetSession();
  _resetDispatcherForTests();
  process.env.GMAIL_ACCOUNT = "work";
});

afterEach(() => {
  sessionEvents.removeAllListeners();
  resetSession();
  _resetDispatcherForTests();
});

describe("e2e: sessionEvents.accountChanged", () => {
  it("fires when switch_account changes the active id", async () => {
    await bootstrapSession();

    const handler = vi.fn();
    sessionEvents.on("accountChanged", handler);

    await callMcpTool("switch_account", { accountId: "personal" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        previous: "work",
        current: "personal",
        scopes: ["gmail.readonly"],
      }),
    );
  });

  it("does NOT fire when switching to the already-active account (no-op)", async () => {
    await bootstrapSession();

    const handler = vi.fn();
    sessionEvents.on("accountChanged", handler);

    await callMcpTool("switch_account", { accountId: "work" });
    expect(handler).not.toHaveBeenCalled();
  });
});
