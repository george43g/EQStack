/**
 * GOLDEN (characterization) tests for imsg's phone-normalization forms.
 *
 * Written BEFORE the planned unification refactor, deliberately: these pin
 * CURRENT behaviour byte-for-byte so the refactor has to prove it preserved
 * it. A table row changing is not automatically a bug — it is a decision that
 * has to be made on purpose, with this file as the place it gets argued.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS: `ContactsDB.stableAnchor`
 * (contacts-db.ts:435) is `sort()[0]` over the contact's normalized phones and
 * emails, and it feeds `identityKey` (imessage-db.ts:296-299), which is hashed
 * into every persisted thread slug. A one-character drift in
 * `normalizePhoneNumber` silently ROTATES EVERY SLUG in ~/.imsg-mcp/slugs.db —
 * and any slug an agent is already holding stops resolving.
 *
 * There are THREE normalization forms in the app and they are NOT
 * interchangeable. Two are exercised here; the third
 * (`replace(/[\s\-()]/g,"")` inside imessage-db's matcher) is covered
 * behaviourally by resolve-chats-overmatch.test.ts.
 *
 *   MATCH form  — `normalizedPhoneVariants` (contacts-db): digits only, no
 *                 "+", one input → SEVERAL indexable variants. Used to index
 *                 the Address Book and to anchor identity.
 *   SEND form   — `normalizePhoneToE164` (recipient): exactly one "+E.164"
 *                 string or null, locale- and vanity-aware. Used to address a
 *                 real send.
 */
import { describe, expect, it } from "vitest";
import { normalizedPhoneVariants } from "../src/contacts-db.js";
import { normalizePhoneToE164 } from "../src/recipient.js";

/** input → [match-form variants, E.164 under AU, E.164 under US] */
const GOLDEN: Array<[string, string[], string | null, string | null]> = [
  // ── AU mobile, every shape it is stored/typed in ──
  ["+61401234567", ["61401234567", "401234567", "0401234567"], "+61401234567", "+61401234567"],
  [
    "0401234567",
    ["0401234567", "401234567", "61401234567", "10401234567"],
    "+61401234567",
    // QUIRK (pinned, not endorsed): under US locale an AU mobile is read as a
    // US 10-digit number and gets a "+1". Only reachable with the default
    // country misconfigured.
    "+10401234567",
  ],
  ["401234567", ["401234567", "61401234567", "0401234567"], "+61401234567", "+401234567"],
  ["61401234567", ["61401234567", "401234567", "0401234567"], "+61401234567", "+61401234567"],
  ["+61 4 0123 4567", ["61401234567", "401234567", "0401234567"], "+61401234567", "+61401234567"],
  [
    "04 0123 4567",
    ["0401234567", "401234567", "61401234567", "10401234567"],
    "+61401234567",
    "+10401234567",
  ],

  // ── US numbers ──
  ["+1 555 123 4567", ["5551234567", "15551234567"], "+15551234567", "+15551234567"],
  ["15551234567", ["5551234567", "15551234567"], "+15551234567", "+15551234567"],
  ["5551234567", ["5551234567", "15551234567"], "+5551234567", "+15551234567"],
  ["(555) 123-4567", ["5551234567", "15551234567"], "+5551234567", "+15551234567"],
  ["555-123-4567", ["5551234567", "15551234567"], "+5551234567", "+15551234567"],

  // ── International passthrough ──
  ["+44 20 7946 0958", ["442079460958"], "+442079460958", "+442079460958"],
  ["+123456789012345", ["123456789012345"], "+123456789012345", "+123456789012345"],

  // ── Shortcodes and junk ──
  // A shortcode indexes as itself but is NOT sendable-normalizable (too short
  // for E.164) — this asymmetry is load-bearing: it is what keeps a shortcode
  // out of the phone-suffix fuzzy match in imessage-db.
  ["234567", ["234567"], null, null],
  ["abc", [""], null, null],
  ["", [""], null, null],
];

describe("phone normalization — golden table (pins pre-refactor behaviour)", () => {
  it.each(GOLDEN)("%s", (input, variants, au, us) => {
    expect(normalizedPhoneVariants(input)).toEqual(variants);
    expect(normalizePhoneToE164(input, "AU")).toBe(au);
    expect(normalizePhoneToE164(input, "US")).toBe(us);
  });
});

describe("the two forms diverge on purpose — pin the divergence, don't 'fix' it blindly", () => {
  it("match form is digitwise and multi-valued; send form is a single +E.164", () => {
    // Same human number, two deliberately different answers.
    expect(normalizedPhoneVariants("+61401234567")).toEqual([
      "61401234567",
      "401234567",
      "0401234567",
    ]);
    expect(normalizePhoneToE164("+61401234567", "AU")).toBe("+61401234567");
  });

  it("VANITY NUMBERS: the send form translates letters, the match form does not", () => {
    // A real gap, pinned so the unification has to decide about it rather than
    // discover it: an Address Book card storing "1-800-FLOWERS" indexes under
    // "1800" and can never match the number an actual send resolves to.
    expect(normalizePhoneToE164("1-800-FLOWERS", "AU")).toBe("+18003569377");
    expect(normalizedPhoneVariants("1-800-FLOWERS")).toEqual(["1800"]);
  });
});

describe("identity-anchor stability (the slug-rotation guard)", () => {
  // stableAnchor = sort()[0] of the contact's normalized handles. Pinning the
  // primitive it is built from is what makes slug rotation detectable here
  // rather than in the wild.
  it("the first variant IS the canonical match form that anchors identity", () => {
    expect(normalizedPhoneVariants("+61401234567")[0]).toBe("61401234567");
    expect(normalizedPhoneVariants("0401234567")[0]).toBe("0401234567");
    expect(normalizedPhoneVariants("+1 555 123 4567")[0]).toBe("5551234567");
  });

  it("US 11-digit loses its leading 1; AU 61-prefix keeps everything", () => {
    expect(normalizedPhoneVariants("15551234567")[0]).toBe("5551234567");
    expect(normalizedPhoneVariants("61401234567")[0]).toBe("61401234567");
  });
});
