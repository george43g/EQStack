import { OBJECT_REPLACEMENT_CHAR } from "./db-schema.js";

export function normalizeSnippetText(text: string | null | undefined): string | null {
  if (!text) return null;

  const attachmentMarker = new RegExp(
    `${OBJECT_REPLACEMENT_CHAR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}+`,
    "g",
  );

  const normalized = text
    .replace(/^[#$]/, "")
    .replace(attachmentMarker, "📎 ")
    .replace(/\uFFFD/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized === "📎" || /^(📎\s*)+$/.test(normalized)) {
    return normalized ? "(image/attachment)" : null;
  }

  return normalized;
}

export function isMetadataOnlySnippet(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.trim();
  return (
    /^[$#]?https?:\/\//i.test(normalized) ||
    /HttpURL\/?$/i.test(normalized) ||
    /^[$#]https?:\/\/.*HttpURL\/?$/i.test(normalized)
  );
}

export function normalizeRichMetadataText(text: string | null | undefined): string | null {
  const normalized = normalizeSnippetText(text);
  if (!normalized) return null;

  if (/^https?:\/\/.*HttpURL\/?$/i.test(normalized)) {
    return normalized.replace(/HttpURL\/?$/i, "");
  }

  return normalized;
}

export function pickConversationSnippet(options: {
  rawText?: string | null;
  parsedText?: string | null;
  summaryText?: string | null;
}): string | null {
  return (
    normalizeSnippetText(options.rawText) ??
    normalizeSnippetText(options.parsedText) ??
    normalizeSnippetText(options.summaryText)
  );
}
