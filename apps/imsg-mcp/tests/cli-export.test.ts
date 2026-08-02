/**
 * Smoke test for the `imsg export` CLI subcommand. Covers:
 *  - argv parsing through commander (validates options reach the handler)
 *  - normalizeFormat error path
 *  - end-to-end NDJSON export against the env-data fixture (skipped on miss)
 *
 * Skipped gracefully when the LFS chat.db is not present.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExportCommand } from "../src/cli.js";
import { getContactsDbPaths, getImsgDbPath, getSlugsDbPath } from "../src/config.js";
import { IMessageDB } from "../src/imessage-db.js";

const dbPath = getImsgDbPath();
const haveFixture = existsSync(dbPath);

const tmpFiles: string[] = [];
function tmpFile(ext: string): string {
  const p = join(
    tmpdir(),
    `imsg-cli-export-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`,
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

describe("runExportCommand argv validation", () => {
  it("rejects unknown format", async () => {
    await expect(runExportCommand("+15555550100", { format: "xml" })).rejects.toThrow(
      /Unknown format/,
    );
  });

  it("rejects out-of-range page-size", async () => {
    await expect(
      runExportCommand("+15555550100", { format: "md", pageSize: "99" }),
    ).rejects.toThrow(/page-size/);
    await expect(
      runExportCommand("+15555550100", { format: "md", pageSize: "5001" }),
    ).rejects.toThrow(/page-size/);
  });

  it("rejects unparseable --since", async () => {
    await expect(
      runExportCommand("+15555550100", { format: "md", since: "notadate-zzz" }),
    ).rejects.toThrow(/--since/);
  });
});

describe.skipIf(!haveFixture)("runExportCommand end-to-end", () => {
  it("exports an NDJSON file for a known chat", async () => {
    // Pick a chat with messages so the export isn't empty
    const db = new IMessageDB(dbPath, getContactsDbPaths(), getSlugsDbPath());
    let target: string | null = null;
    try {
      const convs = await db.listConversations(50);
      for (const c of convs) {
        const msgs = await db.getMessagesForChat(c.chatIdentifier, 5);
        if (msgs.length >= 1) {
          target = c.chatIdentifier;
          break;
        }
      }
    } finally {
      await db.close();
    }
    if (!target) return;

    const out = tmpFile("ndjson");
    await runExportCommand(target, {
      format: "ndjson",
      output: out,
      pageSize: "200",
    });
    expect(existsSync(out)).toBe(true);
    const content = readFileSync(out, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]!) as { id: number };
    expect(typeof first.id).toBe("number");
  }, 30_000);

  it("resolves a thread slug to its chatIdentifier", async () => {
    const db = new IMessageDB(dbPath, getContactsDbPaths(), getSlugsDbPath());
    let slug: string | null = null;
    try {
      const all = db.getAllSlugs();
      for (const rec of all) {
        const msgs = await db.getMessagesForChat(rec.chatIdentifier, 5);
        if (msgs.length >= 1) {
          slug = rec.slug;
          break;
        }
      }
    } finally {
      await db.close();
    }
    if (!slug) return;

    const out = tmpFile("ndjson");
    await runExportCommand(slug, {
      format: "ndjson",
      output: out,
      pageSize: "200",
    });
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8").trim().length).toBeGreaterThan(0);
  });
});
