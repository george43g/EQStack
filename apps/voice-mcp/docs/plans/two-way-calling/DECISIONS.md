# DECISIONS — two-way agent calling

Append-only. **Nothing counts as settled until it is in this file with an anchor.**
Own your own rows; leave everyone else's exactly as found, including ones you think
are stale. To reverse a decision, move it to `## Rejected` with a reason — never
delete it, or the next agent re-proposes it three rounds later.

Anchor = a SHA, a `file:line`, command output, or a dated attribution to George.

> ⚠️ **Two kinds of date live in this file. Do not "correct" the second kind.**
>
> - **"As of now"** — e.g. WORKSTREAM.md's invariant stamps. These claim currency and
>   *are* checkable against the file's own mtime (`stat -f '%Sm %N'`).
> - **"This happened then"** — e.g. `George 2026-08-24`, `published 2026-08-28`,
>   `proven live 2026-08-02`. These deliberately refer to a past event and **should**
>   disagree with the mtime of the file recording them. Most dates below are this kind.
>
> Ask what a stamp *claims* before testing it. A blind mtime sweep over this file
> would rewrite every `George 2026-08-24` attribution to the day it was typed up,
> destroying the only fact those lines exist to carry.
>
> ⚠️ **`git blame` is worse than useless for dating anything under `apps/voice-mcp/`
> that hasn't been touched since the import.** The app arrived flattened: its earliest
> commit is `c7de878`, 2026-08-09, *"chore(voice-mcp): add telephony MCP app to the
> monorepo"*, while the code it carries was written and proven live on **2026-08-02**
> (`HANDOFF.md:44-51`) — so blame reads seven days late, in the direction that looks
> plausible. `src/gateway/session.ts` has exactly one commit and is one of these.
>
> **The tell is NOT the commit count.** `apps/voice-mcp` has **13** commits (all
> post-import), `apps/gmail-mcp` 192 (history preserved via filter-repo), `apps/imsg-mcp`
> 120 — a count threshold would wrongly clear voice-mcp. What discriminates is the
> **earliest** commit: whether its subject reads as an import, and whether its date
> postdates the work the files describe.
>
> ```
> git log --reverse --format='%h %ci %s' -- <path> | head -1
> ```
>
> *(Corrected 2026-08-29: an earlier version of this note said the app had one commit
> total. That figure was `--follow` on a single FILE described as if it held for the
> app — the same measurement-on-the-part, claimed-for-the-whole error this note warns
> about. Caught by `dotfiles [edd465]`.)*

---

## Settled

| # | Decision | Anchor |
|---|---|---|
| D-1 | Package `telephony-mcp`, bin `tel`, app dir `apps/telephony-mcp` | George 2026-08-29. `npm view telephony-mcp` → 404 (available); `voice-mcp` taken at 1.0.7 |
| D-2 | No MCP tool-name prefix; names self-describing without one | George 2026-08-29 ("get rid of the tool prefix entirely… next best after *nothing* is tel_"). Evidence hosts namespace: this session's toolset shows `mcp__tmux-rust__capture-pane` |
| D-3 | Dial allowlist deleted; any E.164 dials | George 2026-08-24 verbatim: *"if a human asks you to call a number, that means youre allowed to call it, end of story"*. ⚠️ **CORRECTED 2026-08-29 — the gate is in TWO places, not one.** (1) `src/domain/call-requests.ts:37-42` at prepare time, and (2) `src/gateway/call-service.ts:117-119` at **dial** time, which re-reads `cfg.recipients[request.recipientAlias]` and then takes `recipient.recordingPolicy` (`:135`) and `recipient.number` (`:156`) from it. The earlier "it's 6 lines" framing in the brief was wrong. Deleting only (1) yields a phase that looks shipped and dies at dial with *"recipient vanished from config"*. Verified by reading both sites |
| D-3a | **The one-shot collapse is load-bearing for correctness, not just ergonomics** | Consequence of INV-11 + D-3. `CallRequest` persists only `numberSuffix` (`call-requests.ts:54`, `lastFour(recipient.number)`) — the full E.164 never enters sqlite. So an ad-hoc number **cannot be re-read from the store at dial time**; it must stay in memory from resolve through to `telephony.createCall`. A two-stage flow + ad-hoc numbers would have forced persisting an E.164 and breaking INV-11 |
| D-3b | Idempotency key must be **HMAC with a per-install secret**, not `sha256(number)` | A bare hash of a phone number is a reversible oracle — the AU mobile space enumerates in seconds. Key lives in the 0700 state dir |
| D-4 | Ad-hoc numbers default to `recordingPolicy: "manual"` | George accepted 2026-08-29. Connects instantly, starts unrecorded. Recording is a separate axis (`src/domain/consent.ts` governs recording ONLY — it was never the dial gate) |
| D-5 | `prepare`+`start` hard-replaced by one-shot `call`; keep `dryRun` preview + idempotency; **drop TTL** | George 2026-08-29. TTL only made sense when authorisation was a separate deferred step |
| D-6 | Typed command registry; every surface a thin adapter | George 2026-08-29, with the note to explain why hand-rolled REST is replaced |
| D-7 | Daemon API = MCP-over-HTTP (`@george43g/mcp-kit`) for commands + WS for live streams | George 2026-08-29 |
| D-8 | `AdminServer` inverted, not deleted. Transport code kept verbatim: loopback bind `admin-server.ts:224`, long-poll cleanup `:183-199`, SSE redaction `:214`/`:217`, error mapping `:55-57`, body cap `:28`. `/metrics` + `/healthz` stay plain HTTP | Quality assessment 2026-08-29 |
| D-9 | Daemon = macOS launchd agent; `tel daemon` wraps launchctl. Linux parity parked | George 2026-08-29 |
| D-10 | Named Cloudflare Tunnel on a George-owned domain (not Quick Tunnel) | George 2026-08-29. Quick Tunnels mint a new hostname per restart — that churn *was* the "hack" |
| D-11 | Kit adoption gets its own first phase. Dropped customisations → TODO ledger, re-implemented in the phase where the feature is relevant, never during adoption | George 2026-08-29, to avoid re-implementing features that end up deprecated |
| D-12 | Published package **is** the app: SDK exports + bins from one package | George 2026-08-29 |
| D-13 | Live listen-in staged: text now, real-audio media fork as an isolated spike | George 2026-08-29 |
| D-14 | All four view surfaces eventually (console, TUI, web SDK + SPA); console first | George 2026-08-29 |
| D-15 | Continuity = invariants doc + this file + typed contracts landed early; every phase file opens with `## Inherited invariants` | George 2026-08-29 |
| D-16 | Cold spawn of a Claude process on inbound is allowed **with hard caps** (later phase) | George 2026-08-29 |
| D-17 | Parallel plan authoring; mostly-sequential build; spike parallel | George 2026-08-29 |
| D-18 | Edge/Worker relocation is **not** a latency fix; justified by availability only, deferred to Phase N | Latency budget in `../2026-08-24-two-way-voice-brief.md` §3. Direct-mode turn is dominated by the agent's own model turn (2–10 s) vs ~60–240 ms of network |
| D-19 | ElevenLabs agents can call our MCP server as a tool source, block 5–300 s, speak while waiting (`pre_tool_speech`), and play built-in thinking sounds | Tool schemas loaded in-session 2026-08-29: `agents_create_mcp_server` (`response_timeout_secs` min 5 max 300, `pre_tool_speech: auto\|force\|off`, `tool_call_sound: typing\|elevator1-4`) |
| D-20 | ElevenLabs can own the Twilio number natively (`TelephonyProvider: twilio\|sip_trunk\|exotel`), so modes 2/3 keep the laptop out of the media path | `agents_list_phone_numbers` schema, 2026-08-29 |
| D-21 | **Both CLIs exist and are already installed** — Phase U's CLI skill is viable and covers both. ElevenLabs: `@elevenlabs/cli`, pinned **0.5.6** via mise (`npm:@elevenlabs/cli` in `~/.config/mise/config.toml`), binary at `~/.local/share/mise/installs/npm-elevenlabs-cli/0.5.6/bin/elevenlabs`. Twilio: `twilio-cli/6.2.4` at `/opt/homebrew/bin/twilio`, `~/.twilio-cli/config.json` present. ⚠️ The installed ElevenLabs CLI is **stale — npm `@elevenlabs/cli` is at 1.1.0** (a major bump); Phase U must write against the version actually pinned, or bump the pin first | Verified 2026-08-29: `elevenlabs --version` → `0.5.6`; `twilio --version` → `twilio-cli/6.2.4`; `npm view @elevenlabs/cli version` → `1.1.0`. **Closes O-4** |

| D-22 | **13 MCP tools, not 14** | `grep -c registerTool src/mcp/server.ts` → 13; pinned at `tests/mcp.integration.test.ts:79-92`. My "14" in the brief (`2026-08-24-two-way-voice-brief.md:95`) and the approved plan is wrong. Target set of 12 = 13 − 2 (prepare/start) + 1 (one-shot) |
| D-23 | `@george43g/mcp-kit` pin **0.1.0 is stale — 1.0.0 published 2026-08-28** | `npm view @george43g/mcp-kit version` → `1.0.0`. Agent diffed the published `.d.ts`: strict superset (`+sanitizeContent`, `+CONTENT_BUDGET`; `buildDispatcher` now throws when a `devOnly` tool lacks a `devOnlyEnabled` predicate — we register none), robustness floor `>=0.12.0` which we already satisfy. `cli-kit@2.0.1` is current |
| D-24 | **O-6 is far lower risk than assumed — moving the dirs is safe.** The AES-256-GCM recording key is a **macOS Keychain item**, not path-derived | `src/stores/recording-store.ts:15-17`: `MAGIC = "VMC1"`, `KEYCHAIN_SERVICE = "voice-mcp"`, `KEYCHAIN_ACCOUNT = "recording-key"`. ⚠️ **Those three constants must stay frozen under EITHER O-6 branch** — renaming them, not moving the directory, is what would destroy the 2026-08-02 recording. Live state on disk: 2616 B config, 282 KB sqlite, one 2.7 MB `.enc` |
| D-25 | **Phase B stays behaviour-neutral; Phase C does the `prepare`+`start` merge** | Adopted from the Phase-A/B agent's counter-argument 2026-08-29. B is the most consequential phase and needs the strongest verification story — *"every operation behaves identically, only its definition moved."* Folding D-5's merge into B would make it a behaviour change wearing a refactor's clothes. Costs one extra rename in C |
| D-26 | ⚠️ **Long-poll starves the idle watchdog.** `mcp-kit`'s `startStdio` wires robustness's idle watchdog, but `noteActivity()` fires from the *dispatcher* — a host parked in a 55 s long-poll (`src/mcp/server.ts:323-329`) looks idle and could be killed **mid-call** | Why Phase A's kit adoption is necessarily partial (leaf helpers only) and dispatcher + transports land in B. Any phase adopting `startStdio` must prove the long-poll path feeds the watchdog |
| D-27 | `HIST_BUCKETS_MS` tops out at **5000 ms** (`src/gateway/metrics.ts:8`), so direct-mode turns (2–10 s) would all land in `+Inf` | Phase E must pass explicit wider buckets or its histograms are useless. `Metrics` also has **no label support**, so mode-splitting needs distinct metric names — which makes O-14's rename more expensive per series added |
| D-28 | 🐛 **Redaction asymmetry — a real INV-11 bug, not a design choice.** The SSE path redacts every event (`admin-server.ts:214`, `:217`); the `?poll=1` batch (`:205`) and `/calls/:id/events` (`:114`) return the **same events unredacted** | Same data, two paths, one redacted. Fix belongs in Phase B when the surface is unified |
| D-29 | 🐛 **`turn.assistant` carries no text** — only `{turn, chars, interrupted[, verbatim]}` (`session.ts:236`, `:253-258`) | Consequence: a live transcript needs `GET /calls/:id/transcript` for the agent's side, and **in `llm` mode neither side's words are on the stream at all**. My "live text is nearly free" claim to George was too optimistic. Cheap fix (put text on the event) is a Phase B contract decision — O-17 |
| D-30 | **Phase F is CONDITIONAL on Phase E's result**, not merely sequenced after it | Two E outcomes kill or redirect F: (a) if direct-mode p50 lands near ~1 s the bed is noise and D-18/R-1 flip; (b) if the dominant leg is **pickup** rather than **think** — plausible, since an MCP host serialises tool calls and may not be sitting in the long-poll — the fix is protocol, not audio, and masking would paper over a deletable bug. **Go/no-go: F starts only if E shows direct-turn p50 > ~1.5 s with think-time dominant** |
| D-31 | Three concrete bugs already caused by the INV-6 violation, all in `admin-server.ts` | `:128` `POST /requests {"recipient":"x"}` creates a request with `objective: ""` and dials — MCP is guarded by Zod `min(1)`, REST is not. **`:131` `{"record":"false"}` → `Boolean("false")` → `true`, turning recording ON when asked to turn it off** (verified: `node -e 'Boolean("false")'` → `true`). `:91` `?beforeMs=abc` → `NaN`, and `NaN ?? MAX` does not substitute → empty list with HTTP **200** instead of 400 |
| D-32 | Line-number corrections to my own citations | `cli.ts` serve is **59-75** (not 60-77); `watch` is **206-227** (not 207-228); `endFrame` runs to **:91** (not :90 — inherited from `HANDOFF.md:120-123`); `public-server.ts:118-125` is only the HTTP branch, the `/relay/<token>` route is the **WS upgrade handler at :72-97** (regex `:79`); `AGENTS.md` two-stage rule is **:15-18**; `2026-08-02-voice-mcp.md` "no switch without latency evidence" is **:25-28**; `schema.ts` "parse, don't guess" spans **:2-3** |
| D-33 | Stale docs found in passing | `apps/voice-mcp/AGENTS.md:24` points redaction at `src/domain/redact.ts` — **deleted**, moved to robustness. `AGENTS.md:48` says `mise run voice-mcp:check` but **no mise config exists anywhere in EQStack** (stale from life-stack). Phase A fixes both |
| D-34 | **Mode names: `direct` · `delegate` · `consult` · `byo-model`.** `CallMode = "direct" | "delegate" | "consult" | "byo-model"` | George 2026-08-29, chosen over the `self`/`delegate+consult` straw man and a shorter `live`/`agent` set. Keeps mode 1 on its **existing** literal (`src/gateway/session.ts`, `schema.ts` — zero migration for the commonest mode); `llm` → `byo-model` is the only rename. `consult` names the callback itself rather than describing mode 3 as mode 2 plus a suffix, and avoids a `+` inside a value that has to survive flags, filenames and metric names. **Closes O-2.** |
| D-35 | **PROVISIONAL — second Twilio number for ElevenLabs; existing number stays ours.** Inbound contention resolved by dedicating number #2 to EL for `delegate`/`consult`; number #1 keeps inbound for the Phase L–M routing ladder | George 2026-08-29 declined to pick and delegated: *"you may choose to ask me if i want to revise this choice later, esp if we arent affected by it for a while"*. Nothing in Pass 1 (A–G) touches it — all Pass 1 work is mode `direct`. **Revisit trigger: the first turn of Phase Q (mode 2). Re-ask George BEFORE any number is bought or any webhook repointed.** Refinement that narrowed the question: outbound calls post inline TwiML (`src/adapters/telephony/twilio-conversation-relay.ts:112`, POST at `:124`), so an outbound dial never reads the number's configured webhook — **the contention is inbound-only** and outbound can share one caller ID across all four modes. Downgrades O-1 from blocking to revisit-scheduled |
| D-36 | **Tunnel zone = `agentpipe.top`, one named tunnel, one hostname per connection TYPE** | George 2026-08-29/30: bought the domain for this purpose and directed *"you should set up multiple subdomains under the domain to separate different types of services or connections the toolkit needs to make."* Zone verified live via Cloudflare API 2026-08-30: id `70723edf90f806852c679630db5503c6`, account **George Personal + Melbourne Web Co** (`0de8624f4e34eaf3ebc22d5290d9b230`), NS `gwen`/`lex.ns.cloudflare.com`. ~~⚠️ status `pending`~~ **→ `active`, verified via API 2026-09-02** — George delegated the NS during the crash downtime; no Phase D prerequisite remains on the zone. **Closes O-9.** Scheme (Phase D implements; each is a separate `cloudflared` ingress rule): `relay.` = ConversationRelay WSS only · `hooks.` = Twilio webhooks, all `X-Twilio-Signature`-verified · `mcp.` = MCP-over-HTTP tool channel for EL agents, bearer-auth, never Twilio-signed · `assets.` = static bytes ONLY, necessarily unauthenticated (Twilio's media fetch cannot carry a signature) · `app.` reserved, NOT routed in Pass 1 (the SPA stays loopback). Rationale: cloudflared ingress, Access policies, WAF and rate limits all attach **per hostname**, so a host that serves only static bytes can be shown to have no mutating route *by construction* instead of by review — which is most of what makes O-15 safe |
| D-37 | **Daemon = LaunchAgent** (`~/Library/LaunchAgents/com.george43g.telephony-mcp.plist`, `KeepAlive` + `RunAtLoad`), not LaunchDaemon | George 2026-09-02. Decisive evidence: both secret paths shell to `/usr/bin/security find-generic-password` against the **login** keychain — opkeep cache `src/stores/secrets.ts:15-16,42-44`, recording AES key `recording-store.ts:16-17,36-41` — which a LaunchDaemon context cannot read: every secret resolves null and the D-24-frozen recording key becomes unreachable. Accepted cost: down after reboot until first login, down on logout. **Revisit gate: Phases L–M re-examine reboot-resilience before unattended inbound goes live** (auto-login variant noted there; unavailable under FileVault). **Closes O-10.** |
| D-38 | **One-shot dial tool = `place_call`**, superseding D-5's `call` on the name only (dryRun + idempotency semantics unchanged) | George 2026-09-02, chosen over `call` and `dial`. Restores INV-1 consistency: the whole family is verb_noun and self-describing without a prefix. **Closes O-11.** |
| D-39 | **Thinking-sound asset served from `assets.agentpipe.top` at the Cloudflare edge** (Worker static assets, wrangler config in-repo), NOT through the tunnel and NOT Twilio Assets | George 2026-09-02. The unauthenticated surface INV-10 worried about is static bytes at Cloudflare with no mutating route by construction; the laptop is out of the media-fetch path, so the sound also works for `delegate`/`consult` calls and survives daemon restarts. Supersedes the pre-crash agent's Twilio-Assets recommendation, which predated the zone. **Closes O-15** (O-16, what the asset *is*, stays open — taste + codec test) |
| D-40 | **State dirs migrate in Phase A**: first `tel` run moves `~/.config/voice-mcp/` → `~/.config/telephony-mcp/` and `~/Library/Application Support/voice-mcp/` → `…/telephony-mcp/` (2616 B config · 282 KB sqlite · 2.7 MB `.enc`) when the new dir is absent and the old exists; back-compat read for one release; Keychain item untouched per D-24 | George 2026-09-02, over pin-to-old-paths and fresh-start. Ordering constraint from the register note stands: **migration lands before the first `daemon install`** — the launchd plist bakes absolute paths (D-37). **Closes O-6.** |

---

## Open

**This table is the register for this workstream.** Every row carries a stable
kebab-case `slug` and an `owner` (a session name as `ListAgents` prints it). The
owner raises the item with George; other sessions do not relay it. All rows below
are owned by **eqstack** unless stated. Checkpoints reference this table rather
than duplicating it.

| # | slug · owner | Question | Whose call | Blocks |
|---|---|---|---|---|
| O-1↻ | `number-contention` · eqstack — **provisionally settled, D-35; re-ask at Phase Q start** | **Number contention.** One Twilio number can point at ElevenLabs *or* at our ConversationRelay gateway, not both. Second number, or gateway bridges to EL per call? | George | Phase Q (mode 2) and Phases L–M (inbound) |
| ~~O-2~~ | ~~`mode-names`~~ — **CLOSED 2026-08-29, see D-34.** | **Mode names.** "Walkie-talkie" retired by George with no replacement named. Four modes now need one taxonomy. Straw man: `self` / `delegate` / `delegate+consult` / `byo-model` | George | **Phase B** — `CallMode` cannot be frozen without it |
| O-3 | `openrouter-scoped-key` · eqstack | **OpenRouter scoped key** — provision via admin key, store in key-vault. Live secret action | George (authorisation at the time) | Phase T (mode 4) |
| ~~O-4~~ | ~~ElevenLabs CLI existence unverified~~ — **CLOSED 2026-08-29, see D-21.** Both CLIs exist and are installed; the residual question is whether to bump the stale 0.5.6 pin to 1.1.0 before writing the skill | — | — |
| O-5 | `mode23-cost-ceiling` · eqstack | **Cost ceiling** for modes 2/3 — ElevenLabs agent minutes bill on top of Twilio | George | before unattended inbound uses them |
| ~~O-9~~ | ~~`tunnel-domain`~~ — **CLOSED 2026-08-30, see D-36** (zone went `active` 2026-09-02; no residual action) | **Named-tunnel prerequisite is George-gated.** `cloudflared 2026.8.1` is installed (`/opt/homebrew/bin/cloudflared`) but **`~/.cloudflared/` does not exist** — no `cert.pem`, zero credential files. Only Quick Tunnels (which need no auth) have ever been used, matching `HANDOFF.md`. D-10 therefore needs a one-time `cloudflared tunnel login` (browser auth, pick a zone) → `tunnel create` → `tunnel route dns`, plus a domain in George's Cloudflare account. **Which domain?** | George | Phase D |
| ~~O-6~~ | ~~`state-dir-migration`~~ — **CLOSED 2026-09-02, see D-40** | **State/config dir during rename** — migrate `~/.config/voice-mcp/` + `~/Library/Application Support/voice-mcp/`, or pin state to the old name? Holds live config and the 2026-08-02 call history incl. one encrypted recording | George (offered, not yet answered) | Phase A |
| O-7 | `play-frame-preemption` · eqstack | **`play`-frame preemption** — does a `preemptible` play frame yield to the reply `text` frame with no clipped first word? Unverified on a live call | implementer (paid test) | Phase F's core assumption |
| O-8 | `twilio-sk-rotation` · eqstack | **Twilio `SK…` rotation** still pending from the previous cycle; the secret leaked into an agent transcript | George only | anything touching Twilio credentials |
| ~~O-10~~ | ~~`launchagent-vs-daemon`~~ — **CLOSED 2026-09-02, see D-37** (revisit gate at L–M) | **LaunchAgent vs LaunchDaemon.** LaunchAgent reaches the login keychain but dies at logout; LaunchDaemon survives logout but has **no keychain access — every secret resolves `null`**. That trade is not obvious and it decides whether calls survive a logout | George | Phase D |
| ~~O-11~~ | ~~`one-shot-tool-name`~~ — **CLOSED 2026-09-02, see D-38** | **One-shot tool name.** D-5 says `call`, but INV-1's own worked example is *"`say_on_call`, not `say`"* — and `call` is a bare verb colliding with the most overloaded word in programming. `place_call` costs one word and reads unambiguously. **My D-5 naming contradicts my own INV-1** | George | Phase C's MCP adapter |
| O-12 | `cli-yes-flag` · eqstack | Does the CLI keep a `--yes` flag on the one-shot, or is invoking it consent enough? | George | Phase C |
| O-13 | `max-concurrent-calls` · eqstack | `limits.maxConcurrentCalls` default is `1` (`schema.ts:116`) — still right now that dialing is open? | George | — |
| O-14 | `metric-name-prefix` · eqstack | Do `voice_*` **metric names** rename with the package (`tel_*`)? Either choice orphans the 2026-08-02 latency baseline. D-27 notes the cost grows per series added | George | A, E |
| ~~O-15~~ | ~~`thinking-asset-host`~~ — **CLOSED 2026-09-02, see D-39** | **Where the thinking-sound asset is hosted** — local static route / Twilio Assets / Worker. Twilio's media fetch cannot carry `X-Twilio-Signature`, so a local route is necessarily unauthenticated. **INV-10 requires a Settled row here BEFORE any public route ships.** Agent recommends Twilio Assets by default, local route opt-in and off | George | Phase F |
| O-16 | `thinking-asset-choice` · eqstack | What the asset actually *is* — must loop seamlessly and survive an 8 kHz phone codec | George (taste) | Phase F |
| O-17 | `assistant-text-on-event` · eqstack | Should assistant text ride on `turn.assistant` instead of forcing a transcript fetch? (see D-29) | implementer → decided in B | G, I, J |
| O-18 | `hint-channel-auth` · eqstack | **Hint-channel authorisation.** INV-4 says direct-mode speech is verbatim to a real person; a hint channel is a *second* path to that microphone. Who may inject, and is it redacted and logged? | George | Phase V |
| O-19 | `twilio-webhook-authority` · eqstack | **Repointing the Twilio number's inbound webhook** is a live account-config change under different authority than INV-14's paid-call gate. Pre-authorised once, or per occasion? | George | Phases L–M |
| O-20 | `mcp-kit-pin-bump` · eqstack | Bump the `mcp-kit` pin to 1.0.0 (D-23) before or during Phase A? | implementer | Phase A |
| O-21 | `env-var-prefix` · eqstack | Env-var prefix: `TEL_` or `TELEPHONY_MCP_`? | George | Phase A |
| O-22 | `multi-host-pickup` · eqstack | With >1 polling host, does the "host picked up" mark go to the first poller or per-host? | implementer | E, later L–M |

> ⚠️ **O-6 collides with Phase D**: the launchd plist bakes **absolute paths**. If the
> state/config dirs move after `daemon install`, the agent points at nothing. The
> rename must land before the first plist install.

---

## Rejected

| # | Option | Why rejected |
|---|---|---|
| R-1 | Cloudflare Worker / edge function **as a latency fix** | Attacks ~60–240 ms of a 2.5–11 s direct-mode round trip. The dominant term is the agent's own model turn, which no topology change touches. Still viable later for *availability* (D-18) |
| R-2 | Quick Tunnel with automated re-registration | Keeps the per-restart hostname churn that made the original setup feel like a hack; inbound breaks briefly on every restart (D-10) |
| R-3 | Keeping the two-stage `prepare` → `start(confirm:true)` flow | Two tool calls plus a token for one instruction. Its real value was idempotency, which D-5 preserves inside the one-shot tool |
| R-4 | `tel_` tool prefix | Renders as `mcp__telephony-mcp__tel_call` under hosts that already namespace — "tel" twice (D-2) |
| R-5 | `call-mcp` / `phone-mcp` / `@george43g/voice-mcp` package names | George chose `telephony-mcp` (D-1). `call-mcp` unscoped is taken at 1.2.0 |
| R-6 | Building the web UI on `cliterface` | Based on a mis-hearing of "cli-kit". The intended library is `@george43g/cli-kit@2.0.1` from the mcp-cli-starter-template. `cliterface` is unrelated |
| R-7 | Keeping `AdminServer` as-is and adding surfaces beside it | Operations are already defined twice (MCP tool schemas + admin route bodies); adding WS/SDK/TUI would make it five times (D-6, D-8) |
| R-8 | Deleting the REST routes entirely in Phase B | George chose the adapter option over the delete option. REST becomes a thin adapter over the registry rather than disappearing (D-6) |
