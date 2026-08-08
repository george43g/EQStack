/**
 * Redaction rules — the invariant enforced here is that full phone numbers
 * and secret-shaped strings never leave the config boundary: events, logs,
 * MCP responses, and search indexes only ever see an alias + last-four.
 */

/** E.164-ish: "+" followed by 7–15 digits, optionally spaced/hyphenated. */
const PHONE_RE = /\+\d[\d\s\-().]{5,17}\d/g;

/** Bearer/API-key shapes we know circulate in this stack. */
const SECRET_RE =
  /\b(sk-[A-Za-z0-9-]{10,}|github_pat_[A-Za-z0-9_]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|SK[a-f0-9]{32}|AC[a-f0-9]{32})\b/g;

export function lastFour(number: string): string {
  const digits = number.replace(/\D/g, "");
  return digits.slice(-4);
}

/** Redact a string: phone numbers become "…NNNN", secret shapes become "[redacted]". */
export function redactString(input: string): string {
  return input.replace(PHONE_RE, (m) => `…${lastFour(m)}`).replace(SECRET_RE, "[redacted]");
}

/** Deep-redact any JSON-ish value. Non-serializable values pass through untouched. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}
