> **Provenance:** written by another agent session against a 2026-08-23 diagnosis of
> `chat.db`; handed to this repo 2026-09-02 and preserved VERBATIM below (including
> its now-wrong suggested save path and its pre-`mcp-kit@1.0.0` assumptions).
> **Do not implement from this file directly** — [`DECISIONS.md`](./DECISIONS.md)
> records what is superseded (S-2/S-3/S-6/S-7, R-1…R-4) and what is gated;
> [`WORKSTREAM.md`](./WORKSTREAM.md) carries the live phase plan. The trailing
> offer ("Want me to run that experiment now?") was NOT accepted; that experiment
> is consent-gated as RS-INV-7 / O-2.

---

# imsg-mcp: Resilient Send-Path, Delivery Feedback & Local Exposure — Implementation Brief

> Suggested save path: `~/repos/EQStack/apps/gmail-mcp/docs/briefs/resilient-send-and-local-exposure.md`
> Audience: implementing agent. Status: design brief, not yet specced to file-level. Confirm open questions in §11 before coding.

## 0. TL;DR
Three coupled changes to the imsg tool, plus one parked future direction:
1. **Honest delivery feedback** — never report "sent" as "delivered". Use a **2-second post-send poll of `chat.db`** and return one of three states (`delivered` / `failed` / `pending`) plus the **actual send pathway** Messages.app ended up using.
2. **Auto-heal** — when the tool observes the signature of an `identityservicesd` (IDS) stale-token failure for one iMessage contact while other contacts still deliver, automatically run the IDS/Messages reset script. Default-on, config-gated.
3. **Single shared daemon + HTTP stream mode** — one long-lived instance on localhost shared by all agents (RAM efficiency), with CLI/TUI/MCP all acting as front-ends via IPC, plus a standalone fallback for scripted use.
4. **(Parked, future)** Expose the local HTTP MCP at a public `https://` URL via a **cloudflared tunnel** so web-only MCP consumers (online ChatGPT, etc.) can use it; and a closed-source hosted "chat.db bridge" as a monetisable product.

## 1. Background — the bug this brief is built on
Diagnosis performed 2026-08-23 against `~/Library/Messages/chat.db`:
- **Symptom:** outgoing iMessages from the Mac intermittently red-badge "Not Delivered" for one contact (Shara, `+61423793080`); iPhone sends to the same contact always deliver.
- **DB evidence:** 14 `error=22` rows in 30 days, **all** to `handle_id=3338` (`+61423793080`, iMessage). Same window: **66 iMessages to other contacts delivered, 0 err=22**. So the Mac's iMessage is healthy globally — failure is handle-isolated.
- **Addressing is identical** on failed vs delivered rows: same `handle_id`, same `chat_id`, same `account` (`E:george43g@me.com`), same `destination_caller_id`. The recipient target is **not** the cause. (Original "Mac vs iPhone target mismatch" hypothesis disproven.)
- **Failure is synchronous & pre-CloudKit:** err=22 rows have `is_sent=0`, `is_delivered=0`, `is_finished=1`, `ck_sync_state=0`, `ck_record_id=NULL` — the message died at the Mac's send handoff before reaching Apple's transport. Classic IDS routing-token resolution failure.
- **Intermittent, not deterministic:** within one 10-min session on 8/22, fail→fail→fail→**deliver**→fail→fail→**deliver**. ~22% fail rate to that handle over 7 days (13 fail / 45 delivered).
- **Trigger:** the contact has **dual handle registration** — both an SMS (`3294`) and iMessage (`3338`) row for the same `+61423793080`, plus a separate iMessage email handle (`inshara.a277@gmail.com`, `5554`). Ambiguous/multi-handle contacts are the known trigger for the Mac's IDS token cache going stale.
- **Empirical fix that cleared it:** `tell application "Messages" to quit` → `killall imagent` → `killall identityservicesd` → `open -a Messages`. (User ran this on 2026-08-23 ~16:50; no errors surfaced.)

**Takeaway for the tool:** the failure is (a) detectable in `chat.db` within ~2s, (b) handle-isolated and pattern-recognisable, and (c) auto-fixable by restarting the Mac's messaging services. None of that is currently in the tool.

## 2. Scope
In scope: config persistence lib; 2s-window delivery feedback + `send_method` field; auto-heal IDS reset; daemon/IPC/HTTP-stream architecture; TUI delivery-state rendering + tests; full test matrix across console/TUI/MCP; local→public exposure design (cloudflared) + monetisation note.
Out of scope (this brief): the actual chat.db sync-to-cloud server, the closed-source hosted product build, rewriting the send path away from osascript.

## 3. Target architecture — one daemon, three front-ends
```
                 ┌─────────────────────────────────────────────┐
                 │            imsg daemon (1 instance)          │
                 │  - chat.db watcher / delivery poller         │
                 │  - IDS-failure pattern detector              │
                 │  - auto-heal supervisor (reset script)       │
                 │  - config (shared lib)                       │
                 │  - IPC socket  +  HTTP stream (localhost)    │
                 └───────▲──────────────▲──────────────▲────────┘
                         │ IPC          │ IPC          │ HTTP/stdio MCP
                  ┌──────┴────┐  ┌──────┴────┐  ┌──────┴──────┐
                  │ CLI       │  │ TUI       │  │ MCP server  │
                  │ (thin)    │  │ (stream)  │  │ (streamable)│
                  └───────────┘  └───────────┘  └─────────────┘
                         │
                  (standalone fallback if no daemon:
                   in-process, no HTTP, no supervisor —
                   just does the op + inline 2s poll, exits)
```
**Principle:** minimal state, exactly one instance on the machine. 50 agents → 1 daemon, not 50 imsg processes. The daemon owns the watch/poll/heal loop; front-ends are thin.

## 4. Config persistence (shared package lib)
- New shared lib (e.g. `@imsg/config` / `imsg-config` crate) that **parses a TOML or JSON config** at `~/.imsg-mcp/config.toml`. Reused by the daemon, CLI, TUI, and MCP front-ends, and by sibling tools (gmail-mcp etc.) so every tool reads settings the same way.
- Schema (initial):
  - `auto_heal.enabled` (bool, **default true**)
  - `auto_heal.min_failures` (int, default 2) — failures for one handle in the window before reset
  - `auto_heal.window_minutes` (int, default 10)
  - `auto_heal.cooldown_minutes` (int, default 10) — don't reset more often than this
  - `auto_heal.require_other_contact_success` (bool, default true) — only heal if some other contact delivered in the window (proves Mac iMessage isn't globally broken)
  - `auto_heal.retry_after_reset` (bool, default true) — re-send the most recent failed message(s) after a reset
  - `daemon.enabled`, `daemon.socket_path`, `http.port`, `http.bind` (default `127.0.0.1`)
  - `send.delivery_poll_ms` (int, default 150), `send.delivery_timeout_ms` (int, default 2000)
  - `expose.tunnel` (enum: `none|cloudflared`, default `none`), `expose.hostname`
- Env-var overrides for every key (e.g. `IMSG_AUTO_HEAL=0`), env wins over file. Flag equivalents on CLI (`--no-auto-heal`).
- The lib must: create `~/.imsg-mcp/` if missing, validate, migrate schema versions, never crash on malformed config (warn + fall back to defaults), and be safe for concurrent readers (daemon reads, CLI reads).

## 5. Send semantics — the 2-second window & 3 response states
After `send_message` hands off to Messages.app and obtains the new message ROWID (the tool already returns `last message ID`), **poll `chat.db` for that ROWID** every `delivery_poll_ms` up to `delivery_timeout_ms` (default 2s). Return one of three states:

| State | Condition | Tool response |
|---|---|---|
| `delivered` | `is_delivered=1 AND error=0` within 2s | success — include `send_method` |
| `failed` | `error != 0` within 2s | failure — include `error_code` + `send_method` |
| `pending` | neither by 2s | "pending — do NOT assume delivered; re-check with `get_messages` or `wait_for_reply` before acting on delivery" |
Rationale (per user): an immediate success or immediate failure can be reported inline without making the agent wait; a 15s blocking wait on every send is unacceptable; `pending` forces the agent to verify instead of falsely assuming success. The observed err=22 appears near-synchronously (`is_finished=1` already set on the failed rows), so the 2s window captures it.

**Always include `send_method`** in the response. Reason: the osascript send surface doesn't reliably tell us which pathway Messages.app actually used — it may default to or silently switch between iMessage / SMS / RCS, or **downgrade** an iMessage to SMS (`was_downgraded=1`). The agent needs to know what actually happened. Derive `send_method` from the row:
- `service` column → `iMessage` | `SMS` | `RCS`
- if `was_downgraded=1` → append ` (downgraded iMessage→SMS)`
- expose both the intended method (what the caller asked for) and the realised method.

Example response shapes (MCP tool result):
```
// delivered
{ "status": "delivered", "message_id": 410580, "send_method": "iMessage", "recipient": "+61423793080" }

// failed (immediate)
{ "status": "failed", "message_id": 410579, "error_code": 22, "send_method": "iMessage",
  "recipient": "+61423793080", "note": "IDS token resolution failure; auto-heal triggered" }

// pending
{ "status": "pending", "message_id": 410581, "send_method": "iMessage",
  "recipient": "+61423793080",
  "note": "Delivery not confirmed within 2s. Do NOT assume delivered — re-check via get_messages before relying on delivery." }
```
Detection SQL (appendix B).

## 6. Auto-heal — IDS reset
**Trigger condition (all must hold):**
1. ≥ `min_failures` send failures (`error != 0`) to the **same handle_id** within `window_minutes`, **and**
2. the failures' `send_method == iMessage` (ignore SMS/RCS failures — different pathway), **and**
3. ≥ 1 successful iMessage delivery to a **different** handle within the same window (`require_other_contact_success`) — proves the Mac's iMessage isn't globally broken (global breakage = account/activation problem, not IDS-stale-for-one-contact; a reset won't help and shouldn't fire), **and**
4. the specific error is one known to match this pattern — seed list: `{22}`; extensible via config.
5. cooldown not active (`cooldown_minutes` since last reset).

**Action:** run the reset script (appendix A), then if `retry_after_reset`, re-send the most recent 1–N failed messages for that handle and re-run the 2s poll on each. Emit a structured event/log line `auto_heal.triggered { handle, failures, error_codes, reset_ok }`.

**Non-goals / safety:** never reset on a single transient failure; never reset if failures span multiple handles; never reset more than once per cooldown; never run the reset if `auto_heal.enabled=false`. The detector must distinguish "one contact failing, others fine" (heal) from "many contacts failing" (don't heal — surface to the agent/user as an account-level fault).

## 7. Daemon, IPC, HTTP stream, and CLI coordination
**Daemon mode:** long-running, owns the watch/poll/heal loop, exposes:
- a **local IPC socket** (unix domain socket, e.g. `~/.imsg-mcp/imsg.sock`) for CLI/TUI,
- an **HTTP streamable-transport endpoint** on `127.0.0.1:<http.port>` so it can serve as a live MCP server on localhost.

**HTTP stream mode is required** so the tool can be an MCP "live on a localhost port" (streamable HTTP transport). But that mode only exists when the daemon is running — it does **not** work for one-shot scripted/CLI calls. Hence the dual mode below.

**CLI behaviour when a command runs — IPC vs standalone:**
- **Default: auto-detect.** If the daemon socket is live, the CLI is thin and **IPC's the command to the daemon** (tmux/yabai model: server holds state, client is thin). This is the right default for efficiency and single-source-of-truth.
- **Standalone fallback:** if no daemon is detected, the CLI runs the operation **in its own ephemeral process** — no HTTP server, no background supervisor, no auto-heal loop, but **still does the inline 2s delivery poll** for that single call and returns the same 3-state response. Exits immediately. This is what scripted use (`imsg send …` in a shell script) gets.
- Flags: `--daemon` (start the long-running instance), `--standalone` / `--no-daemon` (force in-process even if a daemon exists), `--ipc` (force IPC, error if no daemon).

**Why IPC-to-daemon by default (not "always spawn own instance"):**
- RAM: one resident process, not N copies across N agents/sessions (the explicit goal — avoid 50 instances).
- One chat.db reader and one IDS-state monitor instead of many racing on the same SQLite file.
- Auto-heal only works if a persistent process is watching the pattern across calls — ephemeral CLI invocations can't see the "2 failures for one contact, others fine" window on their own.
- Single outbound tunnel connection (§Appendix C) from the daemon, not per-CLI-call.

**Why standalone fallback still matters:** scripts, cron, SSH, headless runs, users who don't want a daemon. The 2s inline poll gives honest delivery feedback even without the supervisor.

**Concurrency:** daemon must serialise sends that target the same handle (avoid racing osascript/Apple Events) while allowing parallel sends to different handles. Document the locking granularity.

## 8. TUI streaming delivery detection
The TUI already has streaming input (compose-as-you-type). Extend the send lifecycle rendering so the bubble shows an honest state machine:
`composing → sending → (delivered | failed | pending)`, where the terminal state is driven by the same 2s poll over `chat.db` (or the IPC response from the daemon).
- **Must not** render "delivered" before `is_delivered=1`.
- **Must** render "failed" (with `error_code`) when `error != 0`.
- **Must** render "pending / sending…" (not "delivered") if the 2s window expires without resolution, with a subtle indicator that delivery is unconfirmed.

## 9. Test plan (matrix)
Tests must cover **all three modes: console (CLI/scripted), TUI, MCP (daemon HTTP/stdio)**.

**A. Delivery-state correctness**
- A1. Send to a handle that returns `is_delivered=1` within 2s → response/TUI = `delivered`, `send_method=iMessage`. (happy path)
- A2. Inject a `error=22` outcome (test harness fakes the chat.db reader, or targets a stub handle) → response/TUI = `failed`, `error_code=22`, `send_method=iMessage`. Assert it does **not** say delivered.
- A3. Inject "no resolution by 2s" → response/TUI = `pending` with the do-not-assume-delivered disclaimer. Assert it does **not** say delivered.
- A4. iMessage downgraded to SMS (`was_downgraded=1`) → `send_method` reports `iMessage (downgraded→SMS)`; intended != realised is surfaced.
- A5. TUI-specific: drive the TUI via its existing test harness, assert the bubble never shows "delivered" while the underlying row is still `is_delivered=0`; asserts the failed and pending renders.

**B. Auto-heal detector**
- B1. **True positive:** 2 iMessage err=22 failures to handle X within 10 min, plus 1 iMessage delivery to handle Y within the window → detector fires reset script (mock the script call in tests; assert it was invoked once), and (if `retry_after_reset`) re-sends the latest failed message.
- B2. **False positive — single failure:** 1 failure to X, Y delivers → reset NOT fired.
- B3. **False positive — multi-contact failure:** failures to X and Y, no successes anywhere → reset NOT fired (account-level fault, not IDS-stale).
- B4. **False positive — SMS failure:** 2 SMS failures to X, iMessage to Y delivers → reset NOT fired (wrong pathway).
- B5. **Cooldown:** back-to-back true-positive windows → reset fires once, second window within cooldown is suppressed.
- B6. **Config gate:** `auto_heal.enabled=false` → true-positive window → reset NOT fired.
- B7. Run B1–B6 in **console, TUI, and MCP** modes (the detector lives in the daemon; the tests assert the daemon's behaviour is observable from each front-end).

**C. Config lib**
- C1. Missing `~/.imsg-mcp/` → created with defaults; no crash.
- C2. Malformed TOML/JSON → warn + defaults.
- C3. Env override beats file; flag beats env.
- C4. Concurrent reads from multiple front-ends are safe.
- C5. Schema migration from v0 (no file) → v1.

**D. Daemon/IPC**
- D1. CLI with daemon present → IPC path, same response shape as standalone.
- D2. CLI with no daemon → standalone path, inline 2s poll, exits.
- D3. `--standalone` with daemon present → does not IPC.
- D4. Serialised sends to same handle; parallel to different handles.
- D5. HTTP streamable MCP transport on `127.0.0.1:<port>` answers a real MCP client.

## 10. Suggested implementation order
1. Config lib + `~/.imsg-mcp/config.toml` (§4) — foundation; land C-tests.
2. 2s-window poll + 3-state response + `send_method` (§5) — land A-tests. Improves honesty immediately, even without daemon.
3. TUI delivery-state rendering (§8) — land A5.
4. Auto-heal detector + reset script runner (§6) — land B-tests. Initially runs **inline in standalone** too (a single process can still evaluate a window from recent `chat.db` history, not just its own session).
5. Daemon + IPC socket (§7) — land D1–D4.
6. HTTP streamable MCP transport (§7) — land D5.
7. cloudflared exposure hook (Appendix C) — gated behind `expose.tunnel`.

## 11. Open questions / decisions to confirm
- **Config format:** TOML or JSON? (Recommend TOML for human-edited config; JSON if you want it machine-written only.)
- **Shared lib language/shape:** is the imsg tool TS, Rust, or mixed? The DB access is already "Rust parser + TS DB" per the MCP output — confirm whether the config lib should be TS (npm package) or Rust (crate) or both with a thin FFI. Recommend matching the daemon's primary language.
- **Auto-heal reset scope:** the current reset quits **Messages.app** (disrupts the user's open conversation). Is there a lighter reset that doesn't quit the GUI app — e.g. `killall identityservicesd` alone first, and only escalate to full quit+relaunch if that fails? Worth testing whether `identityservicesd`-only restart clears err=22 without closing Messages.
- **Retry-after-reset count:** re-send just the latest failed message, or all failed-and-pending for that handle?
- **HTTP transport auth:** the localhost MCP endpoint has no auth by default. For tunnel exposure (Appendix C) we must add auth (Cloudflare Access / token). Decide the auth model before enabling `expose.tunnel`.
- **Standalone auto-heal:** should a one-shot CLI invocation (no daemon) be able to trigger auto-heal by inspecting recent `chat.db` history, or is heal strictly a daemon capability? Recommend: standalone may *detect and warn*, only daemon *acts* (to avoid 50 parallel CLI processes all firing resets).

## Appendix A — IDS reset script (the empirical fix)
```bash
osascript -e 'tell application "Messages" to quit'
killall imagent 2>/dev/null
killall identityservicesd 2>/dev/null
open -a Messages
```
Notes: no `sudo` required. macOS respawns `identityservicesd` and `imagent` automatically. Consider a lighter variant (kill `identityservicesd` only) per §11.

## Appendix B — delivery-poll & failure-detection SQL
```sql
-- poll a just-sent row by ROWID
SELECT error, is_sent, is_delivered, is_finished, service, was_downgraded
FROM message WHERE ROWID = :rowid;

-- recent-failure window for a handle (auto-heal detector)
SELECT h.id, COUNT(*) AS failures,
       GROUP_CONCAT(DISTINCT m.error) AS codes,
       MAX(datetime(m.date/1e9+978307200,'unixepoch','localtime')) AS last_fail
FROM message m JOIN handle h ON h.ROWID = m.handle_id
WHERE m.is_from_me=1 AND m.error != 0 AND m.service='iMessage'
  AND m.date > (strftime('%s','now','-:window_minutes minutes')-978307200)*1e9
GROUP BY h.ROWID HAVING failures >= :min_failures;

-- "other contact still works" guard for the same window
SELECT COUNT(*) FROM message
WHERE is_from_me=1 AND error=0 AND is_delivered=1 AND service='iMessage'
  AND handle_id != :failing_handle_id
  AND date > (strftime('%s','now','-:window_minutes minutes')-978307200)*1e9;
```
## Appendix C — Local HTTP MCP → public HTTPS endpoint (parked, future)

**Problem:** many web-only MCP consumers (e.g. online ChatGPT) accept **only `https://`** MCP entries. This tool **must run locally** (it reads `~/Library/Messages/chat.db` and drives Messages.app via osascript). So we need a bridge from a localhost HTTP MCP to a public HTTPS URL, while keeping the laptop's local stack light.

**General structure (options evaluated):** [three options — Docker+home-server, UPnP+DDNS+Caddy, cloudflared tunnel — with cloudflared chosen; full option analysis preserved in the source conversation. The fleet has since settled this via telephony D-10/D-36: named tunnel on `agentpipe.top`. See DECISIONS S-6/R-2/R-3.]

**Wiring into the tool:** the imsg daemon owns the tunnel lifecycle. When `expose.tunnel = "cloudflared"` and `expose.hostname` is set, the daemon spawns/manages a `cloudflared tunnel` child process pointing at its own HTTP port, and reports the public URL in startup logs. Auth (Cloudflare Access or a shared-token header check) is **mandatory** before the tunnel is considered live.

**Monetisable parked product (closed-source hosted bridge):** instead of exposing *this* user's laptop, run a **hosted server** in the cloud that the local imsg tool **streams chat.db contents to** over a tunnel. The hosted server exposes the public HTTPS MCP endpoint; online ChatGPT connects to the URL; the server queries the synced corpus and returns results. Because the **parsing/querying happens server-side on synced data** (not by shipping the parser to the client), the server can be **closed-source**. Customers pay for the hosted bridge; the local tool just gains a "sync to cloud" mode. **Privacy hardening required before this is real:** client-side encryption with customer-held keys, no plaintext at rest on the server, audited access. Note as a future business direction, not a current implementation item.
