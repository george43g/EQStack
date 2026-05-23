// Handler-level tests for src/core/ops/messages.ts.
//
// Covers gap items 1.1 (read_email handler), 1.3 (search_emails handler),
// 1.4 (modify_email labelIds precedence), 1.5 (delete_email handler), and
// 1.6 (schema parse) from docs/test-coverage-inventory.md.
//
// Strategy: import the module so the ops register themselves on the singleton
// registry, then dispatch by name with a hand-rolled OperationContext whose
// `gmail` field is a deep nest of vi.fn() stubs. No real Gmail API calls.

import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import {
  DeleteEmailSchema,
  ModifyEmailSchema,
  ReadEmailSchema,
  SearchEmailsSchema,
} from "../../tools.js";
import type { OperationContext } from "../context.js";
import { registry } from "../registry.js";
// Side-effect import: registers readEmail / searchEmails / modifyEmail / deleteEmail.
import "./messages.js";

// Build a context whose gmail.users.messages.* are all vi.fn()s with the
// provided per-method overrides. Anything not overridden is a noop fn.
function makeCtx(overrides: {
  get?: ReturnType<typeof vi.fn>;
  list?: ReturnType<typeof vi.fn>;
  modify?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
}): OperationContext {
  const messages = {
    get: overrides.get ?? vi.fn(),
    list: overrides.list ?? vi.fn(),
    modify: overrides.modify ?? vi.fn(),
    delete: overrides.delete ?? vi.fn(),
  };
  const gmail = {
    users: { messages },
  } as unknown as gmail_v1.Gmail;
  return {
    gmail,
    oauth2Client: {} as OAuth2Client,
    authorizedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    toolName: "test",
  };
}

describe("read_email handler", () => {
  it("renders full message and populates structuredContent (1.1)", async () => {
    const getMock = vi.fn().mockResolvedValue({
      data: {
        threadId: "T123",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Subject", value: "hi" },
            { name: "From", value: "a@b.com" },
            { name: "To", value: "c@d.com" },
            { name: "Date", value: "2026-05-01" },
            { name: "Message-ID", value: "<msg-1@example>" },
          ],
          body: { data: Buffer.from("hello world", "utf8").toString("base64") },
        },
      },
    });
    const ctx = makeCtx({ get: getMock });

    const result = await registry.dispatch("read_email", { messageId: "M1" }, ctx);

    expect(getMock).toHaveBeenCalledWith({ userId: "me", id: "M1", format: "full" });
    expect(result.content[0].text).toContain("Thread ID: T123");
    expect(result.content[0].text).toContain("Subject: hi");
    expect(result.content[0].text).toContain("hello world");
    expect(result.structuredContent).toMatchObject({
      messageId: "M1",
      threadId: "T123",
      subject: "hi",
      from: "a@b.com",
      to: "c@d.com",
      date: "2026-05-01",
      rfcMessageId: "<msg-1@example>",
      body: "hello world",
      bodyText: "hello world",
      bodyHtml: "",
      attachments: [],
    });
  });

  it("emits the HTML-only contentTypeNote when no plain text is present (1.1)", async () => {
    const getMock = vi.fn().mockResolvedValue({
      data: {
        threadId: "T2",
        payload: {
          mimeType: "text/html",
          headers: [{ name: "Subject", value: "html only" }],
          body: { data: Buffer.from("<p>hi</p>", "utf8").toString("base64") },
        },
      },
    });
    const ctx = makeCtx({ get: getMock });

    const result = await registry.dispatch("read_email", { messageId: "Mhtml" }, ctx);
    expect(result.content[0].text).toContain(
      "[Note: This email is HTML-formatted. Plain text version not available.]",
    );
    expect(result.structuredContent).toMatchObject({
      body: "<p>hi</p>",
      bodyHtml: "<p>hi</p>",
      bodyText: "",
    });
  });
});

describe("search_emails handler", () => {
  it("defaults maxResults to 10 and fetches metadata per hit (1.3)", async () => {
    const listMock = vi.fn().mockResolvedValue({
      data: { messages: [{ id: "m1" }, { id: "m2" }] },
    });
    const getMock = vi.fn().mockImplementation(async ({ id }: { id: string }) => ({
      data: {
        payload: {
          headers: [
            { name: "Subject", value: `subj-${id}` },
            { name: "From", value: `from-${id}@x` },
            { name: "Date", value: `date-${id}` },
          ],
        },
      },
    }));
    const ctx = makeCtx({ list: listMock, get: getMock });

    const result = await registry.dispatch("search_emails", { query: "in:inbox" }, ctx);

    expect(listMock).toHaveBeenCalledWith({ userId: "me", q: "in:inbox", maxResults: 10 });
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(getMock).toHaveBeenCalledWith({
      userId: "me",
      id: "m1",
      format: "metadata",
      metadataHeaders: ["Subject", "From", "Date"],
    });
    expect(result.structuredContent).toEqual({
      resultCount: 2,
      results: [
        { id: "m1", subject: "subj-m1", from: "from-m1@x", date: "date-m1" },
        { id: "m2", subject: "subj-m2", from: "from-m2@x", date: "date-m2" },
      ],
    });
  });

  it("honours an explicit maxResults and tolerates an empty result list (1.3)", async () => {
    const listMock = vi.fn().mockResolvedValue({ data: {} });
    const getMock = vi.fn();
    const ctx = makeCtx({ list: listMock, get: getMock });

    const result = await registry.dispatch(
      "search_emails",
      { query: "label:important", maxResults: 25 },
      ctx,
    );

    expect(listMock).toHaveBeenCalledWith({ userId: "me", q: "label:important", maxResults: 25 });
    expect(getMock).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({ resultCount: 0, results: [] });
  });
});

describe("modify_email handler", () => {
  it("addLabelIds wins over the deprecated labelIds field; removeLabelIds passes through (1.4)", async () => {
    const modifyMock = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx({ modify: modifyMock });

    const result = await registry.dispatch(
      "modify_email",
      {
        messageId: "M9",
        labelIds: ["LEGACY"],
        addLabelIds: ["NEW"],
        removeLabelIds: ["GONE"],
      },
      ctx,
    );

    expect(modifyMock).toHaveBeenCalledWith({
      userId: "me",
      id: "M9",
      requestBody: { addLabelIds: ["NEW"], removeLabelIds: ["GONE"] },
    });
    expect(result.structuredContent).toEqual({ messageId: "M9", status: "modified" });
  });

  it("falls back to labelIds → addLabelIds when only the deprecated field is supplied (1.4)", async () => {
    const modifyMock = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx({ modify: modifyMock });

    await registry.dispatch("modify_email", { messageId: "M10", labelIds: ["L1", "L2"] }, ctx);

    expect(modifyMock).toHaveBeenCalledWith({
      userId: "me",
      id: "M10",
      requestBody: { addLabelIds: ["L1", "L2"] },
    });
  });
});

describe("delete_email handler (1.5)", () => {
  it("calls gmail.users.messages.delete and returns deleted status", async () => {
    const deleteMock = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx({ delete: deleteMock });

    const result = await registry.dispatch("delete_email", { messageId: "Mdel" }, ctx);

    expect(deleteMock).toHaveBeenCalledWith({ userId: "me", id: "Mdel" });
    expect(result.content[0].text).toBe("Email Mdel deleted successfully");
    expect(result.structuredContent).toEqual({ messageId: "Mdel", status: "deleted" });
  });
});

describe("schema parse (1.6)", () => {
  it("ReadEmailSchema requires messageId", () => {
    expect(ReadEmailSchema.parse({ messageId: "abc" })).toEqual({ messageId: "abc" });
    expect(() => ReadEmailSchema.parse({})).toThrow();
  });

  it("SearchEmailsSchema requires query and accepts optional maxResults", () => {
    expect(SearchEmailsSchema.parse({ query: "in:inbox" })).toEqual({ query: "in:inbox" });
    expect(SearchEmailsSchema.parse({ query: "x", maxResults: 5 })).toEqual({
      query: "x",
      maxResults: 5,
    });
    expect(() => SearchEmailsSchema.parse({})).toThrow();
  });

  it("ModifyEmailSchema requires messageId; all label arrays are optional", () => {
    expect(ModifyEmailSchema.parse({ messageId: "m" })).toEqual({ messageId: "m" });
    expect(
      ModifyEmailSchema.parse({
        messageId: "m",
        labelIds: ["A"],
        addLabelIds: ["B"],
        removeLabelIds: ["C"],
      }),
    ).toEqual({
      messageId: "m",
      labelIds: ["A"],
      addLabelIds: ["B"],
      removeLabelIds: ["C"],
    });
    expect(() => ModifyEmailSchema.parse({ labelIds: ["A"] })).toThrow();
  });

  it("DeleteEmailSchema requires messageId", () => {
    expect(DeleteEmailSchema.parse({ messageId: "m" })).toEqual({ messageId: "m" });
    expect(() => DeleteEmailSchema.parse({})).toThrow();
  });
});
