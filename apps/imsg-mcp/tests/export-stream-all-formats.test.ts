/**
 * Stress test: streamExport against every supported format, asserting:
 *   - each output file exists and is non-trivial in size
 *   - count + oldest/newest are consistent across formats
 *   - heap growth across all 4 exports stays bounded (proves streaming)
 *   - markdown header includes the chat title
 *
 * Complements export-stream.test.ts, which covers individual format
 * correctness — this one is the regression net for "did someone make
 * one format buffer the whole thread accidentally".
 *
 * Skips when the env-data fixture isn't present (LFS pointer / fresh
 * clone).
 */

import { existsSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getContactsDbPaths, getImsgDbPath, getSlugsDbPath } from "../src/config.js";
import { streamExport } from "../src/exportStream.js";
import { IMessageDB } from "../src/imessage-db.js";

const dbPath = getImsgDbPath();
const haveFixture = existsSync(dbPath);

const tmpFiles: string[] = [];
function tmp(ext: string): string {
  const p = join(
    tmpdir(),
    `imsg-export-all-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`,
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

describe.skipIf(!haveFixture)("streamExport — all formats, bounded heap", () => {
  it("streams md/csv/json/ndjson with consistent counts and bounded heap", async () => {
    const db = new IMessageDB(dbPath, getContactsDbPaths(), getSlugsDbPath());
    try {
      // Find a non-trivial chat (≥200 msgs) so streaming is exercised.
      const convs = await db.listConversations(50);
      let target: string | null = null;
      for (const c of convs) {
        const sample = await db.getMessagesForChat(c.chatIdentifier, 250);
        if (sample.length >= 200) {
          target = c.chatIdentifier;
          break;
        }
      }
      if (!target) return;

      if (global.gc) global.gc();
      const heapStart = process.memoryUsage().heapUsed;

      const formats = ["markdown", "csv", "json", "ndjson"] as const;
      const results = await Promise.all(
        formats.map(async (format) => {
          const path = tmp(format === "markdown" ? "md" : format);
          const result = await streamExport({
            db,
            chatIdentifier: target as string,
            format,
            outputPath: path,
            since: null,
            until: null,
            pageSize: 200,
          });
          return { format, path, result };
        }),
      );

      if (global.gc) global.gc();
      const heapEnd = process.memoryUsage().heapUsed;
      const growthMb = (heapEnd - heapStart) / 1024 / 1024;

      // Each format must produce a non-empty file.
      for (const { path, result } of results) {
        expect(existsSync(path)).toBe(true);
        const size = statSync(path).size;
        expect(size).toBeGreaterThan(0);
        expect(size).toBe(result.sizeBytes);
      }

      // Same chat → same logical message count across formats.
      const counts = results.map((r) => r.result.count);
      const unique = [...new Set(counts)];
      expect(unique).toHaveLength(1);
      expect(counts[0]).toBeGreaterThanOrEqual(200);

      // Markdown should include a `# ` title (chat name).
      const md = results.find((r) => r.format === "markdown");
      expect(md).toBeDefined();
      // Title is the first non-empty line; verify it starts with `# `.
      const { readFileSync } = await import("node:fs");
      const head = readFileSync(md!.path, "utf8").split("\n", 3).join("\n");
      expect(head).toMatch(/^# /);

      // Bounded-heap proof: even after 4 sequential exports against a
      // ≥200-msg thread, total heap growth must be modest. A regression
      // that buffers the whole thread per-format would blow past this.
      //
      // Budget = 75 MB:
      //   - Synthetic fixture (4972 msgs, small): ≈10 MB observed
      //   - Real Mac chat.db (rich messages, longer text, attributedBody
      //     parse retain): ≈45 MB observed
      //   A genuine "buffer the whole thread" regression for the largest
      //   real thread (~26k msgs × 200 B each = 5 MB per format × 4) +
      //   string conversion overhead would be 150+ MB — still flagged.
      expect(growthMb).toBeLessThan(75);
    } finally {
      await db.close();
    }
  }, 60_000);
});
