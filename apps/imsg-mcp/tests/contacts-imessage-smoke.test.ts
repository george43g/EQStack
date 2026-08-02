import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getContactsDbPaths, getImsgDbPath } from "../src/config.js";
import { ContactsDB } from "../src/contacts-db.js";
import { IMessageDB } from "../src/imessage-db.js";
import { isGitLfsPointer } from "./helpers.js";

describe("Contacts + iMessage integration (smoke)", () => {
  it("loads contacts stats when Address Book DB is present and not an LFS pointer", () => {
    const paths = getContactsDbPaths();
    const first = paths?.[0];
    if (!first || isGitLfsPointer(first)) {
      return;
    }

    const contacts = new ContactsDB(paths);
    contacts.initialize();
    try {
      const stats = contacts.getStats();
      expect(stats.totalContacts).toBeGreaterThanOrEqual(0);
      expect(stats.phoneNumbers).toBeGreaterThanOrEqual(0);
      expect(stats.emails).toBeGreaterThanOrEqual(0);
    } finally {
      contacts.close();
    }
  });

  it("lists conversations when chat.db is present and not an LFS pointer", async () => {
    const chatPath = getImsgDbPath();
    if (isGitLfsPointer(chatPath)) {
      return;
    }

    const paths = getContactsDbPaths();
    const tempDir = mkdtempSync(join(tmpdir(), "imsg-smoke-"));
    const slugsPath = join(tempDir, "slugs.db");
    const imsg = new IMessageDB(chatPath, paths ?? undefined, slugsPath);
    try {
      const convs = await imsg.listConversations(50);
      expect(Array.isArray(convs)).toBe(true);
      if (convs.length > 0) {
        const c = convs[0];
        expect(c).toHaveProperty("chatIdentifier");
        expect(c).toHaveProperty("threadSlug");
      }
    } finally {
      await imsg.close();
    }
  });
});
