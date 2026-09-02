# DECISIONS — imsg resilient send-path, delivery feedback & local exposure

Append-only; own your own rows. Anchor = SHA, `file:line`, command output, or a
dated attribution to George. Companion: [`WORKSTREAM.md`](./WORKSTREAM.md), source
brief [`BRIEF-2026-08-23-resilient-send.md`](./BRIEF-2026-08-23-resilient-send.md).

## Settled

| # | Decision | Anchor |
|---|---|---|
| S-1 | Brief lives HERE (`apps/imsg-mcp/docs/plans/resilient-send/`), not the gmail path its header suggested — it is an imsg workstream | Fork analysis 2026-09-02; brief header said `apps/gmail-mcp/docs/briefs/…` (see R-1) |
| S-2 | **The 2026-08-23 IDS reset held.** 13 `err=22` rows on 8/22–8/23; **zero** failed outgoing iMessages on ANY handle since the reset (10 days) | `sqlite3 ro chat.db` 2026-09-02: per-day error counts `2026-08-22\|22\|7`, `2026-08-23\|22\|6`, then `count(DISTINCT handle_id)` since 8/23 17:00 → `0`. Consequence: auto-heal is insurance, not the daily-value item; **no live repro exists**, so detector tests MUST fake the DB reader (brief §9 A2 already says so) |
| S-3 | Config persistence is NOT greenfield: `src/app-config.ts` already parses JSON config with XDG-aware path chain and a separate chmod-600 `credentials.json` | `app-config.ts:8-10` (path chain), `:125` (candidates), `:14-15,196` (credentials split). Brief §4's ask reduces to: new schema keys + cross-tool sharing + env/flag layering + (maybe) TOML — see O-1 |
| S-4 | Send-failure surfacing partially exists: `get_last_send_error` MCP tool, failure note in the send response, and the DB layer already documents the `error != 0` surface | `src/mcp-tools.ts:364`, `src/index.ts:1004,470`, `src/imessage-db.ts:2109`. §5 extends this machinery; it does not build from zero |
| S-5 | The daemon's "chat.db watcher" already exists in-process: the WAL-watcher EventBus behind `wait_for_changes` | CLAUDE.md §MCP Tools (`wait_for_changes` — "WAL-watcher EventBus"); `docs/plans/realtime-streaming-and-api-surface.md` Part A is its design record. §7's daemon is a RE-HOMING of existing machinery plus IPC, not a new watcher |
| S-6 | Exposure mechanism is already settled fleet-wide: **named** Cloudflare tunnel on `agentpipe.top` (zone ACTIVE, verified 2026-09-02), one hostname per service | Telephony workstream D-10/D-36 (`apps/telephony-mcp/docs/plans/two-way-calling/DECISIONS.md`). Appendix C's option evaluation is superseded; imsg exposure = a new hostname on that zone (e.g. `imsg.agentpipe.top`) behind mandatory auth (O-6) |
| S-7 | HTTP MCP transport = `@george43g/mcp-kit` `startHttpServer` (Streamable HTTP + bearer), NOT hand-rolled. Also already a STATUS backlog row | mcp-kit 1.0.0 published 2026-08-28 (telephony D-23); telephony D-7 adopts it; `docs/STATUS.md:213` ("Streamable-HTTP transport — stdio-only today"), `:16` (George's online/remote-MCP direction) |
| S-8 | Env↔flag layering = cli-kit `bindEnvFlags` — the pattern just shipped in telephony Phase A (PR #132) and lifts directly | telephony Phase A kit-adoption commit (`bindEnvFlags` + preAction apply) |
| S-9 | **imsg-mcp has real production consumers (public npm, v1.25.x)** — unlike telephony there is no "rewrite anything" licence. §5's response change must be ADDITIVE (keep today's text/fields; add `status` / `send_method` / `error_code`) or ride a major bump. The brief does not address this; it binds every phase | `npm view imsg-mcp` 1.25.x; contrast telephony WORKSTREAM constraint ("no existing consumers") which does NOT transfer |
| S-10 | Telephony D-26 hazard transfers verbatim: an idle watchdog wired at dispatcher level is starved by long-polls (`wait_for_reply`, `wait_for_changes`). Any mcp-kit dispatcher adoption here must prove the long-poll path feeds `noteActivity()` | telephony D-26; imsg long-poll tools in CLAUDE.md §MCP Tools |
| S-11 | Standalone (daemon-less) invocations may **detect and warn**, only the daemon **acts** on auto-heal — prevents N parallel CLI processes racing resets | Brief §11 recommendation, adopted as designed; no counter-argument found |
| S-12 | **RS-A SHIPPED (PR pending).** `src/delivery-status.ts` = pure `deriveDeliveryState`/`deriveSendMethod`/`deriveDeliveryStatus` (delivered|failed|pending + realised send_method); `IMessageDB.getDeliveryRow(rowId)` polls one ROWID column-tolerantly (is_sent/is_finished/was_downgraded absent on the reduced fixture AND older macOS → null, via the existing `hasColumn` guard); `send_message` polls after `confirmSendLanded` pins the ROWID and adds `status`/`sendMethod`/`errorCode` **beside** every existing field (RS-INV-1 verified: suite 1202→1216, no existing assertion changed). Poll window is env-tunable (`IMSG_DELIVERY_POLL_MS` 150 / `IMSG_DELIVERY_TIMEOUT_MS` 2000) — **deliberately NOT an app-config key**, so RS-A stays clear of the O-1 config-format gate. Tests: 12 pure (A1-A4 + column-tolerance) + 2 against the real fixture | Implementer 2026-09-02 |

## Open

| # | slug · owner | Question | Whose call | Blocks |
|---|---|---|---|---|
| O-1 | `config-format-and-home` · eqstack | New shared TOML lib (brief §4) vs **extend existing JSON `app-config.ts`** and extract a shared kit only when a second consumer is real? Fork recommends extend-JSON-now: zero migration for shipped users (S-3, S-9), no speculative package; TOML only if human editing becomes primary. Cost of the road not taken: cross-tool sharing waits | George | RS-C, brief §10 step 1 |
| O-2 | `auto-heal-default-and-scope` · eqstack | Default-ON auto-reset kills `identityservicesd`/`imagent` and **quits Messages.app** under the user. Accept as-is, or require the lighter `identityservicesd`-only variant first (escalate only on failure)? The lighter-reset experiment needs a REAL send to the affected contact → consent-gated (privacy guardrail: confirm before sending) | George | RS-D |
| O-3 | `retry-after-reset` · eqstack | Brief defaults `retry_after_reset=true`. Fork recommends **false**: a late-delivering original + auto re-send = double text to a human, and unsupervised re-sends are consent-sensitive. Keep the failed message surfaced for the agent to decide | George | RS-D |
| O-4 | `daemon-adoption-and-tcc` · eqstack | Adopt the single-shared-daemon at all, and as what? ⚠️ UNVERIFIED but load-bearing: TCC grants (Full Disk Access, Automation) attach to the responsible process — a launchd-spawned daemon is NOT covered by the terminal's grants and needs its own approvals. Verify before committing. Coordinate with telephony D-37 (LaunchAgent-for-keychain) and lift Phase D's launchctl wrapper | George (+ a TCC spike) | RS-E |
| O-5 | `fleet-tunnel-ownership` · eqstack | One fleet-level cloudflared (ingress rule per app hostname) vs telephony Phase D's current tel-daemon-owns-tunnel? If imsg (and later gmail) expose, one tunnel beats N. **Needs coordination with the telephony main agent NOW, while Phase D is unbuilt** — keep the tunnel supervisor factorable and reserve `imsg.` in the D-36 scheme | George + eqstack main session | RS-G; telephony Phase D design |
| O-6 | `exposure-auth-model` · eqstack | An exposed imsg MCP reads private messages. Cloudflare Access vs bearer-token (mcp-kit) vs both; and whether imsg is EVER exposed publicly at all | George | RS-G, any non-loopback bind |
| O-7 | `pending-window-value` · eqstack | 2s default `delivery_timeout_ms` shipped in RS-A (env-tunable); right value? (err=22 lands near-synchronously per the diagnosis; delivery receipts can be slower.) Implementer may tune with data | implementer | RS-A polish |
| O-8 | `hosted-bridge-product` · eqstack | Closed-source hosted chat.db bridge (Appendix C monetisation) — business direction, parked. Not planned here | George | — (parked) |

## Rejected

| # | Option | Why |
|---|---|---|
| R-1 | Saving the brief under `apps/gmail-mcp/docs/briefs/` | Wrong app; it would be invisible to anyone working on imsg |
| R-2 | UPnP + DDNS + Caddy (Appendix C option 2) | Superseded by the fleet's D-10 decision and Appendix C's own analysis: inbound port, public IP, router access, breaks on CGNAT/roam |
| R-3 | `trycloudflare.com` quick URLs | Per-restart hostname churn — already rejected fleet-wide (telephony R-2/D-10) |
| R-4 | Hand-rolled HTTP transport or bespoke IPC protocol design | mcp-kit `startHttpServer` exists and is fleet policy (S-7); IPC framing should reuse the same command shapes |
| R-5 | Blocking sends 15s for a delivery receipt | Brief's own rationale: 3-state response with honest `pending` instead |
