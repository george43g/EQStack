/**
 * Encrypted recording storage.
 *
 * File format: "VMC1" magic (4) | IV (12) | GCM tag (16) | ciphertext.
 * Key: 32 random bytes held in the macOS Keychain (service "voice-mcp" — FROZEN legacy
 * identifier, see INV-13 / D-24: renaming it strands every existing recording;
 * account "recording-key", hex-encoded), created on first use. Tests inject
 * a key provider instead. Recordings are retained until explicit deletion.
 */
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecordingStore } from "../domain/ports.js";

const MAGIC = Buffer.from("VMC1");
const KEYCHAIN_SERVICE = "voice-mcp";
const KEYCHAIN_ACCOUNT = "recording-key";

export type KeyProvider = () => Promise<Buffer>;

function execFileP(file: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });
}

/** Fetch-or-create the AES key in the login keychain. macOS only. */
export const keychainKeyProvider: KeyProvider = async () => {
  if (process.platform !== "darwin") {
    throw new Error("recording encryption key requires the macOS Keychain (or an injected key)");
  }
  try {
    const { stdout } = await execFileP("/usr/bin/security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ]);
    const hex = stdout.trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    throw new Error("keychain item exists but is not a 32-byte hex key");
  } catch (err) {
    if ((err as Error).message.includes("not a 32-byte")) throw err;
    const key = randomBytes(32);
    await execFileP("/usr/bin/security", [
      "add-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
      key.toString("hex"),
    ]);
    return key;
  }
};

export function encryptRecording(key: Buffer, plain: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptRecording(key: Buffer, file: Buffer): Buffer {
  if (file.length < 4 + 12 + 16 || !file.subarray(0, 4).equals(MAGIC)) {
    throw new Error("not a telephony-mcp encrypted recording (bad header)");
  }
  const iv = file.subarray(4, 16);
  const tag = file.subarray(16, 32);
  const ciphertext = file.subarray(32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export class EncryptedRecordingStore implements RecordingStore {
  private key: Buffer | null = null;

  constructor(
    private dir: string,
    private keyProvider: KeyProvider = keychainKeyProvider,
  ) {}

  private async getKey(): Promise<Buffer> {
    if (!this.key) this.key = await this.keyProvider();
    return this.key;
  }

  private pathFor(providerRecordingId: string): string {
    if (!/^[A-Za-z0-9]+$/.test(providerRecordingId)) {
      throw new Error("invalid recording id");
    }
    return join(this.dir, `${providerRecordingId}.enc`);
  }

  async store(
    providerRecordingId: string,
    plain: Uint8Array,
  ): Promise<{ path: string; sizeBytes: number }> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const key = await this.getKey();
    const encrypted = encryptRecording(key, plain);
    const path = this.pathFor(providerRecordingId);
    writeFileSync(path, encrypted, { mode: 0o600 });
    return { path, sizeBytes: encrypted.length };
  }

  async load(providerRecordingId: string): Promise<Uint8Array> {
    const key = await this.getKey();
    const file = readFileSync(this.pathFor(providerRecordingId));
    return decryptRecording(key, file);
  }

  async deleteLocal(providerRecordingId: string): Promise<boolean> {
    const path = this.pathFor(providerRecordingId);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  hasLocal(providerRecordingId: string): boolean {
    return existsSync(this.pathFor(providerRecordingId));
  }
}
