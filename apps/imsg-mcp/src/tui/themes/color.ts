/**
 * Pure color-space utilities — re-exported from `@george43g/tui-kit/theme`,
 * which lifted this module's implementation verbatim (its header credits this
 * file). Named re-exports only: the kit's own theme model (`derivePalette`,
 * `Theme`, `ThemeProvider`, `GlyphSet`) is deliberately NOT pulled into
 * imsg's namespace — imsg keeps its own flat theme model in `palette.ts` /
 * `ThemeContext.tsx` (see the EQSTACK-16B adoption brief: 391 read sites,
 * colliding key types).
 *
 * Hex format: always 7-char `#RRGGBB`. Output strings are lower-case.
 * HSL: h ∈ [0, 360), s ∈ [0, 1], l ∈ [0, 1].
 */

export {
  contrastRatio,
  type Hsl,
  hexToHsl,
  hslToHex,
  relativeLuminance,
  rotateHue,
  tint,
  withL,
  withS,
} from "@george43g/tui-kit/theme";
