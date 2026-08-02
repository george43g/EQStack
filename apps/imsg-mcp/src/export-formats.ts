/**
 * Format converters for exporting messages from the TUI.
 *
 * All three formats accept the same Message[] + optional header info.
 * Keep these pure (no fs / no React) — the modal + MCP export tool both
 * call into them.
 */
import type { Message } from "./types.js";

export interface ExportHeader {
  thread: string;
  participants?: string[];
  serviceType?: string;
}

function fmtDate(d: Date): string {
  return d
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

function senderLabel(m: Message): string {
  if (m.isFromMe) return "Me";
  return m.displayName ?? m.handle;
}

/** Markdown — human-readable, suitable for sharing or further processing. */
export function toMarkdown(messages: Message[], header: ExportHeader): string {
  const lines: string[] = [];
  lines.push(`# ${header.thread}`);
  lines.push("");
  if (header.participants && header.participants.length > 0) {
    lines.push(`**Participants**: ${header.participants.join(", ")}`);
  }
  if (header.serviceType) {
    lines.push(`**Service**: ${header.serviceType}`);
  }
  lines.push(`**Exported**: ${fmtDate(new Date())} (${messages.length} messages)`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const m of messages) {
    if (m.isReply && m.replyTo?.replyToText) {
      lines.push(`> ${m.replyTo.replyToText.replace(/\n/g, "\n> ")}`);
    }
    const ts = `[${fmtDate(m.date)}]`;
    const sender = senderLabel(m);
    let text = m.text ?? (m.hasAttachments ? "*(attachment)*" : "*(no text)*");
    // Embed a resolved voice-note transcript / image-video caption: replace the
    // placeholder when the message has no text of its own, else append a tag.
    const interp = m.interpretedMedia;
    if (interp) {
      const label = interp.kind === "audio" ? "voice note" : interp.kind;
      text = m.text ? `${m.text} _[${label}: ${interp.text}]_` : `_[${label}: ${interp.text}]_`;
    }
    const flags: string[] = [];
    if (m.isEdited) flags.push("edited");
    if (m.hasAttachments) flags.push("📎");
    const flagStr = flags.length > 0 ? ` _(${flags.join(", ")})_` : "";
    lines.push(`**${ts}** ${sender}: ${text}${flagStr}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** CSV — for spreadsheet import. RFC 4180-ish quoting. */
export function toCSV(messages: Message[]): string {
  const escapeCsv = (v: string | null | undefined): string => {
    if (v == null) return "";
    if (/[",\n\r]/.test(v)) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };

  const lines: string[] = [];
  lines.push(
    "id,date,sender,handle,is_from_me,is_read,is_reply,reply_to_text,text,has_attachments",
  );

  for (const m of messages) {
    const row = [
      String(m.id),
      m.date.toISOString(),
      escapeCsv(senderLabel(m)),
      escapeCsv(m.handle),
      m.isFromMe ? "1" : "0",
      m.isRead ? "1" : "0",
      m.isReply ? "1" : "0",
      escapeCsv(m.replyTo?.replyToText ?? ""),
      // For a media-only message (voice note, image), surface the resolved
      // transcript/caption in the text column so spreadsheets aren't blank.
      escapeCsv(m.text ?? m.interpretedMedia?.text ?? ""),
      m.hasAttachments ? "1" : "0",
    ];
    lines.push(row.join(","));
  }

  return lines.join("\n");
}

/** JSON — full message objects, indented, dates as ISO strings. */
export function toJSON(messages: Message[], header?: ExportHeader): string {
  const data = {
    ...(header ?? {}),
    exportedAt: new Date().toISOString(),
    count: messages.length,
    messages: messages.map((m) => ({
      ...m,
      date: m.date.toISOString(),
      dateRead: m.dateRead?.toISOString() ?? null,
      dateDelivered: m.dateDelivered?.toISOString() ?? null,
    })),
  };
  return JSON.stringify(data, null, 2);
}

/** NDJSON — newline-delimited JSON, ideal for streaming exports. */
export function toNDJSONLine(m: Message): string {
  const entry: Record<string, unknown> = {
    ...m,
    date: m.date.toISOString(),
    dateRead: m.dateRead?.toISOString() ?? null,
    dateDelivered: m.dateDelivered?.toISOString() ?? null,
  };
  // Sort top-level keys so the same data always serializes to the same bytes.
  // Message objects come from different construction paths (TS parser, native
  // parser, cache hydration) whose property insertion order can differ, which
  // made re-exports of identical data diff at the byte level.
  return JSON.stringify(
    Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

/** Choose extension for a given format. */
export function extensionFor(format: "markdown" | "csv" | "json" | "ndjson"): string {
  switch (format) {
    case "markdown":
      return "md";
    case "csv":
      return "csv";
    case "json":
      return "json";
    case "ndjson":
      return "ndjson";
  }
}
