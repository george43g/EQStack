import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptRecording, EncryptedRecordingStore, encryptRecording } from "./recording-store.js";

describe("recording encryption", () => {
  const key = randomBytes(32);

  it("round-trips AES-256-GCM with the VMC1 header", () => {
    const plain = Buffer.from("RIFF pretend this is dual-channel wav audio");
    const enc = encryptRecording(key, plain);
    expect(enc.subarray(0, 4).toString()).toBe("VMC1");
    expect(decryptRecording(key, enc).equals(plain)).toBe(true);
  });

  it("rejects tampered ciphertext (GCM auth)", () => {
    const enc = encryptRecording(key, Buffer.from("audio"));
    enc[enc.length - 1] = (enc[enc.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptRecording(key, enc)).toThrow();
  });

  it("rejects the wrong key", () => {
    const enc = encryptRecording(key, Buffer.from("audio"));
    expect(() => decryptRecording(randomBytes(32), enc)).toThrow();
  });

  it("rejects files without the header", () => {
    expect(() =>
      decryptRecording(key, Buffer.from("junkjunkjunkjunkjunkjunkjunkjunkjunk")),
    ).toThrow(/bad header/);
  });
});

describe("EncryptedRecordingStore", () => {
  let dir: string;
  const key = randomBytes(32);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "voice-mcp-rec-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeStore(): EncryptedRecordingStore {
    return new EncryptedRecordingStore(dir, async () => key);
  }

  it("stores ciphertext (never plaintext) with 0600 perms and loads it back", async () => {
    const store = makeStore();
    const plain = Buffer.from("secret audio bytes");
    const { path, sizeBytes } = await store.store("RE123", plain);
    const onDisk = readFileSync(path);
    expect(onDisk.length).toBe(sizeBytes);
    expect(onDisk.includes(plain)).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Buffer.from(await store.load("RE123")).equals(plain)).toBe(true);
  });

  it("deleteLocal removes the file and reports absence", async () => {
    const store = makeStore();
    await store.store("RE9", Buffer.from("x"));
    expect(store.hasLocal("RE9")).toBe(true);
    expect(await store.deleteLocal("RE9")).toBe(true);
    expect(store.hasLocal("RE9")).toBe(false);
    expect(await store.deleteLocal("RE9")).toBe(false);
  });

  it("refuses path-traversal-shaped recording ids", async () => {
    const store = makeStore();
    await expect(store.store("../evil", Buffer.from("x"))).rejects.toThrow(/invalid/);
  });
});
