/**
 * RS-A: getDeliveryRow against the real (reduced) fixture chat.db. The fixture
 * lacks is_sent / is_finished / was_downgraded, so this pins that the DB layer
 * returns those as null instead of throwing (column tolerance).
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getContactsDbPaths, getImsgDbPath, getSlugsDbPath } from "../src/config.js";
import { deriveDeliveryStatus } from "../src/delivery-status.js";
import { IMessageDB } from "../src/imessage-db.js";

const dbPath = getImsgDbPath();
const haveFixture = existsSync(dbPath);

describe.skipIf(!haveFixture)("getDeliveryRow (column-tolerant)", () => {
  it("reads a real ROWID's delivery columns without a schema-mismatch throw", async () => {
    const db = new IMessageDB(dbPath, getContactsDbPaths(), getSlugsDbPath());
    try {
      const convs = await db.listConversations(20);
      expect(convs.length).toBeGreaterThan(0);
      const msgs = await db.getMessagesForChat(convs[0]!.chatIdentifier, 5);
      expect(msgs.length).toBeGreaterThan(0);
      const rowId = msgs[msgs.length - 1]!.id;

      const row = db.getDeliveryRow(rowId);
      expect(row).not.toBeNull();
      if (!row) return;
      // absent columns on the reduced fixture come back null, not a throw
      expect(row.isSent).toBeNull();
      expect(row.isFinished).toBeNull();
      expect(row.wasDowngraded).toBeNull();
      // present columns are usable, and derivation runs end-to-end
      const status = deriveDeliveryStatus(row);
      expect(["delivered", "failed", "pending"]).toContain(status.state);
    } finally {
      db.close();
    }
  });

  it("returns null for a ROWID that does not exist", async () => {
    const db = new IMessageDB(dbPath, getContactsDbPaths(), getSlugsDbPath());
    try {
      expect(db.getDeliveryRow(999_999_999)).toBeNull();
    } finally {
      db.close();
    }
  });
});
