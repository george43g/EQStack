// Unit tests for the console REPL helpers. The interactive loop itself is
// covered by manual smoke tests (`gmail console` over a TTY); these tests
// focus on the pure helpers + the REPL-mode flag round-trip in runtime.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBuiltinCommand, parseConsoleInput, rewriteAlias } from "./console.js";
import { runCliOp } from "./runtime.js";

describe("parseConsoleInput", () => {
  it("splits a simple command line on whitespace", () => {
    expect(parseConsoleInput("inbox 10")).toEqual({ cmd: "inbox", args: ["10"] });
  });

  it("preserves double-quoted strings as single tokens", () => {
    expect(parseConsoleInput('search "from:noreply newer_than:7d"')).toEqual({
      cmd: "search",
      args: ["from:noreply newer_than:7d"],
    });
  });

  it("preserves single-quoted strings as single tokens", () => {
    expect(parseConsoleInput("send -s 'A subject with spaces'")).toEqual({
      cmd: "send",
      args: ["-s", "A subject with spaces"],
    });
  });

  it("handles mixed quoted and unquoted tokens", () => {
    expect(parseConsoleInput('mod abc123 --add "Important,Work"')).toEqual({
      cmd: "mod",
      args: ["abc123", "--add", "Important,Work"],
    });
  });

  it("returns empty cmd for empty input", () => {
    expect(parseConsoleInput("")).toEqual({ cmd: "", args: [] });
    expect(parseConsoleInput("   ")).toEqual({ cmd: "", args: [] });
  });
});

describe("rewriteAlias", () => {
  it.each([
    ["i", "inbox"],
    ["s", "search"],
    ["r", "read"],
    ["ra", "reply-all"],
    ["d", "draft"],
    ["mod", "modify"],
    ["del", "delete"],
    ["bm", "batch-modify"],
    ["bd", "batch-delete"],
    ["lab", "labels"],
    ["fil", "filters"],
    ["h", "health"],
  ])("rewrites %s → %s", (input, expected) => {
    expect(rewriteAlias(input)).toBe(expected);
  });

  it("passes unknown commands through unchanged", () => {
    expect(rewriteAlias("inbox")).toBe("inbox");
    expect(rewriteAlias("not-a-thing")).toBe("not-a-thing");
    expect(rewriteAlias("")).toBe("");
  });
});

describe("isBuiltinCommand", () => {
  it.each([
    "help",
    "?",
    "clear",
    "cls",
    "quit",
    "q",
    "exit",
    "tools",
    "raw",
  ])("recognises `%s` as a built-in", (cmd) => {
    expect(isBuiltinCommand(cmd)).toBe(true);
  });

  it("rejects regular commands", () => {
    expect(isBuiltinCommand("inbox")).toBe(false);
    expect(isBuiltinCommand("search")).toBe(false);
    expect(isBuiltinCommand("")).toBe(false);
  });
});

describe("runCliOp REPL-mode flag", () => {
  let originalExit: typeof process.exit;
  let exitCalls: Array<number | undefined>;

  beforeEach(() => {
    exitCalls = [];
    originalExit = process.exit;
    // Capture process.exit calls without actually exiting the test runner.
    process.exit = ((code?: number) => {
      exitCalls.push(code);
      throw new Error(`__exit_called__:${code}`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
    delete process.env.GMAIL_CLI_REPL;
  });

  it("does not call process.exit when GMAIL_CLI_REPL=1", async () => {
    process.env.GMAIL_CLI_REPL = "1";
    // Invoke runCliOp with a bogus tool name. bootstrapForCli will throw
    // (no credentials in test env), executeCliOp catches + writes to stderr,
    // returns isError outcome, and runCliOp should NOT call process.exit
    // because REPL mode is active.
    await runCliOp("definitely_not_a_real_tool", {}, { json: false });
    expect(exitCalls).toEqual([]);
  });

  it("calls process.exit when GMAIL_CLI_REPL is unset", async () => {
    delete process.env.GMAIL_CLI_REPL;
    // Same setup; this time runCliOp should exit (we intercept via thrown
    // Error). The exact code may be 1, 2, or 3 depending on error classifier.
    await expect(runCliOp("definitely_not_a_real_tool", {}, { json: false })).rejects.toThrow(
      /^__exit_called__/,
    );
    expect(exitCalls.length).toBe(1);
  });
});
