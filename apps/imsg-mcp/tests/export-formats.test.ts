/**
 * Pin export formats so future refactors don't silently break round-trips.
 */
import { describe, expect, it } from "vitest";
import { extensionFor, toCSV, toJSON, toMarkdown, toNDJSONLine } from "../src/export-formats.js";
import type { Message } from "../src/types.js";

const baseMsg = (overrides: Partial<Message>): Message => ({
  id: 1,
  guid: "g1",
  text: "hello",
  handle: "+1234567890",
  isFromMe: false,
  date: new Date("2024-03-15T10:30:00.000Z"),
  dateRead: null,
  dateDelivered: null,
  isRead: true,
  isDelivered: true,
  chatId: "c1",
  service: "iMessage",
  isReaction: false,
  isReply: false,
  isEdited: false,
  isRetracted: false,
  hasAttachments: false,
  ...overrides,
});

const FIXTURE: Message[] = [
  baseMsg({
    id: 1,
    text: "Hey, are you free tonight?",
    date: new Date("2024-03-15T10:30:00.000Z"),
  }),
  baseMsg({
    id: 2,
    text: "Yes — what time?",
    isFromMe: true,
    date: new Date("2024-03-15T10:31:00.000Z"),
  }),
  baseMsg({
    id: 3,
    text: "Around 7? 🎉",
    displayName: "Alice",
    date: new Date("2024-03-15T10:32:00.000Z"),
    isReply: true,
    replyTo: { replyToGuid: "g2", replyToText: "Yes — what time?" },
  }),
  baseMsg({
    id: 4,
    text: null,
    isFromMe: true,
    hasAttachments: true,
    date: new Date("2024-03-15T10:33:00.000Z"),
  }),
];

describe("toMarkdown", () => {
  it("includes header with thread name and participants", () => {
    const md = toMarkdown(FIXTURE, {
      thread: "Alice",
      participants: ["+1234567890"],
      serviceType: "iMessage",
    });
    expect(md).toContain("# Alice");
    expect(md).toContain("**Participants**: +1234567890");
    expect(md).toContain("**Service**: iMessage");
    expect(md).toContain("4 messages");
  });

  it("renders Me vs sender labels", () => {
    const md = toMarkdown(FIXTURE, { thread: "Alice" });
    expect(md).toContain("Me: Yes — what time?");
    expect(md).toContain("Alice: Around 7? 🎉");
  });

  it("renders reply context as blockquote", () => {
    const md = toMarkdown(FIXTURE, { thread: "Alice" });
    expect(md).toContain("> Yes — what time?");
  });

  it("shows attachment placeholder for null-text messages", () => {
    const md = toMarkdown(FIXTURE, { thread: "Alice" });
    expect(md).toContain("*(attachment)*");
  });
});

describe("toCSV", () => {
  it("starts with the header row", () => {
    const csv = toCSV(FIXTURE);
    const firstLine = csv.split("\n")[0];
    expect(firstLine).toBe(
      "id,date,sender,handle,is_from_me,is_read,is_reply,reply_to_text,text,has_attachments",
    );
  });

  it("escapes commas and quotes in text", () => {
    const msg = baseMsg({ id: 99, text: 'with, comma and "quote"' });
    const csv = toCSV([msg]);
    expect(csv).toContain('"with, comma and ""quote"""');
  });

  it("escapes newlines in text", () => {
    const msg = baseMsg({ id: 99, text: "line1\nline2" });
    const csv = toCSV([msg]);
    expect(csv).toContain('"line1\nline2"');
  });

  it("emits ISO dates", () => {
    const csv = toCSV([baseMsg({ id: 1, date: new Date("2024-03-15T10:30:00.000Z") })]);
    expect(csv).toContain("2024-03-15T10:30:00.000Z");
  });

  it("encodes booleans as 0 / 1", () => {
    const m = baseMsg({
      id: 7,
      isFromMe: true,
      isRead: false,
      isReply: true,
      hasAttachments: true,
    });
    const csv = toCSV([m]);
    const dataLine = csv.split("\n")[1];
    const fields = dataLine.split(",");
    // is_from_me, is_read, is_reply, has_attachments at indices 4, 5, 6, 9
    expect(fields[4]).toBe("1");
    expect(fields[5]).toBe("0");
    expect(fields[6]).toBe("1");
    expect(fields[9]).toBe("1");
  });
});

describe("toJSON", () => {
  it("produces valid JSON that round-trips", () => {
    const out = toJSON(FIXTURE, { thread: "Alice" });
    const parsed = JSON.parse(out) as {
      count: number;
      messages: Array<{ id: number; date: string }>;
    };
    expect(parsed.count).toBe(4);
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[0].id).toBe(1);
    expect(parsed.messages[0].date).toBe("2024-03-15T10:30:00.000Z");
  });
});

describe("toNDJSONLine", () => {
  it("produces one line per message, no trailing newline", () => {
    const line = toNDJSONLine(FIXTURE[0]);
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line);
    expect(parsed.id).toBe(1);
  });

  it("serializes identical data to identical bytes regardless of property insertion order", () => {
    // Message objects come from different construction paths (TS parser,
    // native parser, cache hydration) whose property insertion order differs.
    const base = FIXTURE[0];
    const reversed = Object.fromEntries(Object.entries(base).reverse()) as typeof base;
    expect(toNDJSONLine(reversed)).toBe(toNDJSONLine(base));
    // And the keys really are sorted.
    const keys = Object.keys(JSON.parse(toNDJSONLine(base)));
    expect(keys).toEqual([...keys].sort());
  });
});

describe("extensionFor", () => {
  it("maps formats to extensions", () => {
    expect(extensionFor("markdown")).toBe("md");
    expect(extensionFor("csv")).toBe("csv");
    expect(extensionFor("json")).toBe("json");
    expect(extensionFor("ndjson")).toBe("ndjson");
  });
});
