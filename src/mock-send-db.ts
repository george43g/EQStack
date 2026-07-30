import { randomUUID } from "node:crypto";
import { MAC_EPOCH_OFFSET, NANOS_PER_SECOND } from "./db-schema.js";
import Database, { type SqliteDatabase } from "./sqlite.js";

function dateToMacTimestamp(date: Date): number {
  return Math.floor((date.getTime() / 1000 - MAC_EPOCH_OFFSET) * NANOS_PER_SECOND);
}

function resolveChat(
  db: SqliteDatabase,
  opts: { chatIdentifier?: string; chatGuid?: string },
): { chatRowId: number; handleId: number } | null {
  let chatRow: any;
  if (opts.chatGuid) {
    chatRow = db
      .prepare("SELECT ROWID, chat_identifier FROM chat WHERE guid = ?")
      .get(opts.chatGuid);
  }
  if (!chatRow && opts.chatIdentifier) {
    chatRow = db
      .prepare("SELECT ROWID, chat_identifier FROM chat WHERE chat_identifier = ?")
      .get(opts.chatIdentifier);
  }
  if (!chatRow) return null;

  const handle: any = db
    .prepare("SELECT ROWID FROM handle WHERE id = ?")
    .get(chatRow.chat_identifier);

  const handleId = handle?.ROWID ?? 0;
  return { chatRowId: chatRow.ROWID, handleId };
}

export function insertSentMessage(
  dbPath: string,
  target: { chatIdentifier?: string; chatGuid?: string },
  text: string,
): number | null {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  try {
    const resolved = resolveChat(db, target);
    if (!resolved) {
      console.warn("[mock-send] Could not resolve chat for", target);
      return null;
    }

    const now = new Date();
    const macDate = dateToMacTimestamp(now);
    const guid = `mock:${randomUUID()}`;

    const insert = db.prepare(`
      INSERT INTO message (guid, text, handle_id, date, is_from_me, associated_message_type, is_read, is_delivered, service)
      VALUES (?, ?, ?, ?, 1, 0, 1, 1, 'iMessage')
    `);
    const result = insert.run(guid, text, resolved.handleId, macDate);
    const messageRowId = Number(result.lastInsertRowid);

    db.prepare(
      "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)",
    ).run(resolved.chatRowId, messageRowId, macDate);

    return messageRowId;
  } finally {
    db.close();
  }
}
