# HANDOFF — Monorepo conversion (✅ COMPLETE 2026-08-03)

> **Read this first.** This is the live handoff for converting `imsg-mcp` into a monorepo. It is
> self-contained on purpose — do **not** rely on any agent's private memory; everything you need is
> here or in the linked repo docs.
>
> **Who / why:** The primary agent (Claude, in a long-running session) is temporarily rate-limited.
> Another agent (**Codex**) is picking up the monorepo work for a couple of days. George will resume
> the original session once usage resets. **Keep this doc updated** — it is the shared source of
> truth across the handoff. Append to the Progress Log (§11) after every meaningful step.
>
> _Created 2026-07-27 · repo at `main` @ `30d0ea4` = **v1.19.0**._

---

## 1. Mission & scope

Convert the single-package `imsg-mcp` repo into a **pnpm-workspaces + Turborepo monorepo**, so it can
host a future second app (a channel-agnostic **relationship-analysis tool**). This handoff covers the
**structural conversion only** — NOT building the analytics app.

**IN scope for this handoff:**
1. Monorepo shell (workspace glob + `turbo.json`).
2. Move the entire `imsg-mcp` package wholesale into `apps/imsg-mcp/`.
3. Adopt the 3 shared **config** packages from the template (`tsconfig`, `biome-config`, `vitest-config`).
4. Reconcile version skew (the real one is **Vitest 2 → 3**).
5. Fix cwd/path assumptions the move surfaces.
6. CI + release reconcile (keep **single-package** semantic-release targeting the imsg app).
7. Scaffold a **blank second app** placeholder (empty shell, proves the structure end-to-end).

**OUT of scope (waits for George):**
- The **suite rename** and final npm scope — see §4 (George's decision).
- Extracting `robustness` / `mcp-kit` / `cli-kit` / `tui-kit` packages — deferred (YAGNI) until the
  analytics app needs them. George will paste the analytics research + plan; **then** we decide which
  packages to refactor out and write stage-by-stage implementation docs.
- Any analytics **domain** code.

**Template (retrofit source):** `/Users/george/repos/mcp-cli-starter-template` — a pnpm-workspaces +
Turborepo starter that explicitly names imsg-mcp as a retrofit target. Scaffolder CLI: `apps/scaffolder`
(bin `mcp-scaffold`; commands `init`/`apply`/`plan`/`migrate`/`add-mcp-app`/`list`). Shared config
packages to adopt: `packages/{tsconfig,biome-config,vitest-config}`. Reference `turbo.json`,
`pnpm-workspace.yaml`, `.github/workflows/ci.yml`.

Full rationale + the corpus-boundary design notes live in
[`docs/MONOREPO_MIGRATION.md`](docs/MONOREPO_MIGRATION.md) — read it before touching structure.

---

## 2. Current state

- **On `main`** @ `60ff99a` = **v1.19.2** (npm). Working tree clean except untracked scratch
  (`.codex/`, `docs/research/*`) — **never** commit those.
- **New root files since the Desktop detour (v1.19.1/1.19.2), all move WITH the package:** tracked
  `manifest.json`, `icon.png`, `assets/` (mcpb extension identity) +
  `scripts/stage-native-deps.mjs`, `scripts/mcp-dev-proxy.ts`; the `pack:mcpb` npm script stages
  `manifest.json package.json icon.png` cwd-relative. `release/` is a gitignored build artifact
  (pattern matches at any depth — still covered after the move).
  (`scripts/hot-deploy-ext.mjs` was deleted 2026-08-03 — `mcpsync deploy` replaced it.)
- The **feedback backlog #212–218 is DONE** across 5 releases (this is why we're free to restructure):
  | Item | PR | Release |
  |---|---|---|
  | 3 TUI bugs (#212–214) | #41 | v1.15.1 |
  | search_contacts ranking (#215) | #42 | v1.16.0 |
  | get_messages scope + over-match fix (#216) | #43 | v1.17.0 |
  | list completeness metadata `truncated`/`totalAvailable` (#217) | #44 | v1.18.0 |
  | identity block + E.164 (#218) | #45 | v1.19.0 |
- **Package identity today:** name `imsg-mcp`, single bin `imsg` (`./dist/cli.js`),
  `packageManager: pnpm@11.1.1`, `type: module`, `engines.node >=24`.
- **Tooling versions today:** `vitest ^2.0.0`, `@biomejs/biome ^2.0.0` (2.4.4), `@types/node ^20.0.0`.
  **No `turbo`** dependency yet. **No `turbo.json`** yet.
- **`pnpm-workspace.yaml`** currently has only `allowBuilds` / `ignoredBuiltDependencies` /
  `onlyBuiltDependencies` / `overrides` (incl. `overrides: imsg-mcp: 'link:'` — a self-link; watch it
  when moving into `apps/imsg-mcp/`). **No `packages:` glob** → single-package today.
- **`.releaserc.json`** present (single-package semantic-release config).
- **`CLAUDE.md` is a symlink to `AGENTS.md`** — edit `AGENTS.md` only; both stay in sync.
- **Branches:** only `main` + one stale legacy branch `cursor/development-environment-setup-690b`
  (old Cursor-cloud AGENTS.md edit, unmerged — ignore or drop).

---

## 3. Decisions LOCKED (do not re-litigate)

From `docs/MONOREPO_MIGRATION.md` + the 2026-07-26/27 planning session:

1. **Template-guided, MANUAL conversion.** Run `mcp-scaffold apply --target …` **dry-run only** (the
   default) to get a `RETROFIT.md` checklist, then hand-apply in stages. **NEVER pass `--execute`**
   against this shipping product.
2. **Minimal package extraction now** — only the 3 config packages. Defer the kit/robustness packages.
3. **Keep the `IMSG_*` env prefix** (do NOT rename to the template's `MCP_*`).
4. **Keep single-package semantic-release** targeting the imsg app. (Multi-package releasing is a
   *later* decision, when the analytics app actually ships.)
5. **The published npm package stays `imsg-mcp`.** The suite rename (§4) affects the GitHub repo /
   brand + internal private-package scope only — NOT the installed package name. This is what makes the
   rename cheap and reversible.
6. **Move the imsg package wholesale as ONE unit** (`git mv` in one shot): `src/`, `native/`, `tests/`,
   `scripts/`, `vite.config.ts`, `tsconfig.json`, `biome.json`, `package.json`, `.env.*`, fixtures,
   **and the mcpb extension files: `manifest.json`, `icon.png`, `assets/`** (the `pack:mcpb` script
   references them cwd-relative — they stay valid only if they move together).
   Tests keep their `../src/...` relative imports (they move together). `native/` must stay a sibling of
   built `dist/` — `src/native-bridge.ts` hardcodes `join(__dirname, "..", "native")`.

---

## 4. OPEN QUESTIONS — need George (do NOT decide these unilaterally)

**Q1 — Suite name. ✅ ANSWERED (2026-07-30): George chose `EQStack`.**
Repo/brand → **EQStack** (the GitHub repo rename itself is still George-triggered on resume); internal
private-package scope → **`@eqstack/*`** (use directly, or find-replace the `@repo/*` placeholder if
already used); the Desktop-extension `display_name` is already **"EQStack — Messages MCP"**. The
published npm package stays **`imsg-mcp`**. Original options considered (kept for history):

| Name | Repo / brand | Internal scope | Read |
|---|---|---|---|
| **humanstack** *(Claude's rec)* | `humanstack` | `@humanstack/*` | Reads as a coherent suite/platform; brandable; likely available. |
| **humans** | `humans` | `@humans/*` | Cleanest, matches the convention exactly. Risk: very generic; name/scope likely taken. |
| **humans-tools** *(George's first idea)* | `humans-tools` | `@humans-tools/*` | Explicit; `-tools` suffix + scope a bit clunky. |
| **kith** | `kith` | `@kith/*` | "kith and kin" = one's people. Distinctive, short, available. Cost: obscure word. |

**Q2 — Analytics research/plan.** George will paste the deep-research plan + analysis (done by a
separate agent swarm) into the repo. That unblocks the package-extraction decisions and the analytics
app implementation docs. Until then, do not design the corpus boundary or analytics domain.

> **Codex: Q1 is answered — use `@eqstack/*` for the private config packages directly** (or
> find-replace it in if you already started with `@repo/*`), and scaffold the blank app under a
> neutral dir (e.g. `apps/analysis`). **Do NOT** rename the GitHub repo — George does that on resume.
> Record what you used in the Progress Log.

---

## 5. What Codex can do NOW vs what's BLOCKED

**Do now (unblocked):** everything in §6 Phase A + B + C, using the `@repo/*` placeholder scope and a
placeholder blank-app dir. Land it as normal PRs.

**Blocked on George:** the actual GitHub repo rename, the final internal scope, the analytics app's
real name + any analytics domain work.

---

## 6. Phase checklist

Tick these off in-place (`[x]`) and log each in §11. Group into **2–4 PRs** (suggested split marked).
Each phase: foreground `pnpm lint && pnpm typecheck && pnpm test` + `pnpm test:no-native`, CI
`build-test` green, signed commit, branch → PR → **merge (not squash)**.

### PR-A — shell + move
- [x] **A0.** Dry-run the scaffolder (read-only): from the template repo,
      `node apps/scaffolder/dist/cli.js apply --target /Users/george/repos/imsg-mcp --existing-strategy full --name imsg --yes`
      (dry-run is default — **no `--execute`**; add `--report-json <path>` for the machine-readable list).
      **Pre-verified 2026-08-03:** the default `safe` strategy yields **0 retrofit intents / 25 skipped**
      (useless here) — `full` is the one that emits the real checklist: **18 would-apply · 8 skipped ·
      10 divergent-preserved · 0 failed**, repo untouched. ⚠️ The `full` list **overshoots the locked
      scope** (it includes the deferred robustness/env-loader/secrets/cli-kit/tui-kit/mcp-kit/shared-types
      packages — §3.2 says config packages only): use it as a *reference map*, hand-apply **only the §6
      subset**. Record the recap in the Progress Log.
- [x] **A1.** Monorepo shell: extend `pnpm-workspace.yaml` with `packages: ["apps/*", "packages/*"]`.
      Add root `turbo.json` (build / typecheck / lint / test / test:no-native pipeline; mirror the
      template). Root becomes a private workspace root. Reconcile the existing
      `overrides: imsg-mcp: 'link:'` self-link with the new layout.
- [x] **A2.** Move the package wholesale into `apps/imsg-mcp/` (one `git mv` unit — see §3.6). Keep
      `native/` a sibling of `dist/`. Verify tests still resolve `../src/...`.

### PR-B — config packages + version skew
- [x] **B1.** Adopt `packages/{tsconfig,biome-config,vitest-config}` from the template (scope
      `@eqstack/*` — Q1 answered). Point `apps/imsg-mcp/{tsconfig.json,biome.json,vitest/vite config}` at them.
- [x] **B2.** Reconcile version skew: **Vitest 2 → 3** (the one real one). Align Biome (2.4.4 →
      template's 2.5.3) if adopting shared config; `@types/node` 20 → 24. Re-run full suites both engines.
- [x] **B3.** Fix cwd/path assumptions the move surfaces (see §8).

### PR-C — CI/release + blank app
- [x] **C1.** Update `.github/workflows` to drive builds/tests via turbo; the macOS `build-test` job
      stays THE gate. Confirm `.releaserc.json` still targets the imsg app (single-package,
      root-orchestrated). Verify a release still cuts correctly (or is a no-op for docs).
- [x] **C2.** Scaffold the blank second app: `mcp-scaffold add-mcp-app <name>` into `apps/analysis`
      (placeholder name). Empty shell only — no domain code. Confirm it builds/tests under turbo.
- [x] **C3.** Re-link the global binary: `pnpm add -g apps/imsg-mcp`; smoke `imsg --version` / `--help`,
      the MCP dev server (`node dist/cli.js mcp` / `pnpm mcp`), and the TUI (against `fixtures/chat.db`
      — never the real DB).
- [x] **C3b.** Re-point every consumer of the old absolute paths (see §8 second block):
      `.mcp.json` (then re-render `opencode.json` via
      `node ~/dotfiles/mcp/render.js --manifest .mcp.json --opencode opencode.json`) and the
      **Claude Desktop manual `mcpServers.imsg-mcp` entry** (`claude_desktop_config.json` — back it up
      first; Desktop needs a full Quit + reopen; note Desktop has silently emptied `mcpServers` before,
      re-check after writing).
- [x] **C4.** Docs pass: refresh `docs/STATUS.md` to the current release, flip
      `docs/MONOREPO_MIGRATION.md` from ACTIVE→DONE, write the Grafana/Prometheus deferred idea (§10)
      into both, update `AGENTS.md`.

---

## 7. Ops & process rules — CRITICAL, follow exactly

These repeatedly bite. Mirrors `docs/STATUS.md` "Carry-forward gotchas" + "Standing constraints".

- **1Password SSH signing re-locks after a timeout** (`error: 1Password: failed to fill whole buffer`).
  **Never skip signing** (no `--no-gpg-sign`). When locked mid-flow: save the commit message to a scratch
  file and retry `git commit -F msgfile` after George unlocks. Don't rebase signed commits (re-sign loops).
- **`gh` CLI intermittently auth-times-out** on the macOS keychain. `git push` uses a different
  credential and keeps working. Fallbacks that need neither keychain nor local signing: read CI via the
  **public** REST API (`GET /repos/{owner}/{repo}/commits/{sha}/check-runs`); merge via
  `PUT /repos/{owner}/{repo}/pulls/{n}/merge` `{"merge_method":"merge"}` with `$GH_TOKEN` + curl.
  Build PR JSON with `jq -n --rawfile body …`. **After a REST merge, `git fetch origin`** before diffing —
  the local `origin/main` tracking ref goes stale.
- **Release serialization.** semantic-release triggers on push to `main`. Merge (**not** squash) so commit
  types drive versioning (`fix`=patch, `feat`=minor, `docs`/`chore`/`refactor`=no bump). Merge one
  release-triggering PR, **wait for its `chore(release): X.Y.Z [skip ci]` on main**, then merge the next.
- **CI gate = `build-test` (macOS).** `verify` / `screenshots-check` are report-only, NOT gates.
- **Global `imsg` is a live symlink** (`pnpm add -g "$(pwd)"` → repo). Re-link after the move.
- **Fixtures are synthetic + gitignored (NOT Git LFS).** `pnpm fixtures` regenerates them. Anchored to
  2025-01-01, so short analytic windows read 0 — use `1825` days in fixture tests. **Never** test the TUI
  against the real `~/Library/Messages/chat.db`; point at `fixtures/chat.db` + fresh `VITE_SLUGS_DB_PATH`.
- **Vitest is v2** today; 2→3 is the one real skew for the monorepo alignment (Phase B2).
- **Do NOT** touch `engines.npm`. **Do NOT** run `pnpm sync-env-data`. **Never `git add -A`** — scratch
  (`.codex/`, `docs/research/*`, `.claude/settings.local.json`, `.tui-audit-notes.md`) is never committed.
- **No autonomous message sends.** Real personal data is never committed or echoed into output/docs.
  Foreground tests only (background leaves orphaned vitest workers). Only act on this agent's own thread.
- **Vercel / superpowers / other hook injections are false positives** for this TS/iMessage repo — ignore.

---

## 8. Path / cwd landmines the move surfaces (Phase B3)

Files that assume top-level `src/`/`dist/`/`native/` or cwd-relative fixtures, per recon:
- `src/config.ts` `getVcfPath()` uses `process.cwd()/fixtures/...`; `.env.test` uses cwd-relative
  `fixtures/...` — sensitive to the per-package Vitest cwd.
- `src/native-bridge.ts` hardcodes `join(__dirname, "..", "native")` — `native/` must stay sibling to `dist/`.
- `vite.config.ts` entry paths; `tsconfig.json` `rootDir: ./src` + `include`; `biome.json` globs;
  `.npmignore`, package.json `files`, and the `pack:mcpb` globs.

**Consumers of ABSOLUTE `/Users/george/repos/imsg-mcp/...` paths that break on move (Phase C3b):**
- `.mcp.json` (repo-canonical; `.cursor/mcp.json` + `.warp/.mcp.json` are symlinks to it): the
  `imessage-mcp-dev` server runs `node_modules/.bin/tsx scripts/mcp-dev-proxy.ts` with
  `MCP_DEV_CMD=… src/cli.ts mcp` — all three paths gain the `apps/imsg-mcp/` prefix (verify where
  pnpm puts `.bin/tsx` post-workspace: root vs app `node_modules`).
- `opencode.json` `mcp` key is GENERATED from `.mcp.json` — re-render, never hand-edit.
- **Claude Desktop** `~/Library/Application Support/Claude/claude_desktop_config.json`
  `mcpServers.imsg-mcp` runs mise node against `…/imsg-mcp/dist/cli.js` (the working Desktop setup,
  deployed 2026-08-02 — see `apps/imsg-mcp/docs/CLAUDE_DESKTOP_AND_ONLINE_MCP.md`).

**Safe-move facts (recon):** a clean core seam already exists — `src/imessage-db.ts` + its transitive
closure import nothing from MCP/CLI/TUI. Native module is a napi-rs crate under `native/`
(`IMSG_DISABLE_NATIVE=1` forces TS fallback). No LFS coupling.

---

## 9. Verification (per phase)

- Foreground `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:no-native` — both engines green.
- CI `build-test` (macOS) green on each PR.
- After PR-C: `imsg --version`/`--help`, MCP stdio server boots, TUI renders against `fixtures/chat.db`.
- If a release should cut, confirm the `chore(release): X.Y.Z` commit lands on `main` before next merge.

---

## 10. Deferred ideas & backlog (nothing lost)

- **NEW deferred idea — home-lab observability.** The analytics app should be able to interface with
  personal/home observability stacks — **Grafana + Prometheus** (and similar): e.g. expose
  relationship/messaging metrics as a Prometheus-scrapeable endpoint (or pushgateway) so users build
  Grafana dashboards over their own corpus. **Not yet designed — George to flesh out.** (Also being
  written into `docs/STATUS.md` deferred + `docs/MONOREPO_MIGRATION.md`.)
- **Analytics app corpus boundary** (for when George pastes the research): normalized channel-agnostic
  export as the boundary; the engine is a corpus *consumer*, not welded to chat.db. Shared surface listed
  in `docs/MONOREPO_MIGRATION.md` §"What the analytics tool will consume".
- **Existing parked backlog** lives in [`docs/STATUS.md`](docs/STATUS.md) §Backlog: 20 remaining analytics
  types; god-file deep splits (needs greenlight); tsconfig strict flags; stress-harness→CI; account
  diagnostics; `wrapUntrusted` on structuredContent; streamable-HTTP transport; shell completions;
  contact-resolver persistence; Media-Intel tails (T3 bulk download; SIP route = NO-GO/closed).

---

## 11. Progress Log (append-only — every agent updates this)

> Format: `YYYY-MM-DD · agent · what changed · branch/PR · state`. Newest at the bottom.

- 2026-07-27 · Claude · Created this handoff. Repo finalized on clean `main` @ v1.19.0 (swept 29 merged
  branches). No monorepo work started yet — Phase A0 is the next action. Awaiting George on Q1 (suite
  name) and Q2 (analytics research), but Codex can run Phases A–C with `@repo/*` placeholder scope.
- 2026-08-02 · Claude · **Detour, not monorepo work** (phases still unstarted; A0 remains next):
  Claude Desktop `.mcpb` crash root-caused — Desktop runs `type:node` extensions on Electron's node
  (abi 146) with **no in-process SQLite** (no better-sqlite3 prebuild, no `node:sqlite`) →
  **v1.19.1** shipped (node:sqlite fallback + stderr observability + packaging + branding);
  **v1.19.2** adds Electron detection + fingerprint diagnostics. Desktop works via a **manual
  `mcpServers` entry on system node**; end-user distribution decision = **bun `type:binary`**
  (deferred). Full story: `apps/imsg-mcp/docs/CLAUDE_DESKTOP_AND_ONLINE_MCP.md`. **Q1 ANSWERED: suite = EQStack
  (`@eqstack/*`)** — §4 updated. Cross-host MCP config tooling prototyped (dotfiles `mcp/` +
  `mcpsync.mjs`); to be replaced by a proper tool — absorption inventory:
  `apps/imsg-mcp/docs/plans/mcp-config-sync-tool.md`. Also recorded: remote-MCP idea (StreamableHTTP + tunnel +
  OAuth), realtime-streaming plan (`apps/imsg-mcp/docs/plans/realtime-streaming-and-api-surface.md`).
- 2026-08-03 · Claude · **Pre-flight readiness pass — migration cleared for execution** (no phase
  boxes ticked; A0 stays the executor's first action). Verified the A0 dry-run end-to-end: scaffolder
  is built; `--existing-strategy safe` = 0 retrofit intents (useless), **`full` = 18 would-apply ·
  0 failed**, target repo untouched — A0 instructions updated with the working invocation + scope
  warning. Amended this doc for the v1.19.1/1.19.2 detour fallout: §2 refreshed to v1.19.2, §3.6
  move unit now includes `manifest.json`/`icon.png`/`assets/`, new §8 block lists absolute-path
  consumers (`.mcp.json` → opencode re-render, Claude Desktop manual entry), new **C3b** re-pointing
  step. Q2 note: George's analytics research sits in untracked `docs/research/*` — still not formally
  handed over; irrelevant to Phases A–C (extraction stays deferred). No open blockers for A0–C4.
- 2026-08-03 · Claude · **PR-A DONE (A0–A2)**: A0 official dry-run re-run (full: 18 would-apply ·
  0 failed). Workspace shell landed: `packages: [apps/*, packages/*]`, root `turbo.json`
  (ui stream, envMode loose; test tasks cache:false), private root `package.json` (name `eqstack`,
  turbo ^2.10.7; root scripts fan out via turbo, app entry points delegate `pnpm -C`). Package moved
  wholesale into `apps/imsg-mcp/` (322 renames) INCLUDING README/CHANGELOG/llms-install/skills +
  app docs (screenshots web) — repo-level docs (`STATUS.md`, `MONOREPO_MIGRATION.md`, `research/`)
  stay at root; new root README. Extras the move forced: app-local `.gitignore` (biome
  `useIgnoreFile` discovers it next to biome.json — `vcs.root` did NOT work), override re-pointed
  `link:apps/imsg-mcp`, `repository.directory` added, `hook:install` hoisted to root, minimal CI
  edits (npm-pack workdir, stress artifact path, screenshots-check paths, pre-push hook prefixes),
  release.yml semantic-release now runs `working-directory: apps/imsg-mcp` (releaserc paths stay
  package-relative). `.mcp.json` re-pointed + `opencode.json` re-rendered (C3b partially done —
  Claude Desktop entry still pending). Verified: turbo build (TS+Rust), lint, typecheck,
  **936/936** native + full suite no-native + Rust 21/21, `npm pack --dry-run` (47 files incl.
  README), MCP stdio serves initialize @1.19.2.
- 2026-08-03 · Claude · **PR-B DONE (B1–B3)**: `packages/{tsconfig,biome-config,vitest-config}`
  adopted under **`@eqstack/*`** (template files, `workspace:*` deps). App tsconfig extends
  `@eqstack/tsconfig/react.json` with overrides: `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`
  **off** (+155 errors measured — stays in the STATUS "tsconfig strict flags" backlog) and
  `lib: [ES2022]` (Ink ≠ browser; react preset's DOM lib collides with @types/node 24 Buffer/BlobPart).
  Skew: **Vitest 2.1.9 → 3.2.7** (zero test changes needed), Biome 2.4.4 → **2.5.6** (12 new
  findings — code fixed, not rule-disabled; SVG got a `<title>`, one justified biome-ignore),
  @types/node 20 → 24. B3: no cwd fixes needed — vitest/tape/fixture paths all resolve at the app
  cwd (verified by green suites post-move). **936/936 both engines** on the new toolchain.
- 2026-08-03 · Claude · **PR-C DONE (C1–C4) — MIGRATION COMPLETE.** C1: workflows already drive
  everything through root turbo scripts since PR-A (build-test stays THE gate; semantic-release runs
  in `apps/imsg-mcp` — its "no release" no-op to be confirmed on the next main push). C2: blank app
  `apps/analysis` (`@eqstack/analysis`, private) hand-scaffolded — the scaffolder's `add-mcp-app` was
  NOT used (it generates deps on template runtime packages `mcp-kit`/`robustness` that §3.2
  deliberately excludes); shell has full template strictness ON, builds/typechecks/lints/tests under
  turbo (2 packages orchestrated). C3: global `imsg` re-linked (`pnpm add -g ./apps/imsg-mcp` →
  1.19.2), CLI + MCP initialize + headless TUI stress (5s, PASS) all smoked. C3b: Claude Desktop
  `mcpServers.imsg-mcp` re-pointed to `apps/imsg-mcp/dist/cli.js` (backup taken; boot-tested with
  Desktop's exact command; Desktop was running → needs full Quit+reopen). C4: STATUS/-MIGRATION
  flipped to DONE, AGENTS.md monorepo banner + layout, all root-doc links to moved app docs
  rewritten, root skills.md pointer updated. PRs: #50 (A), #51 (B), #52 (C).
- 2026-08-03 · Claude · **EQStack RENAME — prep commit (PR #53, merged `922e71e`).** gitignored
  `.codex/` + `.turbo/` (`docs/research/*` deliberately left untracked per George); HANDOFF record +
  resume protocol for the rename. Prep landed on the still-named `imsg-mcp` repo before the
  filesystem/GitHub rename.
- 2026-08-05 · Claude · **EQStack RENAME — EXECUTED & VERIFIED (George-triggered).**
  **Canonical path is now `/Users/george/repos/EQStack`** with a back-compat symlink
  `~/repos/imsg-mcp → EQStack` (kept as the safety net for any path not yet repointed — e.g.
  `~/.claude.json` session state, deliberately not hand-edited). GitHub repo renamed
  `george43g/imsg-mcp` → **`george43g/EQStack`** via `gh repo rename` (old slug redirects, verified);
  `git remote origin` → `git@github.com:george43g/EQStack.git`. **npm package stays `imsg-mcp`.**
  Configs repointed to the new path: `.mcp.json` (+ `opencode.json`), `.codex/config.toml`, Claude
  Desktop `mcpServers.imsg-mcp`; global `imsg` re-linked (`pnpm add -g ./apps/imsg-mcp`). `.turbo`
  cache cleared. **Verified from the new path:** cold `pnpm build`/`typecheck`/`lint` green + **936/936
  imsg-mcp + 1/1 analysis** tests. Gotchas found & fixed: (1) Claude Desktop had **self-regressed** its
  entry to the pre-monorepo path `…/imsg-mcp/dist/cli.js` on reopen — corrected to
  `…/EQStack/apps/imsg-mcp/dist/cli.js` (Desktop not running → loads next launch); (2) `.codex/config.toml`
  was stale from the monorepo move (root `scripts/`/`src/`) — fixed to `apps/imsg-mcp/…`;
  (3) **`~/dotfiles/mcp/render.js` no longer exists** (retired with mcpsync, `bcb8451`) so
  `opencode.json` was rewritten directly — **AGENTS.md/CLAUDE.md still tell agents to run that deleted
  script** (§"MCP servers (project scope)") = stale, needs a fix. **⚠️ npm OIDC follow-up owed by
  George:** the release uses an OIDC Trusted Publisher bound to `george43g/imsg-mcp` + workflow file —
  the GitHub rename changed the OIDC `repository` claim to `george43g/EQStack`, so the **next**
  `semantic-release` publish fails auth until the Trusted Publisher config on npmjs.com is updated to
  the new repo name (manual UI step; not API-scriptable). package.json/manifest `repository`/`homepage`
  URLs still say imsg-mcp (GitHub redirects) — cosmetic.
- 2026-08-05 · **Parallel work in the tree (NOT this agent's — do not clobber/commit):** George is
  porting a **third app `apps/voice-mcp/`** into the monorepo (`voice-mcp` — local-first MCP +
  telephony gateway: agent-initiated Twilio ConversationRelay calls + ElevenLabs voice + OpenRouter
  LLM; private, not published). It has its OWN `apps/voice-mcp/HANDOFF.md`. Working tree currently
  carries its untracked dir + `README.md` (adds the voice-mcp row) + `pnpm-lock.yaml` edits, all
  George's — left untouched here.
- 2026-08-09 · Claude · **voice-mcp landed + per-package publishing (PRs #54, #55) — closes the
  rename follow-ups above.** (1) **`apps/voice-mcp` committed** (PR #54, `chore(voice-mcp)`) — green
  in-workspace (build/typecheck/lint + 98 tests) and stdio-MCP boot-smoked (13 `voice_*` tools);
  George's parallel work, landed on his behalf. (2) **Per-package releasing** (PR #55,
  `ci(release)`): adopted **`@anolilab/multi-semantic-release`** (`pnpm release` from repo root) so
  each published app releases only from commits touching its own path — private apps (voice-mcp,
  analysis, `@eqstack/*`) auto-skip. Chose anolilab (peer `semantic-release >=24.2.9`) over
  `@qiwi/multi-semantic-release`, which pins sr `^21` and would break our v25 plugins + OIDC.
  imsg-mcp tags are now `imsg-mcp-v${version}`; migration baseline tag `imsg-mcp-v1.19.2` pushed.
  (3) **Root cause of the red release runs found & fixed:** every Release run since the rename failed
  at `@semantic-release/github` verifyConditions with `EMISMATCHGITHUBURL` because
  `apps/imsg-mcp/package.json` `repository.url` still said `imsg-mcp` — **not cosmetic; it broke
  publishing.** Fixed package.json + manifest.json URLs → EQStack (folded into PR #55). (4)
  **render.js doc drift fixed** (this housekeeping PR): AGENTS.md/CLAUDE.md now regen opencode via
  `mcpsync -c ./.mcp.json apply --scope project --to opencode`. **npm OIDC: DONE** — George rebound
  the Trusted Publisher to `george43g/EQStack`. The post-merge Release run is now **green** and
  correctly no-ops ("Released 0 of 1"). A future 2nd published app (`gmail-MCP-server`) will be
  imported via **git filter-repo** (clean, re-pathed history) + its own `.releaserc.json`.

---

## 12. Resume protocol (for George / Claude when usage resets)

1. Read this file top-to-bottom, especially the **Progress Log (§11)** — that's where Codex records what
   it actually did.
2. **Migration DONE · repo renamed to EQStack · `apps/voice-mcp` landed · per-package publishing live
   (`@anolilab/multi-semantic-release`) · npm OIDC rebind DONE.** Only open scratch item: paste/track
   **Q2 (analytics research)** when ready — still untracked in `docs/research/`.
3. Next major arc = designing the analytics app (`apps/analysis` shell exists; its own
   spec → plan → implementation cycle, per `docs/MONOREPO_MIGRATION.md` trigger, once Q2 lands). A
   future 2nd published app (`gmail-MCP-server`) imports via **git filter-repo** + its own
   `.releaserc.json` (private → auto-skips).

---

## Links
- [`docs/MONOREPO_MIGRATION.md`](docs/MONOREPO_MIGRATION.md) — full plan, locked decisions, corpus boundary.
- [`docs/STATUS.md`](docs/STATUS.md) — project status + backlog + ops gotchas + standing constraints.
- [`AGENTS.md`](AGENTS.md) (== `CLAUDE.md`) — repo/agent guide.
- Template: `/Users/george/repos/mcp-cli-starter-template`.
- Analytics research (untracked scratch, George's): `docs/research/RELATIONSHIP_ANALYSIS_RESEARCH_BRIEF.md`,
  `docs/research/deep-research-report.md`, `docs/research/*eval*.md`.
