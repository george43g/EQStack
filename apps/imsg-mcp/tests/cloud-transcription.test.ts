/**
 * Opt-in cloud transcription escape-hatch.
 *
 * Local on-device transcription (hear/yap/whisper-cli) is always the default;
 * the cloud path is reached only when explicitly configured via
 * IMSG_TRANSCRIBE_PROVIDER + IMSG_TRANSCRIBE_API_KEY and no local transcriber
 * produced text. These tests exercise the config resolver and the OpenAI-
 * compatible HTTP call with an INJECTED fetch — no network, no real provider.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTranscribeCloudConfig } from "../src/config.js";
import { transcribeAudioBest, transcribeAudioCloud } from "../src/media.js";

const ENV_KEYS = [
  "IMSG_TRANSCRIBE_PROVIDER",
  "IMSG_TRANSCRIBE_API_KEY",
  "IMSG_TRANSCRIBE_MODEL",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function tempAudio(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-tx-"));
  const path = join(dir, "memo.m4a");
  writeFileSync(path, Buffer.from([0, 1, 2, 3, 4])); // not real audio — never transcribes locally
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const cfg = { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "whisper-1" };

describe("getTranscribeCloudConfig", () => {
  it("returns null unless BOTH provider and api key are set", () => {
    expect(getTranscribeCloudConfig()).toBeNull();
    process.env.IMSG_TRANSCRIBE_PROVIDER = "openai";
    expect(getTranscribeCloudConfig()).toBeNull();
    process.env.IMSG_TRANSCRIBE_API_KEY = "sk-x";
    expect(getTranscribeCloudConfig()).not.toBeNull();
  });

  it("resolves known aliases, raw URLs, trailing slash, and model default/override", () => {
    process.env.IMSG_TRANSCRIBE_API_KEY = "sk-x";

    process.env.IMSG_TRANSCRIBE_PROVIDER = "openai";
    expect(getTranscribeCloudConfig()).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
    });

    process.env.IMSG_TRANSCRIBE_PROVIDER = "groq";
    expect(getTranscribeCloudConfig()?.baseUrl).toBe("https://api.groq.com/openai/v1");

    process.env.IMSG_TRANSCRIBE_PROVIDER = "https://my.host/openai/v1/";
    expect(getTranscribeCloudConfig()?.baseUrl).toBe("https://my.host/openai/v1"); // trailing slash stripped

    process.env.IMSG_TRANSCRIBE_MODEL = "whisper-large-v3";
    expect(getTranscribeCloudConfig()?.model).toBe("whisper-large-v3");
  });
});

describe("transcribeAudioCloud", () => {
  it("POSTs multipart to {baseUrl}/audio/transcriptions with a bearer token and returns the text", async () => {
    const { path, cleanup } = tempAudio();
    try {
      const fetchImpl = vi.fn(
        async () => new Response("  hello from the cloud  ", { status: 200 }),
      );
      const out = await transcribeAudioCloud(path, cfg, { fetchImpl: fetchImpl as never });
      expect(out).toBe("hello from the cloud"); // trimmed

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.example.com/v1/audio/transcriptions");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(form.get("model")).toBe("whisper-1");
      expect(form.get("file")).toBeInstanceOf(Blob);
    } finally {
      cleanup();
    }
  });

  it("returns null on a non-2xx response", async () => {
    const { path, cleanup } = tempAudio();
    try {
      const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
      expect(await transcribeAudioCloud(path, cfg, { fetchImpl: fetchImpl as never })).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("returns null when fetch throws (network error / abort)", async () => {
    const { path, cleanup } = tempAudio();
    try {
      const fetchImpl = vi.fn(async () => {
        throw new Error("network down");
      });
      expect(await transcribeAudioCloud(path, cfg, { fetchImpl: fetchImpl as never })).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("returns null (without calling fetch) when the file does not exist", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { status: 200 }));
    expect(
      await transcribeAudioCloud("/no/such/file.m4a", cfg, { fetchImpl: fetchImpl as never }),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("transcribeAudioBest", () => {
  it("falls back to cloud (source=cloud) when configured and local yields nothing", async () => {
    const { path, cleanup } = tempAudio();
    try {
      // The fake 5-byte file cannot be transcribed by any local transcriber, so
      // the local path returns null and the injected cloud config is used.
      const fetchImpl = vi.fn(async () => new Response("cloud transcript", { status: 200 }));
      const result = await transcribeAudioBest(path, {
        cloudConfig: cfg,
        fetchImpl: fetchImpl as never,
      });
      expect(result).toEqual({ transcript: "cloud transcript", source: "cloud" });
    } finally {
      cleanup();
    }
  });

  it("returns null when cloud is explicitly disabled and local yields nothing", async () => {
    const { path, cleanup } = tempAudio();
    try {
      expect(await transcribeAudioBest(path, { cloudConfig: null })).toBeNull();
    } finally {
      cleanup();
    }
  });
});
