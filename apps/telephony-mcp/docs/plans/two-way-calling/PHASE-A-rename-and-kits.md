# PHASE A — rename to `telephony-mcp` + kit adoption

> Read [`WORKSTREAM.md`](./WORKSTREAM.md) then [`DECISIONS.md`](./DECISIONS.md) first.
> Where this file and `WORKSTREAM.md` disagree, `WORKSTREAM.md` is correct.
>
> **This phase is deliberately boring.** Its only interesting property is that it
> touches George's live config, his real call history, and the AES key for a real
> recording. Everything else is find-and-replace.

## Inherited invariants

| INV | How it constrains this phase |
|---|---|
| **INV-11** | All logging keeps going through `logger` (`src/log.ts:26` already pipes every field through `redactValue`). The rename must not introduce a `console.error` path that bypasses it. |
| **INV-12** | Secrets resolve by NAME. `VOICE_MCP_KEYCHAIN_SERVICE` (`src/stores/secrets.ts:16`) is an *override* whose default (`"opkeep"`) is shared with other tools — renaming the env var is safe, renaming the default is not. |
| **INV-13** | The recordings AES key is a **macOS Keychain item keyed on the literal string `"voice-mcp"`** (`src/stores/recording-store.ts:16-17`). See Step 7 — this is the one irreversible hazard in the phase. |
| **INV-14** | Default suite stays offline/free. Kit adoption must not pull a transport that opens a socket at import time. |
| **INV-15** | `private: true` stays in `package.json`. The rename changes `name`, not that flag. |
| **INV-16** | One merge, then wait for the Release run. The rename touches `apps/**` paths msr scans. |
| **INV-17** | Never `git add -A`. `.mcp.json`, `.codex/config.toml`, `opencode.json` are all untracked (verified: `git ls-files --error-unmatch` fails on each) — they must be edited but **cannot** be committed. |
| **INV-5 / INV-8** | **Not yet in force.** Phase A knowingly leaves operations defined twice (`src/mcp/server.ts` + `src/gateway/admin-server.ts:121-177`). Phase B fixes it. Do not "improve" it here. |
| **INV-1** | **Not applied here.** Tool names stay `voice_*` through Phase A; Phase B renames them, because Phase B also deletes two of them (D-5). Renaming tools that are about to be merged is wasted churn. |

## Scope

1. Package `voice-mcp` → `telephony-mcp`; bin `voice-mcp` → `tel`; dir `apps/voice-mcp` → `apps/telephony-mcp` via `git mv` (this plan folder moves with it).
2. Add `@george43g/mcp-kit` and `@george43g/cli-kit@2.0.1` as dependencies and adopt the parts that do **not** require a command registry.
3. Config + state directory decision and, if migrating, the migration itself (**blocked on O-6**).
4. Machine-local host configs and doc references.
5. The **TODO ledger** below — every customisation a kit displaces gets a row.

## Non-goals

- **No tool renames** (INV-1 → Phase B).
- **No command registry, no dispatcher wiring** — `buildDispatcher({ registry })` structurally requires a registry, which is Phase B's deliverable. See *Open questions* Q-A3.
- No dial-gate change, no `dryRun`, no `prepare`/`start` collapse (Phase C, D-5).
- No `CallMode` change (Phase B).
- No tunnel, daemon, or launchd work (Phase D).
- No `private: true` flip and no baseline tag (INV-15 — that is a separate, George-gated event).
- No re-adoption of `@george43g/robustness` — already a dependency at `^0.12.0` (`package.json:26`).
- No new HTTP routes; `PublicServer`'s three routes are untouched.

## Steps

### 1 — Move the directory
`git mv apps/voice-mcp apps/telephony-mcp`, then `pnpm install`.
- `pnpm-workspace.yaml` globs `apps/*` — **no workspace edit needed**.
- `minimumReleaseAgeExclude` already lists `@george43g/*`, so the kits install without an age wait — **no edit needed**.
- `node_modules/` and `dist/` ride along on the rename; reinstall anyway so pnpm's store links are re-derived.
- Verify with `git log --follow apps/telephony-mcp/src/paths.ts` that history survived.

### 2 — `package.json`
| Field | From | To |
|---|---|---|
| `name` | `voice-mcp` | `telephony-mcp` |
| `bin` | `{"voice-mcp": "./dist/cli.js"}` | `{"tel": "./dist/cli.js"}` |
| `private` | `true` | `true` (unchanged — INV-15) |
| `version` | `0.0.0` | `0.0.0` (unchanged) |
| `description`, `keywords` | "voice" wording | telephony wording |

### 3 — Identifier sweep (verified sites)
| File:line | Today | Note |
|---|---|---|
| `src/paths.ts:13` | `~/.config/voice-mcp/config.json` | Step 7 |
| `src/paths.ts:18-20` | `~/Library/Application Support/voice-mcp` | Step 7 |
| `src/paths.ts:34` | `voice-mcp.sqlite3` | Step 7 |
| `src/mcp/server.ts:69` | `new McpServer({ name: "voice-mcp" })` | host-visible server identity |
| `src/mcp/server.ts:454,483,502` | `voice://calls/...` resource URIs | scheme rename → Q-A4 |
| `src/cli.ts:34` | `` `voice-mcp: ${msg}` `` error prefix | |
| `src/cli.ts:43` | `program.name("voice-mcp")` | replaced by `buildProgram` in Step 6 |
| `src/cli.ts:166,185` | `voice-mcp call …`, `voice-mcp watch` hint strings | |
| `src/client/admin-client.ts:11` | `` start it with `voice-mcp serve` `` | |
| `src/config/schema.ts:7-8` | `VOICE_MCP_CONFIG` | env prefix → Q-A2 |
| `src/log.ts:12` | `VOICE_MCP_LOG_LEVEL` | env prefix → Q-A2 |
| `src/stores/secrets.ts:16` | `VOICE_MCP_KEYCHAIN_SERVICE` | env prefix → Q-A2; **keep the `"opkeep"` default** |
| `tests/helpers.ts:61` | `VOICE_MCP_STATE_DIR` | env prefix → Q-A2 |
| `src/stores/recording-store.ts:16` | `KEYCHAIN_SERVICE = "voice-mcp"` | **DO NOT RENAME** — Step 7 |
| `src/stores/recording-store.ts:15,72` | `"VMC1"` file magic | **DO NOT RENAME** — on-disk format |
| `src/gateway/call-service.ts:6`, `src/gateway/gateway.ts:2` | docstrings | cosmetic |

### 4 — Add the kits
```
pnpm --filter telephony-mcp add @george43g/mcp-kit @george43g/cli-kit
```
`cli-kit@2.0.1` peer-deps `commander@^14.0.0` — already satisfied (`package.json:28`). `mcp-kit@1.0.0`
deps `@george43g/robustness >=0.12.0 <1` — already satisfied. **Version pin is Q-A1**: the workstream
scope names `@george43g/mcp-kit@0.1.0`, but `1.0.0` shipped 2026-08-28 and is a superset (verified by
diffing the published `.d.ts`: `+sanitizeContent`, `+CONTENT_BUDGET`, and `buildDispatcher` now
*throws* when a `devOnly` tool is registered with no `devOnlyEnabled` predicate). We register no
`devOnly` tools, so the breaking change does not apply.

### 5 — Adopt `@george43g/mcp-kit` (leaf helpers only)
| Adopt now | Where it lands |
|---|---|
| `sanitize` / `sanitizeContent` | Transcript + utterance text on its way out over MCP. Today nothing sanitizes them (`src/mcp/server.ts:366` returns store rows raw). |
| `wrapUntrusted` | Callee utterances in tool output — content typed by a third party on a phone line. |
| `wrapToolError` | Replaces `errorContent()` (`src/mcp/server.ts:44-49`), which returns a bare `error.message`. |
| **Defer**: `makeRegistry`, `buildDispatcher`, `buildResourcesHandler` | Phase B (they need a registry). |
| **Defer**: `startStdio`, `startHttpServer` | Phase B / Phase H — see Q-A3. |

### 6 — Adopt `@george43g/cli-kit@2.0.1`
| Adopt | Replaces |
|---|---|
| `buildProgram({name:"tel", description, version})` | `src/cli.ts:42-43`. Adds `--json / -q / -v / --no-color` globally. Needs a version string — see ledger row L-3. |
| `printJson`, `printTable`, `printAuto`, `resolveOutputMode` | `src/cli.ts:38-40` (hand-rolled `printJson`). Gives `history list` a real table. |
| `bindEnvFlags` / `applyEnvFromFlags` | Nothing today. Makes every `TEL_*` var also a flag. Depends on Q-A2. |
| `runRepl` | Nothing today (no console verb). **Wire in Phase B**, where the dispatcher it needs exists. |

`fail()` (`src/cli.ts:33-36`) has **no** cli-kit equivalent — it stays, unchanged.

### 7 — Config + state directory (**BLOCKED ON O-6**)

Live state, measured on this machine 2026-08-29:
```
~/.config/voice-mcp/config.json                      2616 B, mtime 2026-08-16
~/Library/Application Support/voice-mcp/
  voice-mcp.sqlite3      282624 B     voice-mcp.sqlite3-shm  32768 B    voice-mcp.sqlite3-wal  0 B
  recordings/REf1b9e505eb135631f17fb3445cf95f50.enc  2688076 B, mtime 2026-08-02
```

> ⛔ **THE ONE IRREVERSIBLE HAZARD.** The AES-256-GCM key for that `.enc` file lives in the macOS
> Keychain under service **`"voice-mcp"`**, account `"recording-key"`, hardcoded at
> `src/stores/recording-store.ts:16-17`. It is **not** derived from any path, so *moving the
> directory is safe*. Renaming that constant without first duplicating the keychain item makes the
> 2026-08-02 recording **permanently undecryptable**. The `"VMC1"` magic at `:15`/`:72` is likewise
> an on-disk format, not a name.
> **Rule for both branches below: `KEYCHAIN_SERVICE` and `MAGIC` are frozen strings.**

**Branch M — migrate** (chosen if George says migrate):
1. Stop `serve` (single-writer, INV-9). Confirm no `tel`/`voice-mcp` process holds the DB.
2. Open the DB read-write once, `PRAGMA wal_checkpoint(TRUNCATE)`, close. Then move
   `voice-mcp.sqlite3` → `telephony-mcp.sqlite3` and **delete** the stale `-shm`/`-wal`
   (a moved `-wal` beside a renamed main DB is a corruption vector).
3. `mv ~/Library/Application\ Support/voice-mcp ~/Library/Application\ Support/telephony-mcp`,
   preserving `0700` on the root and `recordings/`, `0600` on files.
4. `mv ~/.config/voice-mcp ~/.config/telephony-mcp`.
5. Leave `src/stores/recording-store.ts:16` alone.
6. ~~Implement as an explicit `tel migrate-state --yes` command~~ **Superseded by D-40/D-47
   (George chose automatic):** startup-only from cli.ts before command dispatch, lock-probe +
   WAL checkpoint, dated backup, skip-on-busy with legacy-path read fallback. Original rationale
   preserved by startup-only + probe. NOT inside `ensureStateDir()`, per the original concern:
   `ensureStateDir()` (`src/paths.ts:24`) — an auto-migration that runs from the MCP server means it
   can fire from a host with no terminal attached, mid-call.
7. Back up first: `cp -a` both trees to a dated folder before touching anything.

**Branch P — pin** (chosen if George says pin):
1. `src/paths.ts` keeps every `voice-mcp` literal.
2. Add a docblock at `src/paths.ts:1-7` stating that these are **frozen legacy identifiers**, not an
   oversight, with a pointer to O-6.
3. Zero risk, permanent cosmetic mismatch between a `tel` binary and a `voice-mcp` state dir.

**Recommendation: Branch M**, gated on George running it himself with the backup in place. Reason:
Phase D adds a launchd daemon (D-9) whose plist label and log paths will be written once and read
for years; encoding the dead name there is the version of this that actually hurts.

### 8 — Machine-local host configs (untracked — edit, never commit)
| File | Action |
|---|---|
| `.mcp.json:22-30` | Rename key `voice-mcp` → `telephony-mcp`; update both absolute paths (`apps/voice-mcp/node_modules/tsx/dist/loader.mjs`, `apps/voice-mcp/src/cli.ts`). |
| `.cursor/mcp.json`, `.warp/.mcp.json` | Symlinks to `.mcp.json` — **nothing to do**. |
| `opencode.json:27-37` | **Generated.** Do not hand-edit: `mcpsync -c ./.mcp.json apply --scope project --to opencode`. |
| `.codex/config.toml:17-19` | Hand-edit; it carries the repo's `.bin/tsx` ban note — keep `node --import <loader>` form. |

### 9 — Tracked docs
`README.md:8,12`; `AGENTS.md:263`; `.github/workflows/release.yml:71` (comment naming private apps);
`apps/telephony-mcp/{README.md,AGENTS.md,HANDOFF.md}`. Fix two known doc-drift items while here:
- `apps/*/AGENTS.md:24` points redaction at `src/domain/redact.ts` — **that file does not exist**; it moved to `@george43g/robustness` (`src/log.ts:6`).
- `apps/*/AGENTS.md:48` says `mise run voice-mcp:check` — **no mise config exists anywhere in EQStack** (stale from the life-stack repo). Replace with `pnpm --filter telephony-mcp test typecheck lint`.

### 10 — Write the TODO ledger (below) as part of the PR, not after it.

## TODO ledger

**Contract (D-11):** anything a kit displaces gets a row here and is re-implemented **in the phase
where the feature is relevant** — never during adoption. A feature that is deprecated by the end of
the workstream should never be re-implemented at all.

| # | Dropped / deferred | Displaced by | Re-implement in | Notes |
|---|---|---|---|---|
| L-1 | `errorContent()` returning bare `error.message` (`src/mcp/server.ts:44-49`) | `wrapToolError` | — (superseded, do not restore) | Bare messages are the thing INV-6 exists to stop. |
| L-2 | Hand-rolled `printJson` (`src/cli.ts:38-40`) | cli-kit `printJson`/`printAuto` | — (superseded) | Output shape changes only under `--json`. |
| L-3 | Version string mismatch: `package.json` `0.0.0` vs `VERSION = "0.1.0"` (`src/gateway/admin-server.ts:14`) | `buildProgram` needs one truth | **Phase A** (pick one) | `/healthz` reports `VERSION`; `AdminClient.health()` consumes it. |
| L-4 | mcp-kit dispatcher (timeout / perf `_meta` / abort / `noteActivity`) | — | **Phase B** | Needs a registry. Until then MCP tool calls have no timeout at all. |
| L-5 | mcp-kit `startStdio` lifecycle (shutdown, stdin-EOF, orphan watch, watchdog, heap monitor) | — | **Phase B** | Deferred on purpose — see Q-A3. |
| L-6 | mcp-kit `startHttpServer` (Streamable HTTP + bearer) | — | **Phase D/H** | D-7 puts MCP-HTTP in the daemon. |
| L-7 | cli-kit `runRepl` console | — | **Phase G** | Console view is Phase G; the dispatcher it needs is Phase B. |
| L-8 | cli-kit `bindEnvFlags` env↔flag binder | — | **Phase A if Q-A2 resolves, else Phase D** | Blocked on the env prefix decision. |
| L-9 | `--mode llm\|direct` hand-validation (`src/cli.ts:153-155`) | Zod in the registry | **Phase B** | Duplicate of `admin-server.ts:123-125` — INV-5's exhibit A. |
| L-10 | `--scope local\|provider\|both` hand-validation (`src/cli.ts:340-342`) | Zod in the registry | **Phase B** | Third copy of the same enum (`admin-server.ts:168`, `mcp/server.ts:432`). |

## Verification

1. `pnpm --filter telephony-mcp lint typecheck test` — ~~95 tests / 10 files~~ **93 / 10 measured on main 2026-09-02** (the 95 was a planning-time miscount); count must not drop. Post-phase: 98 (5 migration tests added).
2. Root `pnpm verify`.
3. `git log --follow` on two moved files proves history followed the `git mv`.
4. `env | grep VOICE_MCP` → currently empty on this machine (checked 2026-08-29). Re-check after any shell-profile change; a stale export silently re-points config/state.
5. `npm view telephony-mcp` still 404 (the D-1 availability anchor).
6. MCP smoke: start the server, `tools/list` returns the **same 13 names** as `tests/mcp.integration.test.ts:79-92`. Phase A changes zero tool names.
7. `tel doctor` (`src/cli.ts:77-139`) — every check green, including `state db` pointing at the post-decision path.
8. **George-gated, Branch M only:** `tel history list` shows the pre-existing calls; `tel recording play REf1b9e505eb135631f17fb3445cf95f50` decrypts and plays. This is the proof the keychain item survived. Do not skip it and do not automate it.
9. No paid call is placed at any point in this phase.

## Seam left behind

| Left behind | Consumed by |
|---|---|
| `apps/telephony-mcp/` with both kits installed and resolving | every later phase |
| `tel` bin backed by a cli-kit `Command` object | Phase B's CLI adapter, Phase D's `tel daemon` |
| A settled state/config path (Branch M or P) | Phase D — launchd plist paths, INV-9's single-writer DB |
| Frozen `KEYCHAIN_SERVICE` / `VMC1` constants, documented as frozen | any phase that touches recordings (INV-13) |
| This TODO ledger | Phases B, D, G, H — each phase picks up its own rows |

## Open questions

| # | Question | Whose call | Blocks |
|---|---|---|---|
| **O-6** *(existing)* | Migrate or pin the config/state dirs? | George | this phase's Step 7 |
| **Q-A1** | Pin `@george43g/mcp-kit` at `0.1.0` (as scoped) or `1.0.0` (published 2026-08-28, strict superset, aligns the robustness floor at `>=0.12.0`)? | implementer + George | Step 4 |
| **Q-A2** | Env prefix: `VOICE_MCP_*` → `TEL_*`, `TELEPHONY_MCP_*`, or keep? cli-kit's binder derives `--log-level` by stripping the prefix, so `TEL_` gives the best flags. A dual-read shim for one phase costs ~6 lines. | George | Step 3, Step 6, ledger L-8 |
| **Q-A3** | Does Phase A adopt `startStdio`? **Hazard:** it wires the robustness idle watchdog, but `noteActivity()` is fired by the *dispatcher*, which Phase A does not adopt. A direct-mode host sitting in a 55 s `voice_get_events` long-poll (`src/mcp/server.ts:323-329`) would look idle. Recommendation: defer to Phase B and land transport + dispatcher together (ledger L-5). | implementer | Step 5 |
| **Q-A4** | Rename MCP resource URIs `voice://calls/{id}` → `tel://…`? No persistence depends on them; hosts may have them bookmarked. | George | Step 3 |
| **Q-A5** | Phases A and B leave a transient host-visible name: `mcp__telephony-mcp__voice_prepare_call`. Land A and B in the same release window, or accept the transient? | George | INV-16 sequencing |
