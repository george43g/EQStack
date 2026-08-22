/**
 * Handle normalization — the THREE forms, in one place, with the reason each
 * one exists.
 *
 * They were previously scattered (and partly duplicated) across contacts-db,
 * imessage-db, recipient, humans-scaffold and humans-hints. They are NOT
 * interchangeable, and collapsing them into one "normalize a phone number"
 * helper would be a bug, not a cleanup — hence this module documents the
 * distinction instead of erasing it. Behaviour is pinned by
 * `tests/phone-normalization-golden.test.ts`; every function here was moved
 * verbatim, so those pins must not move either.
 *
 *   MATCH form  — `phoneDigits` / `phoneVariants` (this module). Digits only,
 *                 NO "+", one input → several indexable variants. Indexes the
 *                 Address Book and anchors identity.
 *   KEY form    — `identifierKey` (this module). Strips only the punctuation
 *                 that chat identifiers vary by, keeps "+" and "@". Compares
 *                 chat.chat_identifier values to each other.
 *   SEND form   — `normalizePhoneToE164` (recipient.ts). Exactly one "+E.164"
 *                 string or null; locale- and vanity-aware. Addresses a real
 *                 send, and lives with the rest of recipient resolution.
 *
 * ⚠️ SLUG STABILITY: `ContactsDB.stableAnchor` is sort()[0] over a contact's
 * `phoneDigits` + `normalizeEmail` outputs, and feeds `identityKey` in
 * imessage-db, which is hashed into every persisted thread slug. Changing
 * `phoneDigits` or `normalizeEmail` rotates EVERY slug in slugs.db and breaks
 * slugs agents are already holding. Treat both as frozen unless a migration
 * is part of the change.
 */

/**
 * MATCH form, canonical: digits only.
 * - US: strip a leading 1 so 11 digits become 10.
 * - AU/international: keep the full digit string (e.g. 61… for Australia).
 */
export function phoneDigits(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  // US: 11 digits starting with 1 -> drop 1
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits;
}

/**
 * MATCH form, expanded: every normalized shape a number should be findable
 * under, so lookups by +61…, 04…, 4… all hit the same card.
 *
 * Address Book cards store local formats ("0408 315 498") while chat
 * identifiers are E.164 ("+61408315498"), so both indexing and handle→chat
 * matching need the whole variant set. The FIRST element is always
 * `phoneDigits(phone)` — the canonical form identity is anchored on.
 */
export function phoneVariants(phone: string): string[] {
  const normalized = phoneDigits(phone);
  const variants = new Set<string>([normalized]);

  // Australia: 61 + 9 digits -> also store bare mobile digits and local 04... format
  if (normalized.length === 11 && normalized.startsWith("61")) {
    const localMobile = normalized.slice(2);
    variants.add(localMobile);
    if (localMobile.length === 9 && localMobile.startsWith("4")) {
      variants.add(`0${localMobile}`);
    }
  }

  // Australia: local 04... mobile -> also store bare mobile digits and 61-prefixed format
  if (normalized.length === 10 && normalized.startsWith("04")) {
    const mobileDigits = normalized.slice(1);
    variants.add(mobileDigits);
    variants.add(`61${mobileDigits}`);
  }

  // US: also store with leading 1
  if (normalized.length === 10) {
    variants.add(`1${normalized}`);
  }
  // Australia: 9 digits starting with 4 (mobile) -> also store with 61 prefix
  if (normalized.length === 9 && normalized.startsWith("4")) {
    variants.add(`61${normalized}`);
    variants.add(`0${normalized}`);
  }

  return [...variants];
}

/** Normalize an email for comparison: lowercase + trim. */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * KEY form: compare two chat identifiers ignoring the punctuation they vary
 * by. Deliberately NOT `phoneDigits` — it must survive emails (keeps "@") and
 * E.164 (keeps "+"), because chat identifiers are phones OR emails OR opaque
 * group ids and the same key function has to handle all three.
 */
export function identifierKey(identifier: string): string {
  return identifier.replace(/[\s\-()]/g, "").toLowerCase();
}

/**
 * Index keys for matching a handle against humans/v1 relationship files.
 * Emails match exactly (lowercased); phones match on any variant, because the
 * file's frontmatter and the chat DB rarely agree on format.
 */
export function handleKeys(handle: string): string[] {
  const trimmed = handle.trim();
  if (trimmed.includes("@")) return [trimmed.toLowerCase()];
  return phoneVariants(trimmed);
}
