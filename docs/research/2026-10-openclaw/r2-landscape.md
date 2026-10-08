# R2: Messaging tooling landscape (EQStack), 2026-10-08

Notebooks (NotebookLM, 50 sources each, deep-research report imported):
- iMessage tooling landscape (EQStack): 34240803-244a-4743-8838-1bb4f0ed70d2 https://notebooklm.google.com/notebook/34240803-244a-4743-8838-1bb4f0ed70d2
- Messenger bridges & MCPs landscape (EQStack): 117af69b-0274-4d3e-964b-6876e866a550 https://notebooklm.google.com/notebook/117af69b-0274-4d3e-964b-6876e866a550

Stars / last push come from `gh search repos` on 2026-10-08 (n/a = not captured; GitHub rate limit hit mid-run). Licence, approach and relevance come from the NotebookLM synthesis plus repo metadata. Full synthesis text: nb1_answer.md and nb2_answer.md in this folder (may be missing if the shell failure lost them; raw JSON nb1.json, nb2.json also here).

## Notebook 1: iMessage tooling (ranked)

| # | Project | URL | What it does | Stars / last push | Licence | EQStack relevance |
|---|---|---|---|---|---|---|
| 1 | ReagentX/imessage-exporter | github.com/ReagentX/imessage-exporter | Rust chat.db exporter + diagnostics; `imessage_database` crate (typedstream/attributedBody, schema variants) | 5647 / 2026-09-20 | GPL-3.0 | Reference parser / test oracle (GPL: do not copy code) |
| 2 | openclaw/imsg | github.com/openclaw/imsg | Swift CLI+core: read/watch/send, NDJSON + JSON-RPC, IDS check, chat-create | ~1.4k (per NLM) / active | MIT | Steal idea (IDS handle check, chat-create); R1a/R1b cover depth |
| 3 | BlueBubbles server/app/helper/docs | github.com/BlueBubblesApp/bluebubbles-server | Mac server bridging iMessage to Android/web; Private API dylib for tapbacks/edit/typing | server 1101, app 1381 / 2026-10 | Apache-2.0 | Integrate (client of its REST API) or steal Private-API design |
| 4 | jesec/imessage-rs | github.com/jesec/imessage-rs | Rust toolkit, BlueBubbles-compatible REST (66 routes), webhooks | 19 / 2026-02 | MIT | Steal idea (crate split db/core) |
| 5 | tszaks/imessage-mcp | github.com/tszaks/imessage-mcp | MCP: attributedBody decode, image view (HEIC to JPEG), read receipts | 1 / 2026-10-01 | MIT | Steal idea (multimodal attachments) |
| 6 | anipotts/imessage-mcp | github.com/anipotts/imessage-mcp | Read-only MCP; privacy modes full/redacted/aggregate; sync_messages cursor | 27 / 2026-10-05 | MIT | Steal idea (privacy modes, change cursor) |
| 7 | wyattjoh/imessage-mcp | github.com/wyattjoh/imessage-mcp | Deno lib + MCP, custom DB path | 29 / 2026-08 | MIT | Ignore / compare |
| 8 | camolechowski/imsg | github.com/camolechowski/imsg | Zero-dep Node CLI + agent skill | 7 / 2026-08 | MIT | Compare (competes with imsg-cli) |
| 9 | hannesrudolph/imessage-query-fastmcp | github.com/hannesrudolph/imessage-query-fastmcp-mcp-server | Python FastMCP read-only | 81 (NLM) | n/a | Ignore |
| 10 | linq-team/linq-cli + claude-code-imessage-channel | github.com/linq-team/linq-cli | Commercial iMessage API CLI; Claude Code channel with in-place streaming edits | 32 / 25, 2026-10 / 2026-07 | Apache-2.0 / MIT | Steal idea (edit-in-place progress); cloud option only |
| 11 | wolfiesch/wolfies-imessage-gateway | github.com/wolfiesch/wolfies-imessage-gateway | CLI gateway (avoids MCP cold start), RAG, follow-up detection | 6 / 2026-06 | MIT | Steal idea (follow-up detection) |
| 12 | adelaidasofia/imessage-mcp | github.com/adelaidasofia/imessage-mcp | whisper.cpp voice notes, FTS5, draft+confirm send, vault export | 2 / 2026-10-05 | MIT | Steal idea (draft+confirm; ties to L transcribers) |
| 13 | kacy/chatbubbles | github.com/kacy/chatbubbles | Tailscale HTTPS API wrapping imsg, pairing, webhooks | 2 / 2026-04 | n/a | Steal idea (remote access/pairing) |
| 14 | msilverblatt/aimessage | github.com/msilverblatt/aimessage | Rust REST/WS server, HMAC, rate limit | 0 / 2026-03 | n/a | Steal idea (rate limit/HMAC) |
| 15 | slandau3/macos-messages-mcp | github.com/slandau3/macos-messages-mcp | Swift read-only MCP, isolated snapshot sandbox | 0 / 2026-08 | none | Steal idea (snapshot sandbox) |
| 16 | johnlarkin1/imessage-schema | github.com/johnlarkin1/imessage-schema | chat.db + AddressBook schema snapshot (macOS 15.5) | 0 / 2025-11 | n/a | Reference |
| 17 | pattersongrant/imsg, daylen/bumper | github.com/daylen/bumper | Local analytics dashboards (top contacts, gap alerts, Claude suggestions) | 1 / 0, 2026 | n/a | Steal idea (analytics UX) |
| 18 | my-other-github-account/imessage_tools | github.com/my-other-github-account/imessage_tools | Python attributedBody decoding reference | 128 / 2023-01 | n/a | Reference only |
| 19 | daveremy, sameelarif, antondkg, willccbb, marissamarym, helv-io/ha-bluebubbles | see notebook | Assorted MCPs (JXA send; Rust+React composer UI; Chroma RAG; Home Assistant) | 1-29 | MIT mostly | Ignore / minor ideas |

### Personal CRMs / contact managers (candidates for George's "second one besides Dex")

| Tool | Type | MCP/API | iMessage link | Note |
|---|---|---|---|---|
| Dex (getdex.com) | SaaS | Official agent skill, community MCPs (davidswolf TS / Rust) | none native | The one George knows |
| Clay, now rebranded **Mesh** (clay.earth redirects to Mesh) | SaaS | proprietary API | none | Likely the "second one" |
| Folk (folk.app) | SaaS | REST API + MCP | none | CRM for LinkedIn/Gmail/WhatsApp |
| Monica (monicahq, 25.4k stars) | OSS AGPL, hosted option | REST + jclement/monica-mcp | none | Classic personal CRM |
| Orbit (moritzWa/orbit) | OSS, local-first | CLI, SQLite | **imports chat.db directly**, merge-redirect dedup | Closest to EQStack; study first |
| harperreed/crm | OSS Go | built-in MCP (14 tools), TUI, Google sync | indirect | 27 stars, 2026-08 |
| Contrack (arvarik) | OSS AGPL | MCP, RAG, relationship pulse scoring | multi-source | 13 stars, active |
| Bondery | OSS AGPL | OpenAPI/REST | none | 17 stars |
| Mob CRM (benkaiser/mob-mcp-crm) | OSS FSL | MCP-first | none | 9 stars |
| PeopleOS, Mondo (Obsidian), Twenty, lorey/personal-crm, Productive | OSS | various | none | minor |

Also in sources, unverified: Reddit r/selfhosted megathread (Aug 2026) listing new self-hosted CRMs.

## Notebook 2: Messenger bridges & MCPs (ranked)

| # | Project | URL | What it does | Stars / last push | Licence | Relevance |
|---|---|---|---|---|---|---|
| 1 | mautrix bridges (whatsapp/signal/telegram/meta/discord/slack/gmessages) | github.com/mautrix/docs | Matrix puppeting bridges, the gold standard | docs 81 / 2026-10 | AGPL-3.0 | Integrate (as backend) / steal bridgev2 model |
| 2 | Beeper Desktop API & MCP + bridge-manager | beeper.com/desktop-api, github.com/beeper/bridge-manager | Local REST+MCP over all networks incl. iMessage; self-host bridges | bbctl 1419 / 2026-10 | Apache-2.0 / proprietary app | Integrate (one MCP surface) / steal idea |
| 3 | whatsmeow (tulir) | github.com/tulir/whatsmeow | Go WhatsApp multidevice lib | n/a | MPL-2.0 | Library for any WhatsApp work |
| 4 | WhatsApp MCPs: lharries (stale), verygoodplugins, FelixIsaac extended, jlucaso1 (Baileys), BrOrlandi | github.com/FelixIsaac/whatsapp-mcp-extended | Go daemon + Python MCP, webhooks, anti-ban | 6420 (lharries, last 2025-07) / 223 / 34 | MIT | Steal idea (two-tier daemon + MCP) |
| 5 | Baileys | github.com/WhiskeySockets/Baileys | TS WhatsApp Web socket lib | n/a | MIT | Library option for TS |
| 6 | WhatsApp Business Cloud API | developers.facebook.com/docs/whatsapp/cloud-api | Official | n/a | proprietary | Integrate (telephony-mcp channel) |
| 7 | signal-cli + signal-cli-rest-api + googlarz/signal-mcp | github.com/AsamK/signal-cli | Unofficial CLI/JSON-RPC; REST wrapper; 80+ tool MCP with FTS5, READONLY | 4962 / 2871 / 9, 2026-10 | GPL-3.0 / MIT / MIT | Integrate signal-cli; steal FTS5 + READONLY |
| 8 | chigwell/telegram-mcp | github.com/chigwell/telegram-mcp | Telethon MCP: session lock, allowlists, prompt sanitising | 1788 / 2026-10-07 | Apache-2.0 | Steal idea (session lock, sanitising) |
| 9 | fast-mcp-telegram | github.com/leshchenko1979/fast-mcp-telegram | 8 consolidated tools, QR auth, multi-tenant | 48 / 2026-10 | MIT | Steal idea (tool consolidation) |
| 10 | TDLib, Telegram Bot API, chaindead/telegram-mcp | github.com/tdlib/td | Official engine / bot API; Go MCP (349 stars) | n/a | BSL-1.0 / MIT | Library option |
| 11 | korotovsky/slack-mcp-server | github.com/korotovsky/slack-mcp-server | Go; OAuth + stealth tokens, GovSlack | 1861 / 2026-07 | MIT | Steal idea (dual-auth) |
| 12 | slackapi/slack-skills-plugin, bolt-js | github.com/slackapi/slack-skills-plugin | Official Slack MCP + skills | 145 / 2026-10 | MIT | Reference for skill packaging |
| 13 | SaseQ/discord-mcp, barryyip0625/mcp-discord | github.com/SaseQ/discord-mcp | Bot-token Discord MCPs | 533, 106 | MIT | Ignore unless Discord needed |
| 14 | mautrix/meta, InstantGram | github.com/mautrix/meta | Messenger/Instagram DM unofficial; official Graph API for business | n/a | AGPL-3.0 | Ignore (severe ban risk); official API only |
| 15 | LINE SDK + Messaging API, beeper/line | github.com/line/line-bot-sdk-nodejs | Official LINE bot; unofficial puppeting bridge | n/a | Apache-2.0 / MIT | Ignore unless LINE needed |
| 16 | WeChat Open Platform, CowAgent | github.com/zhayujie/CowAgent | Official accounts only; personal WeChat risky | n/a | Apache-2.0 | Ignore |
| 17 | capcom6/android-sms-gateway | github.com/capcom6/android-sms-gateway | Phone as SMS/MMS REST gateway, E2EE | n/a | Apache-2.0 | Integrate (cheap SMS path beside Twilio) |
| 18 | matterbridge | github.com/42wim/matterbridge | 20+ network relay; stale (~3y) | n/a | Apache-2.0 | Ignore (stale) |
| 19 | vercel/chat | github.com/vercel/chat | TS universal chat layer for bots | n/a | MIT | Steal idea (adapter interface) |
| 20 | Pyrogram, GramJS | see notebook | Telegram MTProto libs; reported archived | n/a | LGPL / MIT | Ignore |
| 21 | beeper/platform-imessage | github.com/beeper/platform-imessage | Swift iMessage automation lib (from NLM answer; verify) | n/a | MIT | Study Beeper's iMessage approach |

## Top 10 most valuable for EQStack

1. moritzWa/orbit: local-first CRM that auto-imports chat.db with merge-redirect dedup; maps onto the contacts-factorisation arc.
2. ReagentX/imessage-exporter: authoritative schema/typedstream behaviour; use as test oracle (GPL, do not copy).
3. BlueBubbles (server + helper) / imessage-rs: Private API route to edits, tapbacks, typing; REST shape for a remote mode.
4. anipotts/imessage-mcp: privacy modes (full/redacted/aggregate) and cursor-based change feed.
5. Beeper Desktop API & MCP + bridge-manager: single local MCP across networks; benchmark for a unified surface.
6. mautrix bridges: only sane path to WhatsApp/Signal/Telegram/Meta without writing protocol code.
7. googlarz/signal-mcp: FTS5 local store, READONLY flag, signal-cli wrapper pattern.
8. chigwell/telegram-mcp: session locking, allowlists, prompt-injection sanitising for agent-facing message text.
9. FelixIsaac/whatsapp-mcp-extended: Go daemon plus MCP two-tier design, webhooks, anti-ban.
10. capcom6/android-sms-gateway and linq-cli/channel: SMS gateway for telephony-mcp; edit-in-place progress messages.

Gaps NotebookLM flagged (validate): no unified CLI+MCP+TUI iMessage tool; no tool resolves contacts across AddressBook plus local CRMs; no encrypted chat.db snapshot streaming to remote agents; no OCR/embedding of attachments; weak agent safety gates (dry-run, recipient allowlist, audit log).
