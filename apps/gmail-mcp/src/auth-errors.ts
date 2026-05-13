import type { OAuth2Client } from "google-auth-library";
import { error as logError, info as logInfo } from "./robustness/index.js";

/**
 * Detects Gmail / OAuth auth failures, attempts a single token refresh on
 * `invalid_grant` (in case the access_token expired and the refresh_token is
 * still valid), and returns an MCP-friendly error response with a remediation
 * hint pointing the user at `npm run auth`.
 *
 * Refresh is attempted at most once per server lifetime per tool call. When
 * google-auth-library is configured correctly it usually refreshes
 * transparently; this is the belt-and-braces path for cases where the
 * automatic refresh has not happened yet.
 */

let refreshAttempted = false;

export interface MCPErrorResponse {
  isError: true;
  content: { type: "text"; text: string }[];
}

export function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: string; code?: number | string; status?: number };
  const msg = (e.message ?? "").toLowerCase();
  if (msg.includes("invalid_grant") || msg.includes("invalid grant")) return true;
  if (msg.includes("invalid credentials")) return true;
  if (e.code === 401 || e.status === 401) return true;
  if (e.code === 403 || e.status === 403) return true;
  if (msg.includes("unauthorized")) return true;
  return false;
}

function isInvalidGrant(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = ((err as { message?: string }).message ?? "").toLowerCase();
  return msg.includes("invalid_grant") || msg.includes("invalid grant");
}

/**
 * Try a single one-shot refresh against the OAuth client. Returns true if the
 * refresh produced a new access_token. Caller should still surface an error to
 * the MCP host — the next tool call will succeed against the refreshed token.
 */
async function tryRefreshOnce(client: OAuth2Client | null): Promise<boolean> {
  if (!client || refreshAttempted) return false;
  refreshAttempted = true;
  try {
    const result = await client.getAccessToken();
    if (result?.token) {
      logInfo("oauth_refresh_attempt", { success: true });
      return true;
    }
  } catch (e) {
    logError("oauth_refresh_attempt", {
      success: false,
      message: (e as Error)?.message,
    });
  }
  return false;
}

/**
 * Wrap an arbitrary error from a tool dispatch into an MCP error response.
 * - Auth errors get tool context + remediation hint.
 * - Other errors get tool context.
 */
export async function wrapToolError(
  err: unknown,
  toolName: string,
  oauth2Client: OAuth2Client | null,
): Promise<MCPErrorResponse> {
  const message = (err instanceof Error ? err.message : String(err)) || "unknown error";

  if (isAuthError(err)) {
    let refreshed = false;
    if (isInvalidGrant(err)) {
      refreshed = await tryRefreshOnce(oauth2Client);
    }
    const hint = refreshed
      ? "auth token was refreshed — retry the call"
      : "re-authenticate with `npm run auth`";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `${toolName} failed: ${message} — ${hint}`,
        },
      ],
    };
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${toolName} failed: ${message}`,
      },
    ],
  };
}

/**
 * Test-only: reset the one-shot refresh latch.
 * @internal
 */
export function _resetForTests(): void {
  refreshAttempted = false;
}
