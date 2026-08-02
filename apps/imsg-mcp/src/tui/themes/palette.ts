/**
 * Single-accent palette derivation.
 *
 * The user picks one hex (default `#1982FC` = iMessage blue) and the
 * accent-driven parts of the palette come out of it. Approach:
 *
 * - **Accent-driven**: backgrounds, borders, headers, sidebar selection,
 *   sent-bubble fill, and the unread dot all use the accent's hue at
 *   varying lightness × saturation. Move the accent to orange and the
 *   whole UI shifts orange.
 * - **Neutral with accent tint**: text colors and dim backgrounds keep
 *   the accent's *hue* but at very low saturation (~5–10%). They feel
 *   like part of the family without competing with the accent itself.
 * - **Semantic colors stay fixed**: error red, sms green, attachment
 *   warm-yellow, edited gold. These need to be recognizable regardless
 *   of accent (a magenta accent shouldn't make SMS markers magenta).
 *   They're hand-tuned to coexist with any accent.
 *
 * The exported `Palette` shape mirrors what the legacy `theme` object
 * exported — the hand-tuned iMessage-inspired values are the target
 * for `accent = #1982FC`.
 */

import { contrastRatio, hexToHsl, hslToHex, withL, withS } from "./color.js";

export interface Palette {
  sent: { bg: string; fg: string; border: string };
  received: { bg: string; fg: string; border: string };
  pending: { bg: string; fg: string; border: string };

  sentText: string;
  receivedText: string;
  senderName: string;
  replyContext: string;
  attachment: string;
  lineNum: string;

  groupBg: { sent: string; received: string };
  selectionBg: string;

  sidebar: {
    selected: string;
    selectedFg: string;
    unread: string;
    read: string;
    snippet: string;
    slug: string;
    slugBg: string;
    separator: string;
    time: string;
  };

  border: string;
  dot: string;
  header: { focused: { bg: string; fg: string }; dim: { bg: string; fg: string } };
  info: { label: string; value: string };
  timestamp: string;
  status: { bg: string; fg: string; accent: string };
  help: { key: string; desc: string };
  sms: string;
  edited: string;
  compose: { bg: string; fg: string; placeholder: string };
  dateSep: string;
  drawer: { bg: string; border: string; label: string; value: string };

  /** Diagnostic — DevStats indicators that previously hard-coded #FF6B35 / #FF4444. */
  rustEngine: string;
  cpuHigh: string;
}

export const DEFAULT_ACCENT = "#1982FC";

export function derivePalette(accent: string): Palette {
  const { h } = hexToHsl(accent);
  // Lightness clamp helpers — accept any input accent, never produce
  // text that's invisible on the dark TUI background.
  const acc = (l: number) => hslToHex({ h, s: 0.95, l });
  // Near-grey, slight accent tint — for borders, dim text, neutral bgs.
  const tint = (l: number, s = 0.06) => hslToHex({ h, s, l });
  // Choose whichever of {near-black, near-white} produces better
  // contrast against `bg`. Used by sent bubbles + sidebar selection
  // where the bg is accent-driven and may swing across the lightness
  // spectrum (magenta at L=0.55 has just-medium luminance and needs
  // dark fg; iMessage blue at L=0.55 needs light fg).
  const dark = tint(0.05, 0.1);
  const light = tint(0.97, 0.05);
  const fgFor = (bg: string) => (contrastRatio(dark, bg) > contrastRatio(light, bg) ? dark : light);

  const sentBg = acc(0.55); // accent at full saturation, mid-light → "iMessage blue"
  const selectedBg = acc(0.27);
  return {
    sent: {
      bg: sentBg,
      fg: fgFor(sentBg),
      border: acc(0.42),
    },
    received: {
      // Light grey bubble, very slight accent tint — preserves the iMessage
      // "received" look. Stays the same shade across accents (it's mostly grey).
      bg: tint(0.91, 0.05),
      fg: tint(0.12, 0.1),
      border: tint(0.75, 0.05),
    },
    pending: {
      bg: tint(0.27, 0.06),
      fg: tint(0.74, 0.06),
      border: tint(0.35, 0.08),
    },

    sentText: acc(0.78), // light accent — for sent text shown outside a bubble
    receivedText: tint(0.85, 0.06),
    // Sender names: a fixed teal that reads as "another person" in every
    // accent. Keeping accent-derived would produce magenta sender names on
    // a magenta accent, defeating the visual cue.
    senderName: SEMANTIC.senderName,
    replyContext: tint(0.62, 0.1),
    attachment: SEMANTIC.attachment, // fixed warm yellow
    lineNum: tint(0.45, 0.05),

    groupBg: {
      sent: tint(0.16, 0.4), // dark, clearly accent-tinted (sent rows)
      received: hslToHex({ h: (h + 20) % 360, s: 0.18, l: 0.14 }), // close-but-not-equal
    },
    selectionBg: SEMANTIC.selection, // muted warm yellow — universal "selected"

    sidebar: {
      selected: selectedBg,
      selectedFg: fgFor(selectedBg),
      unread: tint(0.97, 0.05),
      read: tint(0.74, 0.06),
      snippet: tint(0.51, 0.05),
      slug: hslToHex({ h, s: 0.28, l: 0.55 }),
      slugBg: tint(0.1, 0.15),
      separator: tint(0.2, 0.05),
      time: tint(0.51, 0.05),
    },

    border: tint(0.25, 0.05),
    dot: acc(0.55),
    header: {
      focused: { bg: tint(0.2, 0.06), fg: tint(0.97, 0.05) },
      dim: { bg: tint(0.13, 0.06), fg: tint(0.51, 0.05) },
    },
    info: { label: tint(0.62, 0.05), value: tint(0.85, 0.05) },
    timestamp: tint(0.62, 0.1),
    status: { bg: tint(0.13, 0.06), fg: tint(0.74, 0.06), accent: acc(0.55) },
    help: { key: tint(0.74, 0.06), desc: tint(0.4, 0.05) },
    sms: SEMANTIC.sms, // green — universal "SMS not iMessage" cue
    edited: SEMANTIC.edited, // gold — universal "this was edited" cue
    compose: {
      bg: tint(0.18, 0.06),
      fg: tint(0.97, 0.05),
      placeholder: tint(0.4, 0.05),
    },
    dateSep: tint(0.32, 0.05),
    drawer: {
      bg: tint(0.13, 0.06),
      border: tint(0.25, 0.05),
      label: tint(0.62, 0.05),
      value: tint(0.85, 0.05),
    },

    rustEngine: SEMANTIC.rustEngine, // warm orange — distinct from any accent
    cpuHigh: SEMANTIC.cpuHigh, // red — universal "elevated"
  };
}

/** Hand-tuned constants kept outside the accent-derivation loop. */
const SEMANTIC = {
  senderName: "#5AC8C8", // teal
  attachment: "#FFB347", // orange (paperclip)
  selection: "#3C3814", // dim olive (visual select bg)
  sms: "#5AC85A", // green (SMS marker)
  edited: "#96821E", // gold (edited indicator)
  rustEngine: "#FF6B35", // warm orange (DevStats engine label)
  cpuHigh: "#FF4444", // red (DevStats elevated CPU)
} as const;

// Surface tiny helpers for tests / setup probes.
export { withL, withS };
