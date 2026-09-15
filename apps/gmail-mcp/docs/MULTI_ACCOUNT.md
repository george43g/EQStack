# Multi-account layout — gmail-mcp

> Moved out of `apps/gmail-mcp/AGENTS.md` on 2026-09-15 so that guide fits Codex's instruction cap
> (`project_doc_max_bytes`, 32,768 bytes across the root-to-app chain). Content is unchanged except that
> relative link targets gained `../`. The guide keeps the must-hold rules and links here.

## Multi-account layout

`<configDir>/accounts.json` is the manifest, and `<configDir>/accounts/<id>/credentials.json` is the per-account token file. Implementation in `src/core/accounts.ts`. The active account is resolved at bootstrap (in `src/index.ts::loadCredentials`) and passed to both `loadOAuthKeys({accountId})` and `coreLoadCredentials({accountId})`.

**Active-account precedence (first hit wins, in `resolveActiveAccount`):**
1. `-a, --account <id>` global CLI flag (stamped into `process.env.GMAIL_ACCOUNT` by the root commander preAction hook).
2. `GMAIL_ACCOUNT` env var.
3. `accounts.json` `defaultAccount`.
4. Sole account in `accounts.json`, if there's exactly one.
5. Legacy-implicit `"default"` — only when no manifest exists AND a legacy `<configDir>/credentials.json` exists AND no env-driven credential source is configured. Triggers the M1 migration shim (copy, not move) on first read.
6. `null` — no account configured.

**File layout (after migration):**

```
<configDir>/
├── accounts.json                       # manifest: {defaultAccount, accounts: {…}}
├── gcp-oauth.keys.json                 # shared OAuth client keys (fallback)
├── credentials.json                    # legacy file, kept for one minor release
└── accounts/
    ├── default/credentials.json        # promoted from legacy file on first read
    ├── work/credentials.json
    └── personal/
        ├── credentials.json
        └── gcp-oauth.keys.json         # per-account OAuth keys override (optional)
```

**OAuth keys resolution** (in `loadOAuthKeys` when `accountId` is supplied):
1. `GMAIL_OAUTH_KEYS_JSON` env (always wins).
2. `<configDir>/accounts/<id>/gcp-oauth.keys.json` — per-account override, if present.
3. `GMAIL_OAUTH_PATH` env / `<configDir>/gcp-oauth.keys.json` — the shared file.
4. Error.

**Migration trigger:** the first `loadCredentials({accountId: "default"})` call where `accounts/default/credentials.json` is missing but `<configDir>/credentials.json` exists copies the legacy file and stamps the manifest with a single `default` entry. Idempotent; no-op once the new file is in place. The legacy file is intentionally not deleted — a downgrade still works.

**Env-driven mode is single-account by design.** `GMAIL_CREDENTIALS_JSON` / `GMAIL_CREDENTIALS_OP` always win over the file loader regardless of `accountId`. If you set them alongside `GMAIL_ACCOUNT`, the credentials still come from env; the account id is used only for the OAuth-keys override fallback and for log tagging. Pure-env multi-account would require per-account env vars (`GMAIL_CREDENTIALS_<ID>_JSON`) and is deferred to Phase M3.

**Subcommands:** `gmail account` opens the Inquirer CRUD manager in a TTY. Scriptable commands are `gmail account {auth [id], list, current, use <id>, rm <id>, check [id|--all], rename <old> <new>}`. `auth` creates or re-authenticates an account; `check` caches non-secret auth-health metadata in the manifest; `rm` deletes both the manifest entry and (unless `--keep-files`) the on-disk directory.

**MCP tools (M2-light):** Two meta-tools expose the same surface to MCP hosts, split for permission-gating:

- `list_accounts` — read-only. Returns `{active: {id, source, isLegacyImplicit}, count, accounts: [{id, emailAddress, scopes, isDefault, isActive, createdAt}]}`. No Gmail API call; `readOnlyHint: true`. Annotated so hosts allow it freely.
- `switch_account` — write/state-change. Input `{accountId}`. Validates the id exists in the manifest, loads its OAuth keys + credentials, builds a fresh `OAuth2Client` + `gmail` handle, and calls `setSession()` to swap atomically. Returns `{previousAccountId, newAccountId, emailAddress, scopes, note}`. Idempotent when switching to the already-active id. Annotated `destructiveHint: false, idempotentHint: false` so hosts can permission-gate it as a write.

Both tools live in `src/core/ops/accounts.ts` and require no Gmail scope (`scopes: []`). The session module (`src/core/session.ts`) tracks `_currentAccountId` and exposes `getCurrentAccountId()` for the list output's `isActive` flag.

**Caveat — stale tool catalog after switch:** the host's cached `tools/list` does NOT auto-refresh when the active account changes. If the new account has narrower scopes than the previous one, affected tools will reject at call-time with the usual re-auth hint. The `switch_account` response includes a `note` field documenting this. Sending `notifications/tools/list_changed` after the swap is a Phase M2-full polish item; deferred.

**Non-goals (current multi-account model):**
- No simultaneous per-request multi-account fan-out. A process has one active account at a time.
- No per-tool `account` argument on Gmail tools (deferred to a future multi-account request model).
- Hosts that want two accounts available without a stateful `switch_account` call should run two `gmail mcp` processes with different `GMAIL_ACCOUNT` envs.
