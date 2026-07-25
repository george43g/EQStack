import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMessageMCPServer } from "../src/index.js";

/**
 * get_messages must make its scope explicit. Omitting chatIdentifier/threadSlug
 * yields an interleaved feed across ALL conversations — a footgun an agent
 * previously mistook for one person's thread. The response now carries a
 * structured `scope` field ("global" | "conversation") and, for the global
 * case, a leading banner in the text so the distinction is unmissable.
 */
describe("get_messages scope signalling", () => {
  let server: any;

  beforeAll(() => {
    process.env.IMSG_DEV = "1";
    server = new IMessageMCPServer();
  });

  afterAll(async () => {
    delete process.env.IMSG_DEV;
    await server.db?.close();
  });

  it("marks an unscoped call as a global timeline (field + banner)", async () => {
    const res = await server.handleGetMessages({ limit: 3 });
    expect(res.structuredContent?.scope).toBe("global");
    const text: string = res.content?.[0]?.text ?? "";
    expect(text).toMatch(/Global timeline/i);
    // The banner must point the agent at how to narrow.
    expect(text).toMatch(/chatIdentifier|threadSlug/);
  });

  it("marks a scoped call as a conversation, with no global banner", async () => {
    // Scope is determined by the INPUT, not by whether messages were found, so
    // a bogus identifier (0 messages) still reports scope: "conversation".
    const res = await server.handleGetMessages({ chatIdentifier: "no-such-handle-xyz", limit: 3 });
    expect(res.structuredContent?.scope).toBe("conversation");
    const text: string = res.content?.[0]?.text ?? "";
    expect(text).not.toMatch(/Global timeline/i);
  });
});
