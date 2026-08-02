import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getContactsDbPaths, getVcfPath } from "../src/config.js";
import { ContactsDB } from "../src/contacts-db.js";
import { compareVcfEntriesToContacts, parseVcfFile } from "../src/vcf-contact-compare.js";
import { isGitLfsPointer } from "./helpers.js";

const defaultVcf = getVcfPath();

/** Same threshold as agreed handoff bar; fixture currently ~98% (see script output). */
const MIN_MATCH_RATE = 0.8;

describe("VCF vs Address Book (fixture)", () => {
  it("parseVcfFile reads at least one card", () => {
    if (!existsSync(defaultVcf)) return; // fixture missing — skip gracefully
    const entries = parseVcfFile(defaultVcf);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("lookupHandle match rate meets minimum vs VCF FN strings", () => {
    const paths = getContactsDbPaths();
    const first = paths?.[0];
    // Skip gracefully if fixtures aren't generated yet, missing, or LFS stubs.
    if (!first || isGitLfsPointer(first) || !existsSync(defaultVcf)) {
      return;
    }

    const entries = parseVcfFile(defaultVcf);
    const contacts = new ContactsDB(paths);
    contacts.initialize();
    try {
      const { total, matchRate } = compareVcfEntriesToContacts(entries, (h) =>
        contacts.lookupHandle(h),
      );
      expect(total).toBeGreaterThan(0);
      expect(matchRate).toBeGreaterThanOrEqual(MIN_MATCH_RATE);
    } finally {
      contacts.close();
    }
  });
});
