# Stage 8 — SIP private-API spike (time-boxed, docs-only)

**Branch**: `docs/sip-private-api-spike` · **Type**: `docs` · **Depends**: — (parallel)

**Goal**: a time-boxed (~half-day) research spike into whether a private-API route could force
attachment downloads more reliably than the AppleScript nudge (Stage 7), given the user runs
yabai (partial SIP-off). **NO product code** — research + a go/no-go doc only.

## Research targets

- **BlueBubbles server Private API**: dylib injection into Messages → IMCore /
  `IMDownloadTransfer`. How it hooks, what SIP state it needs, current-macOS stability.
- **imessage-rest** and similar prior art.
- Feasibility with partial SIP-off (yabai-style — user's actual setup) vs full SIP.

## Deliverable

`docs/plans/media-intel/spike-sip-findings.md`:
- Approach map (what the private API actually calls).
- Stability assessment across recent macOS versions.
- Security/permission implications.
- **Go/no-go recommendation** for a future cycle.

## Constraints

- Docs-only. No injection code, no SIP toggling, no shipping anything that requires SIP-off by
  default.
- Time-box strictly — if the research rabbit-holes, write up what's known and stop.
