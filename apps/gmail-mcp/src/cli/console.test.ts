// Unit tests for the console REPL helpers. The interactive loop itself is
// covered by manual smoke tests (`gmail console` over a TTY); these tests
// focus on the pure helpers + the REPL-mode flag round-trip in runtime.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    ["t", "threads"],
    ["mod", "modify"],
    ["del", "delete"],
    ["bm", "batch-modify"],
    ["bd", "batch-delete"],
    ["lab", "labels"],
    ["fil", "filters"],
    ["de", "download-email"],
    ["da", "download-attachment"],
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

// ── runConsole legend + REPL-driven built-ins ────────────────────────────
// These tests mock `node:readline.createInterface` so the loop can be driven
// from in-memory line queues instead of stdin. `runConsole` returns once the
// legend is rendered and bootstrap settles; the readline mock keeps the loop
// alive by calling each queued line's question-callback in turn, and signals
// completion via a resolver shared with the test.

describe("runConsole legend + REPL built-ins (11.7, 11.11, 11.12)", () => {
  type Line = string;
  let queuedLines: Line[];
  let doneResolve: (() => void) | null;
  let donePromise: Promise<void>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    queuedLines = [];
    doneResolve = null;
    donePromise = new Promise<void>((r) => {
      doneResolve = r;
    });
    // Capture writes to stdout/stderr without printing during tests.
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Guard against accidental process.exit (rl.on("close")) — readline mock
    // never emits close, but be defensive.
    originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`__exit_called__:${code}`);
    }) as typeof process.exit;

    // Mock readline so `rl.question(prompt, cb)` pops the next queued line
    // and dispatches it. When the queue empties, resolve the test's
    // donePromise instead of hanging.
    vi.resetModules();
    vi.doMock("node:readline", () => ({
      createInterface: () => ({
        question: (_prompt: string, cb: (line: string) => void) => {
          if (queuedLines.length === 0) {
            // No more lines — signal completion. The loop is left dangling
            // (the next question() never resolves), but the test has already
            // observed the side-effects it cares about.
            doneResolve?.();
            return;
          }
          const next = queuedLines.shift() as string;
          // Defer to a microtask so the synchronous `loop()` returns first,
          // matching how a real readline would invoke the callback.
          queueMicrotask(() => cb(next));
        },
        on: (_event: string, _handler: () => void) => {
          // Swallow close handlers — runConsole registers one that calls
          // process.exit(0). Not invoking it keeps the test process alive.
        },
        close: () => {},
      }),
    }));
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exit = originalExit;
    vi.doUnmock("node:readline");
    vi.resetModules();
  });

  it("(11.7) renders the legend with section headers via the `write` injector", async () => {
    const writes: string[] = [];
    const write = (s: string) => {
      writes.push(s);
    };
    // No queued lines — the readline mock will resolve donePromise on the
    // first question() call, immediately after legend rendering completes.
    const { runConsole } = await import("./console.js");
    await runConsole({ write });
    await donePromise;

    const joined = writes.join("\n");
    // Header / title.
    expect(joined).toContain("gmail console");
    // Each section header from LEGEND_LINES.
    expect(joined).toMatch(/Read:/);
    expect(joined).toMatch(/Write:/);
    expect(joined).toMatch(/Manage:/);
    expect(joined).toMatch(/Debug:/);
    expect(joined).toMatch(/Session:/);
    // A couple of representative command rows so we know the loop iterated.
    expect(joined).toMatch(/i \[n\]/);
    expect(joined).toMatch(/raw <name> <json>/);
  });

  it("(11.11) `raw` with no tool name prints a usage hint without crashing", async () => {
    queuedLines.push("raw");
    const { runConsole } = await import("./console.js");
    await runConsole({ write: () => {} });
    await donePromise;
    // Give the microtask-deferred callback time to run.
    await new Promise((r) => setTimeout(r, 10));

    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toMatch(/Usage: raw <toolName>/);
  });

  it("(11.11) `raw <tool> <bad-json>` reports invalid JSON without crashing", async () => {
    queuedLines.push("raw health_check {not valid json");
    const { runConsole } = await import("./console.js");
    await runConsole({ write: () => {} });
    await donePromise;
    await new Promise((r) => setTimeout(r, 10));

    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toMatch(/Invalid JSON/);
  });

  it("(11.12) `tools` enumerates registered tool names from the registry", async () => {
    queuedLines.push("tools");
    const { runConsole } = await import("./console.js");
    await runConsole({ write: () => {} });
    await donePromise;
    // listTools awaits bootstrap + dynamic registry import; allow microtasks
    // to drain so its stdout writes land before we assert.
    await new Promise((r) => setTimeout(r, 50));

    const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    // The registry side-effect-loads every op when ../core/ops/index.js is
    // imported (which happens transitively via runConsole → bootstrapForCli
    // → main → src/index.ts). Spot-check a few well-known names.
    expect(stdoutText).toMatch(/health_check/);
    expect(stdoutText).toMatch(/search_emails/);
    expect(stdoutText).toMatch(/list_email_labels/);
  });
});
