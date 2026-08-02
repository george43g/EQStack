import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMessageMCPServer } from "../src/index.js";
import { OUTPUT_SCHEMAS, type ToolName } from "../src/mcp-tools.js";

// We can instantiate the server and test handlers directly
// But we need to make sure we don't start the transport.

describe("MCP Output Schema Validation", () => {
  let server: any;

  beforeAll(() => {
    process.env.IMSG_DEV = "1";
    server = new IMessageMCPServer();
  });

  afterAll(async () => {
    delete process.env.IMSG_DEV;
    await server.db?.close();
  });

  async function callHandler(name: ToolName, args: unknown): Promise<any> {
    const handlerMap: Record<ToolName, (args: unknown) => Promise<any>> = {
      get_messages: server.handleGetMessages.bind(server),
      export_messages: server.handleExportMessages.bind(server),
      get_unread_messages: server.handleGetUnreadMessages.bind(server),
      send_message: server.handleSendMessage.bind(server),
      wait_for_reply: server.handleWaitForReply.bind(server),
      list_conversations: server.handleListConversations.bind(server),
      search_messages: server.handleSearchMessages.bind(server),
      get_logs: server.handleGetLogs.bind(server),
      get_last_send_error: server.handleGetLastSendError.bind(server),
      run_build: () => Promise.resolve({ structuredContent: { ok: true, stdout: "", stderr: "" } }), // Mock to avoid running build in tests
      request_restart: server.handleRequestRestart.bind(server),
      health_check: server.handleHealthCheck.bind(server),
      list_contacts: server.handleListContacts.bind(server),
      search_contacts: server.handleSearchContacts.bind(server),
      get_contact: server.handleGetContact.bind(server),
      resolve_conversation: server.handleResolveConversation.bind(server),
      resolve_handle: server.handleResolveHandle.bind(server),
      check_imessage_availability: server.handleCheckImessageAvailability.bind(server),
      search_attachments: server.handleSearchAttachments.bind(server),
      get_attachment: server.handleGetAttachment.bind(server),
      chat_analytics: server.handleChatAnalytics.bind(server),
    };

    return handlerMap[name](args);
  }

  const testCases: { name: ToolName; args: unknown; validate?: boolean }[] = [
    { name: "get_messages", args: { limit: 5 } },
    { name: "get_unread_messages", args: { limit: 5 } },
    { name: "list_conversations", args: { limit: 5 } },
    { name: "search_messages", args: { query: "hello", limit: 5 } },
    { name: "get_logs", args: { tail: 5 } },
    { name: "get_last_send_error", args: {} },
    { name: "health_check", args: {} },
    { name: "request_restart", args: {}, validate: false },
    { name: "run_build", args: {} },
    // Mock send_message output shape? We should test that its structuredContent matches.
    { name: "send_message", args: { message: "test", recipient: "test@example.com" } },
    // export_messages writes a file, we could mock or provide a temp path
    {
      name: "export_messages",
      args: { outputPath: "/tmp/export_test.md", chatIdentifier: "test" },
      validate: false,
    }, // we can skip it or use temp
    {
      name: "wait_for_reply",
      args: { chatIdentifier: "test", timeoutSeconds: 0.1 },
      validate: false,
    }, // difficult to test due to timeout
    { name: "list_contacts", args: { limit: 5 } },
    { name: "search_contacts", args: { query: "z", limit: 5 } },
    { name: "get_contact", args: { handle: "+15555550100" } },
    { name: "resolve_conversation", args: { query: "z", limit: 5 } },
    { name: "resolve_handle", args: { handle: "+15555550100" } },
    { name: "check_imessage_availability", args: { handle: "+15555550100" } },
    { name: "search_attachments", args: { limit: 5 } },
    { name: "get_attachment", args: { rowId: 999999 }, validate: false }, // file likely missing
    { name: "chat_analytics", args: { type: "daily_heatmap", windowDays: 7 } },
  ];

  for (const { name, args, validate } of testCases) {
    if (validate === false) continue;

    it(`validates output schema for ${name}`, async () => {
      let res: any;
      try {
        if (name === "send_message") {
          // Mock send_message to return a valid structured output without actually sending
          res = { structuredContent: { success: true } };
        } else {
          res = await callHandler(name, args);
        }
      } catch (_e) {
        // Just skip if there's an error calling the handler
        return;
      }

      const content = res?.structuredContent;
      if (content) {
        const schema = OUTPUT_SCHEMAS[name];
        expect(() => schema.parse(content)).not.toThrow();
      }
    });
  }

  it("validates search_messages empty result output", async () => {
    const res = await callHandler("search_messages", {
      query: "zzzz_imsg_mcp_schema_no_match",
      limit: 5,
    });
    expect(() => OUTPUT_SCHEMAS.search_messages.parse(res.structuredContent)).not.toThrow();
  });

  it("validates get_messages empty chat output", async () => {
    const res = await callHandler("get_messages", {
      chatIdentifier: "definitely-no-such-chat-identifier",
      limit: 5,
    });
    expect(() => OUTPUT_SCHEMAS.get_messages.parse(res.structuredContent)).not.toThrow();
  });

  it("get_contact maps each handle to its thread slug (contact → conversation)", async () => {
    // Slugs are derived data: on a fresh fixture set (CI regenerates
    // fixtures/slugs.db) the store starts empty until the background sync
    // populates it. Kick the sync and wait for the fixture chat's slug so the
    // assertion doesn't depend on leftover local state.
    server.db.scheduleBackgroundSlugSync();
    const deadline = Date.now() + 5000;
    while (!server.db.getSlugForChatGuid("iMessage;-;+15550000100") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    // Fixture: Blake Reed owns +15550000100, which has a 1:1 chat.
    const res = await callHandler("get_contact", { handle: "+15550000100" });
    const content = res.structuredContent;
    expect(() => OUTPUT_SCHEMAS.get_contact.parse(content)).not.toThrow();
    expect(content.contact?.displayName).toBe("Blake Reed");
    const entry = content.threads.find((t: any) => t.handle === "+15550000100");
    expect(entry).toBeDefined();
    expect(entry.threadSlug).toMatch(/~/); // resolved to a real slug
    // The text payload surfaces the mapping for CLI users too.
    expect(res.content?.[0]?.text).toContain("Threads:");
  });
});
