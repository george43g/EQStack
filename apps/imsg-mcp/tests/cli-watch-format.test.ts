/**
 * Console `watch` verb — one printed line per live change event.
 * The formatter is pure; the ChangeWatcher/EventBus plumbing behind the verb
 * is covered by change-watcher.test.ts / event-bus.test.ts.
 */

import { describe, expect, it } from "vitest";
import { formatChangeEventLine } from "../src/cli.js";
import type { ChangeEvent } from "../src/event-bus.js";
import type { Message } from "../src/types.js";

function msg(overrides: Partial<Message>): Message {
  return {
    id: 1,
    guid: "g1",
    text: "hello world",
    handle: "+15550000131",
    isFromMe: false,
    chatId: "+15550000131",
    isReaction: false,
    ...overrides,
  } as Message;
}

describe("formatChangeEventLine", () => {
  it("prints type, thread slug, sender, and snippet", () => {
    const e: ChangeEvent = { type: "message.new", message: msg({ displayName: "Quinn" }) };
    const line = formatChangeEventLine(e, () => "quinn-smith~imsg~782a");
    expect(line).toBe("[message.new] ~quinn-smith~imsg~782a Quinn: hello world");
  });

  it("falls back to the raw leg identifier when the slug store can't map it", () => {
    const e: ChangeEvent = { type: "reaction", message: msg({}) };
    const line = formatChangeEventLine(e, () => null);
    expect(line).toBe("[reaction] ~+15550000131 +15550000131: hello world");
  });

  it("labels from-me rows as 'me' and collapses whitespace into one capped line", () => {
    const e: ChangeEvent = {
      type: "message.new",
      message: msg({ isFromMe: true, text: `a\n\n b${"x".repeat(200)}` }),
    };
    const line = formatChangeEventLine(e, () => "slug");
    expect(line).toContain("me: a b");
    expect(line?.length).toBeLessThanOrEqual("[message.new] ~slug me: ".length + 80);
    expect(line).not.toContain("\n");
  });

  it("handles text-less rows and skips group events (no consumer yet)", () => {
    const noText: ChangeEvent = { type: "message.new", message: msg({ text: null }) };
    expect(formatChangeEventLine(noText, () => "slug")).toContain("(no text)");
    const group: ChangeEvent = { type: "group.renamed", chatIdentifier: "chat1000" };
    expect(formatChangeEventLine(group, () => "slug")).toBeNull();
  });
});
