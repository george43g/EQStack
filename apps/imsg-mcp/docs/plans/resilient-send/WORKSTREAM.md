# WORKSTREAM — imsg resilient send-path, delivery feedback & local exposure

> Read order: this file → [`DECISIONS.md`](./DECISIONS.md) → the source
> [`BRIEF-2026-08-23-resilient-send.md`](./BRIEF-2026-08-23-resilient-send.md).
> Where the brief and DECISIONS disagree, DECISIONS is correct (the brief predates
> mcp-kit 1.0.0, the agentpipe.top zone, telephony Phase A, and the S-2 finding
> that the reset held). Phase files get split out per repo convention once the
> gated Open rows are answered; until then this file carries the phase sketch.

## Invariants (inherited + new)

| INV | Statement |
|---|---|
| RS-INV-1 | **Additive response evolution.** imsg-mcp is public npm with real consumers (S-9): `send_message`'s existing response text/fields survive; `status`/`send_method`/`error_code` are added beside them. Breaking shape changes ride a major, never a patch |
| RS-INV-2 | **Never report sent as delivered.** Every surface (MCP, CLI, TUI) renders exactly one of `delivered` / `failed` / `pending`; `pending` carries the do-not-assume disclaimer |
| RS-INV-3 | **Detector tests never depend on a live failure.** No reproduction exists post-reset (S-2); the chat.db reader is faked in tests (brief §9 A2/A3) |
| RS-INV-4 | **Standalone detects and warns; only the daemon acts** (S-11). No reset ever fires from a one-shot CLI process |
| RS-INV-5 | **Reuse fleet kits**: mcp-kit for HTTP transport + dispatcher, cli-kit for program/output/env-flags, robustness for redaction/watchdog. Long-poll must feed the idle watchdog (S-10) |
| RS-INV-6 | **Nothing binds beyond 127.0.0.1 without a Settled auth row** (O-6) — same rule as telephony INV-10 |
| RS-INV-7 | **Real-message experiments are consent-gated.** The lighter-reset experiment sends a real iMessage to a real person: George confirms per occasion (standing privacy guardrail) |

## Phase sketch → PR groups

```
RS-A delivery truth ──▶ RS-B TUI state machine
   (unblocked NOW)          (after A)
RS-C config keys        — gated O-1
RS-D auto-heal inline   — gated O-2/O-3 (+ reset-scope experiment, RS-INV-7)
RS-E daemon + IPC       — gated O-4; lift telephony Phase D's launchctl wrapper
RS-F HTTP MCP (mcp-kit) — loopback-only may precede O-6; watchdog proof per S-10
RS-G tunnel exposure    — gated O-5/O-6; hostname on agentpipe.top per S-6
```

- **RS-A — delivery truth (§5).** Post-send poll of the pinned ROWID (`delivery_poll_ms`/`delivery_timeout_ms`), 3-state result + realised `send_method` (`service` + `was_downgraded`), additive per RS-INV-1; fold `get_last_send_error` into the same shape. Tests A1–A4. **No George gate — first PR.** Directly fixes the known "iMessage-first to an SMS-only number silently never delivers" trap (CLAUDE.md §Conventions/Sending).
- **RS-B — TUI delivery state machine (§8).** `composing → sending → delivered|failed|pending`; tests A5. After RS-A.
- **RS-C — config keys (§4).** `auto_heal.*`, `daemon.*`, `http.*`, `send.*`, `expose.*` in whatever home O-1 picks; env-over-file, flag-over-env via cli-kit. Tests C1–C5.
- **RS-D — auto-heal detector (§6).** Inline (standalone warns, daemon acts); trigger = min_failures same-handle iMessage errors in window ∧ other-contact success ∧ known code (`{22}`) ∧ cooldown. Tests B1–B7.
- **RS-E — daemon + IPC (§7).** Re-homes the WAL-watcher EventBus (S-5); unix socket; send serialisation per handle; auto-detect with `--standalone`/`--ipc`. Tests D1–D4. TCC spike first (O-4 ⚠️).
- **RS-F — Streamable HTTP MCP.** mcp-kit `startHttpServer`, loopback bind; the STATUS.md:213 backlog row. Test D5.
- **RS-G — tunnel exposure (Appendix C, superseded parts removed).** Hostname on the fleet zone; auth per O-6; ownership per O-5.

## Coordination seams with the telephony workstream (act on these NOW)

1. **Phase D tunnel supervisor must stay factorable** and the D-36 hostname scheme
   should reserve per-app names (`imsg.agentpipe.top`, later `gmail.`) — O-5 here;
   raise as a note in the telephony DECISIONS before Phase D is built.
2. **Phase B's dispatcher long-poll/`noteActivity` proof** is the exact pattern
   imsg needs (S-10) — write it liftable.
3. **Phase D's `tel daemon` launchctl wrapper** is imsg's daemon wrapper too —
   kit candidate; do not bury it in telephony-specific code.

## Parked

Hosted closed-source chat.db bridge (O-8) — recorded, not planned.
