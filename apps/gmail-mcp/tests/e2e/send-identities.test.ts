// End-to-end coverage for list_send_identities against the work fixture.
//
// Proves the settings read op returns the account's send-as identities,
// forwarding addresses, and the inbound routing filters that reveal a
// catch-all/forwarding setup ("mail to X@domain → label Y").

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

describe("e2e: list_send_identities surfaces send-as + routing", () => {
  it("returns identities, forwarding, and the catch-all routing filter", async () => {
    await bootstrapSession();

    const result = await callMcpTool("list_send_identities", {});
    expect(result.isError).not.toBe(true);
    const s = result.structuredContent as {
      sendAsIdentities: Array<{ email: string; isDefault: boolean; treatAsAlias: boolean }>;
      forwardingAddresses: Array<{ email: string }>;
      inboundRoutingFilters: Array<{ id: string; to: string | null; addLabelIds: string[] }>;
      truncated: boolean;
      total_available: number;
    };

    const emails = s.sendAsIdentities.map((i) => i.email);
    expect(emails).toContain("user-work@fixture.test");
    expect(emails).toContain("admin@catchall.fixture.test");
    expect(emails).toContain("sales@catchall.fixture.test");
    expect(s.sendAsIdentities.find((i) => i.email === "user-work@fixture.test")?.isDefault).toBe(
      true,
    );

    expect(s.forwardingAddresses.map((f) => f.email)).toContain("archive@fixture.test");

    // The catch-all routing filter (to:catchall.fixture.test → Label_1) is surfaced.
    const catchAll = s.inboundRoutingFilters.find((f) => f.id === "FilterCatchAll");
    expect(catchAll?.to).toBe("catchall.fixture.test");
    expect(catchAll?.addLabelIds).toContain("Label_1");

    expect(s.truncated).toBe(false);
    expect(s.total_available).toBe(s.sendAsIdentities.length);
  });
});
