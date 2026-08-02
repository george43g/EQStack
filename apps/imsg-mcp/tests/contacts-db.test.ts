import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ContactsDB } from "../src/contacts-db.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function makeAddressBookFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "imsg-contacts-"));
  tempDirs.push(dir);

  const dbPath = join(dir, "AddressBook-v22.abcddb");
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE ZABCDRECORD (
      Z_PK INTEGER PRIMARY KEY,
      ZFIRSTNAME TEXT,
      ZLASTNAME TEXT,
      ZMIDDLENAME TEXT,
      ZNICKNAME TEXT,
      ZORGANIZATION TEXT
    );

    CREATE TABLE ZABCDPHONENUMBER (
      Z_PK INTEGER PRIMARY KEY,
      ZFULLNUMBER TEXT,
      ZLABEL TEXT,
      ZOWNER INTEGER,
      Z22_OWNER INTEGER
    );

    CREATE TABLE ZABCDEMAILADDRESS (
      Z_PK INTEGER PRIMARY KEY,
      ZADDRESS TEXT,
      ZLABEL TEXT,
      ZOWNER INTEGER,
      Z22_OWNER INTEGER
    );
  `);

  // Synthetic test data using fictional reserved numbers (+1-555-01xx).
  // Two contacts:
  //   1. Has a nickname (exercises nickname > firstname/lastname preference)
  //   2. Multi-part name in firstname (exercises composite name handling)
  db.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZMIDDLENAME, ZNICKNAME, ZORGANIZATION) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(1, "Alex", "Example", null, "AlexNick", null);
  db.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZMIDDLENAME, ZNICKNAME, ZORGANIZATION) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(2, "Sam / Jamie", null, null, null, null);

  // Numbers stored in local format (without country code) — exercises the
  // normalization path that turns "0412 345 678" into "+61412345678" or
  // similar canonical form for international matching.
  db.prepare(
    "INSERT INTO ZABCDPHONENUMBER (Z_PK, ZFULLNUMBER, ZLABEL, ZOWNER, Z22_OWNER) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "0412 345 678", "_$!<Mobile>!$_", 1, 22);
  db.prepare(
    "INSERT INTO ZABCDPHONENUMBER (Z_PK, ZFULLNUMBER, ZLABEL, ZOWNER, Z22_OWNER) VALUES (?, ?, ?, ?, ?)",
  ).run(2, "0498 765 432", "_$!<Mobile>!$_", 2, 22);

  db.close();
  return dbPath;
}

describe("ContactsDB", () => {
  it("matches local mobile numbers against international chat handles", () => {
    const contacts = new ContactsDB(makeAddressBookFixture());
    contacts.initialize();

    try {
      // Address Book stores "0412 345 678" (Australian local format), iMessage
      // stores "+61412345678" (international). The matcher must canonicalize
      // both to the same digits-only form.
      expect(contacts.lookupHandle("+61412345678")).toBe("AlexNick");
      expect(contacts.lookupHandle("+61498765432")).toBe("Sam / Jamie");
    } finally {
      contacts.close();
    }
  });

  it("prefers nickname over first and last name for display labels", () => {
    const contacts = new ContactsDB(makeAddressBookFixture());
    contacts.initialize();

    try {
      expect(contacts.lookupHandle("0412 345 678")).toBe("AlexNick");
    } finally {
      contacts.close();
    }
  });
});
