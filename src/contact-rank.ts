/**
 * Relevance ranking for contact search. `search_contacts` used to return a
 * plain substring filter in address-book cache order, so an agent got e.g.
 * "Armen Grigorian" and "Andre Armenian" for the query "Armen" with no way to
 * tell which the query actually meant. This scores each match — exact > prefix
 * > substring > fuzzy — and reports WHICH field matched, so callers can rank
 * and disambiguate. Pure + dependency-light (only fuzzyScore); unit-testable.
 */

import type { Contact } from "./contacts-db.js";
import { fuzzyScore } from "./fuzzy.js";

export type ContactMatchField =
  | "displayName"
  | "firstName"
  | "lastName"
  | "nickname"
  | "organization"
  | "phone"
  | "email";

export interface ContactMatch {
  contact: Contact;
  /** Relevance in [0,1]; higher = better. */
  score: number;
  /** Which field produced the best score. */
  matchedField: ContactMatchField;
}

/** Score a text field: exact (1) > prefix (0.9) > substring (0.7) > fuzzy typo. */
function scoreTextField(query: string, value: string | null | undefined): number {
  if (!value) return 0;
  const v = value.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  if (v === q) return 1;
  if (v.startsWith(q)) return 0.9;
  if (v.includes(q)) return 0.7;
  return fuzzyScore(q, v); // typo tolerance for names
}

/** Score a phone by digit-only substring so formatting/country codes don't matter. */
function scorePhoneField(query: string, phone: string): number {
  const qd = query.replace(/\D/g, "");
  const pd = phone.replace(/\D/g, "");
  if (!qd || !pd) return 0;
  if (pd === qd) return 1;
  if (pd.includes(qd)) return 0.8;
  return 0;
}

const NAME_FIELDS: Array<[ContactMatchField, (c: Contact) => string | null | undefined]> = [
  ["displayName", (c) => c.displayName],
  ["firstName", (c) => c.firstName],
  ["lastName", (c) => c.lastName],
  ["nickname", (c) => c.nickname],
  ["organization", (c) => c.organization],
];

/**
 * Best (score, field) for one contact against the query, or null if below the
 * inclusion floor. The floor is 0.6 so every prior substring match (0.7) is
 * preserved while mild typo matches (≥0.6) become newly reachable — recall is
 * never reduced, only ranked and slightly widened.
 */
export function scoreContactMatch(
  query: string,
  contact: Contact,
  floor = 0.6,
): ContactMatch | null {
  let best = 0;
  let field: ContactMatchField = "displayName";

  for (const [name, get] of NAME_FIELDS) {
    const s = scoreTextField(query, get(contact));
    if (s > best) {
      best = s;
      field = name;
    }
  }
  for (const phone of contact.phoneNumbers) {
    const s = scorePhoneField(query, phone);
    if (s > best) {
      best = s;
      field = "phone";
    }
  }
  for (const email of contact.emails) {
    const s = scoreTextField(query, email);
    if (s > best) {
      best = s;
      field = "email";
    }
  }

  if (best < floor) return null;
  return { contact, score: Math.round(best * 1000) / 1000, matchedField: field };
}

/**
 * Rank contacts by match quality (best first). Ties break alphabetically by
 * display name so ordering is deterministic across runs.
 */
export function rankContacts(query: string, contacts: Contact[], floor = 0.6): ContactMatch[] {
  const out: ContactMatch[] = [];
  for (const c of contacts) {
    const m = scoreContactMatch(query, c, floor);
    if (m) out.push(m);
  }
  out.sort(
    (a, b) => b.score - a.score || a.contact.displayName.localeCompare(b.contact.displayName),
  );
  return out;
}
