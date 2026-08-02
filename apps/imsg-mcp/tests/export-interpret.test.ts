/**
 * Stage 4 — export media interpretation: passive embedding (cached/instant),
 * the paid-call guard, and active interpretation. Uses a fake DB + an injected
 * interpret runtime (real service, temp cache, stubbed network) so nothing
 * hits the real chat.db or the network.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExportInterpretGuardError, streamExport } from "../src/exportStream.js";
import { MediaIntelService } from "../src/media-intel.js";
import { _setMediaIntelCachePathForTests, closeMediaIntelCache } from "../src/media-intel-cache.js";
import type { InterpretRuntime } from "../src/media-intel-runtime.js";
import type { Message } from "../src/types.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "imsg-exp-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  closeMediaIntelCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function msg(over: Partial<Message>): Message {
  return {
    id: 1,
    guid: "g",
    text: null,
    handle: "+15551110000",
    isFromMe: false,
    date: new Date("2024-03-02T12:00:00Z"),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: "c",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
    ...over,
  };
}

/** A fake DB returning a fixed one-page thread; fresh copies each call so the
 *  guard walk and main walk don't share mutated instances. */
function fakeDb(makeMessages: () => Message[]): any {
  return {
    findChatByHandle: async () => ({
      displayName: "Tester",
      rawIdentifier: "+15551110000",
      threadSlug: "tester~imsg~0000",
    }),
    findUnmergedSiblingChats: () => [],
    getMessagesForChatExportPage: async () => ({
      messages: makeMessages(),
      nextCursor: null,
      rawCount: makeMessages().length,
    }),
  };
}

/** Runtime whose service captions images via a stubbed provider (no network). */
function runtime(over: Partial<InterpretRuntime["config"]> = {}): InterpretRuntime {
  const chains = { audio: ["apple", "local"], image: ["provider:p"], video: [] };
  const service = new MediaIntelService(
    { auto: "all", chains, providers: [{ name: "p", preset: "openai", apiKey: "sk" }] },
    {
      readImage: () => ({ base64: "AA==", mimeType: "image/jpeg" }),
      transcribeLocal: () => null,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "a beach at sunset" } }] }), {
          status: 200,
        })) as any,
    },
  );
  return {
    service,
    config: {
      auto: "all",
      chains,
      providers: [{ name: "p", preset: "openai", apiKey: "sk" }],
      inlineTranscripts: true,
      exportConfirmThreshold: 25,
      nudge: { enabled: true, tier2SyncNow: false, timeoutSeconds: 30 },
      configPath: null,
      warnings: [],
      ...over,
    },
  };
}

describe("streamExport — media interpretation", () => {
  let imgPath: string;
  beforeEach(() => {
    _setMediaIntelCachePathForTests(join(tmp(), "exp-cache.db"));
    imgPath = join(tmp(), "pic.jpg");
    writeFileSync(imgPath, "img-bytes");
  });

  function thread(): Message[] {
    return [
      msg({ id: 1, appleAudioTranscript: "on my way, five minutes" }),
      msg({
        id: 2,
        hasAttachments: true,
        attachments: [
          { rowId: 42, filename: imgPath, mimeType: "image/jpeg", transferName: "pic.jpg" },
        ] as any,
      }),
    ];
  }

  it("embeds the instant Apple transcript WITHOUT any cloud call by default", async () => {
    const out = join(tmp(), "e.md");
    const rt = runtime();
    const r = await streamExport({
      db: fakeDb(thread),
      chatIdentifier: "+15551110000",
      format: "markdown",
      outputPath: out,
      since: null,
      until: null,
      pageSize: 1000,
      interpret: false,
      interpretRuntime: rt,
    });
    expect(r.count).toBe(2);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("voice note: on my way, five minutes");
    // The image was NOT captioned (no active interpret, nothing cached).
    expect(md).not.toContain("a beach at sunset");
  });

  it("blocks an active-interpret export over the cloud threshold, writing nothing", async () => {
    const out = join(tmp(), "guard.md");
    const rt = runtime({ exportConfirmThreshold: 0 });
    await expect(
      streamExport({
        db: fakeDb(thread),
        chatIdentifier: "+15551110000",
        format: "markdown",
        outputPath: out,
        since: null,
        until: null,
        pageSize: 1000,
        interpret: true,
        confirmCloudInterpret: false,
        interpretRuntime: rt,
      }),
    ).rejects.toBeInstanceOf(ExportInterpretGuardError);
    // Guard runs BEFORE the file is created.
    expect(existsSync(out)).toBe(false);
  });

  it("actively captions the image when the guard is confirmed", async () => {
    const out = join(tmp(), "active.md");
    const rt = runtime({ exportConfirmThreshold: 0 });
    const r = await streamExport({
      db: fakeDb(thread),
      chatIdentifier: "+15551110000",
      format: "markdown",
      outputPath: out,
      since: null,
      until: null,
      pageSize: 1000,
      interpret: true,
      confirmCloudInterpret: true,
      interpretRuntime: rt,
    });
    expect(r.count).toBe(2);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("voice note: on my way, five minutes");
    expect(md).toContain("image: a beach at sunset");
  });

  it("folds a voice-note transcript into the CSV text column", async () => {
    const out = join(tmp(), "e.csv");
    const r = await streamExport({
      db: fakeDb(thread),
      chatIdentifier: "+15551110000",
      format: "csv",
      outputPath: out,
      since: null,
      until: null,
      pageSize: 1000,
      interpret: false,
      interpretRuntime: runtime(),
    });
    expect(r.count).toBe(2);
    const csv = readFileSync(out, "utf8");
    expect(csv).toContain("on my way, five minutes");
  });
});
