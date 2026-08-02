/**
 * Native bridge — tries to load the Rust native module for accelerated
 * SQLite queries and blob parsing. Falls back to the TypeScript implementation
 * if the native module is unavailable.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The native module accelerates exactly two things — attributedBody blob
 * parsing and Address Book contact resolution. Conversation/message listing,
 * cross-handle merge, and slugs live in the TypeScript `IMessageDB` (the single
 * source of truth); the engine label is "Rust parser + TS DB" to match.
 */
export interface NativeModule {
  parseAttributedBody(blob: Buffer): string | null;

  resolveContacts(
    contactsMainPath: string,
    contactsSourcesDir: string | null,
    handles: string[],
  ): Promise<Record<string, string>>;
}

let _native: NativeModule | null | undefined;

/**
 * Try to load the native module. Returns null if unavailable.
 * Result is cached after first attempt.
 *
 * Set `IMSG_DISABLE_NATIVE=1` to force the TypeScript fallback (useful for
 * testing the fallback path or comparing performance).
 */
export function tryLoadNative(): NativeModule | null {
  if (_native !== undefined) return _native;

  if (process.env.IMSG_DISABLE_NATIVE === "1") {
    _native = null;
    return null;
  }

  try {
    const require = createRequire(import.meta.url);
    // Try loading from the native/ directory relative to dist/
    const nativePath = join(__dirname, "..", "native", "index.js");
    _native = require(nativePath) as NativeModule;
    return _native;
  } catch {
    // Native module not available — fall back to TS
    _native = null;
    return null;
  }
}

/**
 * Check if the native module is available.
 */
export function hasNativeModule(): boolean {
  return tryLoadNative() !== null;
}
