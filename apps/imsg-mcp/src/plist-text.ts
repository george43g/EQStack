import { parseBuffer } from "bplist-parser";

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized && normalized.length >= 4 ? normalized : undefined;
}

/**
 * Heuristic output must look like human text: mostly word characters and at
 * least one two-letter run. Binary-plist structural bytes routinely form
 * short printable runs ("(I_d~", "DWm") that leaked into sidebar snippets.
 * Exported so every plist-derived snippet path can share the same gate.
 */
export function isPlausibleHumanText(s: string): boolean {
  const wordish = (s.match(/[\p{L}\p{N}\s]/gu) ?? []).length;
  if (wordish / s.length < 0.7 || !/\p{L}{2}/u.test(s)) return false;
  // Single-token candidates (no whitespace) are the leak-prone case: a decoded
  // bplist fragment like "#DWm" or "-0Qdz" survives the ratio check but isn't a
  // word. A genuine one-word snippet is clean-cased — Title/lower/UPPER/digits,
  // nothing weird mid-word — so require that shape once punctuation is stripped.
  if (!/\s/.test(s.trim())) {
    const core = s.replace(/^[^\p{L}\p{N}]+/u, "");
    if (!/^(\p{Lu}?\p{Ll}+|\p{Lu}+|\p{N}+)$/u.test(core)) return false;
  }
  return true;
}

/**
 * Detect a message the sender unsent ("You unsent a message").
 *
 * On current macOS the retract is NOT recorded in `date_retracted` (it stays 0
 * across the whole DB) — the marker lives in `message_summary_info`, and
 * `date_edited` is repurposed as a last-modified stamp, so an unsent message
 * even reads as `date_edited > 0`. Neither column can be trusted on its own.
 *
 * The reliable signal is content-absence: a normal message (item_type 0, not a
 * reaction, no attachments) that still carries a `message_summary_info` blob but
 * has lost all of its text and every byte of its attributedBody. An *edited*
 * message, by contrast, always retains its current text in attributedBody
 * (verified on real data: 407/407 edited-with-content rows keep body bytes),
 * so requiring an empty body is what separates "unsent" from "edited".
 */
export function isUnsentMessage(opts: {
  text: string | null | undefined;
  attributedBodyLength: number;
  hasSummaryInfo: boolean;
  itemType: number;
  associatedMessageType: number;
  hasAttachments: boolean;
}): boolean {
  return (
    opts.itemType === 0 &&
    opts.associatedMessageType === 0 &&
    opts.hasSummaryInfo &&
    !opts.hasAttachments &&
    opts.attributedBodyLength === 0 &&
    (opts.text == null || opts.text.trim() === "")
  );
}

export function extractNullPaddedAsciiText(blob: Buffer | null): string | undefined {
  if (!blob) return undefined;

  let best = "";
  let current = "";

  const flush = () => {
    if (current.length > best.length) {
      best = current;
    }
    current = "";
  };

  for (let index = 0; index < blob.length - 1; index += 1) {
    const first = blob[index];
    const second = blob[index + 1];

    if (first === 0 && second >= 32 && second <= 126) {
      current += String.fromCharCode(second);
      index += 1;
      continue;
    }

    flush();
  }

  flush();

  const normalized = normalizeText(best);
  return normalized && isPlausibleHumanText(normalized) ? normalized : undefined;
}

export function extractArchivedAttributedStringText(blob: Buffer | null): string | undefined {
  if (!blob) return undefined;

  try {
    const [plist] = parseBuffer(blob) as Array<{ $objects?: unknown[] }>;
    const objects = plist?.$objects;
    if (!Array.isArray(objects)) {
      return extractNullPaddedAsciiText(blob);
    }

    const attributedString = objects.find(
      (value): value is { NSString?: { UID?: number } } =>
        typeof value === "object" && value !== null && "NSString" in value,
    );
    const stringUid = attributedString?.NSString?.UID;
    if (typeof stringUid === "number" && typeof objects[stringUid] === "string") {
      return normalizeText(objects[stringUid] as string);
    }

    const firstString = objects.find(
      (value): value is string =>
        typeof value === "string" && !value.startsWith("$") && !value.startsWith("NS"),
    );
    return normalizeText(firstString) ?? extractNullPaddedAsciiText(blob);
  } catch {
    return extractNullPaddedAsciiText(blob);
  }
}

export function extractChatSummaryText(blob: Buffer | null): string | undefined {
  if (!blob) return undefined;

  try {
    const [plist] = parseBuffer(blob) as Array<{
      chatSummaryDictionary?: { chatSummary?: Buffer | null };
    }>;
    const chatSummary = plist?.chatSummaryDictionary?.chatSummary;
    if (chatSummary) {
      return extractArchivedAttributedStringText(chatSummary);
    }
  } catch {
    // No structured chatSummary — fall through to undefined.
  }

  // Intentionally NO raw-byte fallback here. A chat's `properties` bplist is
  // dense with base64/UUID/token bytes; scanning it for null-padded ASCII
  // reliably leaked short fragments ("#DWm" → "DWm") into sidebar snippets
  // whenever the real chatSummary was absent (the common case). The structured
  // field above is the only trustworthy source; when it's missing, callers
  // fall back to the previous real message instead.
  return undefined;
}
