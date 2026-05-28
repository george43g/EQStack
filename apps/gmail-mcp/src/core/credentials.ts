// Credential loader chain for Gmail-MCP-Server.
//
// Resolution order (first hit wins):
//   1. GMAIL_CREDENTIALS_JSON env var  — raw JSON string of {tokens, scopes}.
//      Designed for CI secrets (GitHub Actions, GitLab, k8s) and Docker.
//   2. GMAIL_CREDENTIALS_OP env var    — 1Password secret reference like
//      "op://Personal/gmail-mcp/credentials". Shells out to `op read`. The
//      `op` CLI must be installed and authenticated (Touch ID via the
//      desktop app, or OP_SERVICE_ACCOUNT_TOKEN for headless).
//   3. GMAIL_CREDENTIALS_PATH file     — explicit override. Without it,
//      named accounts resolve ~/.gmail-mcp/accounts/<id>/credentials.json.
//
// Why three sources: a CLI tool that's used both interactively and from CI/
// remote servers needs flexibility. Personal Gmail OAuth tokens cannot be
// minted on a headless server (Google requires a browser-based flow), so the
// usual pattern is "auth on a laptop, transfer credentials to the remote".
// Env-var injection (1) and 1Password (2) both serve that pattern.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { addAccount, getAccountCredentialsPath, loadManifest } from "./accounts.js";
import { getCredentialsPath } from "./config-paths.js";

const execFileAsync = promisify(execFile);

export interface StoredCredentials {
  // Google OAuth tokens (whatever google-auth-library returns).
  // Kept untyped here because google-auth-library's Credentials type is
  // surface-area-heavy and we just round-trip the object.
  tokens: Record<string, unknown>;
  // Shorthand scope names like "gmail.modify". May be missing on legacy creds.
  scopes?: string[];
}

export type CredentialSource = "env-json" | "1password" | "file";

export interface LoadedCredentials {
  credentials: StoredCredentials;
  source: CredentialSource;
  // For "1password" / "file", the locator string (op:// URL or file path).
  locator?: string;
}

export class CredentialLoadError extends Error {
  source: CredentialSource;
  cause?: unknown;
  constructor(source: CredentialSource, message: string, cause?: unknown) {
    super(message);
    this.name = "CredentialLoadError";
    this.source = source;
    this.cause = cause;
  }
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Account id whose credentials to load. When supplied:
   *   - Env-driven sources (GMAIL_CREDENTIALS_JSON / _OP / _PATH) still take
   *     precedence and ignore the id (env mode is single-account by design).
   *   - File mode resolves <configDir>/accounts/<id>/credentials.json
   *     instead of the legacy <configDir>/credentials.json.
   *   - When id is "default" and the per-account file doesn't yet exist but
   *     the legacy file does, runs the M1 migration shim (copy + manifest).
   * When omitted: legacy single-account behaviour (back-compat for callers
   * that haven't been threaded through yet).
   */
  accountId?: string;
  // Override file path when GMAIL_CREDENTIALS_PATH isn't set.
  fallbackPath?: string;
  // Injectable for tests.
  readFile?: (p: string, enc: BufferEncoding) => string;
  fileExists?: (p: string) => boolean;
  runOp?: (ref: string) => Promise<string>;
}

const DEFAULT_RUN_OP = async (ref: string): Promise<string> => {
  // `op read` prints the field value to stdout. Caller picks an item that
  // contains the JSON blob as a multi-line text field.
  const { stdout } = await execFileAsync("op", ["read", ref], {
    // Don't inherit a huge env; pass only what `op` needs.
    env: {
      ...process.env,
    },
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

function parseStoredCredentials(raw: string, source: CredentialSource): StoredCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CredentialLoadError(
      source,
      `Failed to parse credentials JSON: ${(err as Error).message}`,
      err,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CredentialLoadError(source, "Credentials JSON must be an object");
  }
  // Support legacy shape {access_token, refresh_token, ...} (no `tokens` wrapper)
  // alongside the canonical {tokens, scopes} shape.
  const obj = parsed as Record<string, unknown>;
  if ("tokens" in obj && obj.tokens && typeof obj.tokens === "object") {
    return {
      tokens: obj.tokens as Record<string, unknown>,
      scopes: Array.isArray(obj.scopes) ? (obj.scopes as string[]) : undefined,
    };
  }
  // Legacy shape — treat the whole object as tokens.
  return { tokens: obj };
}

export async function loadCredentials(opts: LoadOptions = {}): Promise<LoadedCredentials> {
  const env = opts.env ?? process.env;
  const readFile = opts.readFile ?? ((p, e) => fs.readFileSync(p, e));
  const fileExists = opts.fileExists ?? ((p) => fs.existsSync(p));
  const runOp = opts.runOp ?? DEFAULT_RUN_OP;

  // 1. Env JSON
  const envJson = env.GMAIL_CREDENTIALS_JSON;
  if (envJson && envJson.trim().length > 0) {
    return {
      credentials: parseStoredCredentials(envJson, "env-json"),
      source: "env-json",
    };
  }

  // 2. 1Password
  const opRef = env.GMAIL_CREDENTIALS_OP;
  if (opRef && opRef.trim().length > 0) {
    if (!opRef.startsWith("op://")) {
      throw new CredentialLoadError(
        "1password",
        `GMAIL_CREDENTIALS_OP must be a 1Password secret reference (op://...), got: ${opRef}`,
      );
    }
    let out: string;
    try {
      out = await runOp(opRef);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new CredentialLoadError(
          "1password",
          "`op` CLI not found on PATH. Install 1Password CLI (https://developer.1password.com/docs/cli/) and run `op signin`.",
          err,
        );
      }
      throw new CredentialLoadError(
        "1password",
        `op read ${opRef} failed: ${(err as Error).message}`,
        err,
      );
    }
    return {
      credentials: parseStoredCredentials(out, "1password"),
      source: "1password",
      locator: opRef,
    };
  }

  // 3. File. Account-aware path resolution:
  //    - GMAIL_CREDENTIALS_PATH override always wins (operator opt-in).
  //    - Otherwise, if an accountId is supplied, resolve the per-account file
  //      (and run the migration shim from the legacy path if needed).
  //    - Otherwise, fall back to the legacy single-account file.
  let credPath: string | undefined = env.GMAIL_CREDENTIALS_PATH ?? opts.fallbackPath;
  if (!credPath) {
    if (opts.accountId) {
      credPath = getAccountCredentialsPath(opts.accountId, env);
      if (
        !fileExists(credPath) &&
        opts.accountId === "default" &&
        fileExists(getCredentialsPath(env))
      ) {
        // M1 migration: promote legacy <configDir>/credentials.json into
        // <configDir>/accounts/default/credentials.json. Copy (not move) so
        // that a downgrade to a single-account release still works.
        runDefaultAccountMigration(env, credPath);
      }
    } else {
      credPath = getCredentialsPath(env);
    }
  }
  if (!fileExists(credPath)) {
    throw new CredentialLoadError(
      "file",
      `Credentials file not found: ${credPath}. Run \`gmail account auth <id>\` to create it.`,
    );
  }
  const raw = readFile(credPath, "utf8");
  return {
    credentials: parseStoredCredentials(raw, "file"),
    source: "file",
    locator: credPath,
  };
}

/**
 * Copy <configDir>/credentials.json → <configDir>/accounts/default/credentials.json
 * and stamp a manifest entry for "default" if no manifest exists yet. Idempotent.
 * Errors here are non-fatal: if we can't migrate (permissions, race), fall
 * through and let the missing-file error surface a clear message.
 */
function runDefaultAccountMigration(env: NodeJS.ProcessEnv, targetPath: string): void {
  try {
    const legacyPath = getCredentialsPath(env);
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    }
    fs.copyFileSync(legacyPath, targetPath);
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(targetPath, 0o600);
      } catch {
        /* mode is best-effort on filesystems without POSIX semantics */
      }
    }
    if (!loadManifest({ env })) {
      addAccount("default", { createdAt: new Date().toISOString() }, env);
    }
  } catch {
    // Swallow migration errors; the subsequent fileExists check will throw
    // a clear "not found" error if we couldn't put the file in place.
  }
}
