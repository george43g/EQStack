# Multi-account access for Gmail-MCP-Server

## Current model (read-only summary)

- **Singleton session.** `src/core/session.ts` holds module-level `let` bindings for `_oauth2Client`, `_gmail`, and `_authorizedScopes`. `setSession()` is called exactly once from `main()` in `src/index.ts`. All counters (`_toolCallCount`, `_recentErrorTs`) are equally process-global.
- **Singleton credential resolution.** `loadCredentials()` (in `src/core/credentials.ts`) reads `GMAIL_CREDENTIALS_JSON` → `GMAIL_CREDENTIALS_OP` → file at `GMAIL_CREDENTIALS_PATH`, first hit wins. There is no "name" attached to the credentials — they're a flat `{tokens, scopes}` blob. Same for `loadOAuthKeys()` in `src/core/auth-flow.ts`.
- **Singleton config dir.** `getConfigDir()` returns either `GMAIL_CONFIG_DIR` (override) or `~/.gmail-mcp/`. Per-file overrides `GMAIL_OAUTH_PATH` / `GMAIL_CREDENTIALS_PATH` bypass it. Everything resolves to a single account's blob.
- **Context is read-once.** `createContext()` in `src/core/context.ts` snapshots the session getters into an `OperationContext` per dispatch. The `gmail`, `oauth2Client`, and `authorizedScopes` fields all come from the singletons.
- **HTTP transport is documented as single-tenant.** `src/server/http.ts` opens with the comment: "Single-tenant by design: one server process = one Gmail account." Bearer token is for transport ingress; it carries no account identity.
- **CLI bootstrap is process-global.** `bootstrapForCli()` in `src/cli/runtime.ts` is idempotent — first call calls `main({ skipTransport: true })` which calls `setSession()` once for the lifetime of the process. The REPL (`gmail console`) inherits the same singleton; there is no way today to switch accounts mid-session.

## Concept distinctions

We need to be precise — "multi-account" smashes together three operationally different things:

### (a) Multi-config switching (operator-time)
The operator chooses *which* account at process-start time via env or flag. Each `gmail` process is bound to one account. To use a different account, exit and re-launch with different env. **No in-flight account state.**

### (b) Runtime account switching (single active account, swappable)
A single long-lived process can switch its *one* active account between requests. E.g. inside `gmail console`, type `account use work`; subsequent commands hit the work account. Or a CLI side-effect command rewrites a tiny `active-account` pointer that future bootstraps pick up. **One active account at a time.**

### (c) Simultaneous multi-account (true multi-session)
A single process serves N accounts concurrently. The dispatcher must thread an `accountId` per request — either as an MCP tool argument (`{ account: "work", query: "..." }`) or as an HTTP request header. Each account gets its own OAuth client, token cache, rate-limit bucket, and scope set. **N active accounts at once.**

### Quick comparison

| Dimension | (a) Multi-config | (b) Runtime switch | (c) Simultaneous |
|---|---|---|---|
| Active accounts per process | 1 | 1 (swappable) | N |
| Token refresh races | none | rare (after `use`) | per-account locking required |
| Tool schema changes | none | none | every tool grows optional `account` |
| Wire-protocol changes (MCP) | none | none | new arg on every tool *or* per-host-config header |
| Scope display in `tools/list` | full single account | full single account | union or per-call filter |
| Audit/log tagging | optional | mandatory after switch | mandatory always |
| HTTP transport implications | mount-per-account | not useful | natural fit — per-request account |
| Implementation cost | small | medium | large |

## What already works today

A user with two Gmail accounts can run two `gmail mcp` processes side-by-side:

```jsonc
// .mcp.json — Claude Code host config
{
  "mcpServers": {
    "gmail-personal": {
      "command": "gmail",
      "args": ["mcp"],
      "env": { "GMAIL_CONFIG_DIR": "${HOME}/.gmail-mcp-personal" }
    },
    "gmail-work": {
      "command": "gmail",
      "args": ["mcp"],
      "env": { "GMAIL_CONFIG_DIR": "${HOME}/.gmail-mcp-work" }
    }
  }
}
```

Each process has its own config dir → its own `gcp-oauth.keys.json` + `credentials.json` → its own OAuth client. The model needs to address `mcp__gmail-personal__search_emails` vs `mcp__gmail-work__search_emails` — distinct tools to it. **This already works with zero code changes.** The only limitation: every Gmail tool gets duplicated in the host's tool catalogue, which means more tokens in the system prompt and more cognitive load for the model. Useful to call out: most hosts can disable tool namespaces they don't need per-session.

CLI users get the same trick via:
```sh
GMAIL_CONFIG_DIR=~/.gmail-mcp-work gmail search "in:inbox"
GMAIL_CONFIG_DIR=~/.gmail-mcp-personal gmail search "in:inbox"
```
or by sourcing different `.env.local` files in different shells. **Phase 0 = this works.** Document it.

## Architectural changes by concept

### Concept (a) — multi-config switching

**Modules touched.**
- `src/core/config-paths.ts` — add an `accountId` parameter to `getConfigDir()` / `getOAuthPath()` / `getCredentialsPath()`. New helper `resolveActiveAccount(env)` reads `GMAIL_ACCOUNT` env, falls back to `default-account` in `~/.gmail-mcp/accounts.json`, then to the literal string `"default"`.
- `src/cli/index.ts` — global `-a, --account <id>` option on the root command. Wire it into `bootstrapForCli()` via a module-scoped `setActiveAccount(id)` setter; honoured before any subcommand's action runs.
- `src/cli/commands/auth.ts` — accept `--account <id>`; write to `accounts/<id>/credentials.json` instead of the legacy top-level path. Continue to write top-level for `default` for back-compat.
- `src/index.ts` — `loadCredentials()` becomes account-aware. Pass through to `getCredentialsPath({ accountId })`.

**New data model.**
```ts
// New: src/core/accounts.ts
export interface AccountManifest {
  defaultAccount: string;                  // "default" | "work" | …
  accounts: Record<string, AccountEntry>;  // name → metadata
}
export interface AccountEntry {
  emailAddress?: string;                   // populated on first successful tools/list
  createdAt: string;                       // ISO
  scopes?: string[];                       // last-seen authorized scopes (mirror)
  // The real {tokens, scopes} blob lives at accounts/<id>/credentials.json.
}
```
The manifest is a single JSON file at `~/.gmail-mcp/accounts.json`. It's metadata only — actual tokens stay in per-account credential files (see Config Layout below).

**CLI surface.**
```sh
gmail account add work            # interactive auth → accounts/work/credentials.json
gmail account list                # prints manifest table (id, email, scopes, default?)
gmail account use work            # writes defaultAccount = "work" to accounts.json
gmail account rm work             # deletes accounts/work/ + manifest entry
gmail --account work search "..."  # one-shot, no default mutation
GMAIL_ACCOUNT=work gmail search "..."   # env equivalent of --account
```

**MCP wire.** No tool schema changes. Account selection is *operator-time* — set `GMAIL_ACCOUNT` in the host's `env: {}` block per MCP entry, or run separate processes per account (the Phase 0 pattern, but with cleaner config layout).

**Risks.**
- Stale state in `gmail console` if the user changes `defaultAccount` from a second shell while a console is running. The bootstrapped session is locked in. Acceptable — document it.
- `--account` global flag conflicts with subcommand options that already use `-a` (none today, but check on commit).
- `GMAIL_CONFIG_DIR` interacts with the per-account paths. Make rule: `GMAIL_CONFIG_DIR` is still the parent dir; account paths live under `<configDir>/accounts/<id>/`.

### Concept (b) — runtime account switching

Built on (a). Same on-disk layout. The new thing: a way to swap the singleton session *without restarting the process*.

**Modules touched.**
- `src/core/session.ts` — expose `swapSession(opts)` that performs the same mutations as `setSession()` but is callable mid-lifecycle. Add a session generation counter so cached `OperationContext` instances in flight can detect "you're stale, refuse." (Most ops snapshot at dispatch, so this is mostly belt-and-suspenders.)
- `src/cli/console.ts` — a new `:account use <id>` REPL command that calls a helper `useAccount(id)` which (i) loads credentials for the new id, (ii) builds a fresh `gmail` API handle, (iii) calls `swapSession`, (iv) prints "now using <email>".
- `src/cli/runtime.ts` — `bootstrapForCli()` learns an "ensure account is X" idempotency check.

**New data model.** Same as (a), plus an in-memory `currentAccountId: string` in `session.ts` for log tagging.

**CLI surface (additions).**
```sh
# inside `gmail console`:
> :account use work
[gmail-mcp] swapped to work (george.work@example.com), scopes=gmail.modify,gmail.labels
> i                                 # list inbox — uses work account now
> :account use personal
> s "from:mom"
```
Outside the console, plain `gmail --account work search …` still works — it's just process-scoped (a).

**MCP wire.** Two viable paths, neither pretty for vanilla hosts:
- A new tool: `account_use(input: { accountId: string })`. Dangerous — turns a previously read-only tool catalogue into stateful. Models may invoke it incorrectly. Recommend: ship it only if the host explicitly opts in via env (`GMAIL_EXPOSE_ACCOUNT_TOOL=1`).
- Don't expose to the model at all. Runtime switch stays a *human* affordance (REPL, CLI). MCP users live with (a).

**Risks.**
- Token refresh race: an in-flight Gmail call still holds the old `oauth2Client` reference while a new one is installed. Probably fine because each call's context snapshots at dispatch time; needs an explicit test.
- Counters (`_toolCallCount`, `_recentErrorTs`) currently lump all accounts. Decide: reset on swap (clean) or carry forward (continuity). Recommend carry-forward with `account` tag added to log entries.
- Watchdog / heap monitor are still process-global. Don't try to make them per-account.

### Concept (c) — simultaneous multi-account

The big one. Every dispatch carries an `accountId`; the dispatcher picks the right session bundle from a map.

**Modules touched.**
- `src/core/session.ts` — replace module-level singletons with a `Map<string, SessionEntry>`. Add `getSession(accountId) / hasSession(accountId) / addSession(accountId, opts) / removeSession(accountId)`. `setSession()` becomes a sugar for `addSession("default", …)`.
- `src/core/context.ts` — `createContext` grows an `accountId` parameter; `OperationContext.accountId: string` is now a required field. `gmail`/`oauth2Client`/`authorizedScopes` are resolved per-call.
- `src/server/build.ts` — the dispatcher must derive `accountId` from… *somewhere*. Three sources, ordered:
  1. MCP tool arg `args.account` (when the tool schema includes it).
  2. HTTP transport: an `X-Gmail-Account` header on the request. Plumb via the SDK's per-request context (the SDK provides an `extra` arg to handlers — check what's available there for stdio).
  3. Process default account.
- `src/tools.ts` — every tool's input schema gains an optional `account: z.string().optional()`. Decide if `account` defaults to the process default or fails closed. Recommend: defaults to process default; fails closed if multi-account mode is on and no default is set.
- `src/scopes.ts` / `hasScope` gating — `tools/list` filters by the *union* of all account scopes (so each tool can run on at least one account). Per-call scope check uses the resolved account's scopes.
- `src/server/http.ts` — adds an `X-Gmail-Account` request header that the dispatcher reads.

**New data model.**
```ts
// session.ts (post-refactor)
interface SessionEntry {
  accountId: string;
  emailAddress?: string;
  oauth2Client: OAuth2Client;
  gmail: gmail_v1.Gmail;
  authorizedScopes: string[];
  // Per-account rate-limit bucket + counters; shared watchdog/log is fine.
  toolCalls: number;
  recentErrorTs: number[];
  refreshLock?: Promise<void>;     // dedupe parallel token refreshes
}
const sessions = new Map<string, SessionEntry>();
let processDefaultAccount: string | null = null;
```
Each `SessionEntry` has its own `oauth2Client` — Google's library handles refresh per-client, so refreshes don't collide *between* accounts. They can still race *within* an account (two parallel calls trigger two refreshes). Add a `refreshLock` promise around `oauth2Client.getAccessToken()` to dedupe.

**CLI surface.** Same `gmail account {add,list,use,rm}` as (a). New: `gmail mcp --multi-account` flag at boot that pre-loads every account in the manifest into the session map. Without the flag the server runs in single-account mode and ignores the per-call arg.

**MCP wire.** Tool args grow `account?: string`. Example:
```jsonc
{ "name": "search_emails", "arguments": { "query": "in:inbox", "account": "work" } }
```

**Risks.**
- *Every* tool schema changes — 27 ops. Even with a shared schema mixin, this is a load-bearing surface change. Existing MCP host configs and prompts continue to work (the field is optional), but the published tool surface broadens.
- Scope display in `tools/list`: if account A has `gmail.modify` and account B is read-only, do we expose `send_email` or not? Options:
  - Union (expose if *any* account can run it; per-call check rejects).
  - Intersection (expose only if *all* can run it; very restrictive).
  - Account-aware advertise via tool name (`send_email__work`) — bad, that's just (a) re-implemented.
  - Recommend: union with clear per-call error when scope is missing for the resolved account.
- Token refresh races (handled by per-account `refreshLock`).
- Audit log must include `account` on every entry. Without it, debug grep is broken.
- HTTP per-request account header is trivially spoofable if the deployment forgets to gate the bearer token (or, worse, hands the same bearer to all accounts' callers). Document that the bearer authenticates the *transport*, not the *account*; if you need account-level auth, use one HTTP process per account.

## Config layout proposals

Picking between four file-layout options for the multi-account state. All assume `<configDir>` resolved per current rules (env → `~/.gmail-mcp/`).

| # | Layout | Pros | Cons |
|---|---|---|---|
| 1 | **Per-account directory.** `<configDir>/accounts/<id>/credentials.json` + `<configDir>/accounts/<id>/gcp-oauth.keys.json` + `<configDir>/accounts.json` manifest | Clean isolation; same `cwd-copy` convenience per-account works; rsync `accounts/work/` between machines is one rsync; matches Concept (c) memory layout 1:1; easy `gmail account rm <id>` is `rm -rf accounts/<id>/`. | Two-level hierarchy is more typing for power users who want to peek. Migration step required. |
| 2 | **Flat per-account file.** `<configDir>/<id>.json` containing `{tokens, scopes, oauthKeys}` rolled into one. | One file per account; less hierarchy. | OAuth keys are shared between accounts in most personal-use cases (one Google Cloud project, many gmail addresses). Embedding them per file duplicates them. Also conflates two different lifecycles (OAuth client keys vs access tokens). |
| 3 | **Postfix-suffix file.** `<configDir>/credentials.<id>.json`, default is `credentials.json` (unchanged). | Smallest diff from today; existing `credentials.json` keeps working as `default`. | Doesn't scale visually past 3-4 accounts; OAuth keys path stays single; manifest still needed separately. |
| 4 | **Manifest-only.** `<configDir>/accounts.json` carries `{[id]: {tokens, scopes, oauthKeys}}` inline. | Single file; trivial to back up. | Per-account file permissions impossible (one file, one chmod); concurrent writes during `gmail account add` race; not friendly to env-driven mounting where one secret-store entry maps to one account. |

**Recommendation: Layout 1 (per-account directory).** Best mapping to memory layout, cleanest migration, cleanest deletes, no shared-write races. Migration: on first run after upgrade, if `<configDir>/credentials.json` exists and `<configDir>/accounts/default/credentials.json` does not, copy (don't move) the former to the latter and write `accounts.json` with `{ defaultAccount: "default", accounts: { default: { createdAt: <now> } } }`. Leave the legacy file in place for at least one minor release so a downgrade still works.

## Env-var conventions

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **A. Single-account env (status quo extended).** `GMAIL_CREDENTIALS_JSON` always picks the "default" account; per-file mode picks per-account via filesystem layout. | No env explosion. Backward compatible. | No way to env-inject all accounts at once — operator must use file mode for multi-account. Acceptable in 99% of cases. |
| **B. Prefixed env-per-account.** `GMAIL_CREDENTIALS_WORK_JSON`, `GMAIL_CREDENTIALS_PERSONAL_JSON`, plus `GMAIL_ACCOUNT=work` selects active. | Pure-env multi-account possible. Friendly to bash + `.env.local`. | Account IDs must be env-safe (uppercase, no `@`). Awkward when the user wants `work@example.com` as the ID. Needs sanitiser. |
| **C. Single combined env.** `GMAIL_ACCOUNTS_JSON='{"work":{tokens,scopes},"personal":{tokens,scopes}}'`. | One env, all accounts. Good for k8s/Docker. | Large blob; harder to rotate one account's tokens. Doesn't match `GMAIL_CREDENTIALS_OP` (1Password) which assumes one item per ref. |

**Recommendation: hybrid (A) + (B), in that order.**
- Phase M1: extend (A) only. Multi-config users use file mode + `GMAIL_ACCOUNT` selector + multi-account file layout. `GMAIL_CREDENTIALS_JSON` continues to mean "default account."
- Phase M3 (if reached): add (B) for pure-env deploys. Document that account IDs in env must match `[A-Za-z0-9_-]+`.
- Skip (C) — the failure mode (lose one account's tokens, lose all) is not worth the slight env-count savings.

A new env var to add either way: `GMAIL_ACCOUNT` (active account selector; falls back to manifest `defaultAccount`; falls back to `default`).

## CLI surface options

The single concrete sketch — pick this and commit.

```sh
# Authentication, per account
gmail auth                                  # default account (or sole account)
gmail auth --account work                   # named account; mints accounts/work/credentials.json
gmail auth --account work --scopes=gmail.modify --print-json
                                            # capture for env-driven deploy

# Account management
gmail account list                          # table: id, email, scopes, default? last-used
gmail account use work                      # set defaultAccount in accounts.json
gmail account add work                      # alias for `gmail auth --account work` + manifest entry
gmail account rm work                       # remove account + creds, with --force to skip prompt
gmail account email <id>                    # print resolved emailAddress (from manifest or live fetch)

# Per-command override (NEVER mutates default)
gmail --account work search "in:inbox"
gmail -a work read <messageId>

# Env equivalent (same precedence as --account)
GMAIL_ACCOUNT=work gmail search "in:inbox"

# Inside `gmail console`
> :account list
> :account use work
> :account current
> i                                         # inbox on currently-active account
```

**Default-account resolution chain (top-to-bottom, first wins):**
1. `--account <id>` CLI flag (per-command, no state change).
2. `GMAIL_ACCOUNT` env var (per-process).
3. `.env.local` GMAIL_ACCOUNT (via `--env-file` in npm scripts).
4. `defaultAccount` field in `<configDir>/accounts.json`.
5. The string `"default"` if only one account exists in the manifest.
6. Error: "No account configured. Run `gmail auth` to create one."

## MCP host integration shapes

| Shape | Description | Status | Use case |
|---|---|---|---|
| **One process per account** | Host `.mcp.json` has `gmail-work` and `gmail-personal` entries; each launches `gmail mcp` with a distinct `GMAIL_ACCOUNT` / `GMAIL_CONFIG_DIR`. | **Works today.** | Most local-MCP users. Recommended default. |
| **One process, per-tool `account` arg** | Single MCP server, every tool grows optional `account: string`. Model passes `{account: "work"}` on each call. | Requires Concept (c). | Power users who want one MCP entry; hosts with strict tool-count limits. |
| **HTTP transport, OAuth bearer** | `Authorization: Bearer <oauth-access-token>` on `/mcp` — Google's token *is* the account identifier. Server has no stored credentials. | Speculative. | True multi-tenant SaaS deployments. Out of scope for this strategy. |
| **HTTP transport, per-request account header** | `Authorization: Bearer <fixed-token>` + `X-Gmail-Account: work`. Account picked per request from a server-side map. | Requires Concept (c) + Concept (a) account store. | Internal HTTP gateway in a trusted network. Document MITM risk if bearer is shared. |

## Risks and footguns

- **Token refresh races within an account.** Two parallel tool calls on the same account trigger two `oauth2Client.getAccessToken()` calls; the second invalidates the first. Today's single-account code already has this risk in flight; multi-account makes it more visible. Mitigation: per-account `refreshLock: Promise<void>` in `SessionEntry`.
- **Scope mismatch across accounts.** A `tools/list` request can only return one tool catalogue. If account A is read-only and account B can compose, exposing `send_email` to a model that's currently bound to A is wrong; hiding it from B is also wrong. Concept (c) makes this acute. Recommend: union-advertise, per-call gate, clear error message.
- **Rate-limit isolation.** Gmail API quotas are *per OAuth client + per user* — they're already isolated by Google. The local `src/robustness/rate-limit.ts` token bucket, on the other hand, is process-global today. In Concept (c), buckets should be per-account or you'll starve high-volume accounts on low-volume ones. Probably overkill for M1; mandatory for M3.
- **Audit/log tagging.** Without an `account` field on log records, you can't grep the NDJSON to answer "which account triggered the `invalid_grant`?" The `logger.ts` API takes a context object; adding `account` to it is one-line. Do this in M1 even though it's nominally an M3 problem.
- **HTTP per-request account-arg.** Trivially abusable if the bearer is shared between callers. Document explicitly: bearer = transport ingress, account = data plane. Same-bearer-for-two-accounts means both callers can read both accounts. If you need account-level auth, run one HTTP server per account.
- **Console REPL stale state.** User runs `:account use work`, runs three commands, walks away. Another shell rotates `accounts.json`. They come back and don't realise the active session is `work`. Mitigate: always render `[work]` in the REPL prompt; print `account=<id>` on every command result; show `:account current` on `?`.
- **OAuth keys per-account vs shared.** Most personal users have *one* Google Cloud project (one OAuth client) and authenticate *multiple Gmail addresses* through it. Layout 1 stores `gcp-oauth.keys.json` per account, which means duplicate keys in three places — annoying but not wrong. Could add `<configDir>/gcp-oauth.keys.json` as a fallback when `accounts/<id>/gcp-oauth.keys.json` is missing. Recommend doing that.
- **Migration from single-account.** Any user with `~/.gmail-mcp/credentials.json` today needs a zero-touch upgrade. Recommended migration: on first multi-account-aware bootstrap, if the legacy file exists, treat it as `accounts/default/credentials.json`. Don't delete the legacy file for at least one minor release.
- **`gmail auth --print-json` shape.** Today emits `{GMAIL_OAUTH_KEYS_JSON, GMAIL_CREDENTIALS_JSON}`. In multi-account world, add an `accountId` field; suggest a per-account env-var name in the stderr help text.

## Phased path recommendation

### Phase 0 — "many MCPs in the host config" (today)
- Document the `GMAIL_CONFIG_DIR`-per-account pattern in the README and CLAUDE.md.
- Add a section to `gmail auth --help` pointing at the multi-MCP pattern.
- **Cost: hours.** Pure docs.

### Phase M1 — Multi-config switching (Concept a)
- New `<configDir>/accounts/<id>/` layout; `accounts.json` manifest.
- `gmail account {add,list,use,rm}` subcommands.
- `--account` global flag + `GMAIL_ACCOUNT` env.
- Migration from single-account layout.
- Log tagging by account (lays groundwork for M3).
- **Cost: 2–4 days.** No tool-schema changes. No wire-protocol changes. Concept (c) people still have the Phase 0 multi-process workaround.

### Phase M2 — Runtime account switching (Concept b)
- `swapSession()` in `src/core/session.ts`.
- `:account use <id>` in the REPL.
- Decide: expose `account_use` as an MCP tool? (Recommend: only behind `GMAIL_EXPOSE_ACCOUNT_TOOL=1`.)
- **Cost: 1–2 days on top of M1.** Only worth doing if there's a real ergonomic complaint after M1 lands. May skip entirely.

### Phase M3 — Simultaneous multi-account (Concept c)
- Sessions become a Map. Every dispatch picks an entry by ID.
- Every tool schema grows `account?: string`.
- HTTP transport learns `X-Gmail-Account`.
- Per-account refresh locks + rate-limit buckets.
- `tools/list` scope union with per-call gate.
- **Cost: 1–2 weeks.** Largest blast radius. Only do this if there's a real use case (e.g. an MCP host that can't run multiple servers, or a hosted deployment).

**Recommended sequencing: ship Phase M1. Re-evaluate M2 and M3 only when concrete user demand surfaces.** M1 unlocks 95% of the value with 10% of the complexity. M2 is sugar. M3 is heavy and only justified by hosted multi-tenant — a non-goal today.

## Open questions for the user

1. **Is "one process per account in the host config" (Phase 0) actually a problem for you?** If yes, what specifically — tool-count bloat, model confusion, env-management pain, something else?
2. **Should `default` be reserved or just-another-id?** I.e. when there's only `default` in the manifest, does `gmail account list` show it, or is it implicit until a second account is added?
3. **Migration: do you want to keep `~/.gmail-mcp/credentials.json` working in parallel for one or two minor releases, or hard-cut in a single release?**
4. **For Phase M3 (if it ever happens), is the `account` field on every tool an acceptable schema change?** Or would you rather route per-account via separate processes and a thin router proxy?
5. **Should the OAuth keys file be per-account or shared (one Google Cloud project, many Gmail addresses)?** Personal use says shared; CI use says per-account.

## Out of scope

Per explicit user requirement:

- **`mise` / `direnv` / `chamber` / `1Password CLI shell wrappers`.** These exist as legitimate alternatives — `direnv` per-directory `.envrc` files in particular can give you per-project account isolation today. They are **not** the strategy and must not be proposed as the answer.
- **System env vars holding "multiple values at once".** No `GMAIL_CREDENTIALS_JSON_1` / `GMAIL_CREDENTIALS_JSON_2` array-style hacks. Env files (`.env`, `.env.local`) loaded via Node `--env-file` are the only env mechanism allowed for swapping configs in this design.
- **External secret-orchestration tools** (Doppler, AWS Secrets Manager, k8s External Secrets Operator). These can populate `GMAIL_CREDENTIALS_JSON` at deploy time — that's fine — but the multi-account design must work without them.
- **`gmail-mcp` as a hosted SaaS / multi-tenant service.** Concept (c) is sketched for completeness but explicitly deferred. The repo is a local MCP server first.
