// Validates the editor-suspend contract without actually spawning vim:
// stub child_process.spawn so we control the exit code + post-edit content.

import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import * as cp from "node:child_process";
import { createEditorOpener, resolveEditor } from "./useEditor.js";

const mockedSpawn = cp.spawn as unknown as ReturnType<typeof vi.fn>;

interface FakeChild {
  on: (event: string, cb: (...args: unknown[]) => void) => FakeChild;
}

function makeChild(
  exitCode: number,
  postEditContent: string | null,
  tmpFileRef: { path: string | null },
): FakeChild {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const child: FakeChild = {
    on: (event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
      // Schedule the editor "exit" microtask so the awaiting Promise resolves.
      if (event === "exit") {
        setImmediate(async () => {
          // Simulate the user saving content before exit.
          if (postEditContent !== null && tmpFileRef.path) {
            await fs.writeFile(tmpFileRef.path, postEditContent, "utf8");
          }
          for (const fn of listeners.exit ?? []) fn(exitCode, null);
        });
      }
      return child;
    },
  };
  return child;
}

describe("resolveEditor", () => {
  it("prefers VISUAL then EDITOR then GMAIL_TUI_EDITOR then vi", () => {
    expect(resolveEditor({ VISUAL: "code", EDITOR: "vim" })).toBe("code");
    expect(resolveEditor({ EDITOR: "vim" })).toBe("vim");
    expect(resolveEditor({ GMAIL_TUI_EDITOR: "nano" })).toBe("nano");
    expect(resolveEditor({})).toBe("vi");
  });
});

describe("createEditorOpener", () => {
  let setRawMode: ReturnType<typeof vi.fn>;
  let origPause: typeof process.stdin.pause;
  let origResume: typeof process.stdin.resume;

  beforeEach(() => {
    setRawMode = vi.fn();
    mockedSpawn.mockReset();
    origPause = process.stdin.pause.bind(process.stdin);
    origResume = process.stdin.resume.bind(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin) as typeof process.stdin.pause;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin) as typeof process.stdin.resume;
  });

  afterEach(() => {
    process.stdin.pause = origPause;
    process.stdin.resume = origResume;
  });

  it("writes the initialContent, spawns the editor, returns the post-edit content on exit 0", async () => {
    const tmpFileRef: { path: string | null } = { path: null };
    mockedSpawn.mockImplementation((bin: string, args: string[]) => {
      tmpFileRef.path = args[0] ?? null;
      return makeChild(0, "edited body", tmpFileRef);
    });
    const open = createEditorOpener(setRawMode, { EDITOR: "vim" });
    const result = await open({ initialContent: "draft" });
    expect(result.exitCode).toBe(0);
    expect(result.content).toBe("edited body");
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(setRawMode).toHaveBeenCalledWith(true);
  });

  it("returns null content when the editor exits non-zero (user aborted)", async () => {
    const tmpFileRef: { path: string | null } = { path: null };
    mockedSpawn.mockImplementation((bin: string, args: string[]) => {
      tmpFileRef.path = args[0] ?? null;
      return makeChild(1, null, tmpFileRef);
    });
    const open = createEditorOpener(setRawMode, { EDITOR: "vim" });
    const result = await open({ initialContent: "draft" });
    expect(result.exitCode).toBe(1);
    expect(result.content).toBeNull();
  });

  it("restores setRawMode(true) even when the editor errors out", async () => {
    mockedSpawn.mockImplementation(
      () =>
        ({
          on: (event: string, cb: (...args: unknown[]) => void) => {
            if (event === "error") setImmediate(() => cb(new Error("ENOENT")));
            return { on: () => ({}) };
          },
        }) as unknown as ReturnType<typeof cp.spawn>,
    );
    const open = createEditorOpener(setRawMode, { EDITOR: "definitely-not-an-editor" });
    await expect(open({ initialContent: "x" })).rejects.toThrow(/ENOENT/);
    expect(setRawMode).toHaveBeenCalledWith(true);
  });
});
