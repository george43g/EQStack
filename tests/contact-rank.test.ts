import { describe, expect, it } from "vitest";
import { rankContacts, scoreContactMatch } from "../src/contact-rank.js";
import type { Contact } from "../src/contacts-db.js";

function contact(over: Partial<Contact> & { id: number; displayName: string }): Contact {
  return {
    firstName: null,
    lastName: null,
    middleName: null,
    nickname: null,
    organization: null,
    phoneNumbers: [],
    emails: [],
    ...over,
  };
}

// The motivating case from the feedback: "Armen" should clearly rank the
// person whose FIRST NAME is Armen above someone who merely has "armen" inside
// their last name ("Andre Armenian").
const ARMEN = contact({
  id: 1,
  firstName: "Armen",
  lastName: "Grigorian",
  displayName: "Armen Grigorian",
});
const ANDRE = contact({
  id: 2,
  firstName: "Andre",
  lastName: "Armenian",
  displayName: "Andre Armenian",
});

describe("scoreContactMatch", () => {
  it("scores an exact first-name match higher than an incidental substring", () => {
    const a = scoreContactMatch("Armen", ARMEN);
    const b = scoreContactMatch("Armen", ANDRE);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.score ?? 0).toBeGreaterThan(b?.score ?? 1);
    expect(a?.matchedField).toBe("firstName");
  });

  it("reports the field that matched (phone, by digits)", () => {
    const c = contact({ id: 3, displayName: "Plumber", phoneNumbers: ["+61 400 111 222"] });
    const m = scoreContactMatch("400111", c);
    expect(m?.matchedField).toBe("phone");
    expect(m?.score ?? 0).toBeGreaterThanOrEqual(0.8);
  });

  it("matches an email substring", () => {
    const c = contact({ id: 4, displayName: "Dad", emails: ["agrigorian@equitystart.ai"] });
    const m = scoreContactMatch("equitystart", c);
    expect(m?.matchedField).toBe("email");
  });

  it("returns null below the inclusion floor", () => {
    expect(scoreContactMatch("zzzzz", ARMEN)).toBeNull();
  });

  it("keeps prior substring matches (substring scores above the floor)", () => {
    // "grig" is a prefix of the last name → included, matchedField lastName.
    const m = scoreContactMatch("grig", ARMEN);
    expect(m).not.toBeNull();
    expect(m?.matchedField).toBe("lastName");
    expect(m?.score ?? 0).toBeGreaterThanOrEqual(0.6);
  });
});

describe("rankContacts", () => {
  it("orders best matches first", () => {
    const ranked = rankContacts("Armen", [ANDRE, ARMEN]);
    expect(ranked.map((m) => m.contact.id)).toEqual([1, 2]); // exact-first-name before substring
  });

  it("excludes non-matches", () => {
    const other = contact({ id: 9, displayName: "Zoe" });
    const ranked = rankContacts("Armen", [ARMEN, other]);
    expect(ranked.map((m) => m.contact.id)).toEqual([1]);
  });
});
