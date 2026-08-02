# Stage 5 — edit history (parallel-safe)

**Branch**: `feat/edit-history` · **Type**: `feat(db+tui)` · **Depends**: — (parallel; only
touches attributed-body extractor + drawer)

**Goal**: the TUI shows a message is edited but the more-info drawer doesn't show the history.
Parse `message.message_summary_info` and render an edit timeline in the drawer.

## Code anchors

- `src/imessage-db.ts` ~1864–1875 — `message_summary_info` is already read for link previews;
  extend for edit history.
- `src/attributed-body-text.ts` — typedstream extractor reused to decode each prior version's
  `"t"` blob.
- `src/tui/components/MessageDrawer.tsx` — render the timeline.
- Reference: ReagentX/imessage-exporter `edited.rs`.

## `src/edit-history.ts`

- `extractEditHistory(msi: Buffer): EditHistory` — bplist-parser (dep already present) → `"ec"`
  key → per message-part → array of versions `{ date (Mac epoch), text (via typedstream
  extractor) }`; `"rp"` → retracted-part flags.
- Pure function, no DB — testable with synthetic bplist fixtures.

## DB + types

- `imessage-db.getEditHistory(rowid)` — **lazy** (drawer-path only; don't inflate every page).
- `Message.editHistory?` populated for `isEdited` rows in `get_messages` pages (~502 rows total
  DB-wide — cheap); add to structuredContent.

## TUI

- `MessageDrawer`: "Edited N times" timeline (date + text per version, oldest→newest).

## Tests

- Synthetic bplist fixtures generated via `python3 plistlib` in the fixtures script (`pnpm
  fixtures` pattern) — **never commit real edit blobs**.
- `extractEditHistory` unit tests: multi-version part, retracted part, no-history message.
- Drawer render test: "Edited N times" + versions shown.

## Verification

- `pnpm lint && pnpm typecheck && pnpm test` green, both engines.
- Live read-only spot-check on the Naomi edited message: drawer shows a version timeline (no
  content echoed to command output).

## Notes for the worker

- This stage is independent of the media-intel service — it can land in parallel with Stages 2–4.
- Reuse the typedstream extractor from Stage 1 (or the existing one if Stage 1 hasn't merged) to
  decode each version's attributedBody. If Stage 1 is not yet merged, use the current
  `extractAttributedBodyText` — versions are plain text runs, so attribute support isn't required
  here.
