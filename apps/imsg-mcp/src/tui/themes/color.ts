/**
 * Pure color-space utilities. No dependencies, no side effects.
 *
 * The TUI palette derives its 30-odd hex colors from a single accent
 * hex; that derivation is HSL math (rotate hue, mix toward grey, push
 * lightness up or down). All of those operations live here so they can
 * be unit-tested without dragging in any rendering code.
 *
 * Hex format: always 7-char `#RRGGBB`. Output strings are lower-case.
 * HSL: h ∈ [0, 360), s ∈ [0, 1], l ∈ [0, 1].
 */

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

/** Parse `#rrggbb` to {r,g,b} ∈ [0,255]. Throws on invalid input. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  if (!HEX6_RE.test(hex)) {
    throw new Error(`invalid hex color: ${hex} (expected #RRGGBB)`);
  }
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function hexToHsl(hex: string): Hsl {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.max(0, Math.min(1, s));
  const ll = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hh < 60) [r1, g1, b1] = [c, x, 0];
  else if (hh < 120) [r1, g1, b1] = [x, c, 0];
  else if (hh < 180) [r1, g1, b1] = [0, c, x];
  else if (hh < 240) [r1, g1, b1] = [0, x, c];
  else if (hh < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return rgbToHex((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255);
}

/** Return `hex` with lightness set to `l` ∈ [0,1]. */
export function withL(hex: string, l: number): string {
  const hsl = hexToHsl(hex);
  return hslToHex({ ...hsl, l });
}

/** Return `hex` with saturation set to `s` ∈ [0,1]. s=0 produces grey at the same lightness. */
export function withS(hex: string, s: number): string {
  const hsl = hexToHsl(hex);
  return hslToHex({ ...hsl, s });
}

/** Rotate hue by `degrees`. Negative values supported. */
export function rotateHue(hex: string, degrees: number): string {
  const hsl = hexToHsl(hex);
  return hslToHex({ ...hsl, h: hsl.h + degrees });
}

/**
 * Produce a desaturated, dark-or-light-tinted variant of `accent`. Used
 * by the palette to make borders / backgrounds / dim text feel like they
 * belong to the accent's "color family" without screaming.
 *
 * @param l       Target lightness ∈ [0,1]
 * @param satMul  Multiplier on the original saturation (1 = keep, 0 = grey)
 */
export function tint(accent: string, l: number, satMul: number): string {
  const hsl = hexToHsl(accent);
  return hslToHex({ h: hsl.h, s: hsl.s * satMul, l });
}

/**
 * WCAG-approximate relative luminance of a hex color.
 * Used by tests to assert palette-pair contrast ratios.
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (c: number) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two hex colors per WCAG 2.0. Range [1, 21]. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
