/**
 * Validate structuredContent the way an MCP client does: against the
 * ADVERTISED JSON Schema (tools/list outputSchema), with a 2020-12 validator,
 * after a JSON round-trip — not with the zod schema's `.parse`.
 *
 * Why this exists (2026-10-07): zod's `.parse` strips unknown keys, so
 * `tests/mcp-output-schema.test.ts` passed while the emitted JSON Schema says
 * `additionalProperties: false` and the runtime returned `replyTo.replyToKind`,
 * `attachments[].emojiDescription` and `editHistory`. Claude Code 2.1.292
 * rejected every get_messages page holding a reply or an attachment.
 */
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { IMessageMCPServer } from "../src/index.js";
import { messageToStructured } from "../src/mcp-format.js";
import { MessageSchema } from "../src/mcp-schemas.js";
import { getActiveTools } from "../src/mcp-tools.js";
import type { Message } from "../src/types.js";

const ajv = new Ajv2020({ strict: false, allErrors: true });
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const errorsOf = (validate: ValidateFunction) =>
  (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message} ${JSON.stringify(e.params)}`);

/** Every optional field the runtime can set, populated. */
function fullyPopulatedMessage(): Message {
  const d = new Date("2026-10-01T10:00:00Z");
  return {
    id: 1,
    guid: "g-1",
    text: "hello",
    handle: "+15555550100",
    displayName: "Test Person",
    isFromMe: false,
    date: d,
    dateRead: d,
    dateDelivered: d,
    isRead: true,
    isDelivered: true,
    sendError: 22,
    chatId: "iMessage;-;+15555550100",
    service: "iMessage",
    isReaction: false,
    reaction: {
      type: "love",
      emoji: "❤️",
      fromHandle: "+15555550100",
      isRemoval: false,
      targetMessageGuid: "g-0",
      targetMessagePart: 0,
    },
    isReply: true,
    replyTo: { replyToGuid: "g-0", replyToText: null, replyToKind: "image" },
    reactions: [],
    richContentType: "link_preview",
    richContentSummary: "a link",
    isEdited: true,
    isRetracted: false,
    editHistory: {
      parts: [
        {
          part: 0,
          versions: [
            { text: "helo", date: d },
            { text: null, date: null },
          ],
        },
      ],
      retractedParts: [1],
    },
    appleAudioTranscript: "transcript",
    interpretedMedia: { kind: "image", text: "a screenshot", source: "cache" },
    hasAttachments: true,
    attachments: [
      {
        rowId: 7,
        filename: "~/Library/Messages/Attachments/a.png",
        mimeType: "image/png",
        transferName: "a.png",
        totalBytes: 1024,
        emojiDescription: null,
      },
    ],
  } as Message;
}

describe("structuredContent matches the advertised JSON Schema (wire validation)", () => {
  it("a fully populated message validates against the advertised Message schema", () => {
    const { $schema: _d, ...schema } = zodToJsonSchema(MessageSchema) as Record<string, unknown>;
    const validate = ajv.compile(schema);
    const ok = validate(wire(messageToStructured(fullyPopulatedMessage())));
    expect(errorsOf(validate)).toEqual([]);
    expect(ok).toBe(true);
  });

  it("the advertised Message schema still rejects unknown keys (the check is real)", () => {
    const { $schema: _d, ...schema } = zodToJsonSchema(MessageSchema) as Record<string, unknown>;
    const validate = ajv.compile(schema);
    const msg = wire(messageToStructured(fullyPopulatedMessage())) as Record<string, unknown>;
    (msg.attachments as Record<string, unknown>[])[0]!.notInSchema = 1;
    expect(validate(msg)).toBe(false);
  });

  describe("real handler output over the fixtures", () => {
    let server: any;
    const prev = process.env.IMSG_DEV;
    beforeAll(() => {
      process.env.IMSG_DEV = "1";
      server = new IMessageMCPServer();
    });
    afterAll(async () => {
      if (prev === undefined) delete process.env.IMSG_DEV;
      else process.env.IMSG_DEV = prev;
      await server.db?.close();
    });

    const cases: { name: string; call: () => Promise<any> }[] = [
      { name: "get_messages", call: () => server.handleGetMessages({ limit: 0 }) },
      { name: "get_unread_messages", call: () => server.handleGetUnreadMessages({ limit: 0 }) },
      {
        name: "search_messages",
        call: () => server.handleSearchMessages({ query: "a", limit: 0 }),
      },
      { name: "list_conversations", call: () => server.handleListConversations({ limit: 0 }) },
      { name: "search_attachments", call: () => server.handleSearchAttachments({ limit: 0 }) },
      { name: "list_contacts", call: () => server.handleListContacts({ limit: 0 }) },
      {
        name: "resolve_conversation",
        call: () => server.handleResolveConversation({ query: "a", limit: 0 }),
      },
      { name: "health_check", call: () => server.handleHealthCheck({}) },
    ];

    for (const { name, call } of cases) {
      it(`${name}`, async () => {
        const tool = getActiveTools().find((t) => t.name === name);
        expect(tool?.outputSchema, `${name} advertises an outputSchema`).toBeTruthy();
        const res = await call();
        const content = res?.structuredContent;
        expect(content, `${name} returned structuredContent`).toBeTruthy();
        const validate = ajv.compile(tool!.outputSchema as object);
        const ok = validate(wire(content));
        expect(errorsOf(validate)).toEqual([]);
        expect(ok).toBe(true);
      });
    }
  });
});
