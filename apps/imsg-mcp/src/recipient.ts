/**
 * Recipient normalization — parse free-form user input into a handle the
 * send_message layer can act on. Handles four input shapes:
 *
 *   1. E.164 phone               +61401990797       → kept as-is
 *   2. Local phone               0401 990 797       → +61401990797 (AU default)
 *   3. iMessage email            alice@icloud.com   → kept as-is (lowercase)
 *   4. Contact name (typeahead)  "Brian Osborne"    → resolved via ContactsDB
 *
 * Used by:
 *   - TUI ComposeRecipientModal (recipient picker stage)
 *   - CLI `imsg send <recipient>` (one-off)
 *   - MCP `send_message` (agents)
 *
 * Contact-name path returns a `disambiguate` result when multiple contacts
 * match — caller surfaces the contact:N picker (existing P2.7 work).
 */

import type { Contact } from "./contacts-db.js";

/** A normalised, send-ready handle. */
export interface ResolvedRecipient {
  kind: "phone" | "email" | "contact";
  /** Handle string send_message accepts (E.164 phone OR email OR chatIdentifier). */
  handle: string;
  /** Display label for confirmation UX. */
  displayName: string;
}

export interface AmbiguousRecipient {
  kind: "ambiguous";
  query: string;
  candidates: ResolvedRecipient[];
}

export interface RecipientError {
  kind: "error";
  message: string;
}

export type RecipientResolution = ResolvedRecipient | AmbiguousRecipient | RecipientError;

/**
 * Source of contact lookups. Kept narrow so the function is unit-testable
 * without spinning up the full ContactsDB.
 */
export interface ContactsSource {
  searchContacts(query: string): Contact[];
}

/**
 * Read the default country from env (`IMSG_DEFAULT_COUNTRY=AU|US`), falling
 * back to `"AU"` (project's primary user is in AU). Used by TUI/CLI/MCP
 * call sites so a single env var changes the default everywhere.
 */
export function defaultCountryFromEnv(): "AU" | "US" {
  const raw = (process.env.IMSG_DEFAULT_COUNTRY ?? "").toUpperCase().trim();
  if (raw === "US") return "US";
  return "AU";
}

/** What we treat as "phone-like" before attempting normalization. */
const PHONE_LIKE_RE = /^[\d\s()+\-.]+$/;

/** What we treat as "vanity-phone-like" — phone-like + letters (e.g. 1-800-FLOWERS). */
const VANITY_PHONE_LIKE_RE = /^[\dA-Za-z\s()+\-.]+$/;

/**
 * Phone-keypad letter → digit mapping. ABC=2, DEF=3, …, WXYZ=9.
 * Lowercased input maps the same way.
 */
const KEYPAD_MAP: Record<string, string> = {
  a: "2",
  b: "2",
  c: "2",
  d: "3",
  e: "3",
  f: "3",
  g: "4",
  h: "4",
  i: "4",
  j: "5",
  k: "5",
  l: "5",
  m: "6",
  n: "6",
  o: "6",
  p: "7",
  q: "7",
  r: "7",
  s: "7",
  t: "8",
  u: "8",
  v: "8",
  w: "9",
  x: "9",
  y: "9",
  z: "9",
};

/**
 * Translate vanity-phone letters to keypad digits in-place. Non-letter chars
 * pass through untouched.
 *
 *   "1-800-FLOWERS" → "1-800-3569377"
 *   "1 800 GO GEICO" → "1 800 46 43426"
 */
function translateVanityLetters(s: string): string {
  let out = "";
  for (const ch of s) {
    const lower = ch.toLowerCase();
    out += KEYPAD_MAP[lower] ?? ch;
  }
  return out;
}

/**
 * Detect a vanity-phone input: phone-like chars + at least one letter +
 * at least one digit. "Alice" alone has no digits → not a vanity phone.
 * "1-800-FLOWERS" has digits + letters → is.
 */
function isVanityPhone(input: string): boolean {
  if (!VANITY_PHONE_LIKE_RE.test(input)) return false;
  const hasLetter = /[A-Za-z]/.test(input);
  const hasDigit = /\d/.test(input);
  return hasLetter && hasDigit;
}

/**
 * Pure helper: turn any user-typed phone number into E.164 format if
 * possible, else return null. Locale: AU default for bare local numbers
 * (the project's primary user is in AU; this is configurable via the
 * `defaultCountry` arg).
 *
 * Examples (defaultCountry="AU"):
 *   "+61401990797"     → "+61401990797"
 *   "+1 555 010 0100"  → "+15550100100"
 *   "0401 990 797"     → "+61401990797"
 *   "(02) 9876 5432"   → "+61298765432"
 *   "555-010-0100"     → "+15550100100"  (when defaultCountry="US")
 *   "abc"              → null
 */
export function normalizePhoneToE164(
  input: string,
  defaultCountry: "AU" | "US" = "AU",
): string | null {
  let trimmed = input.trim();
  if (!trimmed) return null;
  // Vanity-phone pre-pass: "1-800-FLOWERS" → "1-800-3569377"
  if (isVanityPhone(trimmed)) {
    trimmed = translateVanityLetters(trimmed);
  }
  if (!PHONE_LIKE_RE.test(trimmed)) return null;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;

  // Already E.164-shaped (starts with `+`)? Strip non-digits and re-prepend.
  if (trimmed.startsWith("+")) {
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }

  // No `+` — interpret based on locale + length.
  if (defaultCountry === "AU") {
    // Australian mobiles: 04... (10 digits total)
    if (digits.length === 10 && digits.startsWith("0")) {
      return `+61${digits.slice(1)}`;
    }
    // Australian without leading 0: 4... (9 digits) — accept e.g. "401990797"
    if (digits.length === 9 && digits.startsWith("4")) {
      return `+61${digits}`;
    }
    // 11-digit Aussie starting 61: "61401990797"
    if (digits.length === 11 && digits.startsWith("61")) {
      return `+${digits}`;
    }
  }

  if (defaultCountry === "US") {
    // US 10-digit
    if (digits.length === 10) return `+1${digits}`;
    // US 11-digit starting 1
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  }

  // International-ish but ambiguous: anywhere from 8-15 digits, assume
  // it's already country-coded.
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;

  return null;
}

/** Simple email validator — RFC-light, no IDN. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isLikelyEmail(input: string): boolean {
  return EMAIL_RE.test(input.trim());
}

/**
 * Resolve a free-form input string into a send-ready recipient (or an
 * ambiguous-contact set / error).
 */
export function resolveRecipient(
  input: string,
  ctx: { contacts: ContactsSource; defaultCountry?: "AU" | "US" },
): RecipientResolution {
  const trimmed = input.trim();
  if (!trimmed) {
    return { kind: "error", message: "Recipient is required." };
  }

  // 1. Email
  if (isLikelyEmail(trimmed)) {
    const handle = trimmed.toLowerCase();
    return { kind: "email", handle, displayName: handle };
  }

  // 2. Phone (E.164, local, or vanity)
  if (PHONE_LIKE_RE.test(trimmed) || isVanityPhone(trimmed)) {
    const e164 = normalizePhoneToE164(trimmed, ctx.defaultCountry ?? "AU");
    if (e164) {
      return { kind: "phone", handle: e164, displayName: e164 };
    }
    // Phone-shaped but couldn't normalise — fall through to contact search,
    // but don't return phone-error yet (might still be a contact name with
    // digits in it, e.g. "John 2nd").
  }

  // 3. Contact name typeahead
  const matches = ctx.contacts.searchContacts(trimmed);
  const candidates: ResolvedRecipient[] = [];
  for (const c of matches) {
    // Each contact may have multiple phones and emails. Normalize each
    // phone through the E.164 helper so the resulting handle is dial-ready.
    for (const phone of c.phoneNumbers) {
      const e164 = normalizePhoneToE164(phone, ctx.defaultCountry ?? "AU");
      const handle = e164 ?? phone;
      candidates.push({
        kind: "contact",
        handle,
        displayName: `${c.displayName} (${handle})`,
      });
    }
    for (const email of c.emails) {
      candidates.push({
        kind: "email",
        handle: email.toLowerCase(),
        displayName: `${c.displayName} (${email})`,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      kind: "error",
      message: `No phone, email, or contact match for "${trimmed}".`,
    };
  }
  if (candidates.length === 1) return candidates[0]!;
  // All handles belonging to ONE contact card are not ambiguous — that's just
  // one person with several ways to reach them. Prefer their first phone
  // (dial-ready) over emails. Pre-fix, "send to dad" listed Dad's own three
  // handles as competing "matches".
  if (matches.length === 1) return candidates[0]!;
  return { kind: "ambiguous", query: trimmed, candidates };
}
