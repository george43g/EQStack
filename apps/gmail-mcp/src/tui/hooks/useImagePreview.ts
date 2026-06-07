// Inline terminal image preview. Detects iTerm2 / kitty / Ghostty graphics
// support from env, encodes the image bytes with the matching protocol, and
// emits the escape sequence directly to stdout. Uses the same Ink-suspend
// flow as useEditor — drop raw mode, pause stdin, write, wait for a key,
// resume — so the image isn't overwritten by Ink's next frame.
//
// Falls back to a status-message-only return when the host terminal doesn't
// support an inline protocol; the caller can then choose to open the file
// with the OS image viewer instead.

import fs from "node:fs/promises";
import path from "node:path";

export type ImageTerminal = "iterm2" | "kitty" | null;

export function detectImageTerminal(env: NodeJS.ProcessEnv = process.env): ImageTerminal {
  // iTerm2 sets TERM_PROGRAM=iTerm.app; LC_TERMINAL=iTerm2 is also set when
  // the user has the Shell Integration installed.
  if (env.TERM_PROGRAM === "iTerm.app" || env.LC_TERMINAL === "iTerm2") return "iterm2";
  // Kitty + Ghostty + WezTerm all speak the kitty graphics protocol.
  // - kitty sets TERM=xterm-kitty
  // - Ghostty sets TERM_PROGRAM=ghostty
  // - WezTerm sets TERM_PROGRAM=WezTerm
  if (env.TERM === "xterm-kitty") return "kitty";
  if (env.TERM_PROGRAM === "ghostty") return "kitty";
  if (env.TERM_PROGRAM === "WezTerm") return "kitty";
  // Tmux passes terminal escape sequences through to the host terminal when
  // it's in passthrough mode. If TMUX is set we still detect the outer term
  // via the same env vars Tmux propagates (TERM_PROGRAM is usually preserved).
  return null;
}

export type ImagePreviewResult = "shown" | "unsupported" | "error";

export interface OpenImagePreviewOptions {
  /** Absolute path to the image file on disk. */
  imagePath: string;
  /** Caller passes Ink's setRawMode so we can drop the TTY lock cleanly. */
  setRawMode: ((mode: boolean) => void) | undefined;
}

/**
 * Suspend Ink, paint the image inline at the cursor, wait for a key, resume
 * Ink. Returns "unsupported" when the terminal can't render images so the
 * caller can fall back (e.g. spawn `open` on macOS).
 *
 * Re-uses the suspend pattern from useEditor.ts:
 *   setRawMode(false) → pause stdin → write to stdout → wait for keypress →
 *   resume stdin → setRawMode(true) → Ink redraws on next render tick.
 */
export async function openImagePreview({
  imagePath,
  setRawMode,
}: OpenImagePreviewOptions): Promise<ImagePreviewResult> {
  const term = detectImageTerminal();
  if (!term) return "unsupported";

  try {
    const bytes = await fs.readFile(imagePath);
    const seq = buildImageEscape(term, bytes, path.basename(imagePath));

    // Suspend Ink (mirrors useEditor flow).
    if (setRawMode) setRawMode(false);
    process.stdin.pause();
    // Take a fresh viewport — clear the screen and emit the image at home.
    // Ink will repaint over the top whenever it next renders, so we lock the
    // user in an explicit "press any key to continue" state until they choose
    // to return.
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(seq);
    process.stdout.write("\r\n\r\n");
    process.stdout.write("press any key to return…\r\n");

    // Wait for a single key. raw mode is off so we get cooked input — that
    // means a single press triggers as soon as it arrives via stdin.
    process.stdin.resume();
    await new Promise<void>((resolve) => {
      const onData = () => {
        process.stdin.off("data", onData);
        resolve();
      };
      process.stdin.on("data", onData);
    });
    return "shown";
  } catch {
    return "error";
  } finally {
    // Restore Ink's TTY ownership; the next state-change render will repaint
    // the panes cleanly.
    try {
      process.stdin.pause();
    } catch {
      // ignore
    }
    if (setRawMode) setRawMode(true);
    try {
      process.stdin.resume();
    } catch {
      // ignore
    }
  }
}

function buildImageEscape(term: ImageTerminal, bytes: Buffer, filename: string): string {
  const b64 = bytes.toString("base64");
  if (term === "iterm2") {
    // OSC 1337 (iTerm2 proprietary). `inline=1` displays inline rather than
    // saving. `name=` is base64-encoded per the spec.
    const nameB64 = Buffer.from(filename).toString("base64");
    return `\x1b]1337;File=name=${nameB64};inline=1;preserveAspectRatio=1:${b64}\x07`;
  }
  // Kitty graphics protocol — a=T (transmit + display), f=100 means PNG,
  // m=1 chunks for big payloads. We chunk at 4096 bytes per kitty's
  // recommendation; smaller images send a single chunk with m=0.
  const CHUNK = 4096;
  if (b64.length <= CHUNK) {
    return `\x1b_Ga=T,f=100,m=0;${b64}\x1b\\`;
  }
  const chunks: string[] = [];
  let i = 0;
  while (i < b64.length) {
    const part = b64.slice(i, i + CHUNK);
    const more = i + CHUNK < b64.length ? 1 : 0;
    if (i === 0) {
      chunks.push(`\x1b_Ga=T,f=100,m=${more};${part}\x1b\\`);
    } else {
      chunks.push(`\x1b_Gm=${more};${part}\x1b\\`);
    }
    i += CHUNK;
  }
  return chunks.join("");
}
