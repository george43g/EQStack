/**
 * Interactive-console routing: the console REPL turns a typed line into a
 * tool call. These tests lock the parser (quoting, verbs) and the
 * line → {tool, args} routing without a live MCP server, using a fake client
 * that records each callTool. No messages are sent (the `send` case only
 * asserts the routed params).
 */
import { describe, expect, it, vi } from "vitest";
import { parseConsoleInput, parseWindowDays, runConsoleCommand } from "../src/cli.js";
import type { LocalMcpClient } from "../src/mcp-client.js";

function fakeClient() {
  const calls: Array<{ name: string; args: any }> = [];
  const client = {
    callTool: vi.fn(async (name: string, args: object) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "ok" }], isError: false };
    }),
  } as unknown as LocalMcpClient;
  return { client, calls };
}

/** Route a raw console line and return the single tool call it produced. */
async function route(line: string) {
  const { client, calls } = fakeClient();
  const { cmd, args } = parseConsoleInput(line);
  await runConsoleCommand(cmd, args, client);
  return calls;
}

describe("parseConsoleInput", () => {
  it("lowercases the command and splits on spaces", () => {
    expect(parseConsoleInput("LIST 20")).toEqual({ cmd: "list", args: ["20"] });
  });

  it("keeps quoted segments intact (double and single quotes)", () => {
    expect(parseConsoleInput('search "happy birthday" 5')).toEqual({
      cmd: "search",
      args: ["happy birthday", "5"],
    });
    expect(parseConsoleInput("send alice 'see you at 5'")).toEqual({
      cmd: "send",
      args: ["alice", "see you at 5"],
    });
  });

  it("collapses runs of spaces and trims", () => {
    expect(parseConsoleInput("  msg    alice   10 ")).toEqual({
      cmd: "msg",
      args: ["alice", "10"],
    });
  });

  it("returns an empty command for a blank line", () => {
    expect(parseConsoleInput("   ")).toEqual({ cmd: "", args: [] });
  });
});

describe("runConsoleCommand routing", () => {
  it("list / conversations → list_conversations with a numeric limit", async () => {
    expect(await route("list 3")).toEqual([{ name: "list_conversations", args: { limit: 3 } }]);
    expect((await route("conversations"))[0]).toMatchObject({ name: "list_conversations" });
  });

  it("msg with a slug routes threadSlug, with a handle routes chatIdentifier", async () => {
    expect((await route("msg alice~imsg~a3f2"))[0]).toEqual({
      name: "get_messages",
      args: { threadSlug: "alice~imsg~a3f2", limit: 20 },
    });
    expect((await route("msg +15551234567 5"))[0]).toEqual({
      name: "get_messages",
      args: { chatIdentifier: "+15551234567", limit: 5 },
    });
  });

  it("msg with a leading number treats it as a limit, not a chat", async () => {
    expect((await route("msg 10"))[0]).toEqual({
      name: "get_messages",
      args: { limit: 10 },
    });
  });

  it("search requires a query and passes the limit", async () => {
    expect((await route("search pizza 7"))[0]).toEqual({
      name: "search_messages",
      args: { query: "pizza", limit: 7 },
    });
    await expect(route("search")).rejects.toThrow(/Usage: search/);
  });

  it("resolve routes to resolve_conversation with a query + limit", async () => {
    expect((await route("resolve selena"))[0]).toEqual({
      name: "resolve_conversation",
      args: { query: "selena", limit: 10 },
    });
    expect((await route("resolve selena 3"))[0]).toEqual({
      name: "resolve_conversation",
      args: { query: "selena", limit: 3 },
    });
    await expect(route("resolve")).rejects.toThrow(/Usage: resolve/);
  });

  it("send routes recipient vs threadSlug and joins the message", async () => {
    expect((await route("send +15551234567 hello there"))[0]).toEqual({
      name: "send_message",
      args: { recipient: "+15551234567", message: "hello there" },
    });
    expect((await route("send weekend~imsg~d4e5 yo"))[0]).toEqual({
      name: "send_message",
      args: { threadSlug: "weekend~imsg~d4e5", message: "yo" },
    });
    await expect(route("send alice")).rejects.toThrow(/Usage: send/);
  });

  it("contacts sub-verbs route to the right tools", async () => {
    expect((await route("contacts search alex 5"))[0]).toEqual({
      name: "search_contacts",
      args: { query: "alex", limit: 5 },
    });
    expect((await route("contacts show 233"))[0]).toEqual({
      name: "get_contact",
      args: { id: 233 },
    });
    expect((await route("contacts show alice@example.com"))[0]).toEqual({
      name: "get_contact",
      args: { handle: "alice@example.com" },
    });
    expect((await route("contacts resolve +15551234567"))[0]).toEqual({
      name: "resolve_handle",
      args: { handle: "+15551234567" },
    });
    await expect(route("contacts bogus")).rejects.toThrow(/Unknown contacts verb/);
  });

  it("humans top / init route to leaderboard + init_human", async () => {
    expect((await route("humans top"))[0]).toEqual({
      name: "chat_analytics",
      args: { type: "relationship_leaderboard", windowDays: 1825 },
    });
    expect((await route("humans init top 3"))[0]).toEqual({
      name: "init_human",
      args: { top: 3 },
    });
    expect((await route("humans init dad~imsg~60a1"))[0]).toEqual({
      name: "init_human",
      args: { threadSlug: "dad~imsg~60a1" },
    });
    expect((await route("humans init Jane Doe"))[0]).toEqual({
      name: "init_human",
      args: { contact: "Jane Doe" },
    });
  });

  it("humans with no verb / help shows usage without leaking 'undefined'", async () => {
    await expect(route("humans")).rejects.toThrow(/Usage:\s*\n\s*humans init/);
    await expect(route("humans")).rejects.not.toThrow(/undefined/);
    await expect(route("humans help")).rejects.toThrow(/Usage:/);
    await expect(route("humans bogus")).rejects.toThrow(/Unknown humans verb: bogus/);
  });

  it("analytics <type> routes to chat_analytics with the type's default window", async () => {
    expect((await route("analytics messaging_streaks"))[0]).toEqual({
      name: "chat_analytics",
      args: { type: "messaging_streaks", windowDays: 365 },
    });
    // Explicit window overrides the default.
    expect((await route("analytics daily_heatmap 30"))[0]).toEqual({
      name: "chat_analytics",
      args: { type: "daily_heatmap", windowDays: 30 },
    });
    // A trailing json/yaml token is a format, not a window.
    expect((await route("analytics tapback_summary json"))[0]).toEqual({
      name: "chat_analytics",
      args: { type: "tapback_summary", windowDays: 365 },
    });
    await expect(route("analytics bogus_type")).rejects.toThrow(/Usage: analytics/);
  });

  it("unknown command throws a helpful error", async () => {
    await expect(route("frobnicate")).rejects.toThrow();
  });
});

describe("parseWindowDays", () => {
  it("defaults when absent or empty", () => {
    expect(parseWindowDays(undefined, 90)).toBe(90);
    expect(parseWindowDays("", 365)).toBe(365);
  });

  it("parses a positive number", () => {
    expect(parseWindowDays("30", 90)).toBe(30);
    expect(parseWindowDays("1825", 90)).toBe(1825);
  });

  it("rejects non-numeric / non-positive input with a clear message", () => {
    expect(() => parseWindowDays("abc", 90)).toThrow(/windowDays must be a positive number/);
    expect(() => parseWindowDays("0", 90)).toThrow(/positive number/);
    expect(() => parseWindowDays("-5", 90)).toThrow(/positive number/);
  });
});
