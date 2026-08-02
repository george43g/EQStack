/**
 * Stage 4 — media-intel runtime wiring + inline surfacing.
 *
 * Covers the chat.db → AttachmentRef adapters, the cache-only inline
 * population (`applyInlineInterpretations`), and `formatMessage`'s
 * `[voice note: …]` / `[image: …]` rendering. No network, no transcribers:
 * a real `MediaIntelService` is injected with a temp cache + stub deps.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatMessage } from "../src/mcp-format.js";
import { MediaIntelService } from "../src/media-intel.js";
import { _setMediaIntelCachePathForTests, closeMediaIntelCache } from "../src/media-intel-cache.js";
import {
  _setInterpretRuntimeForTests,
  applyInlineInterpretations,
  attKey,
  type InterpretRuntime,
  kindFromMime,
  refForAttachment,
  transcriptSourceEnum,
} from "../src/media-intel-runtime.js";
import type { Message } from "../src/types.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "imsg-mir-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  _setInterpretRuntimeForTests(null);
  closeMediaIntelCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function baseMessage(over: Partial<Message> = {}): Message {
  return {
    id: 1,
    guid: "g1",
    text: null,
    handle: "+15551234567",
    isFromMe: false,
    date: new Date("2024-01-15T10:00:00"),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: "c1",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
    ...over,
  };
}

/** A runtime backed by a real service (temp cache) + stub deps, inlining ON. */
function runtimeWith(over: Partial<InterpretRuntime["config"]> = {}): InterpretRuntime {
  const chains = { audio: ["apple", "local"], image: [], video: [] };
  return {
    service: new MediaIntelService(
      { auto: "all", chains, providers: [] },
      { transcribeLocal: () => null },
    ),
    config: {
      auto: "all",
      chains,
      providers: [],
      inlineTranscripts: true,
      exportConfirmThreshold: 25,
      nudge: { enabled: true, tier2SyncNow: false, timeoutSeconds: 30 },
      configPath: null,
      warnings: [],
      ...over,
    },
  };
}

describe("kindFromMime", () => {
  it("classifies by mime, then by extension", () => {
    expect(kindFromMime("audio/m4a", "/x/vm.m4a")).toBe("audio");
    expect(kindFromMime("image/jpeg", "/x/p.jpg")).toBe("image");
    expect(kindFromMime("image/heic", "/x/p.heic")).toBe("image");
    expect(kindFromMime("video/mp4", "/x/v.mp4")).toBe("video");
    expect(kindFromMime(null, "/x/note.caf")).toBe("audio");
    expect(kindFromMime(null, "/x/pic.HEIC")).toBe("image");
    expect(kindFromMime("application/pdf", "/x/doc.pdf")).toBeNull();
  });
});

describe("refForAttachment", () => {
  it("builds a ref for media and attaches the Apple transcript only for audio", () => {
    const audio = refForAttachment(
      { rowId: 7, filename: "~/a/vm.caf", mimeType: "audio/x-caf", transferName: "vm.caf" },
      "apple said",
    );
    expect(audio?.key).toBe(attKey(7));
    expect(audio?.kind).toBe("audio");
    expect(audio?.filename).toBe("vm.caf");
    expect(audio?.appleTranscript).toBe("apple said");

    // An image never claims an Apple transcript, even if one is passed in.
    const img = refForAttachment(
      { rowId: 8, filename: "~/a/p.jpg", mimeType: "image/jpeg", transferName: null },
      "leaked",
    );
    expect(img?.kind).toBe("image");
    expect(img?.appleTranscript).toBeNull();
  });

  it("returns null for non-media and missing rowId", () => {
    expect(
      refForAttachment({ rowId: 1, filename: "d.pdf", mimeType: "application/pdf" }),
    ).toBeNull();
    expect(refForAttachment({ rowId: null, filename: "vm.m4a", mimeType: "audio/m4a" })).toBeNull();
  });
});

describe("transcriptSourceEnum", () => {
  it("maps granular sources to the local|cloud back-compat enum", () => {
    expect(transcriptSourceEnum("apple")).toBe("local");
    expect(transcriptSourceEnum("local")).toBe("local");
    expect(transcriptSourceEnum("provider:openrouter")).toBe("cloud");
    expect(transcriptSourceEnum(null)).toBeUndefined();
  });
});

describe("applyInlineInterpretations", () => {
  beforeEach(() => {
    _setMediaIntelCachePathForTests(join(tmp(), "inline-cache.db"));
  });

  it("inlines the instant Apple transcript with no attachments needed", () => {
    const rt = runtimeWith();
    _setInterpretRuntimeForTests(rt);
    const msg = baseMessage({ appleAudioTranscript: "running late, 10 min" });
    applyInlineInterpretations([msg]);
    expect(msg.interpretedMedia).toEqual({
      kind: "audio",
      text: "running late, 10 min",
      source: "apple",
    });
  });

  it("inlines a CACHED provider caption for an image attachment (peek only)", async () => {
    const dir = tmp();
    const path = join(dir, "pic.jpg");
    writeFileSync(path, "img-bytes");
    // Pre-populate the cache via a real interpret with a stubbed image reader + fetch.
    const chains = { audio: [], image: ["provider:p"], video: [] };
    const svc = new MediaIntelService(
      { auto: "all", chains, providers: [{ name: "p", preset: "openai", apiKey: "sk" }] },
      {
        readImage: () => ({ base64: "AA==", mimeType: "image/jpeg" }),
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "a cat on a couch" } }] }),
            {
              status: 200,
            },
          )) as any,
      },
    );
    const rt: InterpretRuntime = {
      service: svc,
      config: { ...runtimeWith().config, chains },
    };
    _setInterpretRuntimeForTests(rt);

    const att = { rowId: 5, filename: path, mimeType: "image/jpeg", transferName: "pic.jpg" };
    const ref = refForAttachment(att)!;
    await svc.interpret(ref); // populate cache

    const msg = baseMessage({ hasAttachments: true, attachments: [att] as any });
    applyInlineInterpretations([msg]);
    expect(msg.interpretedMedia?.kind).toBe("image");
    expect(msg.interpretedMedia?.text).toBe("a cat on a couch");
  });

  it("is a no-op when inlineTranscripts is off", () => {
    _setInterpretRuntimeForTests(runtimeWith({ inlineTranscripts: false }));
    const msg = baseMessage({ appleAudioTranscript: "should stay hidden" });
    applyInlineInterpretations([msg]);
    expect(msg.interpretedMedia).toBeUndefined();
  });

  it("does not overwrite an already-set interpretation", () => {
    _setInterpretRuntimeForTests(runtimeWith());
    const msg = baseMessage({
      appleAudioTranscript: "apple",
      interpretedMedia: { kind: "audio", text: "preset", source: "manual" },
    });
    applyInlineInterpretations([msg]);
    expect(msg.interpretedMedia?.text).toBe("preset");
  });
});

describe("formatMessage — inline interpreted media", () => {
  it("renders a voice-note transcript in place of (no text)", () => {
    const out = formatMessage(
      baseMessage({
        displayName: "Alex",
        interpretedMedia: { kind: "audio", text: "call me back", source: "apple" },
      }),
    );
    expect(out).toContain("[voice note: <untrusted>call me back</untrusted>]");
    expect(out).not.toContain("(no text)");
  });

  it("labels image and video captions by kind and appends to any body text", () => {
    const img = formatMessage(
      baseMessage({
        text: "look",
        interpretedMedia: { kind: "image", text: "a sunset", source: "provider:or" },
      }),
    );
    expect(img).toContain("<untrusted>look</untrusted>");
    expect(img).toContain("[image: <untrusted>a sunset</untrusted>]");

    const vid = formatMessage(
      baseMessage({
        interpretedMedia: { kind: "video", text: "a dog running", source: "provider:or" },
      }),
    );
    expect(vid).toContain("[video: <untrusted>a dog running</untrusted>]");
  });

  it("is unchanged for a message with no interpreted media", () => {
    const out = formatMessage(baseMessage({ text: "hi there" }));
    expect(out).toContain("<untrusted>hi there</untrusted>");
    expect(out).not.toContain("voice note");
    const empty = formatMessage(baseMessage({ text: null }));
    expect(empty).toContain("(no text)");
  });
});
