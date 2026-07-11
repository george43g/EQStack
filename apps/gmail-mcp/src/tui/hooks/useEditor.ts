// External `$EDITOR` suspend flow. The hook returns a single function that
// callers await: write content to a tmp .eml file → release Ink's raw mode →
// spawn the editor with stdio: "inherit" → read the file back when the editor
// exits. Ink's render loop survives the suspension (we don't unmount); the
// editor takes the TTY because we drop raw mode and pause stdin while it runs.
//
// The suspend-and-spawn pattern matches what aerc, mutt, and lazygit do.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface OpenEditorOptions {
  /** Initial content written to the tmp file before the editor opens. */
  initialContent: string;
  /** Override editor binary. Otherwise: VISUAL → EDITOR → "vi". */
  editor?: string;
  /** Extension on the tmp file — defaults to `.eml` so editor syntax highlighting kicks in. */
  extension?: string;
}

export interface OpenEditorResult {
  /** Content of the file after the editor exited. null if user aborted (non-zero exit). */
  content: string | null;
  /** Editor's exit code. */
  exitCode: number;
}

export type OpenEditor = (opts: OpenEditorOptions) => Promise<OpenEditorResult>;

export function resolveEditor(env: NodeJS.ProcessEnv = process.env): string {
  return env.VISUAL?.trim() || env.EDITOR?.trim() || env.GMAIL_TUI_EDITOR?.trim() || "vi";
}

/**
 * Factory — produces an `openEditor` function bound to the supplied
 * setRawMode callback. The hook itself doesn't depend on Ink; the wiring at
 * the App layer passes in `useStdin().setRawMode` so the editor can reclaim
 * the TTY cleanly.
 */
export function createEditorOpener(
  setRawMode: ((mode: boolean) => void) | undefined,
  env: NodeJS.ProcessEnv = process.env,
): OpenEditor {
  return async ({ initialContent, editor, extension = ".eml" }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-mcp-"));
    const tmpPath = path.join(tmpDir, `compose-${process.pid}-${Date.now()}${extension}`);
    await fs.writeFile(tmpPath, initialContent, "utf8");

    const bin = (editor ?? resolveEditor(env)).trim();
    // Cleanup helper — always runs, even on exception, to avoid tmp-file leaks.
    const cleanup = async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    };

    try {
      // Release Ink's raw-mode lock so the editor gets a clean TTY. Pause
      // stdin so Ink's input listeners don't grab bytes destined for the
      // editor. The editor process inherits the parent stdio so it renders
      // on the same alternate screen — when it exits, control returns to
      // Ink, which will redraw on the next state change.
      if (setRawMode) setRawMode(false);
      process.stdin.pause();

      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(bin, [tmpPath], {
          stdio: "inherit",
          env: { ...env },
          shell: false,
        });
        child.on("error", (err) => reject(err));
        child.on("exit", (code, signal) => {
          if (signal) {
            resolve(128 + (signalToNumber(signal) ?? 1));
            return;
          }
          resolve(code ?? 0);
        });
      });

      if (exitCode !== 0) {
        return { content: null, exitCode };
      }
      const content = await fs.readFile(tmpPath, "utf8");
      return { content, exitCode };
    } finally {
      try {
        process.stdin.resume();
      } catch {
        // ignore
      }
      if (setRawMode) setRawMode(true);
      await cleanup();
    }
  };
}

function signalToNumber(sig: NodeJS.Signals): number | null {
  const table: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[sig] ?? null;
}
