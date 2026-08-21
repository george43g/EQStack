// Operation context — the dependency bundle handed to every registry op.
//
// Replaces the closure capture pattern in the old monolithic dispatcher
// (gmail / oauth2Client / signal / authorizedScopes were all reached via
// `main()`'s lexical scope). With ops as standalone functions, every dep
// becomes an explicit field on this object.

import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import { getAuthorizedScopes, getGmail, getOAuth2Client } from "./session.js";

export interface OperationContext {
  gmail: gmail_v1.Gmail;
  oauth2Client: OAuth2Client;
  authorizedScopes: string[];
  signal?: AbortSignal;
  /** Tool name; mainly for log correlation inside the handler. */
  toolName: string;
}

/**
 * Build an OperationContext from the current session + a per-request signal.
 * Throws if the session hasn't been initialised (call setSession first).
 */
export function createContext(opts: { toolName: string; signal?: AbortSignal }): OperationContext {
  return {
    gmail: getGmail(),
    oauth2Client: getOAuth2Client(),
    authorizedScopes: getAuthorizedScopes(),
    signal: opts.signal,
    toolName: opts.toolName,
  };
}
