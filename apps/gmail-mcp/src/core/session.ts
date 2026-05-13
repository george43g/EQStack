// Session state for the active Gmail MCP process.
//
// Holds the singletons that the dispatcher closure used to capture from
// `main()` scope. Centralising them here lets `src/index.ts` shrink to an
// orchestrator and makes the in-process callers (CLI, TUI, HTTP wrapper)
// consume the same state without each rebuilding it.
//
// Single-process / single-account by design. Phase G2 multi-tenant would
// need a per-tenant session map; out of scope here.

import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import { DEFAULT_SCOPES } from "../scopes.js";

let _oauth2Client: OAuth2Client | null = null;
let _gmail: gmail_v1.Gmail | null = null;
let _authorizedScopes: string[] = DEFAULT_SCOPES;

// Counters surfaced via health_check.
let _toolCallCount = 0;
const _recentErrorTs: number[] = [];
const ERROR_WINDOW_MS = 5 * 60_000;

export function setSession(opts: {
  oauth2Client: OAuth2Client;
  gmail: gmail_v1.Gmail;
  authorizedScopes?: string[];
}): void {
  _oauth2Client = opts.oauth2Client;
  _gmail = opts.gmail;
  if (opts.authorizedScopes) _authorizedScopes = opts.authorizedScopes;
}

export function setAuthorizedScopes(scopes: string[]): void {
  _authorizedScopes = scopes;
}

export function getOAuth2Client(): OAuth2Client {
  if (!_oauth2Client) {
    throw new Error("Session not initialised — call setSession() first (main()/bootstrap).");
  }
  return _oauth2Client;
}

export function getGmail(): gmail_v1.Gmail {
  if (!_gmail) {
    throw new Error("Session not initialised — call setSession() first (main()/bootstrap).");
  }
  return _gmail;
}

export function getAuthorizedScopes(): string[] {
  return _authorizedScopes;
}

export function isSessionReady(): boolean {
  return _oauth2Client !== null && _gmail !== null;
}

// --- Counters -----------------------------------------------------------

export function incrementToolCallCount(): void {
  _toolCallCount += 1;
}

export function getToolCallCount(): number {
  return _toolCallCount;
}

export function recordToolError(): void {
  _recentErrorTs.push(Date.now());
}

export function getRecentErrorCount(): number {
  const cutoff = Date.now() - ERROR_WINDOW_MS;
  while (_recentErrorTs.length > 0 && (_recentErrorTs[0] ?? 0) < cutoff) {
    _recentErrorTs.shift();
  }
  return _recentErrorTs.length;
}

/**
 * Reset all session state. Test-only — not exported from the barrel.
 * Lets per-test cleanup avoid bleed between cases.
 */
export function _resetForTests(): void {
  _oauth2Client = null;
  _gmail = null;
  _authorizedScopes = DEFAULT_SCOPES;
  _toolCallCount = 0;
  _recentErrorTs.length = 0;
}
