/**
 * Glyph presets — the user-selectable "theme" axis.
 *
 * - "safe" (default): only universally-renderable glyphs. Geometric
 *   Shapes (▶ ◀ ●), ASCII separators (─), emoji where every modern OS
 *   font has them (✉ 💬 📱). No Powerline private-use codepoints, no
 *   Nerd Font icons. Renders correctly in Apple Terminal, Warp, iTerm2,
 *   VS Code's integrated terminal, Alacritty defaults, kitty defaults.
 *
 * - "powerline": Powerline arrows + Nerd Font icons. Looks better but
 *   requires the user's terminal font to be a Nerd-Font-patched build
 *   (FiraCode Nerd Font, JetBrainsMono Nerd Font, etc.). The README
 *   warns about this. `imsg config show` flags it too.
 *
 * Categories — the consumer (theme.ts → makeTheme) just spreads one of
 * these into the produced Theme object.
 */

export interface GlyphSet {
  /** Powerline arrow separators. Only used when the user opts in. */
  arrowRight: string;
  arrowRightThin: string;
  arrowLeft: string;
  arrowLeftThin: string;

  /** Direction indicators on each message row. Always single-cell-wide. */
  sent: string;
  received: string;

  /** Status indicators */
  unreadDot: string;
  envelope: string;

  /** Service icons (iMessage / SMS) */
  iMessage: string;
  sms: string;

  /** Misc UI */
  paperclip: string;
  group: string;
  search: string;
  pencil: string;
  refresh: string;
  separator: string;
}

const SAFE: GlyphSet = {
  // Powerline arrows aren't actually safe — for the safe preset we
  // substitute simple ASCII triangles. Components that draw arrow
  // separators between segments fall back to vertical bar `│`.
  arrowRight: "│",
  arrowRightThin: "│",
  arrowLeft: "│",
  arrowLeftThin: "│",
  // Geometric Shapes — fixed-width East-Asian range, every font has them.
  sent: "▶", // ▶
  received: "◀", // ◀
  unreadDot: "●",
  envelope: "✉",
  iMessage: "💬",
  sms: "📱",
  paperclip: "📎",
  group: "☰",
  search: "⌕",
  pencil: "✎",
  refresh: "↻",
  separator: "─",
};

const POWERLINE: GlyphSet = {
  // Powerline private-use range (E0B0..E0B3).
  arrowRight: "",
  arrowRightThin: "",
  arrowLeft: "",
  arrowLeftThin: "",
  // Use the Powerline arrows as direction glyphs too — visually consistent.
  sent: "",
  received: "",
  unreadDot: "●",
  envelope: "", // Nerd Font envelope (FontAwesome)
  iMessage: "", // Nerd Font speech bubble
  sms: "", // Nerd Font phone
  paperclip: "", // Nerd Font paperclip
  group: "", // Nerd Font group
  search: "", // Nerd Font magnifier
  pencil: "", // Nerd Font pencil
  refresh: "", // Nerd Font refresh
  separator: "─",
};

export const GLYPH_PRESETS = {
  safe: SAFE,
  powerline: POWERLINE,
} as const;

export type GlyphPreset = keyof typeof GLYPH_PRESETS;

export const TAPBACK_EMOJI: Record<string, string> = {
  love: "❤️",
  like: "👍",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  question: "❓",
};
