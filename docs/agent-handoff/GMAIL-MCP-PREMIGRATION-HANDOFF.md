# Gmail-MCP-Server — Agent Handoff

> **Status: PAUSED (weekly-usage limit). A takeover agent (Codex) is picking this up for ~1–2 days
> until the limit resets, then work resumes in the original Claude Code session.**
> Created 2026-07-27. **This file is the single source of truth for in-progress work.** Keep it
> updated as you go (see [§10 Keeping this doc current](#10-keeping-this-doc-current)).

> **Publication note (2026-09-04, added on tracking).** The two paragraphs below — and the matching
> line at the very end of this file — were the *original* repo's rule while this was a live working
> doc in the standalone `Gmail-MCP-Server` repo. They are kept verbatim as part of the record and
> are **no longer operative**. George's call (2026-09-04) was to redact and track this file here, so
> the migration record survives the laptop it was written on. Redactions made before tracking, and
> only these: the literal no-real-data denylist patterns in §2.3 and one private memory-note name in
> §9 (both marked `[redacted …]` in place). Nothing else was altered, reworded, or removed — no
> credentials or tokens appear anywhere in this file. The **unredacted** original remains on
> George's machine at `apps/gmail-mcp/HANDOFF.md` (gitignored).

This file was **gitignored on purpose** — it is a local working doc for whichever agent is driving,
not part of the public package. Do **not** commit it, and do **not** `git add -A -f` it into history.

---

## 0. Read this first (orientation)

- **What this repo is:** a Gmail integration exposed as an MCP server + a full `gmail` CLI + an
  Ink/React TUI. Deep architecture, module boundaries, env vars, and conventions live in
  **`AGENTS.md`** (root; `CLAUDE.md` is a symlink to it). Read `AGENTS.md` before touching code.
- **Where we are:** milestones **A + B + C + D1 + D2 are done** and committed on a local feature
  branch (**unpushed**). The only remaining planned work is **D3 (Phase 0 — release automation)**.
- **⚠ The one thing that will bite you — commit signing.** This repo requires **1Password SSH
  commit signing** (`commit.gpgsign=true`, `gpg.format=ssh`, `op-ssh-sign`). A takeover agent almost
  certainly **cannot** produce a signed commit and **must not bypass signing** (`--no-gpg-sign`,
  `-n`/`--no-verify`, disabling the hook — all forbidden). **Default rule for the takeover agent:
  do the work, add tests + docs, run `pnpm verify` to green, then STOP before committing** — stage
  the change and write the commit message into a file, and leave the actual signed commit to George.
  See [§2](#2-hard-constraints--do-not-violate) and [§7 Q1](#7-open-questions-for-george).
- **Do NOT push anything** without an explicit instruction from George.
- **Full detail / rationale** for every decision lives in George's private Claude-session docs (see
  [§9](#9-where-the-claude-session-docs-live)). A takeover agent can't read those, so everything you
  need to act is duplicated here.

---

## 1. Snapshot (status at a glance)

| Field | Value |
|---|---|
| Branch | **`main` — everything MERGED + PUSHED** (2026-08-21 night, George's explicit go-ahead: "permission to merge, push"). Feature branches retained on origin for review trail. |
| HEAD | `66986bf` (origin + local in sync) — kit starvation bump on top of the `ba530da` chain: D3 `633b38f` → release-disable `531233e` → Phase 1 `254b85b` → Phase 2 `50643bd` → kits `70b9a07` → tsx-fix `0bdada2` → biome-pin/mcpsync-docs `024309a` → screenshots `739385c` → robustness-0.10.0 seam `e35a9bb` → resolutionMode retraction `a76d115` → tui-kit-0.5.0 fitToWidth `37be062` → screenshots `ba530da` → kit-starvation bump `66986bf` |
| Done | A–D3 + Phases 1&2 merged + shared-kit refactor + **EQ-STACK MIGRATION COMPLETE (§11)** |
| Next | **THIS REPO IS FROZEN** (`32a53ec` banner; archive George-gated). Develop in `~/repos/EQStack/apps/gmail-mcp`. Next work: contacts factorisation + repo comparison (design round with eqstack). |
| Green baseline | **826 unit (robustness suite moved upstream) + 23 e2e; stress 10/10; `pnpm verify` exit 0** |
| ⚠ History note | The pre-push A–D3 branch history was REWRITTEN (all re-signed) to scrub George's business name from `72f7781`'s test fixtures (now `catchall.fixture.test`, incl. the mixed-case variant a case-sensitive first pass missed). Old local hashes in earlier docs (`8d5bdd0` etc.) no longer exist. |
| Release pathway | **DISABLED** (`release.yml` = workflow_dispatch-only) until the EQ-Stack migration lands — trusted-publishing + provenance bind to repo identity, so first real publish happens under the final repo. |
| Tool catalog | **34** (work fixture: `gmail.modify`+`gmail.settings.basic`) / **36** (full fixture: `gmail.full`+`gmail.settings.basic`) |
| Also done, separate branches (unpushed) | Phase 1 `c444ef3` (`george43/fix-display-name-recipients`), Phase 2 `4a73b64` (`george43/tui-send-confirm`) |

Runtime: **Node ≥ 20.6, ESM-only**. Package managers: **pnpm preferred** (npm also supported; both
lockfiles committed).

---

## 2. Hard constraints — DO NOT VIOLATE

1. **Commit signing is mandatory (1Password SSH).** Never bypass hooks or signing. If you can't
   sign, **don't commit** — prepare + verify + stage, leave the signed commit to George. See §0.
2. **No `git push`** without an explicit instruction. George pushes when ready.
3. **Public fork — no personal data in committed files.** Denylist (must never appear in committed
   files, esp. fixtures): [redacted on tracking — three literals: George's personal email
   local-part, an employer email domain, and his real business catch-all domain. The authoritative
   copy of the list is the guard test itself, `src/fixtures/schemas.test.ts` in the gmail app;
   standing fleet rule is that the patterns are never pasted into a tracked prose file].
   Synthetic addresses use the reserved `.test` TLD / `@fixture.test`.
   A no-real-data guard test (`src/fixtures/schemas.test.ts`) enforces this — keep it green.
4. **No real data in fixtures.** Hand-crafted synthetic JSON only.
5. **No live npm publish.** The **first** publish is done manually by George from his machine. D3
   only *authors* release config and verifies it via **dry-run** — do not trigger a real publish.
6. **One signed commit per phase; docs + tests go INSIDE the same commit** (that's the A→D2 pattern).
7. **Run `pnpm verify` before wrapping any phase** (see [§8](#8-how-to-work-here-workflow--verification)).

---

## 3. What's done

| Commit | Milestone | Summary |
|---|---|---|
| `3cf3ef2` | A1 | `search_emails`: `threadId` + structured `{name,email}` recipients (from/to/cc), lowercased |
| `4959bbd` | A2 | `get_thread` accepts a `messageId` (resolves to threadId) |
| `794ee05` | A3 | `truncated` / `total_available` on every list-shaped output (shared `listMeta` in `core/email-helpers.ts`) |
| `72f7781` | B (§5a) | send-as identity op `list_send_identities` + closest-identity reply-from (`reply_all` picks the right alias for a catch-all domain) |
| `337d31d` | C (§5b) | read-only cross-account `unread_summary` + shared session-free `buildAccountGmail` factory (`core/account-gmail.ts`) |
| `08f94d7` | D1 (Phase 4) | `gmail.full` fixture account + drafts/attachments corpus; fixture client `drafts.list`/`.get`; 35→36-tool e2e groundwork; `screenshots.yml` pinned to `ubuntu-24.04` + dimensions gate |
| `71113cf` | D2 (Phase 3) | `list_drafts` op + `gmail list-drafts` CLI + TUI local `.eml` draft recovery (`p`/`:drafts`/`:resume`) + `e` edit-in-place via `update_draft` (no duplicate). **Catalog → 34/36.** |
| `44ac797` | (dotfiles MCP-audit, other session) | Canonical project MCP set: `.cursor/mcp.json` symlink, `opencode.json`, AGENTS.md MCP section. Landed unformatted → fixed in `f690a8e`. |
| `3f30599` | chore | `.gitignore` now ignores `HANDOFF.md` / `HANDOFF-*.md` (the previously-uncommitted edit, folded in). |
| `f690a8e` | style | `opencode.json` biome-formatted (fixes `pnpm lint` broken at HEAD by `44ac797`). |
| `8d5bdd0` | **D3 (Phase 0)** | semantic-release + commitlint + npm OIDC trusted publishing (`.releaserc.json`, `release.yml`, `commitlint.config.js`, `.githooks/commit-msg`); ci.yml version asserts de-hardcoded; **security override bumps** fast-uri 3.1.5 / hono 4.13.3 / ip-address 10.5.0 (fresh advisories; both audits 0 vulns). |

**D2 detail (most recent, for context):**
- Server: `list_drafts` op in `src/core/ops/drafts.ts` (`drafts.list` + per-draft metadata `get`,
  `scopes:["gmail.readonly","gmail.modify"]`, `listMeta`, typed `ListDraftsOutputSchema`).
- CLI: `src/cli/commands/list-drafts.ts` (`--max`/`--page-token`/`--json`); `useGmail` gained
  `listDrafts/updateDraft/sendDraft/deleteDraft`.
- TUI recovery: `src/tui/compose-parser.ts` emits/parses/strips `X-Gmail-MCP-Kind` /
  `-Source-Message-Id` / `-Source-Thread-Id` (empty template stays byte-exact; X-headers never reach
  the sent message since sends rebuild from parsed fields); `src/tui/drafts-recovery.ts`
  (`listLocalDrafts`/`readLocalDraft`/`discardLocalDraft`); `DraftsRecovery` overlay + reducer
  `drafts` overlay/`localDrafts`/`SET_LOCAL_DRAFTS`; keymap `p`; ex-commands `:drafts`/`:resume`;
  `msg.draft.edit`→`editDraft` correlates the focused draft via `list_drafts` and calls
  `update_draft` in place.
- Tests: op unit + output-schema, compose round-trip, `listLocalDrafts` unit, `DraftsRecovery`
  (ink-testing-library), reducer + keymap, e2e (`list_drafts` + edit→update→send).
- **Minor scope note:** the plan asked to "wire `gd` Drafts-view rows to open a draft"; this is
  served via `e`/`msg.draft.edit` (correlates whatever draft is focused, incl. in the `gd` Drafts
  folder) rather than a bespoke Enter-on-row handler. Functionally equivalent, simpler.

---

## 4. ~~Next task —~~ D3 — Phase 0: release automation ✅ DONE (`8d5bdd0`, 2026-08-21)

**Landed.** Deviations from / resolutions of the spec below, all deliberate:
- **Q3 RESOLVED:** `@semantic-release/npm` v13 supports tokenless OIDC trusted publishing natively —
  `permissions: id-token: write` on the job, provenance automatic, no direct `npm publish` needed.
  Gotcha honored: **no `registry-url` on `setup-node`** (its generated `.npmrc` breaks the auth).
- **Plugin order corrected:** spec had exec (gen-usage) *before* npm; npm's prepare is what stamps
  the new version, so exec now runs *after* npm (order: analyzer → notes → changelog → npm → exec →
  git → github). Otherwise `usage.kdl` would bake the stale version.
- **Concurrency:** `release.yml` and `screenshots.yml`'s commit job share a `main-mutations` group
  (same string across workflows = one queue) so they can't push to main concurrently.
- **pnpm 11 override gotcha (discovered here):** the live override source is
  `pnpm-workspace.yaml`'s `overrides` block — package.json's block is IGNORED when it exists, and
  no install variant invalidates the lockfile on change. Edit pnpm-workspace.yaml, then
  `pnpm install`. npm side: changed overrides aren't reconciled either; regenerate
  `package-lock.json` in an isolated dir (arborist crashes reading pnpm's symlinked node_modules).
- **⚠ Merging this branch to main ARMS auto-publish:** next `feat`/`fix` on main with green CI cuts
  a real npm release via OIDC. Merge deliberately.

**(original spec below, for reference)**

**Goal:** author release-automation config (semantic-release + conventional commits) so future
releases are CI-driven. **⚠ Publishing now goes through npm OIDC trusted publishing, NOT an
`NPM_TOKEN`.** Keep it dry-run-verified only; the FIRST real publish is manual by George.

### 4.1 The OIDC change (READ — supersedes the old "INERT, no publish" stance)
George has configured **npm OIDC trusted publishing** on npmjs.com linking the package
`@george43g/gmail-mcp` ↔ the GitHub repo `george43g/gmail-mcp`, authorizing the `release.yml`
workflow (npm perms granted: publish + stage publish). **No `NPM_TOKEN` secret is needed.** So:
- `release.yml` must declare `permissions: id-token: write` (plus `contents/issues/pull-requests: write`).
- Publish via a **provenance-capable / trusted-publishing** `npm publish` (npm ≥ 11.5). No token env.
- **Open implementation question:** `@semantic-release/npm` historically expects `NPM_TOKEN`.
  Verify whether the current `@semantic-release/npm` supports **tokenless OIDC trusted publishing**;
  if not, the release step may need to invoke `npm publish` directly (with `id-token: write`) instead
  of relying on the plugin's auth. **Until confirmed, keep the workflow effectively inert and prove
  it only via `--dry-run`.** Do not wire a real publish.

### 4.2 Work items (from the roadmap)
1. **De-hardcode `2.0.0` in `ci.yml`** (currently ~3 spots: tarball name, `--version` assert, docker
   `--version` — **re-verify current line numbers**) → `node -p "require('./package.json').version"`.
   `usage.kdl` version already flows from `package.json` via `gen-usage`.
2. **devDeps** — add with `pnpm add -D <pkg>` **then** `npm install --package-lock-only` (keeps both
   lockfiles in sync): `semantic-release` + `@semantic-release/{commit-analyzer,release-notes-generator,changelog,npm,git,github,exec}`
   + `@commitlint/{cli,config-conventional}`.
3. **`.releaserc.json`** — `tagFormat: "v${version}"`, `branches: ["main"]`, plugins in order:
   commit-analyzer → release-notes-generator → changelog → **exec**
   (`prepareCmd: "npm run gen-usage && npm install --package-lock-only"`) → npm → github → git
   (assets: `package.json`, both lockfiles, `usage.kdl`, `CHANGELOG.md`;
   message `chore(release): ${nextRelease.version} [skip ci]`).
4. **`.github/workflows/release.yml`** — `workflow_run` on CI success on `main`; Node 24; pnpm
   install/build; `npx semantic-release`; a `concurrency` group (must **not** race the screenshots
   auto-commit workflow); `permissions: { id-token: write, contents: write, issues: write, pull-requests: write }`.
   **Authored but effectively INERT** — dry-run-verified, no real publish, **no `NPM_TOKEN`** (OIDC).
5. **commitlint** — `commitlint.config.js` extends `config-conventional`; `.githooks/commit-msg` runs
   `npx --no -- commitlint --edit "$1"`. (`core.hooksPath` is already wired via `hooks:install`;
   `.githooks/` currently has only `pre-push`.)
6. **Docs (in the commit):** update `AGENTS.md` "Known follow-ups" — Phase 0 landed; publishing now
   via OIDC (no `NPM_TOKEN`), first publish manual.

### 4.3 Verify
- `npx semantic-release --dry-run` on a scratch branch prints the next version + CHANGELOG + asset
  list **without publishing**.
- A non-conventional commit message is **rejected** by commitlint.
- `pnpm verify` stays green.
- **Signing caveat applies (§0/§2): a takeover agent should stop before creating the phase commit.**

---

## 5. Deferred tasks & ideas (nothing lost)

- **Contacts management (spike-then-decide — DECISION PENDING; George revisits after D2).** Wants
  structured contacts tied into the Gmail tool, like the iMessage MCP has. Both strong candidates are
  **Swift** (this tool is Node/TS), so cross-language library import is off the table — integration
  is spawn-a-binary or a sidecar MCP. Provisional coupling = **spawn CLI + parse JSON**, fully
  decoupled from A–D.
  - **`RyanLisse/Contactbook`** (MIT, Swift) — **already modular** (`ContactbookCore` lib + thin CLI
    + thin MCP, full CRUD, `Contacts.framework`, AppleScript fallback). Matches George's modularity
    goal; forkable. Build `swift build -c release`. **Current lean.**
  - **`mattt/iMCP`** (MIT, Swift) — signed `.app` (holds TCC) + `imcp-server` CLI over loopback
    Bonjour. **App-monolith** (Messages+Contacts+Calendar+Reminders), **no standalone importable
    Contacts lib** → conflicts with "modular, use one aspect."
  - **Spike deliverable when picked up:** install both, test against real Apple Contacts for
    completeness / speed / TCC-prompt friction / Node-callability; recommend fork-Contactbook vs
    build-own vs adopt-iMCP. That recommendation is the gate — **not yet run.**
- **Shared identity schema** `{canonical_name, phones[] (E.164), emails[] (lowercased), handles[]}`
  consistent across Gmail / iMessage / Apple Mail. A1's lowercased structured emails are the
  groundwork. Deferred with contacts.
- **Wrap remaining Gmail call sites** with `withRetry` / `rateLimitAcquire` (library exists; wired
  into `read_email` + `search_emails` as the pattern). Read paths (`list_inbox_threads`, `get_thread`,
  `download_*`) + idempotent writes (`modify_*`, `delete_*`, `batch_*`) are progressive-adoption
  candidates. **Send/draft creation must stay unwrapped (non-idempotent).**
- **TUI follow-ups:** visual-mode batch ops, filter/label CRUD UI, attachment preview, sent/drafts
  folder UIs.
- **`gmail console` polish:** inline `@inquirer/prompts` widgets for destructive ops; richer status.
- **`notifications/tools/list_changed` after `switch_account`** (M2-full polish; the catalog doesn't
  auto-refresh when the active account changes).
- **Phase G2 — multi-tenant HTTP mode** (per-request OAuth introspection, per-tenant creds,
  scope-isolated rate limiting). Defer until a real use case appears.
- **Dependency bumps (defer until a concrete need):** `zod` 3→4 (+ `zod-to-json-schema` co-bump;
  changes discriminated-union/default/error surfaces — review `tools.ts` + fixtures); `mcp-evals`
  1→2; `nodemailer` 7→8; `open` 10→11; TypeScript 5.x→6.x.
- **iMessage MCP feedback (DIFFERENT repo — noted for its owner, not this repo):** add
  `matchScore`/`matchedField`, conversation-scoped `get_messages`, `truncated`/`total_available`.
- **Live-verify B / C / D2 in tmux** (fixture mode) — reply-from alias pick, cross-account summary,
  draft recovery flow. Non-blocking.
- **Push / review** A+B+C+D1+D2+D3 (and Phases 1 & 2 on their branches) — George pushes when ready.
- **Shared-packages adoption (from the `mcp-cli-toolkit` session, 2026-08-21; DECISION FOR GEORGE).**
  The starter-template repo (github.com/george43g/mcp-cli-starter-template) publishes
  `@george43g/{robustness,cli-kit,tui-kit,secret-store}` (query npm for versions — never trust a
  relayed number; `^0.x` locks the MINOR). `mcp-kit`/`shared-types` NOT published (their DEFERRED
  #25); configs deliberately never published. This repo will reportedly be **merged into EQ-Stack**,
  which already consumes `@george43g/robustness`. **Their recommendation: adopt `robustness` BEFORE
  the merge** (our `src/robustness/` will collide with the package at merge time; standalone
  migration = one-variable debugging), defer cli-kit/tui-kit/secret-store to the merge (additive,
  no collision). Counter-case they volunteered: their release automation has misfired twice
  (accidental majors), rendered CLI output is not semver-covered, and if the merge is WEEKS away
  adopt-at-merge wins. **The flip input is the merge timeline — only George knows it.** Their doc
  pointers: AGENTS.md / docs/SHARED_RUNTIME.md / DEFERRED.md / HANDOFF.md in their repo. Kit
  change-requests to them are work orders by default; publishing needs George's own approval.
- **tsx signal-relay hazard in dev spawn paths (from `mcp-cli-toolkit`, verified locally; FIX
  PENDING George's OK).** The tsx CLI wrapper (`node_modules/.bin/tsx` / bare `tsx`) spawns a
  grandchild and SIGKILLs it if a signal isn't acked over IPC within **30ms** (busy event loop =
  no ack) — the wrapper then exits `143 signal=null`, which reads as "handler never ran". Affected
  here (dev-only): `scripts/mcp-dev-proxy.ts` (default `MCP_DEV_CMD` = `tsx …`, and
  `killChildGroup` signals the group) and `opencode.json`'s dev-server command (generated from
  dotfiles `.mcp.json` — fix belongs THERE, or it regenerates back). Consequence: a busy dev server
  can be SIGKILLed mid-shutdown → no NDJSON `shutdown` marker → misread as a crash. NOT affected:
  `scripts/stress-mcp.ts` (uses `node --import tsx` — the safe form) and the published binary
  (plain node). Fix shape: switch spawn strings to `node --import tsx …`.

---

## 6. Decisions locked

- **Sequencing:** quick-wins first (A) → new features (B, C) → approved phases (D).
- **Multi-account = summary only** (read-only `unread_summary`); every other op stays
  single-active-account via `switch_account`. **No per-request fan-out.**
- **Contacts = spike-then-decide**, provisional coupling **spawn-CLI + parse JSON**, **fully
  decoupled** from A–D. Direction (fork Contactbook / build-own / adopt iMCP) **still pending** —
  George revisits after D2.
- **npm publish:** OIDC trusted publishing is now set up → **no `NPM_TOKEN`**; **first publish
  manual** by George, then CI-driven. (This relaxes the old "publish gated on the contacts decision"
  coupling — OIDC was set up independently.)

---

## 7. Open questions for George

1. **Signing for the takeover agent (BLOCKING for committing).** The takeover agent can't 1Password-
   sign. Preferred handling: it does the work + tests + docs, runs `pnpm verify` green, stages the
   change and writes the commit message to a file, and **George creates the signed commit**.
   Confirm this, or authorize an explicit alternative. **Until George says otherwise, do not commit.**
2. **Contacts direction** — fork `Contactbook` vs build-own vs adopt `iMCP`. Needs the hands-on spike
   (§5) before deciding. Not started.
3. ~~**`@semantic-release/npm` + OIDC tokenless publish**~~ **RESOLVED in D3:** v13 supports it
   natively (see §4). No direct `npm publish` needed.
4. **When to push** the feature branches (George pushes when ready). Note: merging to main now also
   arms auto-publish (§4).
5. **Adopt `@george43g/robustness` before the EQ-Stack merge?** (see §5 — their recommendation is
   yes-if-merge-is-months-away, no-if-weeks; the merge timeline is the deciding input.)
6. **Fix the tsx dev-spawn hazard?** (see §5 — `mcp-dev-proxy.ts` default cmd is a 1-line local fix;
   `opencode.json` must be fixed in dotfiles' `.mcp.json` + renderer or it regenerates back.)

---

## 8. How to work here (workflow + verification)

- **Build:** `npm run build` (clean `dist/` + `tsc`). **Tests:** `npm test` / `pnpm test` (vitest,
  tests live next to source `*.test.ts`). **Lint:** `pnpm lint` (biome). **Typecheck:**
  `pnpm typecheck`. **Format:** `pnpm format` (biome write).
- **CLI usage artifact:** when Commander commands/help change, `pnpm run gen-usage` then
  `pnpm run gen-usage -- --check` (drift fails CI). `usage.kdl` is generated — never hand-edit.
- **e2e:** `pnpm test:e2e` (fixture mode against `fixtures/gmail/{work,personal,full}/`). Run when
  touching bootstrap / account / dispatch surfaces.
- **Stress:** `npm run stress` (dispatcher/lifecycle/transport changes).
- **Full gate before wrapping a phase:** `pnpm verify` =
  `lint && typecheck && test && build && gen-usage --check && package:check && audit:prod && stress && test:e2e`.
- **Adding a dep:** `pnpm add <pkg>` **then** `npm install --package-lock-only` (sync both lockfiles).
- **Fixtures:** synthetic only (`@fixture.test` / `.test`); the denylist guard must stay green.
- **MCP stdout rule:** never write to stdout after the stdio transport opens — logs go through
  `src/robustness/logger.ts` (NDJSON + ring buffer), never `console.*`.
- **Catalog counts to keep in sync** if you add/remove a tool: e2e `tests/e2e/cli-binary.test.ts`
  asserts **34** (work) and **36** (full); `AGENTS.md` header + fixture section state the counts.
- **Green baseline to preserve:** 926 unit + 23 e2e, stress 10/10.

---

## 9. Where the Claude-session docs live (for George's resume)

These are George's **private** Claude-Code docs (outside the repo; contain real personal details —
never commit them anywhere). A takeover agent generally can't read them; this HANDOFF.md is the
self-contained substitute. On the Claude-session resume, reconcile any changes here back into them.

- Roadmap (source of truth for the Claude session): `~/.claude/plans/steady-doodling-cloud.md`
  (top **STATUS** block).
- Full context handoff: `~/.claude/plans/gmail-mcp-handoff-2026-07-23.md` (§0.5 "IMPLEMENTATION
  PROGRESS" is read-first).
- Auto-memory index + notes: `~/.claude/projects/-Users-george-repos-Gmail-MCP-Server/memory/`
  (`MEMORY.md` index; notes incl. `npm-oidc-trusted-publishing`, `contacts-mcp-deferred`,
  [redacted on tracking — one note name that encodes the business catch-all domain],
  `gmail-multiaccount-summary-preference`, `visual-env-editor-quirk`, `handoff-2026-07-23`).

---

## 10. Keeping this doc current

**Update this file as you work** so the next agent (and George on resume) lose nothing:
- When you start/finish a task, update [§1 Snapshot](#1-snapshot-status-at-a-glance) and
  [§3](#3-whats-done) / [§4](#4-next-task--d3--phase-0-release-automation).
- Log new ideas/decisions/blockers under [§5](#5-deferred-tasks--ideas-nothing-lost) /
  [§6](#6-decisions-locked) / [§7](#7-open-questions-for-george) as they arise.
- If you make changes but **can't sign the commit**, record exactly what changed + the intended
  commit message here (or in a `*-commit-msg.txt` file) so George can commit it cleanly.
- Append dated one-liners below.

### Change log
- **2026-07-27** — Handoff created after D2 (`71113cf`). Paused on weekly-usage limit; Codex taking
  over until reset. Next: D3 (Phase 0 release automation, via OIDC).
- **2026-08-21** — Claude session resumed (Codex made no roadmap changes; only the MCP-config
  commit landed from the dotfiles session, left unformatted → fixed). **D3 done** + folded the
  `.gitignore` handoff-ignore + security override bumps (fresh advisories since July; both audits
  clean). Q3 (OIDC plugin support) resolved. New §5 items from the `mcp-cli-toolkit` peer session:
  shared-packages adoption recommendation + tsx signal-relay hazard.
- **2026-08-21 (night) — George's go-ahead: merge/push/refactor.** (1) Auto-release DISABLED
  (`release.yml` dispatch-only; provenance/trusted-publishing bind to repo identity → first publish
  under EQ-Stack). (2) Branch history rewritten pre-push to scrub the business-name domain from
  test fixtures (case-insensitive verified; all commits re-signed). (3) Everything merged to
  `main` + PUSHED: A–D3, Phases 1&2 (P2's confirm-send reconciled with D2's breadcrumb threading).
  (4) **Shared-kit refactor**: `@george43g/robustness@0.9.0` adopted wholesale (src/robustness/
  deleted; setLogFilePrefix + once-guarded getShutdownCause marker; health-snapshot seam for
  consumer tests; stress 10/10 proves the contract), `tui-kit@0.4.1` targeted
  (truncateToWidth/visualWidth/padToWidth), **mcp-kit deferred** — 2 contract conflicts (no ctx
  injection; JSON-stringified text envelope) + 2 absent features (scope gate, async auth
  remediation) filed as upstream work orders with exact shapes. (5) CI infra fixes: ci.yml GAL
  type-fork fixed via `googleapis-common@8.0.1` override; main's ruleset dropped
  required-status-checks (Actions app can't be a bypass actor on a personal repo) so the
  screenshots auto-commit + future release pushes work — deletion/force-push protection retained.
  (6) Repo was already public; pre-push scans found + fixed the one personal-data leak.
  (7) tsx hazard FIXED in dev configs (`0bdada2`: proxy default + opencode.json + local .mcp.json →
  `node --import tsx` via the mise shim). (8) CI follow-through: biome pinned EXACTLY at 2.5.9
  (`024309a`) — npm lock had 2.5.9 vs pnpm's 2.4.14 under `^`, and the minors format differently,
  failing CI lint on locally-clean files (lesson: formatter versions must be lockstep across dual
  lockfiles). Screenshots run on `70b9a07` failed only on a benign non-fast-forward race with the
  tsx-fix push; re-dispatched. (9) AGENTS.md MCP section: retired-renderer pointer replaced with
  `mcpsync sync --scope project` + the dotfiles session's inverted-source caveat (fresh clones:
  hand-recreate gitignored `.mcp.json`; never `mcpsync import` — the `.bin/tsx` resurrection
  vector).
  (10) Toolkit session shipped the snapshotHealth seam as **robustness 0.10.0 via
  starter-template PR #71 — GEORGE'S MERGE = PUBLISH, his call**. Kit ranges widened to
  `>=0.x <1` (`116a375`) so it lands here automatically (caret-on-0.x would starve forever);
  trade-off: lockfile regens can pull breaking 0.x minors — the verify gate is the guard.
  When 0.10.0 arrives: collapse `src/core/health-snapshot.ts` to
  `snapshotHealth(counters, readWatchdogState())` and mock the barrel. mcp-kit: George's
  publish criterion (per toolkit relay) says fix-the-shape-first — both our seams
  (late-bound context, `{text?, structured}` envelope) accepted as design input, designed
  against all four consumer repos, not tonight. `padToWidth` contributed to the shared
  TUI-primitives negotiation (suggested `fitToWidth` composition).
  (11) **George merged PR #71 → robustness 0.10.0 published + consumed here** (`e35a9bb`):
  seam file deleted, call sites pass `readWatchdogState()` into the real `snapshotHealth`,
  state-driven tests restored. **pnpm-11 resolver finding** (configured in
  pnpm-workspace.yaml): default `minimumReleaseAge` quarantine excludes fresh publishes from
  RANGE resolution (exact bypasses) — defeats the real-time-fix workflow with `pnpm install`
  saying "up to date"; fixed via `minimumReleaseAgeExclude: ["@george43g/*"]` (protection kept
  for the rest of the registry). Reported upstream; toolkit confirmed + landed it in the
  template (their PR #74). A second claimed finding (`resolutionMode: lowest-direct` default)
  was **WRONG and retracted** (`a76d115`) — toolkit disproved it on 10.29.3, and my own
  bisection agreed on re-read: the quarantine masquerades as floor-pinning.
  (12) **tui-kit 0.5.0 consumed** (`37be062`): both call sites collapsed to `fitToWidth`
  (built to our contributed spec, the `<= n` invariant property-tested upstream, post-condition
  `=== n`), local `padToWidth` util deleted — same pattern as the health seam. Docs caveat:
  width model ≠ every terminal's ambiguous-width table. Their `navReduce` structured query on
  our reducer/keymap is still coming; `splitNavChunk` may slot into `resolveKey` — evaluate
  when queried, not before.
- **2026-08-22 — EQ-Stack migration kicked off (George's order).** Plan agreed with the eqstack
  session (matches their recorded ITER-12 shape); kit-starvation bump landed first (`66986bf`);
  Phase-1 import branch cut (`gmail-import @ 294cd2b`, 195 commits, denylist-proved) and handed
  off; P3 release-path findings banked. Full detail: **§11**.

---

## 11. EQ-Stack migration — ✅ COMPLETE (2026-08-22, gmail-cli-mcp session)

> **LANDED: EQStack PR #122 merged as `1cc19a0`, all 5 checks green first try** (build-test,
> gmail Verify, Package Smoke incl. consumer-side npm audit, Screenshot Check, stress-linux).
> Release run verified no-op ("Released 0 of 1 packages" — private:true holding; no new tags;
> npm untouched). Advisory-fix PR #123 followed (`pnpm audit --fix=update`: version-specific
> one-shot age excludes, NO overrides, prod audit ZERO; voice's starved ws re-resolved; my
> tsx-guard ENOENT-hardening suggestion shipped in it). eqstack's review added one fix commit
> `9442365`: kit deps → explicit caret pins per the settled fleet policy (see below).
> Old repo marked frozen (`32a53ec` banner on README + AGENTS.md, pushed); **canonical home is
> now `~/repos/EQStack/apps/gmail-mcp`** — do not develop in this checkout. Remaining
> George-gated: old-repo ARCHIVE; publish re-enable (checklist in EQStack app AGENTS.md).
> Next work per George: contacts tui/cli/mcp factorisation + competitive repo comparison —
> design round WITH the eqstack session (imsg contacts code untouched by migration, as agreed).
>
> **Contacts-arc inputs from eqstack's identity survey (verified by me 2026-08-22, file:line
> in the EQStack tree; fold into the arc, NOT standalone PRs):**
> 1. Duplicate `parseEmailAddresses` exports with incompatible contracts — reply-all-helpers.ts:16
>    (`string[]`, hand-rolled) vs email-export.ts:60 (`ParsedAddress[]`, RFC lib); send.ts imports
>    one, messages.ts the other. CONFIRMED.
> 2. Address-unwrap consolidation: 3 parsers + 1 validator (NOT 4 parsers — utl.ts:28
>    `validateEmail` deliberately preserves the original string so sent headers keep display
>    names; validate-via-lib OK, never rewrite). Consolidation shape = email-export's
>    strict-RFC-parse + never-fail fallback. Real bug supporting it: reply-all's
>    `/<([^>]+)>/` corrupts quoted display names containing `<` into recipient lists.
> 3. Email redaction: robustness logger redacts every line by default (MCP_LOG_REDACT on) but
>    the RULESET covers phones+secrets only — emails are not a redacted shape. Live exposure
>    narrow (17 log sites, none address-bearing; error payloads are the leak path). Fix is a
>    KIT rule (email analog of lastFour = local-part truncation) via eqstack's negotiation;
>    app-side boundary redaction is fallback.

**George's directive (verbatim):** "kick off the EQ-Stack merge … work collaborate with eqstack
agent (message that agent first and agree on a plan you collaborate on, then perform the migration.
try to retain git history. after the migration, the very next priority will be to refactor or
factorise contacts tui/cli/mcp, and to compare yourself to a few online repos i found, where you
will need to absorb all good features to 'overtake' them - very large design improvements upcoming,
so need to get the foundations solid".

**Agreed plan (negotiated with the eqstack session — it matches THEIR recorded ITER-12 decision
of 2026-08-09, HANDOFF §12 in ~/repos/EQStack):**
- History: `git filter-repo --to-subdirectory-filter apps/gmail-mcp` on a scratch clone → eqstack
  merges `--allow-unrelated-histories`. Signature loss on 195 rewritten commits accepted (cosmetic;
  flag to George at PR — his veto point). Tags stripped (v1.2.x/v2.0.0 stay in this repo).
- Destination `apps/gmail-mcp`; package stays `@george43g/gmail-mcp`. **msr tag format will be
  `@george43g/gmail-mcp-v<semver>`** (msr force-overrides per-package tagFormat with the root's
  global `--tag-format` — their hard-won lesson; the baseline tag George pushes at publish-enable
  MUST match that format exactly or msr computes 1.0.0).
- Baton-pass phases, strictly serial, never both editing EQStack concurrently:
  **P1 (me, DONE):** rewritten branch ready — scratch
  `<session scratchpad>/gmail-mcp-rewrite`, branch `gmail-import`, HEAD `294cd2b` (= rewrite of
  main `66986bf`), 195 commits, tree rooted at `apps/gmail-mcp/`. Denylist proof sent (matches
  ONLY the guard files `schemas.test.ts` + `AGENTS.md` — the enforcement literals, already public;
  0 domain matches; 0 HANDOFF files). Scratch is regenerable deterministically if it evaporates.
  **P2 (eqstack, DONE):** merged as `d11cdb4` + wiring `aa22ac2`/`06637e5` on branch
  `feat/gmail-mcp-migration`; they independently reproduced the denylist proof.
  **P3 (me, in THEIR tree, DONE 2026-08-22):** seven signed commits `5dd6ad4`→`228b576`;
  **root `pnpm verify` EXIT 0 at `228b576`** incl. gmail lint/typecheck/826-unit/build; app-extra
  gates all green in-workspace (usage-drift, stress 10/10, e2e 23/23, package:check 115 files).
  Key deltas: private:true gate; identity → EQStack (+directory for provenance); **bundling
  DROPPED** (SDK ≥1.30 declares `^1.19.9 || ^2.0.5`, both arms audit clean — the "patched SDK"
  apparatus was obsolete; check-package now asserts nothing bundles); all audit pins dissolved
  except scoped `googleapis>googleapis-common: 8.0.1` (type-fork, verified single-GAL); per-app
  msr .releaserc (semantic-release-pnpm, no tarballDir — usage.kdl ordering); root gmail-ci.yml
  (Node-24 verify + tarball-on-Node-20 smoke + consumer-side npm audit as the blocking security
  gate; docker dropped per their veto) + gmail-screenshots-check.yml (check-only); app
  .githooks/.github/commitlint/opencode.json deleted; broken `.cursor/mcp.json` symlink deleted
  (it ENOENT'd imsg's repo-wide tsx-inventory guard — the one root-verify failure, diagnosed +
  fixed `495e03c`); AGENTS.md rewritten for the monorepo. Baton returned to eqstack for
  review + push + PR. **Workspace advisory situation is EQSTACK'S lane:** 62 pre-existing vulns
  (fresh Aug-21 advisories, fixes quarantined by pnpm's default minimumReleaseAge) hit all three
  apps via the MCP SDK dep tree; their decision = `pnpm audit --fix` (writes scoped overrides +
  advisory-scoped quarantine excludes; all floors same-major, verified) in THEIR OWN PR
  immediately after the migration merges — sequenced to avoid a lockfile-conflict trap. Until
  then my app's `audit:prod` is documented-red (workspace-wide by design); the BLOCKING security
  gate is gmail-ci's consumer-side npm audit. My earlier "pins dissolve" claim was
  npm-frame-only — CORRECTED in-flight (quarantine blocks pnpm from the fresh fixes).
- Their amendments accepted: overrides SCOPED not global (their `ws` veto — voice-mcp's Twilio
  gateway runs ws 8.21.3, no downgrades); commitlint hook DROPPED from migration (propose
  separately later); my CI → app-scoped `.github/workflows/gmail-ci.yml` path-filtered to
  `apps/gmail-mcp/**` (their root ci.yml is imsg-centric + gates releases); screenshots →
  check-only model (auto-commit REJECTED: bot pushes to main strand their serial releases);
  migration commit ships **`"private": true`** (their release.yml runs msr on EVERY main push —
  private is the only off-switch); `.releaserc.json` per-app.

**P3 worklist (planned):** private:true; repository.url→EQStack + `directory: "apps/gmail-mcp"`;
delete app-level pnpm-lock.yaml + package-lock.json + pnpm-workspace.yaml + .githooks/ +
commitlint.config.js + .github/ (inert history); remove `packageManager` field (root corepack
pnpm@11.1.1 wins); engines stays >=20.6 (agreed); root gmail-ci.yml (docker job fate: ask);
screenshots-check path filter; keep biome/tsconfig/vitest APP-LOCAL for the migration (converge
to @eqstack/* config packages later, deliberately).

**P3 findings banked tonight (tested, not speculation):**
- `pnpm pack` HARD-ERRORS on bundleDependencies under the default isolated linker.
- `npm pack` from a pnpm-layout tree DOES bundle (verified via `--json`: 677 SDK files) **but
  drags 3355 `node_modules/.pnpm/*` store files into the tarball** — a pnpm-layout pack is
  publish-poison. (Published 2.0.0 + CI packs came from npm trees — clean.)
- **The bundling may be obsolete:** it exists to force `@hono/node-server` 2.0.11 into the SDK
  (SDK declares ^1.19.9; 1.x had the advisory). Scratch audit tonight: `@hono/node-server@1.19.17`
  → **0 vulnerabilities** — the 1.x line is fixed. So P3 proposal: drop the override + drop
  bundleDependencies + update check-package.ts/ci smoke asserts → standard pnpm release path,
  no bespoke staging. Wire-contract change for consumers → flag at PR for George. Re-test ALL
  audit pins (@hono/node-server, body-parser, qs, ws, fast-uri, hono, ip-address,
  googleapis-common) against fresh resolution — most may drop the same way (ws pin already
  contradicts EQStack's resolved 8.21.3; googleapis-common 8.0.1 pin is a TYPE-fork fix, not an
  advisory — likely stays, but scoped).
- pnpm `parent>child` override selectors may only match DIRECT deps — verify empirically before
  relying on scoped pins for deep transitives.
- **P3 FIRST-INSTALL CHECK (toolkit, 2026-08-22):** after the first merged-tree `pnpm install`,
  verify kit versions FROM DISK per app (`node_modules/@george43g/<kit>/package.json`), not from
  specifiers. EQStack's lockfile already holds robustness ≤0.10.x satisfying my `>=0.9.0 <1` —
  pnpm may REUSE that entry for the new gmail importer, silently pulling my freshly-proven 0.11.0
  back down (the retained-entry class striking cross-app). If stale: two-step at workspace root +
  hand-restore ranges. (Also: their apps' `^0.10.0` carets are themselves starving — eqstack's
  side, already flagged to them.)
- **Method caveat (toolkit):** absence-by-grep is valid only for confirmed literals. Function
  names in robustness are literals; env-knob names are NOT (constructed as `key("LOG_KEEP_FILES")`
  with prefix prepended — `MCP_LOG_KEEP_FILES` never appears verbatim in source). Never "prove"
  an env knob unwired by grepping for it.
- EQStack facts from their reply: signed commits YES (machine-level, automatic); NO active LFS
  (their .gitattributes disables filters on *.db by design); vitest include convention at
  packages/vitest-config/vitest.shared.ts:14; fixtures synthetic + generated + gitignored (house
  law); pnpm 11.1.1; releases strictly serial (one PR → wait for Release run → next).

**Kit starvation (fixed here pre-migration, `66986bf`):** comparator ranges only take newest on
FIRST resolution; existing satisfying lockfile entries are retained forever (pnpm AND npm).
Two-step fix: `pnpm update <kits>` then HAND-RESTORE the comparator ranges (update rewrites them
to carets = re-armed starvation), `pnpm install`, verify from disk. npm side: same retention;
force via `npm update --package-lock-only` in an isolated dir (npm does NOT caret-rewrite).
Now on robustness 0.11.0 (pruneLogs — log dir no longer unbounded; MCP_LOG_KEEP_FILES) +
tui-kit 0.5.1 (NaN fail-open fixes incl. fitToWidth). Full verify green at `66986bf`.
**⚠ POLICY SUPERSEDED 2026-08-22 (fleet-wide; toolkit WITHDREW its comparator-range advice with
lockfile evidence):** kit deps now use **explicit caret pins** (`^0.11.0` style), bumped
explicitly and verified from disk — a comparator range floats only on first resolution, then the
retained lockfile entry starves silently while the manifest LOOKS like it floats; an honest pin
plus explicit bumps beats the illusion. Applied in EQStack by eqstack's `9442365` (resolution
verified unchanged). The old "`>=0.x <1`, caret locks the minor" trap line in the checkpoint
below is WITHDRAWN — do not re-apply comparator ranges. The old repo's `66986bf` manifest keeps
the ranges; it freezes at archive time (canonical manifest now lives in EQStack).

**After the migration (George's stated next priority):** factorise contacts across tui/cli/mcp +
absorb features from repos George found ("overtake them"). Constraint agreed with eqstack: the
migration must NOT touch imsg's contacts code (apps/imsg-mcp/src/contacts-db.ts,
conversation-merge.ts, thread-slug.ts; invariants: apps/imsg-mcp/docs/CONTACT_MERGE_AND_SLUGS.md —
read before the design round). Factorisation shape = design negotiation with eqstack at the table
(tui-kit-primitives pattern: primitives-not-monolith, likely a packages/-level contacts core);
nothing in the migration pre-commits its shape.

---

## Pre-compaction checkpoint — 2026-08-22 (gmail-cli-mcp session)

> **Precedence: where this checkpoint and any conversation summary disagree, this file is
> correct.** The summary narrates; this states what is true now.

### State
All planned work + three kit round-trips shipped and verified: `main @ ba530da` (origin == local,
tree clean, CI + Screenshots green); every remaining item is George-gated or upstream-gated.

### Constraints (verbatim, George, 2026-08-21 night — standing until revoked)
- "you have my permission to merge, push, etc..."
- "I'd disable the publish pathway for now, (but still test etc...)" — publishing stays OFF
  until the EQ-Stack migration (release.yml is workflow_dispatch-only; manual dispatch = REAL release).
- "ensure that there's nothing sensetive or private in git or git history"
- "work with the starter repo to achieve a clean refactor - tui kit, mcp kit, robustness - if the
  latest version of one of these libs lacks a feature, or the feature is broken, you can report it
  to that agent and discuss a solution"
- Goal guardrails: "dont pick up new tasks without checking with me first"; on blockers "simply
  pause and ask me to fix it".
- Earlier standing rules still hold: 1Password-signed commits; conventional commits
  (commit-msg hook); no real data in fixtures.

### Done
See §3 table + change-log items (1)–(12) above — every entry carries its SHA. Verification anchor:
`pnpm verify` exit 0 at `37be062` (826 unit, stress 10/10, e2e 23); CI green on origin for
`531233e→ba530da` tips (the one red, lint on `70b9a07`/`0bdada2`, was the biome skew, fixed `024309a`).

### Open
- **Contacts spike** — never attempted; needs George's direction + interactive TCC testing (§5).
- **mcp-kit adoption** — blocked upstream by design: toolkit is negotiating the seams (late-bound
  context, `{text?, structured}` envelope, scope gate, error interceptor) against all four consumer
  repos; George deprioritized it (per toolkit relay). Do not vendor meanwhile.
- **Dev-tree Dependabot vulns (~52)** — deliberately deferred: fixing means the dep majors
  George's policy defers (zod 4, nodemailer 8, mcp-evals 2, TS 6). His call.
- **`navReduce` structured query** from mcp-cli-toolkit — announced, not yet received. Answer with
  verbatim `src/tui/reducer.ts` + `src/tui/keymap.ts` + line refs, per querying-peer-agents.
- **EQ-Stack merge** — George's action; this repo is ready (see State).

### Corrections
- The `resolutionMode: lowest-direct` claim was WRONG — retracted at `a76d115`; the pnpm-11
  `minimumReleaseAge` quarantine was the entire mechanism. Do not re-add the line.
- All pre-push local hashes in older notes (`8d5bdd0`, `71113cf`-era descendants) are GONE —
  history was rewritten (re-signed) before first push to scrub a business-name domain.

### Traps (each cost real time tonight)
- pnpm 11 quarantines fresh publishes from RANGE resolution by default; `pnpm install` says
  "up to date". Fix: `minimumReleaseAgeExclude` for own scope (in pnpm-workspace.yaml, commented).
- pnpm's live override source is `pnpm-workspace.yaml`, NOT package.json, and no install variant
  invalidates the lockfile when overrides change.
- npm's arborist crashes regenerating package-lock beside pnpm's symlinked node_modules —
  regenerate in an isolated dir with only package.json.
- Formatters must be exact-pinned across dual lockfiles (biome ^2.4.14 → npm got 2.5.9, minors
  format differently, CI-only lint failure).
- Caret on 0.x locks the MINOR; kit ranges use `>=0.x <1`.
- The tsx CLI wrapper SIGKILLs a busy child 30ms after relaying a signal — spawn via
  `node --import tsx` (and never grep for it with a line-level node_modules filter).
- `googleapis-common` 8.0.2+ exact-pins google-auth-library → duplicated-GAL type fork under npm.
- A case-sensitive scrub misses mixed-case variants; verify with `grep -i` across `git rev-list`.
- GitHub personal-repo rulesets cannot grant the Actions app bypass; required-status-checks there
  blocks every bot push.

### Tree
Repo `Gmail-MCP-Server`, branch `main @ ba530da` == `origin/main`, working tree clean (0 dirty
paths, all mine). Feature branches retained on origin for review trail. Local `.mcp.json`
(gitignored) carries the fixed node-launcher shape.

### Blocked on you (George)
Contacts direction · dev-dep majors go-ahead · EQ-Stack merge timing · re-enabling release.yml
after migration (remember: `repository.url` must match the new repo, provenance requires public).

### Resume
No mid-flight state: no background tasks, no staged work, no half-applied edits, no unanswered
peer query. Next action = whatever George directs (likely EQ-Stack migration support). If the
toolkit's `navReduce` query arrives first, answer it as specced in Open. This file is
gitignored BY DESIGN (repo rule: never commit HANDOFF.md to the public repo) — it survives
compaction on disk; do not commit it.

*(Superseded 2026-09-04 — see the publication note at the top of this file. The gitignore rule
above was the standalone gmail repo's; this redacted copy is tracked in EQStack by George's
decision so the record outlives one laptop.)*
