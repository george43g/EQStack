/**
 * One-shot dedupe key (Phase C step 5, D-3b).
 *
 * HMAC-SHA256 with a per-install secret, NOT a bare digest: the E.164 space
 * is small enough to enumerate in seconds, so a plain hash persisted to
 * sqlite would be a phone number wearing a hat (INV-11). The install key is
 * 32 random bytes at <stateDir>/idempotency.key, mode 0600.
 *
 * An explicit idempotencyKey input overrides the derived one so a host can
 * retry safely across its own restarts.
 */
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function loadOrCreateInstallKey(stateDir: string): Buffer {
  const path = join(stateDir, "idempotency.key");
  if (existsSync(path)) return readFileSync(path);
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

export function deriveIdempotencyKey(
  installKey: Buffer,
  e164: string,
  objective: string,
  mode: string,
  profile: string,
): string {
  const h = createHmac("sha256", installKey);
  h.update(e164);
  h.update(Buffer.from([0]));
  h.update(objective);
  h.update(Buffer.from([0]));
  h.update(mode);
  h.update(Buffer.from([0]));
  h.update(profile);
  return h.digest("hex").slice(0, 32);
}
