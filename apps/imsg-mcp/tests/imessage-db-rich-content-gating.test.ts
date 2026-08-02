/**
 * Regression: `richContentSummary` must NOT be set on plain text
 * messages just because `message_summary_info` happens to be non-null.
 *
 * Pre-fix bug: convertMessage gated richContentSummary on
 * `ext.message_summary_info` alone. macOS Messages writes summary-info
 * blobs to many plain-text messages (delivery receipt / typing
 * indicator metadata, depending on iOS version). The result was a
 * stray `richContentSummary:"[Rich Content]"` badge on messages like
 * "hello world" — visible in search_messages output and downstream
 * formatted exports.
 *
 * Post-fix: also require `ext.balloon_bundle_id` (the canonical
 * rich-balloon marker). Plain text → no richContentSummary.
 *
 * We inject the bug shape into a fixture copy: text + non-null
 * message_summary_info + NULL balloon_bundle_id. Pre-fix this would
 * round-trip as "[Rich Content]"; post-fix the field stays undefined.
 */

import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";

const FIXTURE = "fixtures/chat.db";
const haveFixture = existsSync(FIXTURE);

describe.skipIf(!haveFixture)("convertMessage richContentSummary gating", () => {
  let workDir: string;
  let dbPath: string;
  let slugsPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "imsg-rich-"));
    dbPath = join(workDir, "chat.db");
    slugsPath = join(workDir, "slugs.db");
    copyFileSync(FIXTURE, dbPath);
  });

  afterEach(() => {
    // tempdir reclaim is fine
  });

  it("returns undefined when balloon_bundle_id is NULL even with summary_info", async () => {
    const sqlite = new Database(dbPath);
    const guid = "test-plain-text-with-msi-deadbeef";
    // Plain text + non-null message_summary_info + NULL balloon_bundle_id.
    sqlite
      .prepare(`
        INSERT INTO message (
          guid, text, handle_id, date, is_from_me, is_read, is_delivered,
          service, item_type, associated_message_type, balloon_bundle_id,
          message_summary_info, cache_has_attachments
        ) VALUES (?, 'hello world', NULL, ?, 1, 1, 1, 'iMessage', 0, 0, NULL, ?, 0)
      `)
      .run(guid, 999_000_000_000, Buffer.from("bplist00 fake summary"));
    sqlite.close();

    const db = new IMessageDB(dbPath, undefined, slugsPath);
    try {
      const msgs = await db.getMessagesInWindow(0);
      const plain = msgs.find((m) => m.guid === guid);
      expect(plain, "injected plain-text message not returned").toBeDefined();
      expect(plain?.text).toBe("hello world");
      // The bug: pre-fix this would be "[Rich Content]".
      expect(plain?.richContentSummary).toBeUndefined();
      expect(plain?.richContentType).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("still parses richContentSummary when balloon_bundle_id IS set", async () => {
    const sqlite = new Database(dbPath);
    const guid = "test-real-rich-content-cafebabe";
    sqlite
      .prepare(`
        INSERT INTO message (
          guid, text, handle_id, date, is_from_me, is_read, is_delivered,
          service, item_type, associated_message_type, balloon_bundle_id,
          message_summary_info, cache_has_attachments
        ) VALUES (?, NULL, NULL, ?, 1, 1, 1, 'iMessage', 0, 0, ?, ?, 0)
      `)
      .run(
        guid,
        999_000_000_001,
        "com.apple.messages.URLBalloonProvider",
        Buffer.from("<string>Apple News article</string>"),
      );
    sqlite.close();

    const db = new IMessageDB(dbPath, undefined, slugsPath);
    try {
      const msgs = await db.getMessagesInWindow(0);
      const rich = msgs.find((m) => m.guid === guid);
      expect(rich, "injected rich message not returned").toBeDefined();
      // parseRichContentSummary picks up the <string>...</string> pattern.
      expect(rich?.richContentSummary).toBe("Apple News article");
    } finally {
      await db.close();
    }
  });
});
