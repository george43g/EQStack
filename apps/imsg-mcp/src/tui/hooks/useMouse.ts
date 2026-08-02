import { useStdin } from "ink";
import { useEffect } from "react";

export interface MouseEvent {
  type: "click" | "scroll-up" | "scroll-down";
  x: number;
  y: number;
  button: number;
}

/**
 * Enable SGR mouse protocol and parse mouse events from stdin.
 * Calls `onEvent` for each click or scroll wheel event.
 */
export function useMouse(onEvent: (event: MouseEvent) => void) {
  const { stdin, setRawMode } = useStdin();

  useEffect(() => {
    // ?1000h = button-event tracking (press/release + scroll wheel only).
    // Do NOT use ?1003h (any-event tracking) — it fires for every pixel of
    // mouse motion, flooding stdin and pinning the event loop.
    // ?1006h = SGR extended coordinates so x/y aren't capped at 223.
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
    setRawMode(true);

    const handler = (data: Buffer) => {
      const str = data.toString();
      // SGR mouse format: \x1b[<btn;x;y;M (press) or \x1b[<btn;x;y;m (release)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the terminal mouse protocol prefix.
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      let match = re.exec(str);
      while (match !== null) {
        const btn = Number.parseInt(match[1], 10);
        const x = Number.parseInt(match[2], 10);
        const y = Number.parseInt(match[3], 10);
        const isPress = match[4] === "M";

        if (btn === 64 && isPress) {
          onEvent({ type: "scroll-up", x, y, button: btn });
        } else if (btn === 65 && isPress) {
          onEvent({ type: "scroll-down", x, y, button: btn });
        } else if (btn === 0 && isPress) {
          onEvent({ type: "click", x, y, button: btn });
        }
        match = re.exec(str);
      }
    };

    stdin.on("data", handler);
    return () => {
      stdin.off("data", handler);
      process.stdout.write("\x1b[?1000l\x1b[?1006l");
    };
  }, [stdin, setRawMode, onEvent]);
}
