/**
 * TUI theme — assembled from a glyph preset + an accent-derived palette.
 *
 * Components consume the resolved theme via `useTheme()` from
 * `./themes/ThemeContext.js`. This file's `makeTheme()` is the single
 * place where palette + glyphs combine into the final shape.
 *
 * Backwards-compat: a few non-component places still want a constant
 * `glyphs` / `TAPBACK_EMOJI`. Those remain re-exported here. The legacy
 * `theme` constant export is gone — components were swept to `useTheme()`
 * in the same change as this refactor.
 */

import { GLYPH_PRESETS, type GlyphPreset, type GlyphSet } from "./themes/glyphs.js";
import { DEFAULT_ACCENT, derivePalette, type Palette } from "./themes/palette.js";

export interface Theme extends Palette {
  glyphs: GlyphSet;
}

export interface ThemeOptions {
  preset?: GlyphPreset;
  accent?: string;
}

export function makeTheme({ preset = "safe", accent = DEFAULT_ACCENT }: ThemeOptions = {}): Theme {
  return {
    ...derivePalette(accent),
    glyphs: GLYPH_PRESETS[preset],
  };
}

export { GLYPH_PRESETS, type GlyphPreset, type GlyphSet, TAPBACK_EMOJI } from "./themes/glyphs.js";
export { DEFAULT_ACCENT } from "./themes/palette.js";
