import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getContactsDbPaths } from "../src/config.js";

const ORIGINAL_CONTACTS_DB_PATH = process.env.VITE_CONTACTS_DB_PATH;
const ORIGINAL_ADDRESS_BOOK_UUID = process.env.VITE_ADDRESS_BOOK_UUID;

afterEach(() => {
  if (ORIGINAL_CONTACTS_DB_PATH === undefined) {
    delete process.env.VITE_CONTACTS_DB_PATH;
  } else {
    process.env.VITE_CONTACTS_DB_PATH = ORIGINAL_CONTACTS_DB_PATH;
  }

  if (ORIGINAL_ADDRESS_BOOK_UUID === undefined) {
    delete process.env.VITE_ADDRESS_BOOK_UUID;
  } else {
    process.env.VITE_ADDRESS_BOOK_UUID = ORIGINAL_ADDRESS_BOOK_UUID;
  }
});

describe("getContactsDbPaths", () => {
  it("falls back to the standard Address Book path when no env override is set", () => {
    delete process.env.VITE_CONTACTS_DB_PATH;
    delete process.env.VITE_ADDRESS_BOOK_UUID;

    expect(getContactsDbPaths()?.[0]).toContain(
      "Library/Application Support/AddressBook/AddressBook-v22.abcddb",
    );
  });

  it("discovers sibling Address Book source databases from the main DB path", () => {
    const root = join(
      tmpdir(),
      `imsg-addressbook-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const mainDb = join(root, "AddressBook-v22.abcddb");
    const sourceA = join(root, "Sources", "A-UUID", "AddressBook-v22.abcddb");
    const sourceB = join(root, "Sources", "B-UUID", "AddressBook-v22.abcddb");

    mkdirSync(join(root, "Sources", "A-UUID"), { recursive: true });
    mkdirSync(join(root, "Sources", "B-UUID"), { recursive: true });
    writeFileSync(mainDb, "main");
    writeFileSync(sourceA, "a");
    writeFileSync(sourceB, "b");

    process.env.VITE_CONTACTS_DB_PATH = mainDb;
    delete process.env.VITE_ADDRESS_BOOK_UUID;

    try {
      expect(getContactsDbPaths()?.sort()).toEqual([mainDb, sourceA, sourceB].sort());
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
