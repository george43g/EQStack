/**
 * End-to-end test of the streaming exporter against the env-data fixture.
 * Skips gracefully if the LFS fixture isn't present.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getContactsDbPaths, getImsgDbPath, getSlugsDbPath } from "../src/config.js";
import { streamExport } from "../src/exportStream.js";
import { IMessageDB } from "../src/imessage-db.js";

const dbPath = getImsgDbPath();
const haveFixture = existsSync(dbPath);

const tmpFiles: string[] = [];
function tmpFile(ext: string): string {
  const p = join(
    tmpdir(),
    `imsg-export-test-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`,
  );
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe.skipIf(!haveFixture)("streamExport", () => {
  it("writes an NDJSON file that round-trips message count + ids", async () => {
    const db = new IMessageDB(dbPath, getContactsDbPaths(), getSlugsDbPath());
    try {
      const convs = await db.listConversations(50);
      let target: string | null = null;
      for (const c of convs) {
        const msgs = await db.getMessagesForChat(c.chatIdentifier, 100);
        if (msgs.length >= 50) {
          target = c.chatIdentifier;
          break;
        }
      }
      if (!target) return;

      const path = tmpFile("ndjson");
      const result = await streamExport({
        db,
        chatIdentifier: target,
        format: "ndjson",
        outputPath: path,
        since: null,
        until: null,
        pageSize: 200,
      });

      expect(result.count).toBeGreaterThan(0);
      expect(result.savedTo).toBe(path);

      const content = readFileSync(path, "utf8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(result.count);
      // Each line must be valid JSON with an id field
      for (const line of lines.slice(0, 10)) {
        const parsed = JSON.parse(line);
        expect(typeof parsed.id).toBe("number");
        expect(typeof parsed.guid).toBe("string");
      }
    } finally {
      await db.close();
    }
  }, 30_000);

  it("respects since/until date bounds", async () => {
    const db = new IMessageDB(dbPath, getContactsDbPaths(), getSlugsDbPath());
    try {
      const convs = await db.listConversations(50);
      let target: string | null = null;
      for (const c of convs) {
        const msgs = await db.getMessagesForChat(c.chatIdentifier, 100);
        if (msgs.length >= 30) {
          target = c.chatIdentifier;
          break;
        }
      }
      if (!target) return;

      // Bound: only this year
      const since = new Date(new Date().getFullYear(), 0, 1);
      const path = tmpFile("ndjson");
      const result = await streamExport({
        db,
        chatIdentifier: target,
        format: "ndjson",
        outputPath: path,
        since,
        until: null,
        pageSize: 100,
      });

      if (result.count === 0) return; // chat has no this-year messages
      expect(result.oldest!).not.toBeNull();
      expect(result.oldest!.getTime()).toBeGreaterThanOrEqual(since.getTime());
    } finally {
      await db.close();
    }
  }, 30_000);

  it("writes valid JSON with bracket-balanced top-level structure", async () => {
    const db = new IMessageDB(dbPath, getContactsDbPaths(), getSlugsDbPath());
    try {
      const convs = await db.listConversations(50);
      let target: string | null = null;
      for (const c of convs) {
        const msgs = await db.getMessagesForChat(c.chatIdentifier, 100);
        if (msgs.length >= 10) {
          target = c.chatIdentifier;
          break;
        }
      }
      if (!target) return;

      const path = tmpFile("json");
      const result = await streamExport({
        db,
        chatIdentifier: target,
        format: "json",
        outputPath: path,
        since: null,
        until: null,
        pageSize: 200,
      });
      const content = readFileSync(path, "utf8");
      const parsed = JSON.parse(content) as { count: number; messages: unknown[] };
      expect(parsed.count).toBe(result.count);
      expect(parsed.messages.length).toBe(result.count);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("writes a CSV with the header row exactly once", async () => {
    const db = new IMessageDB(dbPath, getContactsDbPaths(), getSlugsDbPath());
    try {
      const convs = await db.listConversations(50);
      let target: string | null = null;
      for (const c of convs) {
        const msgs = await db.getMessagesForChat(c.chatIdentifier, 100);
        if (msgs.length >= 30) {
          target = c.chatIdentifier;
          break;
        }
      }
      if (!target) return;

      const path = tmpFile("csv");
      await streamExport({
        db,
        chatIdentifier: target,
        format: "csv",
        outputPath: path,
        since: null,
        until: null,
        pageSize: 50, // Small pages so we exercise the multi-page path
      });

      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines[0]).toBe(
        "id,date,sender,handle,is_from_me,is_read,is_reply,reply_to_text,text,has_attachments",
      );
      // Header must appear only once even across multiple pages
      const headerCount = lines.filter((l) => l.startsWith("id,date,sender,")).length;
      expect(headerCount).toBe(1);
    } finally {
      await db.close();
    }
  }, 30_000);
});
