import { error as logError, info as logInfo } from "@george43g/robustness";
import type { OAuth2Client } from "google-auth-library";
import { getCurrentAccountId } from "./core/session.js";

/**
 * Detects Gmail / OAuth auth failures, attempts a single token refresh on
 * `invalid_grant` (in case the access_token expired and the refresh_token is
 * still valid), and returns an MCP-friendly error response with a remediation
 * hint pointing the user at `gmail account auth`.
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

/**
 * Detects Gmail API 404s, which arrive as either `err.code === 404`,
 * `err.status === 404`, or `err.errors?.[0]?.reason === "notFound"`. Used to
 * rewrap "entity not found" with the active account id so callers (humans
 * and sub-agents) can self-diagnose IDs pasted from the wrong mailbox.
 */
export function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: number | string;
    status?: number;
    message?: string;
    errors?: Array<{ reason?: string }>;
  };
  if (e.code === 404 || e.status === 404) return true;
  if (typeof e.code === "string" && e.code === "404") return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => x?.reason === "notFound")) return true;
  // googleapis surfaces a bare "Not Found" message for some operations.
  const msg = (e.message ?? "").toLowerCase();
  if (msg === "not found" || msg.startsWith("not found")) return true;
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
    const hint = refreshed ? "auth token was refreshed — retry the call" : formatReauthHint();
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

  // 404s are particularly confusing without account context: a message or
  // thread id valid in account A returns bare "Not Found" when the active
  // session is on account B. Surface the active account so the user (or a
  // sub-agent) knows where the lookup was scoped and how to switch. For
  // thread-specific tools we also flag the common messageId-vs-threadId
  // mix-up — `read_email` returns a `threadId` field that callers should
  // use here.
  if (isNotFoundError(err)) {
    const accountId = getCurrentAccountId();
    const scope = accountId ? `account "${accountId}"` : "the active account";
    const isThreadOp = toolName === "get_thread" || toolName === "modify_thread";
    let hint: string;
    if (!accountId) {
      hint = "no active account is configured — run `gmail account auth <id>` to set one up";
    } else if (isThreadOp) {
      hint =
        "verify the id is a threadId, not a messageId (use `read <id>` to fetch its `threadId` field). If the id is correct, it may belong to a different mailbox — `accounts` + `sw <id>` to switch.";
    } else {
      hint =
        "list accounts with `accounts` and switch with `sw <id>` if the id belongs to a different mailbox";
    }
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `${toolName} failed: no such message/thread in ${scope} — ${hint}`,
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

function formatReauthHint(): string {
  const accountId = getCurrentAccountId();
  return accountId
    ? `re-authenticate with \`gmail account auth ${accountId}\``
    : "re-authenticate with `gmail account auth <id>`";
}

/**
 * Test-only: reset the one-shot refresh latch.
 * @internal
 */
export function _resetForTests(): void {
  refreshAttempted = false;
}
