#import "@preview/fletcher:0.5.8": diagram, node, edge
#set page(paper: "a4", margin: (x: 1.6cm, y: 1.8cm), numbering: "1")
#set text(size: 9.5pt)
#set heading(numbering: "1.")
#show link: set text(fill: rgb("#1a5fb4"))
#show raw: set text(size: 8.5pt)

#align(center)[
  #text(size: 18pt, weight: "bold")[openclaw org crawl: what EQStack should take]\
  #text(size: 10pt)[Research wave R3, 2026-10-08. Sources: #link("https://github.com/orgs/openclaw/repositories")[github.com/orgs/openclaw/repositories], shallow clones under `scratchpad/research/r3/c`. Diagrams: Typst + fletcher 0.5.8 (d2, dot, mmdc are not installed).]
]

= Executive summary

The org holds *95 repos* (listing pulled with `gh repo list openclaw --limit 500`, 2026-10-08). 65 are openclaw-internal infrastructure and are ignored. Most of the value is a *family of local-first Go "crawl" CLIs* for messengers, a few TypeScript libraries that fit EQStack's stack, and a Node-compat fork of Bun. Licences are MIT for 86 of 95 repos.

*Ranked recommendations*

+ *Bun: do not adopt the fork. Spike upstream Bun 1.4.2 as a dev and CI tool only.* Upstream `oven-sh/bun` is itself written in Rust from 1.4.x, so "the Rust Bun" is just current Bun. The openclaw fork is a Node-compat patch queue (396 commits ahead, 7 behind, prerelease-only builds). Measured today: the imsg-mcp napi addon loads under Bun; *better-sqlite3 does not* (`'better-sqlite3' is not yet supported in Bun`); Ink renders; Vitest runs. See @bun.
+ *`wacli` (WhatsApp): thin wrapper.* New `apps/whatsapp-mcp` that spawns `wacli --read-only --json`. Effort M. Closest thing in the org to a messenger MCP source. Meta ToS risk, see @risks.
+ *`fs-safe`: vendor as an npm dependency.* Root-bounded filesystem handles for attachment export and any tool that takes a relative path. Effort S.
+ *`mcporter`: skill or script around it.* Calls our own MCP servers from scripts and CI and can emit standalone CLIs. Effort S.
+ *`clawpdf`: vendor as an npm dependency* for PDF attachment text and page PNGs in the media-intel path. Effort S.
+ *`agent-skills`: cherry-pick skills* through `link-repo-skills`. Effort S.
+ *`clawdex`, `imsgcrawl`, `crawlkit`: study only,* as input to the contacts-factorisation arc and the archive design. Effort S.
+ *`gogcli`, `telecrawl`: skill or script,* only when Calendar/Drive or Telegram are wanted. Effort S each.

_Not analysed here:_ `openclaw/imsg` and `openclaw/openclaw` (R1a/R1b). `imsg` is listed in the table for completeness.

= Landscape

#figure(
  diagram(
    node-stroke: 0.6pt, node-inset: 5pt, spacing: (14mm, 9mm), node-corner-radius: 3pt,
    node((0,0), [*Messenger crawlers* (Go)\ wacli, wacrawl, telecrawl,\ discrawl, slacrawl,\ imsgcrawl, clawdex], fill: rgb("#d8f0d8")),
    node((1,0), [*Messenger Swift/TS*\ imsg (R1), crabline\ (mock servers)], fill: rgb("#d8f0d8")),
    node((2,0), [*Agent tooling*\ mcporter, acpx, lobster,\ agent-skills, turnwire,\ clawscan, Peekaboo], fill: rgb("#d8e4f8")),
    node((0,1), [*Shared kits*\ crawlkit (Go)], fill: rgb("#f0f0d0")),
    node((1,1), [*TS libraries*\ fs-safe, clawpdf,\ ffmpeg-wasm, rastermill,\ libopus-wasm], fill: rgb("#f8e4d0")),
    node((2,1), [*Runtime*\ bun (fork), WebKit (fork)], fill: rgb("#f0d8d8")),
    node((0,2), [*Apple/Google CLIs*\ gogcli, remindctl,\ goplaces, spogo], fill: rgb("#eeeeee")),
    node((1,2), [*openclaw internals (ignored)*\ platform, infra, plugin SDK,\ docs, bots: 60+ repos], fill: rgb("#eeeeee")),
    edge((0,1),(0,0), "->", label: [used by], label-side: left),
  ),
  caption: [Repo landscape grouped by category. Green: messenger-relevant. Blue: agent tooling. Orange: libraries. Red: runtime.]
)

= How the picks plug into EQStack

#figure(
  diagram(
    node-stroke: 0.6pt, node-inset: 5pt, spacing: (13mm, 10mm), node-corner-radius: 3pt,
    node((0,0), [`apps/imsg-mcp`], fill: rgb("#e8e8e8")),
    node((1,0), [`apps/gmail-mcp`], fill: rgb("#e8e8e8")),
    node((2,0), [`apps/telephony-mcp`], fill: rgb("#e8e8e8")),
    node((3,0), [*`apps/whatsapp-mcp`* (new)], fill: rgb("#d8f0d8")),
    node((3,1), [`wacli` binary\ (Go, external)], fill: rgb("#f8f8c8")),
    node((0,2), [`fs-safe` (npm dep)], fill: rgb("#f8e4d0")),
    node((1,2), [`clawpdf` (npm dep)], fill: rgb("#f8e4d0")),
    node((2,2), [`mcporter` (script/CI)], fill: rgb("#d8e4f8")),
    node((0,3), [`packages/*` shared config], fill: rgb("#e8e8e8")),
    node((2,3), [`.agents/skills`\ from `agent-skills`], fill: rgb("#d8e4f8")),
    edge((3,0),(3,1), "<->", label: [spawn, NDJSON], label-side: left),
    edge((0,0),(0,2), "->", label: [attachment export]),
    edge((0,0),(1,2), "->", label: [pdf text], label-pos: 0.3),
    edge((2,2),(0,0), "->", label: [calls], label-pos: 0.5),
    edge((2,2),(1,0), "->"),
    edge((2,2),(3,0), "->"),
  ),
  caption: [Proposed wiring. Only whatsapp-mcp is new code; the rest are dependencies or scripts.]
)

= Full triage table

All 95 repos. Columns: repo, category, language, stars, last push, licence (fork parent), relevance (H/M/L), verdict and effort, note. Verdict key: vendor = take as dependency or workspace package; wrapper = thin MCP/TS wrapper; skill = skill or script around the binary; study = read, do not adopt; ignore. Rows marked "not inspected" rely on the GitHub description only. Rows for `imsg` and `bun` point to other sections.

#import "rows.typ": rows
#set text(size: 7pt)
#table(
  columns: (2.6cm, 1.7cm, 1.4cm, 0.9cm, 1.6cm, 1.5cm, 0.6cm, 1.5cm, 1fr),
  inset: 3pt, stroke: 0.3pt + gray,
  table.header([*repo*],[*cat.*],[*lang*],[*stars*],[*pushed*],[*licence*],[*rel.*],[*verdict*],[*note*]),
..rows,
)
#set text(size: 9.5pt)

= Deep dives

== Messenger crawlers (Go, one family)

`wacli`, `telecrawl`, `imsgcrawl`, `discrawl`, `slacrawl`, `wacrawl`, `clawdex` share the same shape: read a local or linked-device source, mirror into SQLite, expose search and send, offer `--json`, release signed Homebrew binaries. They sit on `crawlkit` (store, snapshot, backup, tui, vector, worker packages; `crawlkit/` @ 2cb2f08). Go 1.27+ is required to build. All are Go, so none can be a workspace package; the integration unit is the *binary*.

*wacli* (@ 8fe6a5a, MIT, ~71k lines Go incl. tests): WhatsApp Web protocol through whatsmeow, pairs as a linked device, `--read-only` and `WACLI_READONLY=1`, `--json` for one-shot commands and `--events` for NDJSON lifecycle events (`wacli/README.md:61-74`). Needs CGO and the `sqlite_fts5` tag to build from source; Homebrew and release archives avoid that. *Recommendation: thin wrapper (M).* A TypeScript MCP that shells out to `wacli` mirrors how EQStack already shells out elsewhere, keeps granular control over which verbs are exposed (default read-only, send gated by the repo's "confirm before sending" rule), and avoids owning a WhatsApp protocol stack. Unknown: whether `--json` output is versioned/stable; whether concurrent invocations are safe on one store.

*imsgcrawl* (@ 14a0b73, ~8k lines): read-only SQLite snapshot of `chat.db`, bounded commands, archive (`imsgcrawl/internal/{archive,sqlitesnapshot,messages}`). Overlaps imsg-mcp, which is more featureful. *Study only (S):* compare the snapshot approach with our fixtures-vs-real-DB boundary.

*clawdex* (@ 8b18778): contacts crawler into a private git-backed markdown repo. Relevant to the contacts factorisation work but a different storage model. *Study only (S).*

*telecrawl* (@ e3444f3): reads Telegram Desktop `tdata` and macOS Postbox, age-encrypted GitHub backups. *Skill (S)* if Telegram history is ever wanted. *discrawl/slacrawl/wacrawl:* study only, no current EQStack channel.

*crabline* (@ 3d0cbee, TypeScript, pnpm, Node 22, MIT): deterministic local mock providers for 12 channels including `imessage` and `whatsapp`, with JSONL recorders. Its mocks target OpenClaw channel plugins, so they do not substitute for our fixtures directly. *Study only (S):* the recorder and nonce-roundtrip pattern is a good model for telephony-mcp and a future whatsapp-mcp test harness.

== Agent tooling

*mcporter* (v0.14.2, Node >=24, MIT, `mcporter/package.json`): "TypeScript runtime and CLI for discovering and calling MCP servers"; exports `.` and `./cli`. Fits EQStack's runtime exactly. *Skill or script (S):* use it to smoke-test `.mcp.json` servers from CI and to generate a CLI for imsg-mcp that agents can call without MCP context cost. Alternative would be to vendor as a devDependency; keeping it as an external tool avoids version coupling.

*turnwire* (@ 24d9d1f, Go): signed, policy-guarded MCP relay between two environments; exposes only `send_message`/`receive_message`/`confirm_delivery`. Directly relevant to CLAUDE.md's thread-isolation rules. *Study only (S).*

*acpx* (v0.19.4): headless ACP client, persistent sessions. *Study only (S);* relevant to delegating-work but overlaps the existing `bus` and SendMessage conventions.

*agent-skills* (@ 7e73306): shared SKILL.md workflows, e.g. `autoreview`, `agent-transcript`. *Cherry-pick (S)* into `.agents/skills/` with `link-repo-skills --check`; review each for repo-specific paths first.

*Peekaboo* (Swift, ~637k lines, MIT): screenshot, accessibility, UI automation, with an MCP launcher. Overlaps `shot`, `mirroir` and the computer-lease flow. *Study only.*

== Libraries

*fs-safe* (`@openclaw/fs-safe`, ~192k lines incl. tests): capability-style roots, like Go `os.Root`; `root()` returns a handle that rejects `..` and symlink escapes. *Vendor as npm dependency (S)* for `export_messages`, `get_attachment` and any path-taking tool. Unknown: the exact published version and Node floor (README only checked).

*clawpdf* (v0.3.3, Node >=22, ~3k lines): PDFium WASM, no native addons, extracts text and PNG pages. *Vendor as npm dependency (S).* Fits the "no postinstall" posture and works on cloud agents.

*ffmpeg-wasm* (`@steipete/ffmpeg-wasm-local`, LGPL FFmpeg core): *study only.* Native ffmpeg is already available on the Mac; WASM only helps on cloud boxes. *libopus-wasm, rastermill, proxyline, libterminal:* ignore or study (rastermill not inspected beyond its README header).

== Google and Apple CLIs

*gogcli* (@ 4d7478e, ~320k lines): one client for Gmail, Calendar, Drive, Docs, Sheets with explicit account routing and safety controls. gmail-mcp already covers Gmail, so *skill or script (S)* for Calendar/Drive only; compare its safety controls with gmail-mcp's. *remindctl:* skill (S) if wanted.

= Bun runtime and the Rust fork <bun>

== What the fork is

#table(
  columns: (auto, 1fr), inset: 4pt, stroke: 0.3pt + gray,
  [Repo], [#link("https://github.com/openclaw/bun")[openclaw/bun], fork of `oven-sh/bun`, created 2026-09-14, 2 stars, @ 42bd1d2],
  [Divergence], [`gh api compare`: 396 commits ahead, 7 behind `oven-sh/bun` main],
  [Releases], [22 tags such as `openclaw-v1.4.3-20261008-42bd1d282a-webkit-cb8d6f202b`; the latest four are prereleases; assets are darwin/linux x64+arm64 zips plus `SHA256SUMS`. No Windows asset, no stable release, `releases/latest` returns 404],
  [Nature], [Node-compat patch queue (`CHANGELOG.md`: `Error.prepareStackTrace`, `vm.Script` cached data, `node:v8.queryObjects`, `module-sync` condition, stack columns), mostly adapting upstream PRs. Pairs with `openclaw/WebKit`, a fork of `oven-sh/WebKit`. Changes defaults: auto-install is off (`docs/runtime/nodejs-compat.mdx`)],
  [Licence], [GitHub reports NOASSERTION (upstream `LICENSE.md` bundles third-party terms incl. JSC LGPL parts); unknown beyond that],
)

*Key correction to the premise:* the fork is not a Rust port. Upstream `oven-sh/bun` is already Rust: `gh api repos/oven-sh/bun` reports language Rust, its `AGENTS.md` says "written primarily in Rust with C++ for JavaScriptCore", and the checkout has 1,547 `.rs` files and `rust-toolchain.toml` pinned to `nightly-2026-09-15`. Upstream stable is `bun-v1.4.2` (2026-09-05); 1.4.0 shipped 2026-08-20. The Bun installed here via mise is 1.3.14, which predates the Rust line.

== Measured compatibility (this machine, 2026-10-08)

Installed `bun@1.4.2` from npm into the scratchpad and ran against the real addon and deps in `apps/imsg-mcp` (read-only; nothing written in the repo). Node is v24.15.0.

#table(
  columns: (auto, auto, 1fr), inset: 4pt, stroke: 0.3pt + gray,
  [*Item*], [*Result under Bun 1.4.2*], [*Evidence*],
  [napi-rs addon `native/imsg-native.darwin-arm64.node`], [*Loads*; exports `resolveContacts`, `parseAttributedBody`, same as Node], [`require()` smoke test only; behaviour and perf not compared],
  [`better-sqlite3` 12.x], [*Fails*: `error: 'better-sqlite3' is not yet supported in Bun.` (`ERR_DLOPEN_FAILED`); Node works], [`new Database(":memory:")` smoke test],
  [`node:sqlite` `DatabaseSync`, `bun:sqlite`], [Both work], [smoke test; API parity with our queries untested],
  [Ink 7 + React], [Renders `<Text>` in a non-TTY run], [raw-mode, resize and input in a real TTY *untested*],
  [Vitest 3], [One trivial test passes under `bun --bun`; 0.95 s vs 1.02 s wall on Node], [real suite (1,165 tests) *not run*],
  [Startup `-e 0`], [~0.00 s vs 0.02 to 0.03 s (10 ms timer granularity)], [3 runs each],
)

Bun's own docs quote `bun:sqlite` as "roughly 3-6x faster than better-sqlite3" for reads (`docs/runtime/sqlite.mdx:33`), a vendor claim not reproduced here.

== Recommendation for `bun-runtime-eval`

*Verdict: do not adopt the openclaw fork; run a time-boxed spike on upstream Bun 1.4.2, scoped to development tooling, not to the published runtime.*

+ Fork: binaries are nightly prereleases, tied to a particular WebKit build, two stars, no Windows build, behaviour changes on defaults. EQStack publishes `imsg-mcp` to npm for Node (`engines.node >=24`), so runtime fidelity to Node matters more than raw speed. Revisit only if a specific Node-compat bug blocks the upstream build.
+ Blocker 1: `better-sqlite3` cannot load. Moving to Bun means rewriting the storage layer onto `bun:sqlite` or `node:sqlite`. Do the `node:sqlite` migration first, behind the existing fixtures, because it is runtime-neutral and removes a native rebuild step (`rebuild` script, `package.json`). Unknown: FTS5, read-only open flags and prepared-statement API parity with imsg-mcp's usage.
+ Keep the napi addon: it loads, so the Rust crate stays; Bun is not a reason to remove it. Measure its throughput under both runtimes before claiming a win.
+ Keep Vitest on Node for the release gate; optionally trial `bun --bun vitest` for local watch speed. Do not move to `bun test` (different API).
+ Ink TUI: requires an interactive TTY check (raw mode, resize, 700-message stress drive already in the repo) before any claim.
+ Concrete spike (half a day): pin Bun 1.4.2 with mise on a branch; time `pnpm build`, `pnpm test`, `pnpm typecheck` and TUI startup on both runtimes, three runs each; record in `docs/STATUS.md`. Success bar: at least 30% wall-clock gain on a task developers wait on, with identical test results. Otherwise close the item.

= Risks and licences <risks>

- *Licences:* 86 of 95 repos are MIT (GraphQL `licenseInfo`). Exceptions: Apache-2.0 (`caclawphony`, `esp-openclaw-node`), CC0 (`flawd-bot`), NOASSERTION (`bun`, `nix-openclaw`), none (`casa`, `WebKit`, `clawgrit-reports`, `endor-clawsweeper-e2e`). Every repo recommended above is MIT. `ffmpeg-wasm` wraps an LGPL FFmpeg core.
- *Platform terms:* wacli and wacrawl use unofficial WhatsApp Web access via whatsmeow and say they are not affiliated with Meta; account bans are possible. Telegram and Discord archivers read local client data.
- *Privacy:* Any messenger wrapper must keep the repo rule: no real personal data in tracked files, confirm before sending, UUID-tagged threads.
- *Maintenance concentration:* pace is very high (most repos pushed within 24 hours of this crawl) and mostly from a small group; APIs may churn. Pin exact versions, per the repo's `.mcp.json` policy.
- *Toolchain:* the Go tools need Go 1.27+ and, for wacli from source, CGO plus FTS5; prefer release binaries and verify checksums.
- *Supply chain:* these repos publish to npm and Homebrew; apply the repo's seven-day release-age practice.

= Unknowns

- Stability and versioning of `--json` output in wacli, telecrawl, imsgcrawl.
- Whether `fs-safe` and `clawpdf` published versions match their repo HEADs.
- Real-suite behaviour of EQStack under Bun (tests, TUI in a TTY, napi throughput).
- `node:sqlite` parity with imsg-mcp queries.
- Fork licence text for `openclaw/bun` beyond GitHub's NOASSERTION.
- Rows marked "not inspected" in the table (about 40 repos were judged from descriptions and names only).
- Star counts and push dates are a snapshot from 2026-10-08.
