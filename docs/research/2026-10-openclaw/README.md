# Research wave 1, 2026-10 (openclaw + messenger landscape)

Wave 1 of `docs/plans/2026-10-08-mcp-platform-and-media.md`. These reports are the input to George's **research gate**: nothing in imsg's structure changes until he has triaged them.

| File | Report | Headline |
|---|---|---|
| `report-r1a.typ` / `.pdf` | openclaw/imsg features and UX, compared with imsg-mcp (37 rows, pinned at `d604a8b`, v0.15.10) | It isn't an MCP server: it's a Swift CLI plus JSON-RPC, and its IMCore features need SIP off. Top adopt-now: typed send dispositions, resumable cursors, a status snapshot, fail-closed input, tapbacks |
| `report-r1b.typ` / `.pdf` | openclaw/imsg internals and algorithms | Split our store around a capability struct, a SELECT builder and one row decoder; read Apple's voice-memo transcript from `attachment.user_info`; one tool-descriptor table; `limit+1` pagination. MIT licence |
| `report-r3.typ` / `.pdf` (+ `rows.typ`) | openclaw GitHub org crawl (95 repos) | `wacli` for a WhatsApp MCP (ban risk), `fs-safe` and `clawpdf` as libraries, `mcporter` as a skill. The bun fork isn't a Rust port; better-sqlite3 is bun's blocker |
| `r2-landscape.md` | NotebookLM landscape: the iMessage tooling notebook and the messenger bridges/MCPs notebook | Orbit CRM, imessage-exporter (GPL, reference only), BlueBubbles, Beeper/mautrix. The second contact manager is likely Clay (now Mesh) |
| `l-local-engines.md` | Local speech and OCR engines installed on gmac | hear, whisper.cpp (needs `-m` and WAV), mac-ocr verified on synthetic samples; yap needs macOS 26 |

Diagrams use Typst `@preview/fletcher`. Rebuild with `typst compile <file>.typ`.
