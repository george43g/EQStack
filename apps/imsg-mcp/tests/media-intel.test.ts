/**
 * Stage 2 — media-intel core: providers, cache, and the interpretation service.
 * No network (injected fetch) and no real transcribers (injected local fn).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AttachmentRef, type InterpretConfig, MediaIntelService } from "../src/media-intel.js";
import {
  _setMediaIntelCachePathForTests,
  closeMediaIntelCache,
  countCachedDone,
  deleteMediaIntel,
  fileSignature,
  lookupMediaIntel,
  storeMediaIntel,
} from "../src/media-intel-cache.js";
import { ProviderClient, resolveProvider } from "../src/media-providers.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "imsg-mi-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  closeMediaIntelCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── Providers ────────────────────────────────────────────────────────────
describe("resolveProvider", () => {
  it("resolves a preset base URL + capabilities", () => {
    const r = resolveProvider({ name: "or", preset: "openrouter" });
    expect(r.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(r.capabilities.vision).toBe(true);
    expect(r.capabilities.transcribe).toBe(false);
  });

  it("builds the Cloudflare URL from an account id, and errors without one", () => {
    expect(resolveProvider({ name: "cf", preset: "cloudflare", accountId: "acc123" }).baseUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1",
    );
    expect(() => resolveProvider({ name: "cf", preset: "cloudflare" })).toThrow(/accountId/);
  });

  it("accepts a custom base URL and strips trailing slashes", () => {
    expect(resolveProvider({ name: "x", baseUrl: "http://localhost:9/v1/" }).baseUrl).toBe(
      "http://localhost:9/v1",
    );
  });
});

describe("ProviderClient", () => {
  it("posts multipart transcriptions and returns text", async () => {
    let seenUrl = "";
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
      return new Response("hello transcript", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = new ProviderClient(
      resolveProvider({ name: "g", preset: "groq", apiKey: "sk-test" }),
      { fetchImpl },
    );
    const out = await client.transcriptions({ buffer: Buffer.from("audio"), filename: "vm.m4a" });
    expect(out).toBe("hello transcript");
    expect(seenUrl).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  });

  it("posts a multimodal chat with an image and returns the caption", async () => {
    let body: any;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "a cat on a sofa" } }] }),
        {
          status: 200,
        },
      );
    }) as unknown as typeof globalThis.fetch;
    const client = new ProviderClient(
      resolveProvider({ name: "or", preset: "openrouter", apiKey: "sk", models: { vision: "m" } }),
      { fetchImpl },
    );
    const out = await client.chatMultimodal({ text: "describe", images: [Buffer.from("img")] });
    expect(out).toBe("a cat on a sofa");
    expect(body.messages[0].content[1].type).toBe("image_url");
    expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof globalThis.fetch;
    const client = new ProviderClient(resolveProvider({ name: "g", preset: "groq", apiKey: "k" }), {
      fetchImpl,
    });
    await expect(
      client.transcriptions({ buffer: Buffer.from("a"), filename: "x.m4a" }),
    ).rejects.toThrow(/500/);
  });
});

// ── Cache ────────────────────────────────────────────────────────────────
describe("media-intel-cache", () => {
  beforeEach(() => {
    _setMediaIntelCachePathForTests(join(tmp(), "cache.db"));
  });

  it("stores and looks up by key + file signature", () => {
    storeMediaIntel({
      key: "att:1",
      kind: "audio",
      status: "done",
      text: "hi",
      extra: null,
      source: "local",
      model: null,
      fileSig: fileSignature(10, 1000),
      durMs: 5,
      error: null,
      createdAt: 1,
    });
    expect(lookupMediaIntel("att:1", fileSignature(10, 1000))?.text).toBe("hi");
    // Different signature → miss (file changed under us).
    expect(lookupMediaIntel("att:1", fileSignature(20, 2000))).toBeNull();
  });

  it("countCachedDone counts only successful rows; delete evicts", () => {
    const sig = fileSignature(1, 1);
    storeMediaIntel({
      key: "a",
      kind: "image",
      status: "done",
      text: "x",
      extra: null,
      source: "provider:p",
      model: "m",
      fileSig: sig,
      durMs: 1,
      error: null,
      createdAt: 1,
    });
    storeMediaIntel({
      key: "b",
      kind: "image",
      status: "failed",
      text: null,
      extra: null,
      source: "provider:p",
      model: null,
      fileSig: sig,
      durMs: 1,
      error: "e",
      createdAt: 1,
    });
    expect(countCachedDone(["a", "b", "c"])).toBe(1);
    deleteMediaIntel("a");
    expect(countCachedDone(["a", "b"])).toBe(0);
  });
});

// ── Service ──────────────────────────────────────────────────────────────
function audioRef(dir: string, key = "att:1"): AttachmentRef {
  const path = join(dir, "vm.m4a");
  writeFileSync(path, "fake-audio-bytes");
  return { key, path, mime: "audio/m4a", filename: "vm.m4a", kind: "audio" };
}

function cfg(over: Partial<InterpretConfig> = {}): InterpretConfig {
  return {
    auto: "all",
    chains: { audio: ["apple", "local", "provider:p"], image: ["provider:p"], video: [] },
    providers: [{ name: "p", preset: "openai", apiKey: "sk" }],
    ...over,
  };
}

describe("MediaIntelService", () => {
  beforeEach(() => {
    _setMediaIntelCachePathForTests(join(tmp(), "svc-cache.db"));
  });

  it("prefers the apple link when a synced transcript is present", async () => {
    const dir = tmp();
    const ref = { ...audioRef(dir), appleTranscript: "apple words" };
    const svc = new MediaIntelService(cfg(), {
      transcribeLocal: () => "local words",
      fetchImpl: (async () => new Response("cloud", { status: 200 })) as any,
    });
    const r = await svc.interpret(ref);
    expect(r.text).toBe("apple words");
    expect(r.source).toBe("apple");
  });

  it("falls through apple → local when no synced transcript", async () => {
    const dir = tmp();
    const svc = new MediaIntelService(cfg(), { transcribeLocal: () => "local words" });
    const r = await svc.interpret(audioRef(dir));
    expect(r.text).toBe("local words");
    expect(r.source).toBe("local");
  });

  it("falls through to the provider when apple + local miss", async () => {
    const dir = tmp();
    let calls = 0;
    const svc = new MediaIntelService(cfg(), {
      transcribeLocal: () => null,
      fetchImpl: (async () => {
        calls++;
        return new Response("cloud transcript", { status: 200 });
      }) as any,
    });
    const r = await svc.interpret(audioRef(dir));
    expect(r.text).toBe("cloud transcript");
    expect(r.source).toBe("provider:p");
    expect(calls).toBe(1);
  });

  it("never interprets the same file twice (cache hit)", async () => {
    const dir = tmp();
    let calls = 0;
    const deps = {
      transcribeLocal: () => null,
      fetchImpl: (async () => {
        calls++;
        return new Response("once", { status: 200 });
      }) as any,
    };
    const ref = audioRef(dir);
    const first = await new MediaIntelService(cfg(), deps).interpret(ref);
    expect(first.cached).toBe(false);
    const second = await new MediaIntelService(cfg(), deps).interpret(ref);
    expect(second.cached).toBe(true);
    expect(second.text).toBe("once");
    expect(calls).toBe(1);
  });

  it("auto=free blocks the paid provider link", async () => {
    const dir = tmp();
    let calls = 0;
    const svc = new MediaIntelService(cfg({ auto: "free" }), {
      transcribeLocal: () => null,
      fetchImpl: (async () => {
        calls++;
        return new Response("cloud", { status: 200 });
      }) as any,
    });
    const r = await svc.interpret(audioRef(dir));
    expect(r.status).toBe("skipped");
    expect(calls).toBe(0);
  });

  it("auto=off skips unless forced; force runs the chain", async () => {
    const dir = tmp();
    const svc = new MediaIntelService(cfg({ auto: "off" }), { transcribeLocal: () => "words" });
    expect((await svc.interpret(audioRef(dir, "k1"))).status).toBe("skipped");
    const forced = await svc.interpret(audioRef(dir, "k2"), { force: true });
    expect(forced.text).toBe("words");
  });

  it("countUncachedCloud counts audio refs that need a paid call", async () => {
    const dir = tmp();
    // audio chain has apple+local (free) → no paid call needed.
    const svc = new MediaIntelService(
      cfg({ chains: { audio: ["apple", "local"], image: ["provider:p"], video: [] } }),
    );
    expect(svc.countUncachedCloud([audioRef(dir)])).toBe(0);
    // provider-only audio chain → paid call needed.
    const svc2 = new MediaIntelService(
      cfg({ chains: { audio: ["provider:p"], image: [], video: [] } }),
    );
    expect(svc2.countUncachedCloud([audioRef(dir)])).toBe(1);
  });

  it("de-dupes concurrent calls for the same key", async () => {
    const dir = tmp();
    let calls = 0;
    const svc = new MediaIntelService(cfg(), {
      transcribeLocal: () => null,
      fetchImpl: (async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return new Response("dedupe", { status: 200 });
      }) as any,
    });
    const ref = audioRef(dir);
    const [a, b] = await Promise.all([svc.interpret(ref), svc.interpret(ref)]);
    expect(a.text).toBe("dedupe");
    expect(b.text).toBe("dedupe");
    expect(calls).toBe(1);
  });
});

describe("MediaIntelService.peek (cache-only / instant, never runs the chain)", () => {
  beforeEach(() => {
    _setMediaIntelCachePathForTests(join(tmp(), "peek-cache.db"));
  });

  it("returns the instant Apple transcript without touching the network or a transcriber", () => {
    const dir = tmp();
    const ref = { ...audioRef(dir), appleTranscript: "hey what's up" };
    let localCalls = 0;
    let fetchCalls = 0;
    const svc = new MediaIntelService(cfg(), {
      transcribeLocal: () => {
        localCalls++;
        return "should not run";
      },
      fetchImpl: (async () => {
        fetchCalls++;
        return new Response("nope", { status: 200 });
      }) as any,
    });
    const r = svc.peek(ref);
    expect(r?.text).toBe("hey what's up");
    expect(r?.source).toBe("apple");
    expect(localCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it("returns a previously-cached result and null when nothing is cached", async () => {
    const dir = tmp();
    const ref = audioRef(dir); // no apple transcript
    const svc = new MediaIntelService(cfg(), { transcribeLocal: () => "cached words" });
    // Nothing cached yet, no apple transcript → miss.
    expect(svc.peek(ref)).toBeNull();
    // Interpret once to populate the cache, then peek hits it (cached: true).
    await svc.interpret(ref);
    const r = svc.peek(ref);
    expect(r?.text).toBe("cached words");
    expect(r?.cached).toBe(true);
  });

  it("does not surface a cached FAILURE (only done results inline)", async () => {
    const dir = tmp();
    const ref = audioRef(dir);
    // Everything misses → interpret records a `failed` row.
    const svc = new MediaIntelService(cfg({ chains: { audio: ["local"], image: [], video: [] } }), {
      transcribeLocal: () => null,
    });
    await svc.interpret(ref);
    expect(svc.peek(ref)).toBeNull();
  });
});
