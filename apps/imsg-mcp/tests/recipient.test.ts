/**
 * Recipient normalization — locks in the parsing rules for the new
 * compose-to-new-thread flow. Covers all 4 input shapes the user can
 * type into the recipient picker + the CLI + the MCP tool.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Contact } from "../src/contacts-db.js";
import {
  defaultCountryFromEnv,
  isLikelyEmail,
  normalizePhoneToE164,
  resolveRecipient,
} from "../src/recipient.js";

describe("normalizePhoneToE164", () => {
  describe("AU default (project's primary user)", () => {
    it("keeps E.164 as-is", () => {
      expect(normalizePhoneToE164("+61401990797")).toBe("+61401990797");
      expect(normalizePhoneToE164("+1 555 010 0100")).toBe("+15550100100");
    });

    it("normalizes local AU mobiles (04xxx)", () => {
      expect(normalizePhoneToE164("0401990797")).toBe("+61401990797");
      expect(normalizePhoneToE164("0401 990 797")).toBe("+61401990797");
      expect(normalizePhoneToE164("(0401) 990-797")).toBe("+61401990797");
    });

    it("normalizes AU mobile without leading 0", () => {
      expect(normalizePhoneToE164("401990797")).toBe("+61401990797");
    });

    it("normalizes 11-digit AU starting with 61", () => {
      expect(normalizePhoneToE164("61401990797")).toBe("+61401990797");
    });

    it("rejects non-phone-like input", () => {
      expect(normalizePhoneToE164("hello")).toBeNull();
      expect(normalizePhoneToE164("brian osborne")).toBeNull();
      expect(normalizePhoneToE164("")).toBeNull();
      expect(normalizePhoneToE164("   ")).toBeNull();
    });

    it("rejects too-short or too-long digit strings", () => {
      expect(normalizePhoneToE164("123")).toBeNull();
      expect(normalizePhoneToE164("+1234567890123456")).toBeNull(); // 16 digits
    });
  });

  describe("US default", () => {
    it("normalizes 10-digit US numbers", () => {
      expect(normalizePhoneToE164("5550100100", "US")).toBe("+15550100100");
      expect(normalizePhoneToE164("555-010-0100", "US")).toBe("+15550100100");
      expect(normalizePhoneToE164("(555) 010-0100", "US")).toBe("+15550100100");
    });

    it("normalizes 11-digit US starting with 1", () => {
      expect(normalizePhoneToE164("15550100100", "US")).toBe("+15550100100");
    });
  });

  describe("vanity letters (phone keypad)", () => {
    it("converts the classic 1-800-FLOWERS form", () => {
      // 1-800-FLOWERS → 1-800-3569377 → 11-digit US → +18003569377
      expect(normalizePhoneToE164("1-800-FLOWERS", "US")).toBe("+18003569377");
    });

    it("accepts mixed-case + extra hyphens (1-800-Free-411)", () => {
      // F=3, R=7, E=3, E=3 → 3733, then 411 = 3733411
      // "1-800-FREE-411" → "1-800-3733-411" → digits "18003733411"
      expect(normalizePhoneToE164("1-800-FREE-411", "US")).toBe("+18003733411");
    });

    it("handles spaces between vanity groups (1 800 GO GEICO)", () => {
      // G=4, O=6, G=4, E=3, I=4, C=2, O=6 → 46 43426 → "1 800 46 43426"
      expect(normalizePhoneToE164("1 800 GO GEICO", "US")).toBe("+18004643426");
    });

    it("converts but still returns null when result isn't a valid phone length", () => {
      // "ABC" → "222" → too short
      expect(normalizePhoneToE164("ABC", "US")).toBeNull();
    });

    it("doesn't convert pure-letter input (treated as not phone-like)", () => {
      // "alice" has no digits, isn't phone-like → null (caller falls to contact search)
      expect(normalizePhoneToE164("alice", "US")).toBeNull();
    });
  });
});

describe("isLikelyEmail", () => {
  it("accepts common email shapes", () => {
    expect(isLikelyEmail("alice@icloud.com")).toBe(true);
    expect(isLikelyEmail("brian.osborne+work@example.co.uk")).toBe(true);
  });

  it("rejects non-emails", () => {
    expect(isLikelyEmail("alice")).toBe(false);
    expect(isLikelyEmail("alice@")).toBe(false);
    expect(isLikelyEmail("@icloud.com")).toBe(false);
    expect(isLikelyEmail("+61401990797")).toBe(false);
  });
});

const contact = (overrides: Partial<Contact>): Contact => ({
  id: 1,
  firstName: null,
  lastName: null,
  middleName: null,
  nickname: null,
  organization: null,
  displayName: "Unknown",
  phoneNumbers: [],
  emails: [],
  ...overrides,
});

function makeContactsSource(contacts: Contact[]) {
  return {
    searchContacts(query: string): Contact[] {
      const q = query.toLowerCase();
      return contacts.filter((c) => c.displayName.toLowerCase().includes(q));
    },
  };
}

describe("resolveRecipient", () => {
  const contacts = makeContactsSource([
    contact({
      id: 1,
      displayName: "Brian Osborne",
      phoneNumbers: ["+61411113227"],
      emails: ["brian@example.com"],
    }),
    contact({
      id: 2,
      displayName: "Alice (work)",
      phoneNumbers: [],
      emails: ["alice@icloud.com"],
    }),
    contact({
      id: 3,
      displayName: "Aisha / Vegas Kittens",
      phoneNumbers: ["+61421106651"],
      emails: [],
    }),
  ]);

  it("resolves an E.164 phone immediately (no contact lookup needed)", () => {
    const r = resolveRecipient("+61401990797", { contacts });
    expect(r.kind).toBe("phone");
    if (r.kind === "phone") expect(r.handle).toBe("+61401990797");
  });

  it("resolves a local AU phone to E.164", () => {
    const r = resolveRecipient("0401 990 797", { contacts });
    expect(r.kind).toBe("phone");
    if (r.kind === "phone") expect(r.handle).toBe("+61401990797");
  });

  it("resolves an iMessage email", () => {
    const r = resolveRecipient("Alice@iCloud.COM", { contacts });
    expect(r.kind).toBe("email");
    if (r.kind === "email") expect(r.handle).toBe("alice@icloud.com");
  });

  it("resolves a unique contact name straight to their first phone (not ambiguous)", () => {
    const r = resolveRecipient("brian", { contacts });
    // Brian has 1 phone + 1 email — but they're the SAME person, so this is
    // not ambiguous: prefer the dial-ready phone. (Pre-fix, "send to brian"
    // listed his own two handles as competing matches.)
    expect(r.kind).toBe("contact");
    if (r.kind === "contact") expect(r.handle).toBe("+61411113227");
  });

  it("returns a single recipient when the contact has only one handle", () => {
    const r = resolveRecipient("aisha", { contacts });
    expect(r.kind).toBe("contact");
    if (r.kind === "contact") expect(r.handle).toBe("+61421106651");
  });

  it("returns ambiguous when multiple contacts match by name", () => {
    const r = resolveRecipient("a", { contacts });
    // Alice (email) + Aisha (phone) + Brian (has "a" in Brian? no) → 2 candidates
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      // Brian Osborne also has 'a' but displayName.toLowerCase() = "brian osborne"
      // — no 'a' in there. Wait, "brian" has 'a'. Let's check:
      // "brian osborne" → has 'a' at index 2. So Brian is included.
      expect(r.candidates.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("returns error for empty input", () => {
    expect(resolveRecipient("", { contacts }).kind).toBe("error");
    expect(resolveRecipient("   ", { contacts }).kind).toBe("error");
  });

  it("returns error for unmatchable input", () => {
    const r = resolveRecipient("ZZ-NoMatch-Whatever-2026", { contacts });
    expect(r.kind).toBe("error");
  });

  it("uses defaultCountry when normalizing", () => {
    const r = resolveRecipient("555-010-0100", { contacts, defaultCountry: "US" });
    expect(r.kind).toBe("phone");
    if (r.kind === "phone") expect(r.handle).toBe("+15550100100");
  });
});

describe("defaultCountryFromEnv", () => {
  const original = process.env.IMSG_DEFAULT_COUNTRY;
  afterEach(() => {
    if (original === undefined) delete process.env.IMSG_DEFAULT_COUNTRY;
    else process.env.IMSG_DEFAULT_COUNTRY = original;
  });

  it("defaults to AU when env is unset", () => {
    delete process.env.IMSG_DEFAULT_COUNTRY;
    expect(defaultCountryFromEnv()).toBe("AU");
  });

  it("returns US when IMSG_DEFAULT_COUNTRY=US", () => {
    process.env.IMSG_DEFAULT_COUNTRY = "US";
    expect(defaultCountryFromEnv()).toBe("US");
  });

  it("is case-insensitive and trims", () => {
    process.env.IMSG_DEFAULT_COUNTRY = "  us  ";
    expect(defaultCountryFromEnv()).toBe("US");
  });

  it("falls back to AU for unknown values", () => {
    process.env.IMSG_DEFAULT_COUNTRY = "GB"; // not yet supported
    expect(defaultCountryFromEnv()).toBe("AU");
  });
});
