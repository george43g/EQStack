/**
 * A normalized, cross-tool "identity" view of a person: their best display
 * name plus their reachable handles in canonical form — phones in E.164 where
 * derivable, emails lowercased, and a deduped union of both. Tools that resolve
 * a contact (`get_contact`, `resolve_handle`) attach this so an agent gets one
 * consistent shape to key off, instead of raw Address-Book-formatted strings.
 *
 * Pure module — no I/O. Phone normalization reuses `normalizePhoneToE164`
 * (recipient.ts); emails are trimmed + lowercased.
 */
import { normalizePhoneToE164 } from "./recipient.js";

export interface Identity {
  /** Best display name for this person (contact display name, or the handle). */
  canonicalName: string;
  /** Phone handles, E.164-normalized where derivable (else the trimmed input). */
  phones: string[];
  /** Email handles, trimmed + lowercased. */
  emails: string[];
  /** Every reachable handle, deduped — phones first, then emails. */
  handles: string[];
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** Trim + lowercase an email address (identity-key canonical form). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** E.164 the phone if we can, else fall back to the trimmed original. */
export function e164OrOriginal(phone: string, country: "AU" | "US"): string {
  return normalizePhoneToE164(phone, country) ?? phone.trim();
}

/** Build an identity from a contact's raw name + handle lists. */
export function buildIdentity(
  canonicalName: string,
  phoneNumbers: string[],
  emails: string[],
  country: "AU" | "US",
): Identity {
  const phones = dedupe(phoneNumbers.map((p) => e164OrOriginal(p, country)));
  const mails = dedupe(emails.map(normalizeEmail));
  return {
    canonicalName,
    phones,
    emails: mails,
    handles: dedupe([...phones, ...mails]),
  };
}

/**
 * Build an identity from a single handle (phone or email) when no contact is
 * known — e.g. resolve_handle on an unknown number still returns the handle in
 * canonical form. `name` defaults to the raw handle.
 */
export function buildIdentityFromHandle(
  handle: string,
  name: string | null,
  country: "AU" | "US",
): Identity {
  const isEmail = handle.includes("@");
  return buildIdentity(name ?? handle, isEmail ? [] : [handle], isEmail ? [handle] : [], country);
}
