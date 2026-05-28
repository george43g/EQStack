// Parse a compose file in the .eml-ish format the editor template uses:
//
//   To: a@b.com, c@d.com
//   Cc: e@f.com
//   Bcc:
//   Subject: hello
//
//   body
//   …
//
// First blank line separates headers from body. Header names are
// case-insensitive. Multiple addresses are comma-separated. Whitespace
// around commas is trimmed.

export interface ParsedCompose {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export function parseCompose(raw: string): ParsedCompose {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const headers: Record<string, string> = {};
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++; // consume the separator
      break;
    }
    const match = line.match(/^([A-Za-z\-_]+)\s*:\s*(.*)$/);
    if (!match) {
      // Unknown line in the header block — treat as start of body (fault-tolerant).
      break;
    }
    const key = match[1]?.toLowerCase() ?? "";
    const value = match[2]?.trim() ?? "";
    if (key) headers[key] = value;
  }
  const body = lines.slice(i).join("\n");
  return {
    to: splitAddrs(headers.to ?? ""),
    cc: splitAddrs(headers.cc ?? ""),
    bcc: splitAddrs(headers.bcc ?? ""),
    subject: headers.subject ?? "",
    body,
  };
}

function splitAddrs(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Build a compose template the editor will open with. */
export function buildComposeTemplate(opts: {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
}): string {
  const to = (opts.to ?? []).join(", ");
  const cc = (opts.cc ?? []).join(", ");
  const bcc = (opts.bcc ?? []).join(", ");
  const subject = opts.subject ?? "";
  const body = opts.body ?? "";
  return `To: ${to}\nCc: ${cc}\nBcc: ${bcc}\nSubject: ${subject}\n\n${body}`;
}

/** Quote a message body for reply context (gmail-style "On X, Y wrote:" header + > prefix). */
export function quoteReplyBody(from: string, date: string, body: string): string {
  const header = `On ${date}, ${from} wrote:`;
  const quoted = body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\n${header}\n${quoted}\n`;
}
