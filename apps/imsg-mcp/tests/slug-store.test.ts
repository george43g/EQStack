import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SlugStore } from "../src/slug-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function makeStore(): SlugStore {
  const dir = mkdtempSync(join(tmpdir(), "imsg-slug-store-"));
  tempDirs.push(dir);
  return new SlugStore(join(dir, "slugs.db"));
}

describe("SlugStore", () => {
  it("remaps a guid to a new slug; the orphaned old slug is cleaned on prune", () => {
    const store = makeStore();

    try {
      // Synthetic data using fictional reserved phone (+1-555-01xx).
      // Re-upserting the same guid with a new slug simulates a contact whose
      // display name changed (e.g. firstname → nickname after Address Book sync).
      const PHONE = "+15550000088";
      const GUID = `iMessage;-;${PHONE}`;

      store.upsert({
        slug: "alex-example~imsg~1234",
        chatGuid: GUID,
        chatIdentifier: PHONE,
        displayName: "Alex Example",
        service: "iMessage",
        isGroup: false,
        participants: PHONE,
        updatedAt: 1,
      });

      store.upsert({
        slug: "alexnick~imsg~1234",
        chatGuid: GUID,
        chatIdentifier: PHONE,
        displayName: "AlexNick",
        service: "iMessage",
        isGroup: false,
        participants: PHONE,
        updatedAt: 2,
      });

      // The guid now points at the new slug.
      expect(store.lookupByGuid(GUID)?.slug).toBe("alexnick~imsg~1234");
      expect(store.lookupBySlug("alexnick~imsg~1234")?.displayName).toBe("AlexNick");
      // The old slug lingers (a slug may have other legs) until prune sweeps orphans.
      store.prune(new Set([GUID]));
      expect(store.lookupBySlug("alex-example~imsg~1234")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("collapses multiple chat legs of one identity into a single canonical slug", () => {
    const store = makeStore();
    try {
      const SLUG = "desiree~imsg~abcd";
      const phoneGuid = "iMessage;-;+15550000200";
      const emailGuid = "iMessage;-;desiree@example.com";

      store.upsert({
        slug: SLUG,
        chatGuid: phoneGuid,
        chatIdentifier: "+15550000200",
        displayName: "Desiree",
        service: "iMessage",
        isGroup: false,
        participants: "+15550000200",
        updatedAt: 1,
      });
      // Email leg arrives second under the SAME slug — must not overwrite the
      // canonical phone identifier.
      store.upsert({
        slug: SLUG,
        chatGuid: emailGuid,
        chatIdentifier: "desiree@example.com",
        displayName: "Desiree",
        service: "iMessage",
        isGroup: false,
        participants: "desiree@example.com",
        updatedAt: 2,
      });

      // Both legs resolve to the one slug.
      expect(store.lookupByGuid(phoneGuid)?.slug).toBe(SLUG);
      expect(store.lookupByGuid(emailGuid)?.slug).toBe(SLUG);
      // One identity row, phone kept as the canonical handle.
      expect(store.all()).toHaveLength(1);
      expect(store.lookupBySlug(SLUG)?.chatIdentifier).toBe("+15550000200");
      // Both guids are linked.
      expect(
        store
          .guidLinks()
          .map((l) => l.chatGuid)
          .sort(),
      ).toEqual([emailGuid, phoneGuid].sort());

      // Pruning with only the phone leg valid drops the email link but keeps the
      // slug (still has the phone leg).
      store.prune(new Set([phoneGuid]));
      expect(store.lookupBySlug(SLUG)).not.toBeNull();
      expect(store.lookupByGuid(emailGuid)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("isGroup round-trips as a boolean (was stored as 0/1)", () => {
    const store = makeStore();
    try {
      store.upsert({
        slug: "crew~imsg~aaaa",
        chatGuid: "iMessage;+;chat999",
        chatIdentifier: "chat999",
        displayName: "Crew",
        service: "iMessage",
        isGroup: true,
        participants: "+15550000001,+15550000002",
        updatedAt: 1,
      });
      const r = store.lookupBySlug("crew~imsg~aaaa");
      expect(r?.isGroup).toBe(true);
      expect(typeof r?.isGroup).toBe("boolean");
    } finally {
      store.close();
    }
  });

  it("lookupByChatIdentifier finds the row by chat_identifier", () => {
    const store = makeStore();
    try {
      store.upsert({
        slug: "alice~imsg~bbbb",
        chatGuid: "iMessage;-;+15550000010",
        chatIdentifier: "+15550000010",
        displayName: "Alice",
        service: "iMessage",
        isGroup: false,
        participants: "+15550000010",
        updatedAt: 1,
      });
      expect(store.lookupByChatIdentifier("+15550000010")?.slug).toBe("alice~imsg~bbbb");
      expect(store.lookupByChatIdentifier("+15550000099")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("all() returns rows ordered by updatedAt DESC", () => {
    const store = makeStore();
    try {
      store.upsert({
        slug: "old~imsg~1111",
        chatGuid: "iMessage;-;+15550000020",
        chatIdentifier: "+15550000020",
        displayName: null,
        service: "iMessage",
        isGroup: false,
        participants: "+15550000020",
        updatedAt: 100,
      });
      store.upsert({
        slug: "new~imsg~2222",
        chatGuid: "iMessage;-;+15550000021",
        chatIdentifier: "+15550000021",
        displayName: null,
        service: "iMessage",
        isGroup: false,
        participants: "+15550000021",
        updatedAt: 200,
      });
      const records = store.all();
      expect(records.map((r) => r.slug)).toEqual(["new~imsg~2222", "old~imsg~1111"]);
    } finally {
      store.close();
    }
  });

  it("upsertMany commits atomically across many rows", () => {
    const store = makeStore();
    try {
      const records = Array.from({ length: 50 }, (_, i) => ({
        slug: `bulk~imsg~${i.toString().padStart(4, "0")}`,
        chatGuid: `iMessage;-;+1555000${i.toString().padStart(4, "0")}`,
        chatIdentifier: `+1555000${i.toString().padStart(4, "0")}`,
        displayName: `Person ${i}`,
        service: "iMessage",
        isGroup: false,
        participants: `+1555000${i.toString().padStart(4, "0")}`,
        updatedAt: 1000 + i,
      }));
      store.upsertMany(records);
      expect(store.all()).toHaveLength(50);
    } finally {
      store.close();
    }
  });

  it("prune removes only rows whose chat_guid is missing from the valid set", () => {
    const store = makeStore();
    try {
      const keepGuid = "iMessage;-;+15550000030";
      const dropGuid = "iMessage;-;+15550000031";
      store.upsert({
        slug: "keep~imsg~aaaa",
        chatGuid: keepGuid,
        chatIdentifier: "+15550000030",
        displayName: null,
        service: "iMessage",
        isGroup: false,
        participants: "+15550000030",
        updatedAt: 1,
      });
      store.upsert({
        slug: "drop~imsg~bbbb",
        chatGuid: dropGuid,
        chatIdentifier: "+15550000031",
        displayName: null,
        service: "iMessage",
        isGroup: false,
        participants: "+15550000031",
        updatedAt: 2,
      });
      const dropped = store.prune(new Set([keepGuid]));
      expect(dropped).toBe(1);
      expect(store.lookupBySlug("keep~imsg~aaaa")).not.toBeNull();
      expect(store.lookupBySlug("drop~imsg~bbbb")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("prune returns 0 when the valid set covers every row", () => {
    const store = makeStore();
    try {
      const guid = "iMessage;-;+15550000040";
      store.upsert({
        slug: "k~imsg~aaaa",
        chatGuid: guid,
        chatIdentifier: "+15550000040",
        displayName: null,
        service: "iMessage",
        isGroup: false,
        participants: "+15550000040",
        updatedAt: 1,
      });
      expect(store.prune(new Set([guid]))).toBe(0);
      expect(store.lookupBySlug("k~imsg~aaaa")).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it("survives a process restart by re-opening the same db path", () => {
    const dir = mkdtempSync(join(tmpdir(), "imsg-slug-restart-"));
    tempDirs.push(dir);
    const path = join(dir, "slugs.db");
    const store1 = new SlugStore(path);
    store1.upsert({
      slug: "persist~imsg~aaaa",
      chatGuid: "iMessage;-;+15550000050",
      chatIdentifier: "+15550000050",
      displayName: "Persisted",
      service: "iMessage",
      isGroup: false,
      participants: "+15550000050",
      updatedAt: 1,
    });
    store1.close();

    // Re-open
    const store2 = new SlugStore(path);
    try {
      const r = store2.lookupBySlug("persist~imsg~aaaa");
      expect(r?.displayName).toBe("Persisted");
    } finally {
      store2.close();
    }
  });
});
