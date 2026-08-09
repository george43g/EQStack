# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and follows [Semantic Versioning](https://semver.org/).

# imsg-mcp [1.21.0](https://github.com/george43g/EQStack/compare/imsg-mcp-v1.20.0...imsg-mcp-v1.21.0) (2026-08-09)


### Features

* **imsg-mcp:** live TUI updates via change stream ([68d56b1](https://github.com/george43g/EQStack/commit/68d56b1862ba41d61c6e65d3bb14ecaf68d640e6))
* **imsg-mcp:** wait_for_changes MCP tool — long-poll the change-event bus ([2704a61](https://github.com/george43g/EQStack/commit/2704a61b8d56aaa055662efdf53af5b2f36301a9)), closes [#66](https://github.com/george43g/EQStack/issues/66)

# imsg-mcp [1.20.0](https://github.com/george43g/EQStack/compare/imsg-mcp-v1.19.4...imsg-mcp-v1.20.0) (2026-08-09)


### Bug Fixes

* **imsg-mcp:** incremental messagesByGuid map in ThreadPane ([d926b35](https://github.com/george43g/EQStack/commit/d926b351a0fbf7d173465c569f9ffe79d50f00d9))


### Features

* **imsg-mcp:** cache hit-rate metrics ([26eeb5a](https://github.com/george43g/EQStack/commit/26eeb5a46e7d4b32e23a56a60ff129b4748507b6))

## imsg-mcp [1.19.4](https://github.com/george43g/EQStack/compare/imsg-mcp-v1.19.3...imsg-mcp-v1.19.4) (2026-08-09)


### Bug Fixes

* **imsg-mcp:** redact logs by default via shared logger facade ([bbacf60](https://github.com/george43g/EQStack/commit/bbacf60168fa5ab21d081f30655d90a9e533ba39))

## imsg-mcp [1.19.3](https://github.com/george43g/EQStack/compare/imsg-mcp-v1.19.2...imsg-mcp-v1.19.3) (2026-08-09)


### Bug Fixes

* **imsg-mcp:** scrub real-message fragments from native parser comments and fixtures ([40f99b4](https://github.com/george43g/EQStack/commit/40f99b47e8337c552073f77943312ad3e50d8586))

## [1.19.2](https://github.com/george43g/imsg-mcp/compare/v1.19.1...v1.19.2) (2026-08-02)


### Bug Fixes

* **config:** XDG_CONFIG_HOME fully replaces ~/.config in config resolution ([2cbe2f9](https://github.com/george43g/imsg-mcp/commit/2cbe2f9192a72e5acdb8d395d561aa366c178798))
* **sqlite:** detect Electron runtime + validate node:sqlite + runtime fingerprint ([c93f9a5](https://github.com/george43g/imsg-mcp/commit/c93f9a55d3d0cfe411e43a318a8f804f16bd24b8))
* **sqlite:** fingerprint records engine outcome; skip under Vitest ([cc17d02](https://github.com/george43g/imsg-mcp/commit/cc17d0247c8b1f0cf1b8802a95dbfe39bd3152b6))

## [1.19.1](https://github.com/george43g/imsg-mcp/compare/v1.19.0...v1.19.1) (2026-07-30)


### Bug Fixes

* **mcpb:** run in Claude Desktop via node:sqlite fallback + observable startup ([6471492](https://github.com/george43g/imsg-mcp/commit/6471492557b37c7936dacfcece0b50b03c212ae1))

# [1.19.0](https://github.com/george43g/imsg-mcp/compare/v1.18.0...v1.19.0) (2026-07-25)


### Features

* **contacts:** attach a normalized identity block to get_contact + resolve_handle ([99dfc72](https://github.com/george43g/imsg-mcp/commit/99dfc723e2a5bf8508f1b3940a63a0aeb684d120))

# [1.18.0](https://github.com/george43g/imsg-mcp/compare/v1.17.0...v1.18.0) (2026-07-25)


### Features

* **tools:** uniform completeness metadata across list responses ([d8fd930](https://github.com/george43g/imsg-mcp/commit/d8fd930dfd28f28ac677ec4ffefd1addb39afbf5))

# [1.17.0](https://github.com/george43g/imsg-mcp/compare/v1.16.0...v1.17.0) (2026-07-25)


### Features

* **get_messages:** signal global vs conversation scope; tighten identifier over-match ([784361b](https://github.com/george43g/imsg-mcp/commit/784361b3f351c8b214bcfa592f425f711dfcb0ed))

# [1.16.0](https://github.com/george43g/imsg-mcp/compare/v1.15.1...v1.16.0) (2026-07-25)


### Features

* **contacts:** rank search_contacts by relevance with matchedField ([352ccd2](https://github.com/george43g/imsg-mcp/commit/352ccd2da1263f26baa31ef38737a9d52bdf3aa0))

## [1.15.1](https://github.com/george43g/imsg-mcp/compare/v1.15.0...v1.15.1) (2026-07-25)


### Bug Fixes

* **tui:** refresh sidebar after in-thread send + navigable filter results ([f6552be](https://github.com/george43g/imsg-mcp/commit/f6552be71a6c11abb240d38c853d0dadefcb25a9))
* **tui:** show identity-canonical service on conversation badges ([0b05827](https://github.com/george43g/imsg-mcp/commit/0b05827eb48b2d217b0d56c6af6b0dbe66e7829b))

# [1.15.0](https://github.com/george43g/imsg-mcp/compare/v1.14.0...v1.15.0) (2026-07-23)


### Features

* **attachments:** tiered sync nudge for undownloaded media ([beb9a75](https://github.com/george43g/imsg-mcp/commit/beb9a755faa20f4acce6221a9f7a344f4d0e1b51))

# [1.14.0](https://github.com/george43g/imsg-mcp/compare/v1.13.0...v1.14.0) (2026-07-23)


### Features

* **tui:** settings panel for media-interpretation config ([56f0db0](https://github.com/george43g/imsg-mcp/commit/56f0db01361e558979346d236cfb29b7727a3dae))

# [1.13.0](https://github.com/george43g/imsg-mcp/compare/v1.12.0...v1.13.0) (2026-07-22)


### Features

* **export,cli:** interpret media in exports + `imsg interpret` command ([dcba1da](https://github.com/george43g/imsg-mcp/commit/dcba1dab50f64b41c09f90eeaaa3eb4957093f5a))
* **mcp:** route get_attachment + get_messages through media-intel ([4f43b99](https://github.com/george43g/imsg-mcp/commit/4f43b99b4ff13e4567dd47e2ad8073bf352635a0))
* **tui:** voice-note interpretation UX — transcript bubbles, R interpret, f reveal ([55697f7](https://github.com/george43g/imsg-mcp/commit/55697f7670d888b90487efd5207c4eeda33d7d70))

# [1.12.0](https://github.com/george43g/imsg-mcp/compare/v1.11.0...v1.12.0) (2026-07-22)


### Features

* **cli:** interactive setup wizard for media interpretation ([0ad7507](https://github.com/george43g/imsg-mcp/commit/0ad75075e08e6cc9db7900a15ba7469b4e91314c))

# [1.11.0](https://github.com/george43g/imsg-mcp/compare/v1.10.0...v1.11.0) (2026-07-21)


### Features

* **db+tui:** parse message edit history and show it in the drawer ([e4df935](https://github.com/george43g/imsg-mcp/commit/e4df93552f96419bebe50acd241b7d0b74854c9b))

# [1.10.0](https://github.com/george43g/imsg-mcp/compare/v1.9.0...v1.10.0) (2026-07-21)


### Features

* **core:** media-intel interpretation service, cache & providers ([d6441de](https://github.com/george43g/imsg-mcp/commit/d6441de0248336f9a1fe04a709a8541c13476527))

# [1.9.0](https://github.com/george43g/imsg-mcp/compare/v1.8.0...v1.9.0) (2026-07-21)


### Features

* **db:** extract Apple-native voice-note transcripts, Genmoji & reply kinds ([6b9d715](https://github.com/george43g/imsg-mcp/commit/6b9d715dd6c356a337b8bb0b3ef96ff40419a73a))

# [1.8.0](https://github.com/george43g/imsg-mcp/compare/v1.7.0...v1.8.0) (2026-07-20)


### Features

* **tui:** per-thread info / attachment drawer (press `i`) ([cbcf809](https://github.com/george43g/imsg-mcp/commit/cbcf80960207a081f5813a4982f94d927a2d7756))

# [1.7.0](https://github.com/george43g/imsg-mcp/compare/v1.6.2...v1.7.0) (2026-07-20)


### Features

* **media:** opt-in cloud transcription escape-hatch for get_attachment ([8551b72](https://github.com/george43g/imsg-mcp/commit/8551b721440e01961d248aa218275b0f1f9d28a3))

## [1.6.2](https://github.com/george43g/imsg-mcp/compare/v1.6.1...v1.6.2) (2026-07-20)


### Bug Fixes

* **cli:** compute thread slugs synchronously on the cold-start path ([31df320](https://github.com/george43g/imsg-mcp/commit/31df3200cd01fabb4bac5cf2f8d2ab3d62a64c43))

## [1.6.1](https://github.com/george43g/imsg-mcp/compare/v1.6.0...v1.6.1) (2026-07-19)


### Bug Fixes

* **test:** strip a stray NUL byte that made a test file binary + guard it ([535b413](https://github.com/george43g/imsg-mcp/commit/535b413c361410337a58b040fc7ceb0983959b99)), closes [#20](https://github.com/george43g/imsg-mcp/issues/20)

# [1.6.0](https://github.com/george43g/imsg-mcp/compare/v1.5.0...v1.6.0) (2026-07-19)


### Bug Fixes

* **cli:** friendlier windowDays + humans usage; add `resolve` console verb ([4a5f389](https://github.com/george43g/imsg-mcp/commit/4a5f3892d6ca9d0683c49c44b9052190552bc7f9))
* **db:** detect unsent messages via content-absence, not the lying date columns ([8a2c5e2](https://github.com/george43g/imsg-mcp/commit/8a2c5e2544f5393f7380a1fb4126e782e81e111c))
* **tui:** filter-commit (Enter) loads the matched thread, not just the cursor ([3666d4a](https://github.com/george43g/imsg-mcp/commit/3666d4a1a6febbdae935fb1406fcf4a39cd9f1ab))


### Features

* **mcp:** resolve_conversation — free-form name → ranked threads in one call ([68485ab](https://github.com/george43g/imsg-mcp/commit/68485ab470b7b7a555719769169107d17c94a1cd))

# [1.5.0](https://github.com/george43g/imsg-mcp/compare/v1.4.0...v1.5.0) (2026-07-19)


### Bug Fixes

* **analytics:** bound getMessagesInWindow so opening a pane can't OOM-kill ([708ba7a](https://github.com/george43g/imsg-mcp/commit/708ba7ab223d8c8a6f2d37b51979490630b5f24a))
* **analytics:** make the relationship leaderboard actually rank ([60159ee](https://github.com/george43g/imsg-mcp/commit/60159ee52776077b8ee5ef6019ec464b3e92c87d))
* **humans:** getChatStats double-counted messages shared across legs ([e1a17cb](https://github.com/george43g/imsg-mcp/commit/e1a17cbe3a2570249122a4c7a86c69dbabf82ec8))
* **media:** correct yap/hear transcriber invocations ([f272e15](https://github.com/george43g/imsg-mcp/commit/f272e15aa34d2fc9db5ecbf344025d6aeb3a57a1))
* **snippets:** unsent last message no longer leaks "DWm" into the preview ([185d073](https://github.com/george43g/imsg-mcp/commit/185d0738d43a5386682e5dc0fbc25e706c1edcea))
* **test:** make CLI e2e cold-safe (no dependency on a warm slugs.db) ([a00b1a8](https://github.com/george43g/imsg-mcp/commit/a00b1a86f854e7ba8e96ddc9230460f8bab929d7))
* **tui:** compose-new modal no longer quits the TUI on a "q" recipient ([78589b1](https://github.com/george43g/imsg-mcp/commit/78589b10184ccedc31796a8e840b91245f1a8149))
* **tui:** stop the near-top loader re-firing when it can't page back further ([1639698](https://github.com/george43g/imsg-mcp/commit/1639698b88e19aa090a64f396810fc400e21542d))


### Features

* **analytics:** expose all 7 analytics via CLI + console with json/yaml ([ac619e9](https://github.com/george43g/imsg-mcp/commit/ac619e904ef7b1aaea6becaa00b896f932d737fc))

# [1.4.0](https://github.com/george43g/imsg-mcp/compare/v1.3.2...v1.4.0) (2026-07-13)


### Bug Fixes

* **native:** attachment-only messages no longer render transfer-GUID garbage ([b7a6ddf](https://github.com/george43g/imsg-mcp/commit/b7a6ddf6898e252a8933fe25e857a66e62a9eda6))
* **native:** bare-UUID attribute values no longer leak as message text ([1e34677](https://github.com/george43g/imsg-mcp/commit/1e34677a7380f1d5401ed996a51034b6e856dd8a))
* **parser:** structured-parse-first — byte-scan only when no NSString parses ([430e9ed](https://github.com/george43g/imsg-mcp/commit/430e9ed8402e24a2b76c7b012d7579f29136506a))
* **parser:** trust the structured parse only when it yields usable text ([68fbeb3](https://github.com/george43g/imsg-mcp/commit/68fbeb3a8430097f047b4fa68d4fd40d994b6f37))
* **parser:** TS fallback no longer resurrects UUID attribute leaks ([f3d0a66](https://github.com/george43g/imsg-mcp/commit/f3d0a66b1fcc49bbf18312ca6328a958cf6eced4))
* **send:** stage attachments into ~/Library/Messages before sending ([945d24b](https://github.com/george43g/imsg-mcp/commit/945d24b9d1e1b923284d30f3146a344b3b8adb65))
* **send:** surface failed sends + route on delivery evidence; tame idle re-renders ([8380765](https://github.com/george43g/imsg-mcp/commit/838076553cafc8679c5622873c4c11413e1cfdc9))
* **snippets:** chat-properties heuristic no longer emits plist noise ([80d852a](https://github.com/george43g/imsg-mcp/commit/80d852a89429e2ad5463dc8aa0541139ee7c32f1))
* **tui:** route compose sends on the thread's real service ([144a1e3](https://github.com/george43g/imsg-mcp/commit/144a1e3b065292a92f90b88566b60e954988b761))
* **tui:** startup thread load, live footer stats, slug overflow, multi-attachment drawer ([b322800](https://github.com/george43g/imsg-mcp/commit/b322800caa6280c371d1e562f13ecb49a2ca358f))
* **tui:** word-wrap long messages in the thread pane ([48b141d](https://github.com/george43g/imsg-mcp/commit/48b141dab12ef9dd77b849e15f6642d47068260e))


### Features

* **humans:** humans/v1 relationship-file convention + init scaffolding ([c90772a](https://github.com/george43g/imsg-mcp/commit/c90772a4b216218eae82f69ab8ee9d4b05920473))
* **humans:** tool-output hints pointing agents at relationship files ([d83a4c7](https://github.com/george43g/imsg-mcp/commit/d83a4c78950045efcf5c92ed4964032ac006379c))
* **mcp:** interjection-aware wait_for_reply + multimodal attachments ([984261f](https://github.com/george43g/imsg-mcp/commit/984261f75160fec2c74c60e80a2c94f18840adcd))
* **watchdog:** heap-space forensics before an rss_exceeded kill ([322a211](https://github.com/george43g/imsg-mcp/commit/322a211f6cdca23ba268fac2ac0c483ab3f25e40))

## [1.3.2](https://github.com/george43g/imsg-mcp/compare/v1.3.1...v1.3.2) (2026-07-12)


### Bug Fixes

* **send:** route on the thread's real service — AppleScript can't detect wrong-service sends ([ff30b7a](https://github.com/george43g/imsg-mcp/commit/ff30b7a9a5fa2837a0e20278d61ba20f27db1780))

## [1.3.1](https://github.com/george43g/imsg-mcp/compare/v1.3.0...v1.3.1) (2026-07-12)


### Bug Fixes

* **cli:** report the real version — inject from package.json at build ([f2d2245](https://github.com/george43g/imsg-mcp/commit/f2d2245ef0e204b25c8d91375bc58656926a3d26))
* **export:** deterministic key order in NDJSON/JSON message lines ([43cf729](https://github.com/george43g/imsg-mcp/commit/43cf729aad3a6651768f2d1511b06485f48b913f))
* **release:** pack .mcpb after version bump; sync manifest.json version ([c93c503](https://github.com/george43g/imsg-mcp/commit/c93c5031f9112ed122b04ff508b27bd7d1f19700))
* **tui:** paint dev-stats immediately when the panel opens ([734257c](https://github.com/george43g/imsg-mcp/commit/734257caa3bedc4ca4a49f354295cfbf61a84de5))

# [1.3.0](https://github.com/george43g/imsg-mcp/compare/v1.2.0...v1.3.0) (2026-07-12)


### Bug Fixes

* **contacts:** per-handle names + name-gated union + stable slug anchors ([5f1ff00](https://github.com/george43g/imsg-mcp/commit/5f1ff001713787d59c1697ff5f14999400ff9a0b))
* **db:** composite cursors for afterMessageId + gap-fill; unstarved dedup paging ([97f8dc1](https://github.com/george43g/imsg-mcp/commit/97f8dc11aedf8a512727a156d712865b5f72c798))
* **db:** composite-cursor pagination for get_messages beforeMessageId ([b7353a9](https://github.com/george43g/imsg-mcp/commit/b7353a9785fb62f7f452e9ff8b7b806807248edf))
* **mcp:** match local-format card phones to E.164 chats in get_contact threads ([a79af10](https://github.com/george43g/imsg-mcp/commit/a79af10204a629fbbc5af1621e3a6c415718ba4f))
* **mcp:** real pagination for list_conversations (offset + nextOffset) ([d663126](https://github.com/george43g/imsg-mcp/commit/d663126916265bb57bc4fdf0dbbb656f4047700c))
* **tui:** reset cursor + scroll when filtering conversations ([3b5f617](https://github.com/george43g/imsg-mcp/commit/3b5f617dfe519c0d04b84aac9fb868de28e06de6))


### Features

* **cli:** contacts subcommands + contact→thread mapping in get_contact ([e070fa7](https://github.com/george43g/imsg-mcp/commit/e070fa795141300656f42a7b6cbbe784f3372470))
* **merge:** cross-source contact identity, complete exports, canonical slugs ([c43cd9c](https://github.com/george43g/imsg-mcp/commit/c43cd9c9893219d256bbd0048e06879df060ade5))

# [1.2.0](https://github.com/george43g/imsg-mcp/compare/v1.1.1...v1.2.0) (2026-06-07)


### Bug Fixes

* **tui:** module-pane Tab cycles type; defer compute so Loading paints ([a69539a](https://github.com/george43g/imsg-mcp/commit/a69539ae6271dc6623dcfe9663728a760cc4fade))


### Features

* **tui:** command palette + feature module system ([59d5628](https://github.com/george43g/imsg-mcp/commit/59d5628238fefc65d6806ad9969716fa508ea2c7))

## [1.1.1](https://github.com/george43g/imsg-mcp/compare/v1.1.0...v1.1.1) (2026-06-07)


### Bug Fixes

* **tui:** stop MCP-shaped shutdown policies from killing user sessions ([f92a92c](https://github.com/george43g/imsg-mcp/commit/f92a92cfb40e463b752a68664b74c7d3efe48909))

# [1.1.0](https://github.com/george43g/imsg-mcp/compare/v1.0.0...v1.1.0) (2026-06-07)


### Bug Fixes

* **analytics:** guard JSON.parse in lookupCache + add coverage ([b097196](https://github.com/george43g/imsg-mcp/commit/b097196627bba7918ffb9658efa0d452f1de384b))
* **analytics:** populate ext object in getMessagesInWindow ([ffab0ad](https://github.com/george43g/imsg-mcp/commit/ffab0adcce8485a1e89f5ce74a2921bbc1dd867c))
* **cache:** prependCached survives huge fresh batches (no Math.min spread crash) ([c6e4557](https://github.com/george43g/imsg-mcp/commit/c6e45570d55e4fd0c2b593f679753eae1017784d))
* **cli:** tighter looksLikeThreadSlug — no email misroute ([7de6788](https://github.com/george43g/imsg-mcp/commit/7de67883103dcbf9ca0715417322d97256d2625b))
* **db:** attachment.created_date is seconds, not nanoseconds ([ace4ef3](https://github.com/george43g/imsg-mcp/commit/ace4ef3daf83c80492b7803fd50da6b0c5694d19))
* **db:** only set richContentSummary when balloon_bundle_id is non-NULL ([3ce6eab](https://github.com/george43g/imsg-mcp/commit/3ce6eab38064ffa4c390da4119422f678a58a1df))
* **export:** writeAndDrain cleans up cross-listener on back-pressure path ([63fb41a](https://github.com/george43g/imsg-mcp/commit/63fb41a93ae6ae626ca9e920f5c263cf59f0c13a))
* **logger:** get_logs(source:file) actually reads the NDJSON ([9e29680](https://github.com/george43g/imsg-mcp/commit/9e29680b3e611415b7220a1f2f5eec6f7c812a9e))
* **logger:** heap warn threshold env-configurable, bumped default to 256MB ([69ff195](https://github.com/george43g/imsg-mcp/commit/69ff19548e2ec2c6a6629f693248c09998b2dcf7))
* **mcp:** friendlier tool error messages from Zod validation ([7126993](https://github.com/george43g/imsg-mcp/commit/71269932be80eab53888fa6ea62683fed55a47ae))
* **mcp:** get_messages engine label reflects runtime, not hardcoded "TS" ([a623e5b](https://github.com/george43g/imsg-mcp/commit/a623e5bfda8ddb37fe779553bee0a6d24dd228db))
* **mcp:** hard-cap list_conversations / search_contacts / get_unread_messages ([e8cf2c7](https://github.com/george43g/imsg-mcp/commit/e8cf2c7ebff1121213dd4da1530a8ff92b3cecd1))
* **mcp:** surface search_messages mode + minScore in the public schema ([aaa93bc](https://github.com/george43g/imsg-mcp/commit/aaa93bc91c5d6929f7be8155e838e2be982f7cb9))
* **mcp:** wait_for_reply cancellation honors signal during sleep ([ceaf1d5](https://github.com/george43g/imsg-mcp/commit/ceaf1d5d6f07fb6cf8115db18f2939977da2bd65))
* **parser:** structured NSString parse in Rust eliminates length-byte prefix ([44c2440](https://github.com/george43g/imsg-mcp/commit/44c2440b538af0641e15deb7588e714d9a69ace9))
* **reliability:** handle unhandled rejections + uncaught exceptions ([f2bb242](https://github.com/george43g/imsg-mcp/commit/f2bb2424c17cc78699d9fb3500d9f487ffbf0352))
* **search:** emoji + punctuation queries match via raw substring fast path ([b6c1472](https://github.com/george43g/imsg-mcp/commit/b6c1472622c2df38040a975b2ba7af31bd64f1b5))
* **send:** check_imessage_availability rejects malformed handles ([6458d68](https://github.com/george43g/imsg-mcp/commit/6458d6818598649fb9fe486e05ccde27dec3319b))
* **send:** validation failures populate get_last_send_error too ([e0991b5](https://github.com/george43g/imsg-mcp/commit/e0991b56d518749d298aad932a104bf2570607f2))
* **tui:** drawer Label colon + status bar overflow + compact engine label ([121d789](https://github.com/george43g/imsg-mcp/commit/121d789edc1bc87315ee1b8bb6e46c9c5a20deb3))
* **tui:** emoji-safe truncation in ConversationItem (no mid-surrogate splits) ([a1f20af](https://github.com/george43g/imsg-mcp/commit/a1f20af7482d1d730c76ac38a666a1e13494c98c))
* **tui:** live audit pass — DevStats wrap, filter Enter, send-via collapse ([fb87da8](https://github.com/george43g/imsg-mcp/commit/fb87da8cef22d8fc301b34250ffdac995985111f))
* **tui:** opaque DateJumpModal + ExportModal, pluralize selection summary ([fb4a16f](https://github.com/george43g/imsg-mcp/commit/fb4a16f00ef612bd298655da4fec6914c287cd87))
* **tui:** preserve prefix chars on overflow rows (HelpBar + MessageBubble) ([8988e55](https://github.com/george43g/imsg-mcp/commit/8988e55138862902c494804264e85731d2128a84))
* **tui:** ThreadPane header truncates instead of wrapping mid-word ([c400ca6](https://github.com/george43g/imsg-mcp/commit/c400ca6f29ed2d48f0f0a5effde60e55bb518390))


### Features

* o-key toast, gg debounce tightening, IMSG_DEFAULT_COUNTRY env ([4197e22](https://github.com/george43g/imsg-mcp/commit/4197e2216466e76a04070a1af1471706f1210f82))
* **recipient:** normalize 4 input forms into send-ready handles ([e8a73e4](https://github.com/george43g/imsg-mcp/commit/e8a73e47747fb593f3884a1ff61efe29282affd6))
* **release:** migrate DXT → MCPB bundle format, attach to GitHub release ([b76111b](https://github.com/george43g/imsg-mcp/commit/b76111beb083dd334df66a9d1ce2bd8674e45b44))
* **tui:** compose-to-new-thread surface (N key + ComposeRecipientModal) ([8fb65ad](https://github.com/george43g/imsg-mcp/commit/8fb65adcae1a9e940137e979f5ecdce614d5751c))
* **tui:** transparency badge — show normalized recipient handle ([5403eac](https://github.com/george43g/imsg-mcp/commit/5403eac05a0c6b4e3277630e4f4fbe26bec0013f))
* **tui:** warn at startup when powerline theme has no Nerd Font ([824e9c7](https://github.com/george43g/imsg-mcp/commit/824e9c77c6142b28547fa5e4054752d8b4120ebd))
* vanity-letter phone parsing + ambiguous-contact numbered picker ([d7b3529](https://github.com/george43g/imsg-mcp/commit/d7b352936b5c2c925f9e400cc4a6605d87f8bb1b))

# 1.0.0 (2026-05-25)


### Bug Fixes

* bin consolidation to 'imsg', memory leak in TUI render loop, and headless e2e tests ([7d6f6d6](https://github.com/george43g/imsg-mcp/commit/7d6f6d61dc54563dc79fa4b78f16667146fcd0e4))
* **parser+limits:** preamble 0x95 variant, raised MCP limits, dev-proxy stdin buffer ([fa55671](https://github.com/george43g/imsg-mcp/commit/fa55671de9d45c71a333344de0587c28fa4d761e))
* **parser:** strip doubled-letter prefix artifacts from native path ([965493d](https://github.com/george43g/imsg-mcp/commit/965493dd92e90eb0fe9d28717d2fd63272c7e054))
* **screenshots:** regenerate with installed JetBrains Mono + add fontconfig guard ([2137b7b](https://github.com/george43g/imsg-mcp/commit/2137b7bfd893af8a8375ececa58e3c611bc11791))
* **test:** VCF contact compare uses env fixture paths on CI ([fc8ecfc](https://github.com/george43g/imsg-mcp/commit/fc8ecfcd1fc78fd6a53cb2a557c6673c382327fe))
* **tui:** always show reply indicator, brighten dim text, breathing room around date separators ([8a9ae6f](https://github.com/george43g/imsg-mcp/commit/8a9ae6fa83c37de75cea6b2f5e86b15b0b780976)), closes [#64646A](https://github.com/george43g/imsg-mcp/issues/64646A) [#9090A0](https://github.com/george43g/imsg-mcp/issues/9090A0) [#3C3C41](https://github.com/george43g/imsg-mcp/issues/3C3C41) [#646470](https://github.com/george43g/imsg-mcp/issues/646470) [#64646A](https://github.com/george43g/imsg-mcp/issues/64646A) [#505055](https://github.com/george43g/imsg-mcp/issues/505055) [#7878A0](https://github.com/george43g/imsg-mcp/issues/7878A0)
* **tui:** call withFullScreen.start() before waitUntilExit ([2598aa1](https://github.com/george43g/imsg-mcp/commit/2598aa1f84cf49c61cb8a91fed075022eb452801))
* **tui:** conversation row layout, sidebar auto-scroll, slower wheel ([eb428b8](https://github.com/george43g/imsg-mcp/commit/eb428b82c9298526eeacc968972875c1af0292bb))
* **tui:** debounce conversation switching to prevent freeze ([69fb9d2](https://github.com/george43g/imsg-mcp/commit/69fb9d219f5f7c79a9e436801c22b12a06182f21))
* **tui:** mouse-mode 1003 floods stdin and pins the event loop ([4ebbed1](https://github.com/george43g/imsg-mcp/commit/4ebbed1778ca5e75346700b90574f9f87f61d158))
* update CLI dynamic imports for new tui/ directory ([7876402](https://github.com/george43g/imsg-mcp/commit/7876402fef8ced9c377717454eb25e33dfc2012d))


### Features

* add CLI, TUI, and publish-ready packaging ([5d41aa7](https://github.com/george43g/imsg-mcp/commit/5d41aa71969c2bfa0fa4ca3c0150f14505aa8f12))
* **analytics:** chat_analytics tool with 6 priority types + SQLite cache ([087cc14](https://github.com/george43g/imsg-mcp/commit/087cc14f14e9dc21e23da08a3ffac4ad59c8e4fe))
* **attachments:** search_attachments + get_attachment with HEIC→PNG conversion ([0e3b3f5](https://github.com/george43g/imsg-mcp/commit/0e3b3f531b6ce821bec83f463ab270351675dac8))
* bounded message window, MCP pagination cursor, streaming export_messages ([654df66](https://github.com/george43g/imsg-mcp/commit/654df6616845f7975c9b5f1e18800273c810cd36))
* **cli:** imsg export subcommand + README restructure + screenshot automation ([0ce0647](https://github.com/george43g/imsg-mcp/commit/0ce0647002d57a03f87488cb56deef1dc817515c))
* **contacts:** contact:N disambiguation selector (carterlasalle parity) ([b74a453](https://github.com/george43g/imsg-mcp/commit/b74a453d0ff6f6fb5d12692aa95416a31cbfc715))
* gate dev-only MCP tools behind IMSG_DEV env flag ([53d758b](https://github.com/george43g/imsg-mcp/commit/53d758bec41ce03f4a7513a2c95ef1602c61cb5b))
* heap monitor, MCP output quality, and text artifact fix ([2ae842f](https://github.com/george43g/imsg-mcp/commit/2ae842fe15c5488424a0bc6a74d5215f514f1950))
* MCP I/O hardening (output schemas, pagination cursors, text sanitization) ([c5a97d0](https://github.com/george43g/imsg-mcp/commit/c5a97d08b059a46472786a9fa89fa2578d282bcd))
* **native:** add Rust acceleration module via napi-rs ([4cb8df9](https://github.com/george43g/imsg-mcp/commit/4cb8df9e1ac21409426044d500b259842ae2c9da))
* **packaging:** MCPB Desktop Extension manifest + pack:mcpb script (carterlasalle parity) ([91fed16](https://github.com/george43g/imsg-mcp/commit/91fed16fb3f4302f8f9f5b37d804fceb72563bad))
* **parser:** hook native Rust parseAttributedBody as fast path ([c9ef08b](https://github.com/george43g/imsg-mcp/commit/c9ef08b90e6392ad56668b489086e6ce332bb0a6))
* Phase 1 pre-publish hardening — send reliability, prompt-injection guardrails, _meta footer ([641feeb](https://github.com/george43g/imsg-mcp/commit/641feeba52fa12558e44bf506b243a585994a2fa))
* prepare v1.0.0 — refactor, AbortSignal cancellation, semantic-release pipeline ([34f8864](https://github.com/george43g/imsg-mcp/commit/34f8864e3f0709cf1c3a1895d7f2635a037f14de))
* process lifecycle reliability + parser hang fix ([c81b5c1](https://github.com/george43g/imsg-mcp/commit/c81b5c19623448b3badab4cc14d53880abef88d8))
* **resources:** MCP Resources for recent messages + contacts (marissamarym parity) ([a4d7e59](https://github.com/george43g/imsg-mcp/commit/a4d7e59833626945d0baf2fb3f69933e9e73e12e))
* **robustness:** self-healing watchdog, per-tool timeouts, unlimited limits, health_check ([0c4e104](https://github.com/george43g/imsg-mcp/commit/0c4e1047cb37bb8b24d84ae80b43f9a64f4be485))
* **search:** fuzzy mode + WRatio-style scorer with token-set + Levenshtein blend ([aa154d4](https://github.com/george43g/imsg-mcp/commit/aa154d4d933a8e617eb0a68dc90fda041be1d635))
* **send:** attachments[] in send_message (1-on-1 only, group not supported) ([faee412](https://github.com/george43g/imsg-mcp/commit/faee4120dbe2f41d885be838cf36d4e173f103cb))
* structured perf logger with file output and instrumented code paths ([2341317](https://github.com/george43g/imsg-mcp/commit/23413171e72972ed9d55486ff80727cc02b2493e))
* **test:** synthetic fixture generator + MCP stress harness ([8ea172a](https://github.com/george43g/imsg-mcp/commit/8ea172a413a940c1bda36c45c3a7ced5f8d72e36))
* theme system, TUI config file, imsg-cli setup, env vars audit ([61a011e](https://github.com/george43g/imsg-mcp/commit/61a011e2aeb0eda916aec3c7f17eddb9fc78aebe)), closes [#FF6B35](https://github.com/george43g/imsg-mcp/issues/FF6B35) [#FF4444](https://github.com/george43g/imsg-mcp/issues/FF4444) [#1982FC](https://github.com/george43g/imsg-mcp/issues/1982FC)
* ThreadPane bottom-anchor, contacts MCP tools, kill observability ([002275a](https://github.com/george43g/imsg-mcp/commit/002275a0dbaf2d01fb9522abd0153eadd1c180c9))
* TUI sweep — date picker, Quick Look preview, logger gate, watchdog sleep skew ([83f5127](https://github.com/george43g/imsg-mcp/commit/83f5127478f381c4d9044eb5b6f78c43ee04178a))
* **tui:** lazy-load conversations + older messages, smart cache ([344725b](https://github.com/george43g/imsg-mcp/commit/344725b4321b6f3660cf4025c32893893dd81703))
* **tui:** O / S keybinds for cross-app launch via URL schemes ([b396386](https://github.com/george43g/imsg-mcp/commit/b3963868b72e7c77e048317d46699bdf68df6099))
* **tui:** premium rewrite with true color, bubbles, and compose ([fb5e83a](https://github.com/george43g/imsg-mcp/commit/fb5e83a7251e1a1649ac1f4aa5287839df9aa5bd))
* **tui:** rewrite with Ink (React for CLI) + batch reactions fix ([aa9ecc8](https://github.com/george43g/imsg-mcp/commit/aa9ecc8ca90c801db76eeff067137175c3415ab3))
* **tui:** scannable layout, vim keybindings, dev stats, drawer ([53ee9a2](https://github.com/george43g/imsg-mcp/commit/53ee9a22d47d0f41e232d55925f05991a86709df))
* **tui:** show thread slug, members, and contact details ([6fefdc9](https://github.com/george43g/imsg-mcp/commit/6fefdc9423f6b6eb5d2a239f8ee777d6ebd61cdc))
* **tui:** visual selection + multi-format export, date-jump modal ([43d1ba4](https://github.com/george43g/imsg-mcp/commit/43d1ba4bdf90abe6c2546abd28eee46f30ef12db))
* use Commander for CLI argument parsing; add TUI resize handling ([1dae45f](https://github.com/george43g/imsg-mcp/commit/1dae45fb3789735f490ea27e8cf171b54e6205c1))


### Performance Improvements

* batch-fetch reactions per chat instead of per message ([1f9a028](https://github.com/george43g/imsg-mcp/commit/1f9a028133393dade6355db84de9ae6fbecea928))
* TTL cache, lazy slug sync, and batched message queries ([505f6e3](https://github.com/george43g/imsg-mcp/commit/505f6e3eabc56d1073ab5471527a50b49b219d81))
* two-pass listConversations with cached aggregate queries ([4c968d4](https://github.com/george43g/imsg-mcp/commit/4c968d49e6b34ee0669b902be2dafed2580d5e2f))

<!-- semantic-release populates entries above this line. -->
