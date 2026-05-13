// Pure helpers for parsing Gmail message payloads.
// Surface-agnostic — used by message reads, threads, downloads.
//
// Lifted from src/index.ts as part of the modular refactor. No behavior change.

import type { EmailAttachment } from "../email-export.js";

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{
    name: string;
    value: string;
  }>;
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string;
  };
  parts?: GmailMessagePart[];
}

export interface EmailContent {
  text: string;
  html: string;
}

export interface ExtractedHeaders {
  subject: string;
  from: string;
  to: string;
  date: string;
  rfcMessageId: string;
}

/**
 * Recursively extract email body content from MIME message parts. Handles
 * complex email structures with nested multipart payloads.
 */
export function extractEmailContent(messagePart: GmailMessagePart): EmailContent {
  let textContent = "";
  let htmlContent = "";

  if (messagePart.body?.data) {
    const content = Buffer.from(messagePart.body.data, "base64").toString("utf8");
    if (messagePart.mimeType === "text/plain") {
      textContent = content;
    } else if (messagePart.mimeType === "text/html") {
      htmlContent = content;
    }
  }

  if (messagePart.parts && messagePart.parts.length > 0) {
    for (const part of messagePart.parts) {
      const { text, html } = extractEmailContent(part);
      if (text) textContent += text;
      if (html) htmlContent += html;
    }
  }

  return { text: textContent, html: htmlContent };
}

/**
 * Extract common headers from a Gmail message payload (subject / from / to /
 * date / message-id). Case-insensitive header lookup; returns empty strings
 * for missing values rather than undefined so callers can compose unchecked.
 */
export function extractHeaders(
  // Accept any payload that exposes a `headers` array of {name, value}
  // entries. Loosely typed because Gmail's generated types allow `null` on
  // both `name` and `value` (and some callers pass headers from MIME parsers
  // with different shapes); we coerce both to strings at lookup time.
  payload: { headers?: Array<{ name?: string | null; value?: string | null }> } | undefined | null,
): ExtractedHeaders {
  const headers = payload?.headers ?? [];
  const getHeader = (name: string): string => {
    const found = headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase());
    return found?.value ?? "";
  };
  return {
    subject: getHeader("subject"),
    from: getHeader("from"),
    to: getHeader("to"),
    date: getHeader("date"),
    rfcMessageId: getHeader("message-id"),
  };
}

/**
 * Walk a Gmail message payload tree and collect every attachment encountered
 * (anything with a `body.attachmentId`). Used by read_email, download_email,
 * download_attachment.
 */
export function extractAttachments(payload: GmailMessagePart): EmailAttachment[] {
  const attachments: EmailAttachment[] = [];

  function processAttachmentParts(part: GmailMessagePart) {
    if (part.body?.attachmentId) {
      attachments.push({
        id: part.body.attachmentId,
        filename: part.filename || `attachment-${part.body.attachmentId}`,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body.size || 0,
      });
    }
    if (part.parts) {
      part.parts.forEach((subpart: GmailMessagePart) => processAttachmentParts(subpart));
    }
  }

  processAttachmentParts(payload);
  return attachments;
}
