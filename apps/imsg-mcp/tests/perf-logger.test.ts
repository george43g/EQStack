import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContactsDbPaths, getImsgDbPath } from "../src/config.js";
import { IMessageDB } from "../src/imessage-db.js";
import type { LogEntry } from "../src/logger.js";
import {
  clearLogs,
  error,
  getLogDirectory,
  getLogFilePath,
  getLogs,
  info,
  perf,
  warn,
} from "../src/logger.js";
import { isGitLfsPointer } from "./helpers.js";

describe("logger", () => {
  // File logging is gated on IMSG_DEV=1 (so end users running the published
  // bin don't accumulate NDJSON in $TMPDIR). Opt in for tests that assert
  // file-writing behavior.
  const originalImsgDev = process.env.IMSG_DEV;
  beforeAll(() => {
    process.env.IMSG_DEV = "1";
  });
  afterAll(() => {
    if (originalImsgDev === undefined) delete process.env.IMSG_DEV;
    else process.env.IMSG_DEV = originalImsgDev;
  });
  it("writes NDJSON log files to the temp directory", () => {
    const dir = getLogDirectory();
    info("test-log-entry", { test: true });

    const logFile = getLogFilePath();
    expect(logFile).not.toBeNull();
    expect(logFile!.startsWith(dir)).toBe(true);
    expect(existsSync(logFile!)).toBe(true);

    const content = readFileSync(logFile!, "utf-8").trim();
    const lines = content.split("\n").map((l) => JSON.parse(l) as LogEntry);
    const testLine = lines.find((l) => l.msg === "test-log-entry");
    expect(testLine).toBeDefined();
    expect(testLine!.level).toBe("info");
    expect(testLine!.mem_mb).toBeGreaterThan(0);
    expect(testLine!.data).toEqual({ test: true });
  });

  it("keeps the in-memory buffer for MCP get_logs tool", () => {
    clearLogs();
    info("mem-test-1");
    warn("mem-test-2");
    error("mem-test-3");

    const logs = getLogs();
    expect(logs.some((l) => l.includes("mem-test-1"))).toBe(true);
    expect(logs.some((l) => l.includes("[warn]") && l.includes("mem-test-2"))).toBe(true);
    expect(logs.some((l) => l.includes("[error]") && l.includes("mem-test-3"))).toBe(true);
  });

  it("perf spans measure duration and memory delta", () => {
    const span = perf("test-span");
    // Do some allocatable work
    const _buf = Buffer.alloc(1024 * 1024);
    const dur = span.end({ items: 42 });

    expect(dur).toBeGreaterThanOrEqual(0);

    const logFile = getLogFilePath()!;
    const lines = readFileSync(logFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as LogEntry);

    const perfLine = lines.find((l) => l.msg === "test-span" && l.level === "perf");
    expect(perfLine).toBeDefined();
    expect(perfLine!.dur_ms).toBeGreaterThanOrEqual(0);
    expect(perfLine!.mem_mb).toBeGreaterThan(0);
    expect(typeof perfLine!.mem_delta_mb).toBe("number");
    expect(perfLine!.data).toEqual({ items: 42 });
  });
});

describe("perf: IMessageDB operations (fixture)", () => {
  const chatPath = getImsgDbPath();
  const skip = isGitLfsPointer(chatPath);

  it("constructor completes within 10s", { skip }, () => {
    const paths = getContactsDbPaths();
    const tempDir = mkdtempSync(join(tmpdir(), "imsg-perf-"));
    const slugsPath = join(tempDir, "slugs.db");

    const span = perf("test:constructor");
    const db = new IMessageDB(chatPath, paths ?? undefined, slugsPath);
    const dur = span.end();

    expect(dur).toBeLessThan(10_000);
    db.close();
  });

  it("listConversations(50) completes within 5s", { skip }, async () => {
    const paths = getContactsDbPaths();
    const tempDir = mkdtempSync(join(tmpdir(), "imsg-perf-"));
    const slugsPath = join(tempDir, "slugs.db");
    const db = new IMessageDB(chatPath, paths ?? undefined, slugsPath);

    const span = perf("test:listConversations");
    const convs = await db.listConversations(50);
    const dur = span.end({ count: convs.length });

    expect(dur).toBeLessThan(5_000);
    expect(convs.length).toBeGreaterThan(0);
    expect(convs.length).toBeLessThanOrEqual(50);
    await db.close();
  });

  it("getUnreadMessages(20) completes within 5s", { skip }, async () => {
    const paths = getContactsDbPaths();
    const tempDir = mkdtempSync(join(tmpdir(), "imsg-perf-"));
    const slugsPath = join(tempDir, "slugs.db");
    const db = new IMessageDB(chatPath, paths ?? undefined, slugsPath);

    const span = perf("test:getUnreadMessages");
    const msgs = await db.getUnreadMessages(20);
    const dur = span.end({ count: msgs.length });

    expect(dur).toBeLessThan(5_000);
    expect(Array.isArray(msgs)).toBe(true);
    await db.close();
  });

  it("searchMessages completes within 5s", { skip }, async () => {
    const paths = getContactsDbPaths();
    const tempDir = mkdtempSync(join(tmpdir(), "imsg-perf-"));
    const slugsPath = join(tempDir, "slugs.db");
    const db = new IMessageDB(chatPath, paths ?? undefined, slugsPath);

    const span = perf("test:searchMessages");
    const msgs = await db.searchMessages("the", 10);
    const dur = span.end({ count: msgs.length });

    expect(dur).toBeLessThan(5_000);
    expect(Array.isArray(msgs)).toBe(true);
    await db.close();
  });

  it("getRecentMessages(20) completes within 5s", { skip }, async () => {
    const paths = getContactsDbPaths();
    const tempDir = mkdtempSync(join(tmpdir(), "imsg-perf-"));
    const slugsPath = join(tempDir, "slugs.db");
    const db = new IMessageDB(chatPath, paths ?? undefined, slugsPath);

    const span = perf("test:getRecentMessages");
    const msgs = await db.getRecentMessages(20);
    const dur = span.end({ count: msgs.length });

    expect(dur).toBeLessThan(5_000);
    expect(msgs.length).toBeGreaterThan(0);
    await db.close();
  });
});
