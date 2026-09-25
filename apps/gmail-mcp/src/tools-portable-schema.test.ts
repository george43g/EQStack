import { describe, expect, it } from "vitest";
import { getToolByName, normalizeToolArgs, SendEmailSchema, toMcpTools } from "./tools.js";

describe("portable MCP input schemas", () => {
  it("publishes optional object fields as required nullable fields", () => {
    const tool = toMcpTools([getToolByName("draft_email")!])[0];
    const schema = tool.inputSchema as any;
    const item = schema.properties.inlineImages.anyOf[0].items;

    expect(schema.required).toEqual([
      "to",
      "subject",
      "body",
      "from",
      "htmlBody",
      "mimeType",
      "cc",
      "bcc",
      "threadId",
      "inReplyTo",
      "attachments",
      "inlineImages",
    ]);
    expect(item.required).toEqual(["cid", "path", "content", "contentType", "filename"]);
    expect(item.properties.path.anyOf).toEqual([
      expect.objectContaining({ type: "string" }),
      { type: "null" },
    ]);
    expect(item.properties.content.anyOf).toEqual([
      expect.objectContaining({ type: "string" }),
      { type: "null" },
    ]);
    expect(item.properties.contentType.anyOf[0].enum).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/bmp",
      "image/x-icon",
    ]);
    expect(item.properties.cid.pattern).toBeUndefined();
  });
});

describe("portable MCP argument normalization", () => {
  it("removes nulls before strict Zod validation", () => {
    const result = SendEmailSchema.safeParse(
      normalizeToolArgs({
        to: ["recipient@example.com"],
        subject: "Subject",
        body: "Body",
        htmlBody: '<img src="cid:hero">',
        inlineImages: [
          {
            cid: "hero",
            path: "/tmp/hero.png",
            content: null,
            contentType: null,
            filename: null,
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inlineImages?.[0]).toEqual({ cid: "hero", path: "/tmp/hero.png" });
    }
  });

  it("preserves strict inline-image validation", () => {
    const base = {
      to: ["recipient@example.com"],
      subject: "Subject",
      body: "Body",
      htmlBody: '<img src="cid:hero">',
    };
    const invalidImages = [
      {
        cid: "hero",
        path: "/tmp/hero.png",
        content: "YQ==",
        contentType: "image/png",
        filename: null,
      },
      { cid: "hero", path: null, content: null, contentType: null, filename: null },
      { cid: "hero", path: null, content: "YQ==", contentType: null, filename: null },
    ];

    for (const inlineImage of invalidImages) {
      expect(
        SendEmailSchema.safeParse(normalizeToolArgs({ ...base, inlineImages: [inlineImage] }))
          .success,
      ).toBe(false);
    }
  });
});
