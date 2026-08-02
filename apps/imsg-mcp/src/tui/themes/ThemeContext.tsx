/**
 * React context that delivers a fully-resolved Theme to every TUI
 * component. Replaces the legacy pattern of `import { theme } from "../theme"`
 * — components now `const theme = useTheme()` so the same component tree
 * can render with different accents / glyph presets.
 *
 * Lookup outside a provider throws — TypeScript would let it slide
 * silently otherwise (default value), and a missing provider is a
 * developer error we want to surface during the first render.
 */

import { createContext, type ReactNode, useContext } from "react";
import type { Theme } from "../theme.js";

const ThemeCtx = createContext<Theme | null>(null);

export function ThemeProvider({ value, children }: { value: Theme; children: ReactNode }) {
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): Theme {
  const t = useContext(ThemeCtx);
  if (!t) {
    throw new Error("useTheme(): no <ThemeProvider> in the component tree above this hook");
  }
  return t;
}
