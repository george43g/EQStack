# Spike: SIP / private-API route for forcing attachment downloads — findings & go/no-go

_Time-boxed research spike (Media-Intel Stage 8). **Docs-only** — no product code, no SIP
toggling, no injection code was written or run. Research date 2026-07-23; macOS baseline Sequoia
(Darwin 24.x). Sources listed at the bottom._

## TL;DR — **NO-GO for this cycle** (and likely for any near-term cycle)

The premise was: could a private-API route (à la BlueBubbles) force **purged/undownloaded
attachments** (`transfer_state = -1`) to re-download more reliably than the Stage 7 AppleScript
nudge? Two independent findings each kill it on their own:

1. **Prior art does not cover our use case.** BlueBubbles' battle-tested private-API surface
   hooks IMCore for **sending, editing, unsending, tapbacks, typing, read receipts, and group
   management — there is no attachment download/re-download hook.** Adopting BlueBubbles buys us
   nothing here; we would have to research and hook our *own* private IMCore/IMFileTransfer path
   with **zero prior-art validation**.
2. **The security cost dwarfs the benefit.** The injection route requires **full `csrutil disable`
   + system-wide Library Validation disabled** — strictly heavier than the *partial* SIP posture
   yabai needs, so "the user already runs yabai" does **not** make this free. Shipping anything
   that nudges users toward that posture is a non-starter for an open-source tool.

Add the environmental ceiling (below): even a *perfect* download hook can only pull media iCloud
**still holds server-side**, which for a fully-synced Full-Disk-Access Mac is a near-empty set.
The AppleScript **T1 open-chat nudge** (Stage 7) already covers that same addressable set using
100% public APIs and zero SIP changes. **Recommendation: keep Stage 7 as the ceiling; do not
pursue the private-API route.** Revisit only if the triggers in §7 flip.

---

## 1. The question

Stage 7 shipped a tiered sync nudge: **T1** = AppleScript-activate Messages + open the
conversation (`imessage://` URL) + poll for the file; **T2** (opt-in) = UI-script "Sync Now".
Both are best-effort — they *ask* Messages to sync and hope. The open question this spike closes:
is there a **deterministic** private route that tells IMCore "download transfer X now"?

Motivating context: the user runs **yabai**, which already requires a partially-disabled SIP, so
a private-API route was hypothesised to be "personally cheap." §5 shows that hypothesis is false.

## 2. Approach map — what the BlueBubbles Private API actually is

BlueBubbles is the reference implementation for private IMCore access on macOS. Mechanism:

- **Injection**: the server launches its **own** instance of Messages.app with
  `DYLD_INSERT_LIBRARIES` pointed at `BlueBubblesHelper.dylib`. The dylib loads inside the
  Messages process and can then call private Objective-C selectors on
  **`IMCore.framework`** (`/System/Library/PrivateFrameworks/IMCore.framework`).
- **What it hooks** (from the official IMCore capability docs):
  - Messaging: send (with subject/effects/mentions/replies), **edit**, **unsend/retract**.
  - Reactions: send tapbacks (love/like/dislike/laugh/emphasize/question).
  - Chat mgmt: fetch chat objects, mark read/unread, rename group, add/remove participants,
    pin/unpin, delete chat.
  - Typing & status: start/stop typing, listen for incoming typing.
- **What it does NOT hook**: **attachment download / re-download / force-fetch.** The docs contain
  no `IMFileTransfer`, `IMFileTransferCenter`, `IMDownloadFileTransfer`, or any download method.
  Attachments appear only as *outgoing* sends and as the `￼` object-replacement marker when
  detecting reactions. **This is the crux: the mature prior art simply does not do the thing we
  need.**

## 3. What a download hook would actually require (unvalidated)

To force a download we would have to research and hook a path prior art has *not* proven. The
private IMCore/`IMDPersistence`/`IMTransferServices` surface *does* contain plausible candidates:

- `IMFileTransferCenter` (singleton `sharedInstance`) — owns `IMFileTransfer` objects keyed by
  GUID; candidate selectors like `transferForGUID:`, `acceptTransfer:` / `-[IMFileTransfer accept]`,
  or a re-request into `IMDownloadFileTransfer`.
- **`IMTransferAgent`** — the actual byte-mover, but it is a **separate SIP-protected daemon**;
  driving it is not the same as calling a selector inside Messages (RESEARCH.md already flagged
  `IMTransferAgent` as ruled out for a public path).

Problems that make this a *large* spike rather than a small one:

- **No prior-art confirmation** that any of these selectors re-pull a **purged
  (`transfer_state = -1`)** attachment from iCloud, versus merely *accepting* an
  incoming-but-not-yet-downloaded transfer. Those are different states.
- **Undocumented, version-fragile selectors** — IMCore internals change across macOS releases
  with no compatibility contract (BlueBubbles itself constantly chases these; see §6).
- Would require its own injected dylib — i.e. the **full §5 security posture** just to *begin*
  experimentally probing selectors.

## 4. Alternatives surveyed (all rejected for this goal)

- **`brctl` / FileProvider** — iCloud-Drive only; Messages attachments are not exposed there.
  (Already recorded in RESEARCH.md §4.)
- **imessage-rest / pypush / Beeper-style protocol clients** — reimplement the *network* iMessage
  protocol (APNs + IDS) to send/receive off-Mac. They do not touch the *local* Messages
  attachment store and would not force a local download; also high ToS/blocking risk
  (see `docs/ICLOUD_API_RESEARCH.md` Approach A). Out of scope for a local download nudge.
- **ricloud (commercial)** — read-only iCloud forensics, paid, 125-device minimum. Not applicable.

## 5. Security / permission cost — and why yabai does NOT already cover it

| Requirement | **yabai** (user's actual posture) | **BlueBubbles private-API route** |
|---|---|---|
| SIP | **Partial**: `csrutil enable --without fs --without debug --without nvram` (Apple Silicon, macOS 13+) — SIP stays *mostly on* | **Full**: `csrutil disable` — SIP entirely off |
| Library Validation | Not disabled system-wide | **`sudo defaults write /Library/Preferences/com.apple.security.libraryvalidation.plist DisableLibraryValidation -bool true`** (system-wide) |
| Boot-arg | `sudo nvram boot-args=-arm64e_preview_abi` (allow unsigned arm64e) | none documented beyond the above |
| Injection target | Dock.app (scripting addition) | **Messages.app** (own DYLD-injected instance) |
| Apple-Silicon side effect | — | **Loses ability to run iOS apps on the Mac** |
| Re-arm after macOS update | `sudo yabai --load-sa` | Re-disable Library Validation + re-inject helper |

**Conclusion:** the two postures are materially different. yabai relaxes *specific* SIP
sub-protections (fs/debug/nvram) and permits unsigned arm64e binaries; it does **not** turn SIP
fully off and does **not** disable Library Validation system-wide. A yabai user would have to
**further weaken** their machine to run the private-API route. For an open-source tool aimed at a
broad audience, telling users to fully disable SIP + Library Validation to fetch the occasional
old attachment is an unacceptable default and an unacceptable *recommendation*.

## 6. Stability assessment across macOS versions

- BlueBubbles supports macOS **10.13+** on Intel and Apple Silicon, but stability is a **moving
  target**: the helper bundle is updated release-over-release specifically because IMCore selectors
  and Messages' hardened-runtime behaviour shift between macOS versions. Users must re-apply the
  SIP/Library-Validation steps and re-inject after major updates.
- On **Apple Silicon**, disabling SIP has escalated friction each release (e.g. the "hold Left
  Shift while clicking Continue in recoveryOS" requirement on recent macOS).
- Net: even the *supported* capability set is maintenance-heavy. An **unsupported** capability we'd
  have to reverse ourselves (attachment download) would carry *worse* version fragility with no
  upstream community keeping it working.

## 7. Environmental ceiling (ties Stage 7's live finding to this decision)

The Stage 7 supervised live test found the real `~/Library/Messages/chat.db` had **exactly one**
`transfer_state = -1` row — a 2022 message that did **not** re-download even after opening the
chat, because it is **purged from iCloud server-side** (unrecoverable by *any* client). Among the
~8,000 most-recent media attachments, **zero** were missing from disk.

Implication independent of mechanism: the addressable universe for *any* download-forcing tool —
AppleScript nudge or a hypothetical private hook — is limited to **media iCloud still holds but
the local Mac hasn't pulled yet**. For a fully-synced FDA Mac that set is ~empty; it is only
meaningfully non-empty on Macs using iCloud **"Optimize Mac Storage"** offload or shortly after a
fresh sign-in. In exactly those cases, **opening the conversation (Stage 7 T1) already triggers
Apple's own sync of that thread's media** — the same server round-trip a private hook would
initiate, minus the SIP cost. The private route's marginal reliability gain over T1 is therefore
small and hits a shrinking population.

## 8. Go / No-Go

**NO-GO** for the private-API / SIP route in this cycle and the foreseeable roadmap. Rationale,
ranked:

1. **No prior-art hook** for attachment download — the expensive part (finding a working IMCore
   download selector) is unvalidated research, not adoption.
2. **Security posture** (full SIP off + Library Validation off system-wide) is unacceptable as a
   default or recommendation for an open-source tool; **not** covered by the user's yabai setup.
3. **Maintenance fragility** — undocumented selectors + hardened-runtime injection break across
   macOS releases with no upstream keeping our path alive.
4. **Tiny, shrinking addressable set** — Stage 7 T1 already covers the same server-held media via
   public APIs; server-purged media is gone for everyone.

### What would flip this to "revisit" (triggers for a future spike)

- Apple ships (or DMA/DOJ pressure forces) a **public** attachment-download or FileProvider API
  for Messages — then no SIP route is needed at all.
- A prior-art project (BlueBubbles or similar) adds and **battle-tests** a re-download hook, giving
  us a validated selector path to evaluate — the cost drops from "research" to "adopt."
- A concrete user need emerges for **bulk** recovery of iCloud-Optimize-Storage-offloaded media at
  a scale where T1 open-per-thread is too slow — and only then, as an **explicitly opt-in,
  clearly-warned, off-by-default** power-user feature, never a default.

## 9. Backlog outcome (for STATUS.md)

- **T3 (per-conversation download-all UI script)** — remains researched-only/documented; fragile
  across macOS versions; not shipped. Keep in backlog.
- **Private-API / SIP download route** — **NO-GO**, recorded here. Move to backlog as "closed —
  revisit only on the §7 triggers."

---

## Sources

- [BlueBubbles Private API — IMCore capability docs](https://docs.bluebubbles.app/private-api/imcore-documentation) (confirms the exposed hook set; **no attachment-download method**)
- [BlueBubbles Private API — Installation](https://docs.bluebubbles.app/private-api/installation) (`csrutil disable` + Library Validation disable; macOS 10.13+; Apple-Silicon iOS-app side effect)
- [BlueBubbles — Simplified Server Setup blog](https://docs.bluebubbles.app/blog/simplified-setup) (`DYLD_INSERT_LIBRARIES` injection into a server-managed Messages instance)
- [bluebubbles-helper (dylib source)](https://github.com/BlueBubblesApp/bluebubbles-helper) (`BlueBubblesHelper.m` calls IMCore selectors)
- [yabai — Disabling System Integrity Protection (wiki)](https://github.com/koekeishiya/yabai/wiki/Disabling-System-Integrity-Protection) (partial SIP `--without fs --without debug --without nvram` + `-arm64e_preview_abi`)
- Internal: `docs/ICLOUD_API_RESEARCH.md` (pypush/ricloud/BlueBubbles send-side survey), `docs/plans/media-intel/RESEARCH.md` §4 (`IMTransferAgent`/`brctl` ruled out; Stage 7 tier design), Stage 7 supervised live-test finding (one `-1` row, server-purged).
