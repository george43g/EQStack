/**
 * Streaming exporter — writes a conversation to a file in pages so a 100k
 * message history doesn't blow up memory. Used by the `export_messages`
 * MCP tool.
 *
 * Strategy:
 *  1. Walk history chronologically with a stable `(date, ROWID)` cursor.
 *  2. Each page is formatted and written immediately to a writable stream.
 *  3. For JSON we emit a top-level `{ ..., messages: [...] }` shape, opening
 *     the array, comma-separating page entries, then closing — that way we
 *     never hold the full array in memory.
 *  4. NDJSON is the simplest streaming option (one JSON object per line) —
 *     recommended for large exports.
 */

import { createWriteStream, statSync } from "node:fs";
import { toCSV, toMarkdown, toNDJSONLine } from "./export-formats.js";
import type { IMessageDB, MessageExportCursor, UnmergedSiblingChat } from "./imessage-db.js";
import {
  embedInterpretations,
  getInterpretRuntime,
  type InterpretRuntime,
  refsForMessages,
} from "./media-intel-runtime.js";

export interface ExportOptions {
  db: IMessageDB;
  chatIdentifier: string;
  format: "markdown" | "csv" | "json" | "ndjson";
  outputPath: string;
  since: Date | null;
  until: Date | null;
  pageSize: number;
  signal?: AbortSignal;
  /**
   * Actively interpret media during export (transcribe voice notes, caption
   * images/videos) and embed the text. Cached + instant Apple transcripts are
   * embedded regardless; this only controls whether NEW (incl. paid) calls run.
   */
  interpret?: boolean;
  /** Skip the paid-call guard (see `exportConfirmThreshold`). */
  confirmCloudInterpret?: boolean;
  /** Injectable interpret runtime (defaults to the process singleton). */
  interpretRuntime?: InterpretRuntime;
}

/**
 * Thrown before any output is written when an `interpret` export would trigger
 * more uncached cloud calls than the configured threshold and the caller has
 * not confirmed. The handler turns this into an actionable message.
 */
export class ExportInterpretGuardError extends Error {
  constructor(
    public readonly uncachedCloud: number,
    public readonly threshold: number,
  ) {
    super(
      `This export would trigger ${uncachedCloud} uncached cloud interpretation call(s) (threshold ${threshold}). Re-run with confirmCloudInterpret:true to proceed, or narrow the range with since/until.`,
    );
    this.name = "ExportInterpretGuardError";
  }
}

export interface ExportResult {
  savedTo: string;
  count: number;
  oldest: Date | null;
  newest: Date | null;
  sizeBytes: number;
  unmergedSiblings: UnmergedSiblingChat[];
}

/** Type guard — Node ESM filesystem stream */
type WritableStream = ReturnType<typeof createWriteStream>;

function writeAndDrain(stream: WritableStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.write(chunk)) {
      resolve();
      return;
    }
    // Back-pressure path: register both listeners and ensure either side
    // also removes the OTHER. Pre-fix only the firing side cleaned up
    // (via .once), so each back-pressure tick leaked a stale "error"
    // listener — exporting a 26k-msg thread triggered the MaxListeners
    // warning around the 11th tick.
    const onDrain = () => {
      stream.removeListener("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      stream.removeListener("drain", onDrain);
      reject(err);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function endStream(stream: WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
}

export async function streamExport(opts: ExportOptions): Promise<ExportResult> {
  const { db, chatIdentifier, format, outputPath, since, until, pageSize, signal } = opts;
  const interpret = opts.interpret ?? false;
  const runtime = opts.interpretRuntime ?? getInterpretRuntime();
  const embedActive = interpret;

  // Guard: an ACTIVE-interpret export can fan out into many paid calls. Count
  // the uncached-cloud work in a metadata-only pre-pass BEFORE truncating the
  // output file, and refuse (throwing) when it exceeds the threshold unless the
  // caller confirmed. Cached/instant embedding needs no guard.
  if (interpret && !opts.confirmCloudInterpret) {
    const threshold = runtime.config.exportConfirmThreshold;
    let uncached = 0;
    let guardCursor: MessageExportCursor | null = null;
    while (true) {
      if (signal?.aborted) throw new Error("Export cancelled by client.");
      const page = await db.getMessagesForChatExportPage(chatIdentifier, pageSize, {
        afterCursor: guardCursor,
        since,
        until,
      });
      if (page.messages.length === 0) break;
      uncached += runtime.service.countUncachedCloud(refsForMessages(page.messages));
      guardCursor = page.nextCursor;
      if (!guardCursor || page.rawCount < pageSize) break;
      await new Promise((r) => setImmediate(r));
    }
    if (uncached > threshold) throw new ExportInterpretGuardError(uncached, threshold);
  }

  const stream = createWriteStream(outputPath, { encoding: "utf8" });

  let count = 0;
  let oldest: Date | null = null;
  let newest: Date | null = null;
  let cursor: MessageExportCursor | null = null;

  try {
    if (signal?.aborted) throw new Error("Export cancelled by client.");

    // Header
    if (format === "markdown") {
      const conv = await db.findChatByHandle(chatIdentifier);
      const name = conv?.displayName ?? conv?.rawIdentifier ?? chatIdentifier;
      await writeAndDrain(stream, `# ${name}\n\n`);
      if (conv?.threadSlug) await writeAndDrain(stream, `**Slug**: \`${conv.threadSlug}\`\n`);
      if (since) await writeAndDrain(stream, `**Since**: ${since.toISOString()}\n`);
      if (until) await writeAndDrain(stream, `**Until**: ${until.toISOString()}\n`);
      await writeAndDrain(stream, `**Exported**: ${new Date().toISOString()}\n\n---\n\n`);
    } else if (format === "csv") {
      await writeAndDrain(
        stream,
        "id,date,sender,handle,is_from_me,is_read,is_reply,reply_to_text,text,has_attachments\n",
      );
    } else if (format === "json") {
      await writeAndDrain(
        stream,
        `{\n  "chatIdentifier": ${JSON.stringify(chatIdentifier)},\n  "exportedAt": ${JSON.stringify(new Date().toISOString())},\n  "messages": [\n`,
      );
    }
    // ndjson: no header

    let firstJson = true;

    // Page through history in chronological order. The export-specific DB
    // method applies date bounds in SQL and dedupes merged chat rows before
    // LIMIT so every normal message gets one chance to be exported.
    while (true) {
      if (signal?.aborted) throw new Error("Export cancelled by client.");
      const page = await db.getMessagesForChatExportPage(chatIdentifier, pageSize, {
        includeReactionDetails: true,
        afterCursor: cursor,
        since,
        until,
      });
      if (page.messages.length === 0) break;

      // Embed voice-note transcripts / captions: cached + instant always, plus
      // active (incl. paid) interpretation when requested. The guard above has
      // already cleared any cloud fan-out.
      await embedInterpretations(page.messages, runtime, embedActive);

      // Track running oldest/newest for the result
      for (const m of page.messages) {
        if (oldest == null || m.date < oldest) oldest = m.date;
        if (newest == null || m.date > newest) newest = m.date;
      }

      // Format and write
      if (page.messages.length > 0) {
        if (format === "markdown") {
          await writeAndDrain(
            stream,
            toMarkdown(page.messages, { thread: chatIdentifier }).split("\n").slice(6).join("\n"),
          );
          // ^ slice(6) skips the per-page header (6 lines without participants) — we wrote it once above
        } else if (format === "csv") {
          // toCSV emits its own header; skip the first line on each page
          const csvBody = toCSV(page.messages).split("\n").slice(1).join("\n");
          await writeAndDrain(stream, `${csvBody}\n`);
        } else if (format === "json") {
          for (const m of page.messages) {
            if (!firstJson) await writeAndDrain(stream, ",\n");
            await writeAndDrain(stream, `    ${toNDJSONLine(m)}`);
            firstJson = false;
          }
        } else if (format === "ndjson") {
          for (const m of page.messages) {
            await writeAndDrain(stream, `${toNDJSONLine(m)}\n`);
          }
        }
      }
      count += page.messages.length;

      cursor = page.nextCursor;
      if (!cursor || page.rawCount < pageSize) break; // last page

      // Yield so other tasks (e.g. health_check) can run
      await new Promise((r) => setImmediate(r));
    }

    // Footer
    if (format === "json") {
      await writeAndDrain(stream, `\n  ],\n  "count": ${count}\n}\n`);
    }

    await endStream(stream);
    const sizeBytes = (() => {
      try {
        return statSync(outputPath).size;
      } catch {
        return 0;
      }
    })();

    const unmergedSiblings = db.findUnmergedSiblingChats(chatIdentifier);

    return { savedTo: outputPath, count, oldest, newest, sizeBytes, unmergedSiblings };
  } catch (error) {
    stream.destroy();
    throw error;
  }
}
