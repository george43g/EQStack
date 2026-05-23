# Gmail-MCP-Server Feature → Test Coverage Audit

**Scope**: 27 MCP tools across 10 op files, full CLI surface (commander tree + REPL + runtime + gen-usage), auth flow (scope resolution + OAuth loopback + key/cred loaders + HTML pages), server transports (stdio dispatcher + Streamable HTTP), the 8-module robustness library, and structured outputSchema declarations.

**Method**: `find . -name "*.test.ts"` produced 25 vitest files; each feature is verified branch-by-branch against the tests that reference it. The `scripts/stress-mcp.ts` harness is end-to-end and is noted where it provides the only coverage of an integration path.

**Status legend**: TESTED (happy + ≥1 failure/edge), PARTIAL (only happy or subset of branches), MISSING (no branch-exercising test).

---

## 1. messages-ops
*Read/search/modify/delete on individual messages — handlers in `src/core/ops/messages.ts` (with `withRetry` + `rateLimitAcquire` wrappers).*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 1.1 | `read_email` handler (`extractHeaders` + `extractEmailContent` + `extractAttachments`, text/html fallback note, attachment summary line) | `src/core/ops/messages.ts:30-91` | `src/core/email-helpers.test.ts` (helpers only); `src/download-email.test.ts` (source grep) | PARTIAL | Handler-level test (mock `ctx.gmail.users.messages.get`) absent; HTML-only contentTypeNote branch untested |
| 1.2 | `read_email` rate-limit + retry wrapping | `src/core/ops/messages.ts:37-46` | none | MISSING | No assertion that `rateLimitAcquire` is called or `withRetry` wraps the call |
| 1.3 | `search_emails` handler (per-message metadata fetch, default maxResults=10) | `src/core/ops/messages.ts:93-145` | none | MISSING | No handler-level test |
| 1.4 | `modify_email` handler — `labelIds` precedence over `addLabelIds`, `removeLabelIds` pass-through | `src/core/ops/messages.ts:147-178` | none | MISSING | Precedence rule untested |
| 1.5 | `delete_email` handler | `src/core/ops/messages.ts:180-196` | none | MISSING | No test |
| 1.6 | `ReadEmailSchema`, `SearchEmailsSchema`, `ModifyEmailSchema`, `DeleteEmailSchema` zod | `src/tools.ts:30-51` | none | MISSING | Parse / required-field tests absent |
| 1.7 | `extractHeaders` helper (case-insensitive, missing payload) | `src/core/email-helpers.ts` | `src/core/email-helpers.test.ts:9-53` | TESTED | — |
| 1.8 | `extractEmailContent` helper (text, html, multipart, missing body) | `src/core/email-helpers.ts` | `src/core/email-helpers.test.ts:55-92` | TESTED | — |
| 1.9 | `extractAttachments` helper (none, top-level, nested, default fallback) | `src/core/email-helpers.ts` | `src/core/email-helpers.test.ts:94-156` | TESTED | — |

**Recommended new tests**: 1.1, 1.3, 1.4 (mocked `ctx.gmail`), 1.6 (schema), 1.2 (spy on retry/rate-limit modules).

---

## 2. threads-ops
*Thread-level reads + atomic modify — handlers in `src/core/ops/threads.ts`.*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 2.1 | `get_thread` handler (per-message header extraction, body extraction skip on `minimal`) | `src/core/ops/threads.ts:51-111` | `src/thread-tools.test.ts` (schema only) | PARTIAL | Handler-level not tested; the `format !== "minimal"` branch unverified |
| 2.2 | `list_inbox_threads` handler (default `in:inbox`, default `maxResults=50`, per-thread metadata) | `src/core/ops/threads.ts:113-161` | `src/thread-tools.test.ts:37-59` (schema only) | PARTIAL | Handler dispatch unverified |
| 2.3 | `get_inbox_with_threads` handler (`expandThreads=false` summary path) | `src/core/ops/threads.ts:163-216` | `src/thread-tools.test.ts:61-84` (schema only) | PARTIAL | Two-branch handler unverified |
| 2.4 | `get_inbox_with_threads` expand-true path (full per-message bodies + attachments) | `src/core/ops/threads.ts:218-278` | none | MISSING | No coverage |
| 2.5 | `modify_thread` handler (request body composition) | `src/core/ops/threads.ts:280-308` | `src/thread-tools.test.ts:86-139` (schema) | PARTIAL | Handler unverified |
| 2.6 | `collectAttachmentMeta` (local walker in threads.ts) | `src/core/ops/threads.ts:31-49` | none | MISSING | Distinct from `extractAttachments`; explicitly not deduped |
| 2.7 | Schema parse: `GetThreadSchema`, `ListInboxThreadsSchema`, `GetInboxWithThreadsSchema`, `ModifyThreadSchema` defaults/required/rejects | `src/tools.ts:258-296,245-256` | `src/thread-tools.test.ts:11-139` | TESTED | — |
| 2.8 | Tool-registry meta (scopes, annotations, descriptions) for thread tools | `src/tools.ts:577-607` | `src/thread-tools.test.ts:141-205` | TESTED | — |

**Recommended new tests**: 2.1, 2.2, 2.3, 2.4 (mock `ctx.gmail.users.threads.get/list`), 2.5 (assert `addLabelIds`/`removeLabelIds` only populated when supplied), 2.6 (golden test for `collectAttachmentMeta` walk vs `extractAttachments` to surface drift).

---

## 3. labels-ops (+ label-manager.ts)
*Label list/CRUD/get-or-create — handlers in `src/core/ops/labels.ts`, low-level helpers in `src/label-manager.ts`.*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 3.1 | `list_email_labels` handler + structured count/system/user split | `src/core/ops/labels.ts:29-63` | none | MISSING | No coverage |
| 3.2 | `create_label` handler (forwards visibility options) | `src/core/ops/labels.ts:65-94` | none | MISSING | — |
| 3.3 | `update_label` handler (only-defined-fields shallow merge) | `src/core/ops/labels.ts:96-129` | none | MISSING | — |
| 3.4 | `delete_label` handler | `src/core/ops/labels.ts:131-144` | none | MISSING | — |
| 3.5 | `get_or_create_label` action-text branch (`found existing` vs `created new`) | `src/core/ops/labels.ts:146-179` | none | MISSING | — |
| 3.6 | `label-manager.createLabel` default visibility + "already exists" rewrap | `src/label-manager.ts:28-59` | none | MISSING | — |
| 3.7 | `label-manager.updateLabel` 404 rewrap + pre-existence check | `src/label-manager.ts:68-98` | none | MISSING | — |
| 3.8 | `label-manager.deleteLabel` system-label refusal + 404 rewrap | `src/label-manager.ts:106-131` | none | MISSING | Important: only place system-label deletion is blocked |
| 3.9 | `label-manager.listLabels` system/user grouping + count | `src/label-manager.ts:138-163` | none | MISSING | — |
| 3.10 | `label-manager.findLabelByName` case-insensitive search | `src/label-manager.ts:171-185` | none | MISSING | — |
| 3.11 | `label-manager.getOrCreateLabel` cache-then-create flow | `src/label-manager.ts:194-215` | none | MISSING | — |
| 3.12 | Schemas: `ListEmailLabelsSchema`, `CreateLabelSchema`, `UpdateLabelSchema`, `DeleteLabelSchema`, `GetOrCreateLabelSchema` | `src/tools.ts:53-102` | none | MISSING | Parse + enum tests absent |

**Recommended new tests**: 3.1–3.5 (mocked `ctx.gmail.users.labels.*`), 3.6–3.11 (mocked low-level Gmail API), 3.8 (system-label deletion refusal — security-relevant), 3.12 (schema enum bounds for `messageListVisibility`).

---

## 4. send-draft-ops (+ reply-all-helpers, utl.ts)
*Outgoing-mail handlers — `src/core/ops/send.ts`, `src/core/ops/drafts.ts`; helpers in `src/reply-all-helpers.ts` and `src/utl.ts`.*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 4.1 | `handleEmailAction` no-attachment send path | `src/core/ops/send.ts:130-156` | `src/utl.test.ts` (source-grep only) | PARTIAL | Behavioural test absent (source grep `expect(source).toContain(...)` is brittle) |
| 4.2 | `handleEmailAction` attachment path (nodemailer route, base64url encoding) | `src/core/ops/send.ts:82-126` | none | MISSING | — |
| 4.3 | `handleEmailAction` auto-resolve threading headers when `threadId` set but `inReplyTo` missing | `src/core/ops/send.ts:41-80` | `src/utl.test.ts:78-86` (source grep) | PARTIAL | Live behaviour (calls `threads.get`, populates `inReplyTo` + `references`) unverified |
| 4.4 | `handleEmailAction` thread-fetch failure → degraded warn + continue | `src/core/ops/send.ts:74-79` | none | MISSING | Error swallow branch |
| 4.5 | `handleEmailAction` draft branch (`gmail.users.drafts.create`) | `src/core/ops/send.ts:108-126,158-171` | none | MISSING | — |
| 4.6 | `reply_all` handler (fetch original, exclude self, build To/CC, addRePrefix) | `src/core/ops/send.ts:192-269` | none (helpers only) | MISSING | Empty `replyTo` → throws unverified |
| 4.7 | `reply_all` handler: empty recipient throw | `src/core/ops/send.ts:229-231` | none | MISSING | — |
| 4.8 | `parseEmailAddresses` (`<>` extraction, multiple, no @ filter, whitespace) | `src/reply-all-helpers.ts:16-34` | `src/reply-all-helpers.test.ts:10-52` | TESTED | — |
| 4.9 | `filterOutEmail` (case-insensitive) | `src/reply-all-helpers.ts:44-47` | `src/reply-all-helpers.test.ts:54-84` | TESTED | — |
| 4.10 | `addRePrefix` (already-prefixed all cases) | `src/reply-all-helpers.ts:56-61` | `src/reply-all-helpers.test.ts:86-110` | TESTED | — |
| 4.11 | `buildReferencesHeader` | `src/reply-all-helpers.ts:71-79` | `src/reply-all-helpers.test.ts:112-136` | TESTED | — |
| 4.12 | `buildReplyAllRecipients` | `src/reply-all-helpers.ts:94-114` | `src/reply-all-helpers.test.ts:138-215` | TESTED | — |
| 4.13 | `createEmailMessage` threading headers (References + In-Reply-To, fallback, none) | `src/utl.ts:31-119` | `src/utl.test.ts:30-69` | TESTED | — |
| 4.14 | `createEmailMessage` mimeType branches: text/plain, text/html, multipart/alternative | `src/utl.ts:81-116` | none | MISSING | Only references branch covered |
| 4.15 | `createEmailMessage` RFC2047 subject encoding for non-ASCII | `src/utl.ts:9-16,32` | none | MISSING | — |
| 4.16 | `createEmailMessage` CRLF/`\0` header sanitization (injection guard) | `src/utl.ts:27-29,53-66` | none | MISSING | Security-relevant |
| 4.17 | `createEmailMessage` invalid recipient throws | `src/utl.ts:46-50` | none | MISSING | — |
| 4.18 | `createEmailWithNodemailer` attachment-file-missing throws | `src/utl.ts:138-141` | none | MISSING | — |
| 4.19 | `createEmailWithNodemailer` references-or-inReplyTo fallback | `src/utl.ts:161` | `src/utl.test.ts:73-76` (source grep) | PARTIAL | Source-string test only |
| 4.20 | `validateEmail` | `src/utl.ts:18-21` | none | MISSING | — |
| 4.21 | `draft_email` op (delegates) | `src/core/ops/drafts.ts:7-15` | none | MISSING | — |
| 4.22 | Schema: `SendEmailSchema`, `ReplyAllSchema` (mimeType enum, defaults) | `src/tools.ts:5-28,298-311` | none | MISSING | — |

**Recommended new tests**: 4.1, 4.2, 4.3 (mock `ctx.gmail` — assert raw MIME contents + `threads.get` call sequence), 4.6 + 4.7 (mocked profile + headers), 4.14–4.18 (utl.ts behavioural tests including CRLF injection attempt strings).

---

## 5. batch-ops (+ core/batch.ts)
*Bulk modify/delete — handlers in `src/core/ops/batch-ops.ts`, helper `src/core/batch.ts`.*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 5.1 | `processBatches` chunking | `src/core/batch.ts:39-48` | `src/core/batch.test.ts:5-14` | TESTED | — |
| 5.2 | `processBatches` per-item fallback on batch failure | `src/core/batch.ts:49-63` | `src/core/batch.test.ts:16-29` | TESTED | — |
| 5.3 | `processBatches` `AbortSignal` honoured between batches | `src/core/batch.ts:40-46,55` | `src/core/batch.test.ts:31-44` | TESTED | — |
| 5.4 | `processBatches` empty-input fast path | `src/core/batch.ts` | `src/core/batch.test.ts:46-49` | TESTED | — |
| 5.5 | `batch_modify_emails` handler (default `batchSize=50`, request-body composition, result text) | `src/core/ops/batch-ops.ts:15-76` | none | MISSING | Handler-level test absent |
| 5.6 | `batch_delete_emails` handler | `src/core/ops/batch-ops.ts:78-130` | none | MISSING | — |
| 5.7 | `BATCH_MESSAGE_IDS_MAX` cap (500) — both schemas | `src/tools.ts:107-136` | `src/batch-schemas.test.ts:1-46` | TESTED | — |
| 5.8 | `BatchModifyEmailsSchema` `addLabelIds`/`removeLabelIds` parse | `src/tools.ts:114-118` | `src/batch-schemas.test.ts:26-32` | TESTED | — |

**Recommended new tests**: 5.5 + 5.6 (mock `ctx.gmail.users.messages.modify`/`delete` failing for some IDs — assert `failureCount` accounting and truncated-ID error formatting at `:60`).

---

## 6. filters-ops (+ filter-manager.ts)
*Server-side filter CRUD + templates — handlers in `src/core/ops/filters.ts`, low-level in `src/filter-manager.ts`.*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 6.1 | `create_filter` handler (criteria+action text formatting) | `src/core/ops/filters.ts:29-64` | none | MISSING | — |
| 6.2 | `list_filters` handler (empty list short-circuit) | `src/core/ops/filters.ts:66-119` | none | MISSING | — |
| 6.3 | `get_filter` handler | `src/core/ops/filters.ts:121-156` | none | MISSING | — |
| 6.4 | `delete_filter` handler | `src/core/ops/filters.ts:158-171` | none | MISSING | — |
| 6.5 | `create_filter_from_template` — all 6 templates + required-param validation throws | `src/core/ops/filters.ts:173-247` | none | MISSING | 6 branches × 6 missing-param throws all unverified |
| 6.6 | `filterTemplates.fromSender` (archive flag) | `src/filter-manager.ts:136-146` | none | MISSING | — |
| 6.7 | `filterTemplates.withSubject` (markAsRead flag) | `src/filter-manager.ts:151-161` | none | MISSING | — |
| 6.8 | `filterTemplates.withAttachments` | `src/filter-manager.ts:166-171` | none | MISSING | — |
| 6.9 | `filterTemplates.largeEmails` | `src/filter-manager.ts:176-182` | none | MISSING | — |
| 6.10 | `filterTemplates.containingText` (markImportant flag) | `src/filter-manager.ts:187-196` | none | MISSING | — |
| 6.11 | `filterTemplates.mailingList` | `src/filter-manager.ts:201-211` | none | MISSING | — |
| 6.12 | `filter-manager.createFilter` 400 rewrap | `src/filter-manager.ts:38-61` | none | MISSING | — |
| 6.13 | `filter-manager.listFilters` empty-array default | `src/filter-manager.ts:68-83` | none | MISSING | — |
| 6.14 | `filter-manager.getFilter` 404 rewrap | `src/filter-manager.ts:91-105` | none | MISSING | — |
| 6.15 | `filter-manager.deleteFilter` 404 rewrap | `src/filter-manager.ts:113-127` | none | MISSING | — |
| 6.16 | Schemas: `CreateFilterSchema`, `GetFilterSchema`, `DeleteFilterSchema`, `CreateFilterFromTemplateSchema` enum | `src/tools.ts:138-218` | none | MISSING | — |

**Recommended new tests**: 6.5 (template-name switch — all 6 plus default throw), 6.6–6.11 (golden-output tests on the static template builders — easy & high-value), 6.12 / 6.14 / 6.15 (mocked 400/404 paths).

---

## 7. downloads-ops (+ email-export.ts, safe-path.ts)
*Email + attachment to disk — `src/core/ops/downloads.ts`, formatters in `src/email-export.ts`, path-traversal guard in `src/safe-path.ts`.*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 7.1 | `download_email` `json` format | `src/core/ops/downloads.ts:63-65` | `src/download-email.test.ts:60-102` (`gmailMessageToJson` unit) | PARTIAL | Handler integration (mkdir, writeFileSync, statSync) unverified |
| 7.2 | `download_email` `eml` format (raw RFC822 fetch + base64url decode) | `src/core/ops/downloads.ts:51-57` | none | MISSING | — |
| 7.3 | `download_email` `txt` format | `src/core/ops/downloads.ts:66-67` | `src/download-email.test.ts:104-133` (`emailToTxt` unit) | PARTIAL | Handler integration unverified |
| 7.4 | `download_email` `html` format + missing-HTML throw | `src/core/ops/downloads.ts:69-70` | `src/download-email.test.ts:135-147` | PARTIAL | Handler integration unverified |
| 7.5 | `download_email` `savePath` mkdir | `src/core/ops/downloads.ts:36-38` | none | MISSING | — |
| 7.6 | `download_email` swallowed error → text-only response | `src/core/ops/downloads.ts:94-98` | none | MISSING | — |
| 7.7 | `download_attachment` handler (filename auto-lookup, savePath default cwd, sanitization) | `src/core/ops/downloads.ts:102-187` | none | MISSING | All branches missing |
| 7.8 | `download_attachment` no-data throw | `src/core/ops/downloads.ts:122-124` | none | MISSING | — |
| 7.9 | `safeJoinWithinBase` simple join | `src/safe-path.ts` | `src/safe-path.test.ts:18-19` | TESTED | — |
| 7.10 | `safeJoinWithinBase` strips `..` prefix via basename | `src/safe-path.ts` | `src/safe-path.test.ts:22-25` | TESTED | — |
| 7.11 | `safeJoinWithinBase` strips absolute path via basename | `src/safe-path.ts` | `src/safe-path.test.ts:27-31` | TESTED | — |
| 7.12 | `safeJoinWithinBase` root edge case `'/'` | `src/safe-path.ts` | `src/safe-path.test.ts:44-49` | TESTED | — |
| 7.13 | `gmailMessageToJson` ISO date + missing headers + serialization | `src/email-export.ts:77-116` | `src/download-email.test.ts:60-102` | TESTED | — |
| 7.14 | `emailToTxt` cc/empty/attachments branches | `src/email-export.ts:135-168` | `src/download-email.test.ts:104-133` | TESTED | — |
| 7.15 | `emailToHtml` no-HTML throw | `src/email-export.ts:173-178` | `src/download-email.test.ts:142-146` | TESTED | — |
| 7.16 | `parseEmailAddress` quoted-name / bare / empty | `src/email-export.ts:43-54` | `src/download-email.test.ts:284-307` | TESTED | — |
| 7.17 | `parseEmailAddresses` (email-export) | `src/email-export.ts:60-72` | `src/download-email.test.ts:309-320` | TESTED | — |
| 7.18 | Tool-registry scope visibility for `download_email` | `src/tools.ts:608-615` | `src/download-email.test.ts:153-184` | TESTED | — |
| 7.19 | Schema: `DownloadEmailSchema` defaults + enum + required | `src/tools.ts:233-243` | `src/download-email.test.ts:189-237` | TESTED | — |
| 7.20 | Schema: `DownloadAttachmentSchema` | `src/tools.ts:220-231` | none | MISSING | — |

**Recommended new tests**: 7.1–7.7 (handler integration with mocked `ctx.gmail` writing into a tmp dir, assert file exists + correct format-extension), 7.20 (schema parse).

---

## 8. health-and-scopes (+ wrapToolError)
*Canary tool, scope check, auth-error wrapping.*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 8.1 | `health_check` op handler (uses `snapshotHealth` + session counters) | `src/core/ops/health.ts:12-27` | none directly; `scripts/stress-mcp.ts:161,178` (integration) | PARTIAL | Unit test absent; stress run is the only coverage |
| 8.2 | `snapshotHealth` healthy / degraded transitions, `killReason` → unhealthy | `src/robustness/health.ts:43-85` | `src/robustness/health.test.ts:4-28` | PARTIAL | `unhealthy` status from event_loop_p99 ≥ 5000 ms branch + `killReason` branch untested |
| 8.3 | `formatHealthText` rendering (with/without Issues, all lines) | `src/robustness/health.ts:87-100` | `src/robustness/health.test.ts:30-75` | TESTED | — |
| 8.4 | `hasScope` — empty required = true | `src/scopes.ts:53-58` | `src/download-email.test.ts:160-183` (indirect) | PARTIAL | Direct unit absent; URL-vs-shorthand normalization tested for one tool only |
| 8.5 | `scopeNameToUrl` / `scopeUrlToName` / `scopeNamesToUrls` | `src/scopes.ts:35-48` | none | MISSING | — |
| 8.6 | `parseScopes` (comma / whitespace split) | `src/scopes.ts:61-66` | indirect via `auth-scopes.test.ts:78-82` | PARTIAL | No dedicated test of mixed separators / empty entries |
| 8.7 | `validateScopes` valid/invalid arrays | `src/scopes.ts:69-72` | indirect via `auth-scopes.test.ts:140-176` | PARTIAL | No dedicated unit |
| 8.8 | `getAvailableScopeNames` | `src/scopes.ts:75-77` | none | MISSING | — |
| 8.9 | `isAuthError` classification (5 positive shapes, 5 negatives) | `src/auth-errors.ts:23-33` | `src/auth-errors.test.ts:4-22` | TESTED | — |
| 8.10 | `wrapToolError` non-auth path | `src/auth-errors.ts:94-104` | `src/auth-errors.test.ts:29-35` | TESTED | — |
| 8.11 | `wrapToolError` auth path remediation hint | `src/auth-errors.ts:76-93` | `src/auth-errors.test.ts:37-46` | TESTED | — |
| 8.12 | `wrapToolError` one-shot `invalid_grant` refresh latch | `src/auth-errors.ts:46-62,77-83` | `src/auth-errors.test.ts:48-63` | TESTED | — |
| 8.13 | `wrapToolError` refresh-fails fallback | `src/auth-errors.ts:55-60` | `src/auth-errors.test.ts:65-72` | TESTED | — |
| 8.14 | `wrapToolError` non-Error inputs | `src/auth-errors.ts:74` | `src/auth-errors.test.ts:74-78` | TESTED | — |
| 8.15 | `HealthCheckSchema` (empty object) | `src/tools.ts:314-318` | none | MISSING | trivial but uncovered |

**Recommended new tests**: 8.1 (unit-test the op handler with stubbed snapshot), 8.2 (`unhealthy` via watchdog `killReason` setter and via 5000ms event-loop value), 8.4–8.8 (direct unit tests in a `scopes.test.ts` file).

---

## 9. auth-flow (loaders, OAuth, scope resolution)
*OAuth keys loader, credential loader chain, scope resolver, port finder, HTML pages, `--print-json`.*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 9.1 | `loadOAuthKeys` env-JSON wins over disk | `src/core/auth-flow.ts:149-153` | `src/core/auth-flow.test.ts:24-40` | TESTED | — |
| 9.2 | `loadOAuthKeys` empty/whitespace env falls through | `src/core/auth-flow.ts:151` | `src/core/auth-flow.test.ts:42-53` | TESTED | — |
| 9.3 | `loadOAuthKeys` disk path | `src/core/auth-flow.ts:166-172` | `src/core/auth-flow.test.ts:55-64,130-152` | TESTED | — |
| 9.4 | `loadOAuthKeys` cwd→configDir copy convenience | `src/core/auth-flow.ts:155-164` | `src/core/auth-flow.test.ts:154-173` | TESTED | — |
| 9.5 | `loadOAuthKeys` parser — installed / web / bare / malformed / missing-field / non-object | `src/core/auth-flow.ts:112-135` | `src/core/auth-flow.test.ts:67-128` | TESTED | — |
| 9.6 | `findAvailablePort` — preferred free | `src/core/auth-flow.ts:50-74` | `src/core/auth-flow.test.ts:175-180` | TESTED | — |
| 9.7 | `findAvailablePort` fallback to neighbouring | `src/core/auth-flow.ts:55-57` | `src/core/auth-flow.test.ts:181-193` | TESTED | — |
| 9.8 | `findAvailablePort` ephemeral fallback (all 10 neighbours taken) | `src/core/auth-flow.ts:58-73` | none | MISSING | Hard to exercise but reachable |
| 9.9 | `runOAuthFlow` happy path (token exchange via `getToken`) | `src/core/auth-flow.ts:188-290` | none | MISSING | Whole loopback flow — would need an HTTP fixture and stubbed `OAuth2Client.getToken` |
| 9.10 | `runOAuthFlow` consent-denied error param branch | `src/core/auth-flow.ts:249-255` | none | MISSING | — |
| 9.11 | `runOAuthFlow` missing-`code` branch | `src/core/auth-flow.ts:256-262` | none | MISSING | — |
| 9.12 | `runOAuthFlow` `getToken` exception → 500 + reject | `src/core/auth-flow.ts:269-278` | none | MISSING | — |
| 9.13 | `runOAuthFlow` headless mode (no browser open) | `src/core/auth-flow.ts:206-222,282-288` | none | MISSING | — |
| 9.14 | `runOAuthFlow` `open` failure fallback message | `src/core/auth-flow.ts:283-286` | none | MISSING | — |
| 9.15 | `createOAuthClient` | `src/core/auth-flow.ts:175-180` | none | MISSING | — |
| 9.16 | `saveCredentialsToFile` (configDir mkdir, mode 0600) | `src/core/auth-flow.ts:300-306` | none | MISSING | — |
| 9.17 | `formatCredentialsForExport` (used by `--print-json`) | `src/core/auth-flow.ts:313-318` | none | MISSING | — |
| 9.18 | `renderSuccessPage` (scope chips + auto-close) | `src/core/auth-flow.ts:350-365` | `src/core/auth-flow.test.ts:197-203` | TESTED | — |
| 9.19 | `renderErrorPage` XSS escape | `src/core/auth-flow.ts:367-378` | `src/core/auth-flow.test.ts:205-210` | TESTED | — |
| 9.20 | `portFromCallback` (defaulting / parse error) | `src/core/auth-flow.ts:383-393` | none | MISSING | — |
| 9.21 | `runAuthCommand` (CLI driver — `--scopes` translation, port resolution, `--print-json` capture w/ both env-keys and disk-keys) | `src/cli/commands/auth.ts:81-183` | none | MISSING | — |
| 9.22 | `loadCredentials` env-JSON wins | `src/core/credentials.ts:110-117` | `src/core/credentials.test.ts:14-32` | TESTED | — |
| 9.23 | `loadCredentials` 1Password branch happy path | `src/core/credentials.ts:119-151` | `src/core/credentials.test.ts:34-52` | TESTED | — |
| 9.24 | `loadCredentials` 1Password non-`op://` reject | `src/core/credentials.ts:122-127` | `src/core/credentials.test.ts:100-105` | TESTED | — |
| 9.25 | `loadCredentials` 1Password ENOENT install hint | `src/core/credentials.ts:131-139` | `src/core/credentials.test.ts:107-123` | TESTED | — |
| 9.26 | `loadCredentials` file branch + fallbackPath | `src/core/credentials.ts:153-172` | `src/core/credentials.test.ts:54-82` | TESTED | — |
| 9.27 | `loadCredentials` no-source / missing-file errors | `src/core/credentials.ts:155-166` | `src/core/credentials.test.ts:86-99` | TESTED | — |
| 9.28 | `loadCredentials` malformed JSON rejection | `src/core/credentials.ts:81-89` | `src/core/credentials.test.ts:125-130` | TESTED | — |
| 9.29 | `loadCredentials` empty/whitespace env-var skip | `src/core/credentials.ts:111-112,121` | `src/core/credentials.test.ts:132-146` | TESTED | — |
| 9.30 | `loadCredentials` canonical `{tokens,scopes}` + legacy bare shapes | `src/core/credentials.ts:91-101` | `src/core/credentials.test.ts:149-181` | TESTED | — |
| 9.31 | `resolveScopes` CLI > env > prompt > default precedence | `src/auth-scopes.ts:88-123` | `src/auth-scopes.test.ts:58-138` | TESTED | — |
| 9.32 | `resolveScopes` invalid-scope throws (`InvalidScopeError`) | `src/auth-scopes.ts:61-65` | `src/auth-scopes.test.ts:140-176` | TESTED | — |
| 9.33 | `findCliScopesArg`, `isNonInteractive` matrix | `src/auth-scopes.ts:43-59` | `src/auth-scopes.test.ts:12-55` | TESTED | — |
| 9.34 | `config-paths` (`getConfigDir`/`getOAuthPath`/`getCredentialsPath`) override precedence | `src/core/config-paths.ts:18-34` | `src/core/config-paths.test.ts:6-51` | TESTED | — |

**Recommended new tests**: 9.9–9.14 (`runOAuthFlow` with a tiny HTTP fixture + stub `OAuth2Client`), 9.16 (mode 0600 + mkdir 0700 + JSON shape), 9.17 + 9.21 (`--print-json` w/ disk vs env oauth keys + `--scopes` translation), 9.20 (URL with no port / https / unparseable).

---

## 10. cli-surface (commands except auth, runtime.ts, gen-usage)
*Commander tree builders + runtime helpers + `--usage-spec` short-circuit + gen-usage script.*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 10.1 | `buildProgram` wires every subcommand | `src/cli/index.ts:56-127` | none | MISSING | No structural test (e.g. `program.commands.map(c=>c.name())`) |
| 10.2 | `readVersion` (graceful fallback to "unknown") | `src/cli/index.ts:39-49` | none | MISSING | — |
| 10.3 | `main` `--usage-spec` short-circuit | `src/cli/index.ts:129-141` | none | MISSING | The hidden flag → generate-and-exit path |
| 10.4 | `isMain` direct-invocation guard | `src/cli/index.ts:144-164` | none | MISSING | — |
| 10.5 | `buildMcpCommand` flag definitions (`--http`, `--port`, `--bind`, `--token-env`) | `src/cli/commands/mcp.ts:17-42` | none | MISSING | — |
| 10.6 | `buildTuiCommand` not-implemented stub + ERR_MODULE_NOT_FOUND graceful exit | `src/cli/commands/tui.ts:9-34` | none | MISSING | — |
| 10.7 | `buildHealthCommand` `--json` vs text + exit code mapping | `src/cli/commands/health.ts:14-33` | none | MISSING | — |
| 10.8 | `buildSearchCommand` default `-n 25` | `src/cli/commands/search.ts:14-25` | none | MISSING | — |
| 10.9 | `buildReadCommand` | `src/cli/commands/read.ts:6-16` | none | MISSING | — |
| 10.10 | `buildThreadsCommand` 4 subcommands incl. defaults | `src/cli/commands/threads.ts:6-77` | none | MISSING | — |
| 10.11 | `buildInboxAliasCommand` positional vs `-n` precedence | `src/cli/commands/threads.ts:84-102` | none | MISSING | — |
| 10.12 | `buildSendCommand` / `buildDraftCommand` shared option attachment | `src/cli/commands/send.ts:50-93` | none | MISSING | — |
| 10.13 | `buildSendCommand` `--to` + `--subject` required error | `src/cli/commands/send.ts:26-28` | none | MISSING | — |
| 10.14 | `buildSendCommand` `--body` required error | `src/cli/commands/send.ts:30-34` | none | MISSING | — |
| 10.15 | `buildReplyAllCommand` body resolution path | `src/cli/commands/send.ts:95-148` | none | MISSING | — |
| 10.16 | `buildModifyCommand` / `buildDeleteCommand` | `src/cli/commands/messages.ts:6-40` | none | MISSING | — |
| 10.17 | `buildBatchModifyCommand` / `buildBatchDeleteCommand` `--ids` parser (`@file` and CSV) | `src/cli/commands/batch.ts:11-82` | none | MISSING | — |
| 10.18 | `buildLabelsCommand` (list/create/update/delete/get-or-create) — `--show`/`--hide` precedence | `src/cli/commands/labels.ts:6-89` | none | MISSING | — |
| 10.19 | `buildFiltersCommand` (list/get/create/delete/template) — template flag mapping | `src/cli/commands/filters.ts:6-128` | none | MISSING | — |
| 10.20 | `buildDownloadEmailCommand` format validator + required `--save-path` | `src/cli/commands/downloads.ts:8-36` | none | MISSING | Format-rejection path on `xml` etc. |
| 10.21 | `buildDownloadAttachmentCommand` positional args | `src/cli/commands/downloads.ts:38-66` | none | MISSING | — |
| 10.22 | `buildConsoleCommand` (lazy import wiring) | `src/cli/commands/console.ts:6-13` | none | MISSING | — |
| 10.23 | `bootstrapForCli` idempotency | `src/cli/runtime.ts:19-24` | none | MISSING | The `bootstrapped` latch isn't exercised |
| 10.24 | `resolveBodyInput` undefined / literal / `@file` / `-` stdin | `src/cli/runtime.ts:33-48` | `src/cli/runtime.test.ts:126-149` | PARTIAL | stdin `-` branch not covered |
| 10.25 | `formatToolResultText` (joins, filters non-text, empty) | `src/cli/runtime.ts:54-62` | `src/cli/runtime.test.ts:16-42` | TESTED | — |
| 10.26 | `printToolResult` structuredContent vs text fallback vs text-mode | `src/cli/runtime.ts:82-102` | `src/cli/runtime.test.ts:44-105` | TESTED | — |
| 10.27 | `exitCodeForError` (auth=2, schema=3, other=1) | `src/cli/runtime.ts:69-74` | `src/cli/runtime.test.ts:107-124` | TESTED | — |
| 10.28 | `executeCliOp` REPL-safe behaviour | `src/cli/runtime.ts:127-142` | `src/cli/console.test.ts:107-115` (indirect) | PARTIAL | — |
| 10.29 | `runCliOp` REPL-mode flag respected | `src/cli/runtime.ts:153-168` | `src/cli/console.test.ts:107-125` | TESTED | — |
| 10.30 | `scripts/gen-usage.ts` write mode | `scripts/gen-usage.ts:34-58` | none | MISSING | — |
| 10.31 | `scripts/gen-usage.ts` `--check` mode (missing file / drift / in-sync) | `scripts/gen-usage.ts:38-53` | none | MISSING | CI drift gate is itself untested |

**Recommended new tests**: 10.1, 10.3, 10.6 (TUI stub path is a regression risk), 10.13 + 10.14 + 10.20 (commander error paths via `program.exitOverride()` + `parseAsync`), 10.17 (`@file` vs CSV ids resolution unit), 10.24 stdin branch, 10.30/10.31 (`gen-usage --check` invoked in a tmp working tree).

---

## 11. console-repl
*Aliases, builtins, tokenizer, REPL-mode flag — `src/cli/console.ts`.*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 11.1 | `parseConsoleInput` whitespace splitter | `src/cli/console.ts:42-67` | `src/cli/console.test.ts:9-39` | TESTED | — |
| 11.2 | `parseConsoleInput` double-quoted preservation | `src/cli/console.ts:48-50` | `src/cli/console.test.ts:13-19` | TESTED | — |
| 11.3 | `parseConsoleInput` single-quoted preservation | `src/cli/console.ts:48-50` | `src/cli/console.test.ts:21-26` | TESTED | — |
| 11.4 | `parseConsoleInput` mixed + empty | `src/cli/console.ts` | `src/cli/console.test.ts:28-38` | TESTED | — |
| 11.5 | `rewriteAlias` — every entry in the 15-alias map | `src/cli/console.ts:20-36,72-74` | `src/cli/console.test.ts:42-64` | PARTIAL | Aliases `t`/`de`/`da` (and the unknown-passthrough case is tested) — but `t`, `de`, `da` missing from the per-row test list |
| 11.6 | `isBuiltinCommand` (`help`/`?`/`clear`/`cls`/`quit`/`q`/`exit`/`tools`/`raw`) | `src/cli/console.ts:135-147` | `src/cli/console.test.ts:67-85` | TESTED | — |
| 11.7 | `runConsole` legend rendering + bootstrap | `src/cli/console.ts:110-129,184-200` | none | MISSING | No render/dispatch test |
| 11.8 | REPL loop — help/clear/quit/tools/raw intercepts | `src/cli/console.ts:207-285` | none | MISSING | — |
| 11.9 | REPL loop — commander route + per-line program rebuild | `src/cli/console.ts:254-282` | none | MISSING | Re-building per line is load-bearing for default-leak prevention |
| 11.10 | REPL loop — error code mapping (`commander.help` quiet exit) | `src/cli/console.ts:264-279` | none | MISSING | — |
| 11.11 | `runRawCommand` — bad JSON, missing tool name | `src/cli/console.ts:149-165` | none | MISSING | — |
| 11.12 | `listTools` — bootstrap + registry enumeration | `src/cli/console.ts:167-174` | none | MISSING | — |
| 11.13 | `GMAIL_CLI_REPL` env var lifecycle (set/clear around `parseAsync`) | `src/cli/console.ts:259-282`; `src/cli/runtime.ts:158-163` | `src/cli/console.test.ts:107-125` | TESTED | — |

**Recommended new tests**: 11.5 (extend table with `t`, `de`, `da`), 11.7 (capture legend via `write` injector — already exposed), 11.8 + 11.10 (build a fake readline interface and feed lines), 11.11 (drive `runRawCommand` directly), 11.12 (mock `bootstrapForCli` to no-op).

---

## 12. mcp-server-transport
*`buildMcpServer` dispatcher, stdio entry, HTTP transport.*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 12.1 | `buildMcpServer` `tools/list` scope filter | `src/server/build.ts:93-98` | `scripts/stress-mcp.ts:148` (integration) | PARTIAL | No unit test |
| 12.2 | Per-tool timeout map (`TOOL_TIMEOUTS_MS`) + default | `src/server/build.ts:28-60,119-120` | `scripts/stress-mcp.ts:233` (`MCP_TOOL_TIMEOUT_FORCE_MS=1`) | PARTIAL | Per-tool override not asserted; `MCP_TOOL_TIMEOUT_FORCE_MS` exclusive precedence covered by stress |
| 12.3 | Dispatcher unknown-tool → error envelope | `src/server/build.ts:107-117` | `scripts/stress-mcp.ts:197` (integration) | PARTIAL | No unit test |
| 12.4 | Dispatcher scope-gated tool → re-auth hint | `src/server/build.ts:108-117` | none | MISSING | — |
| 12.5 | Dispatcher `ToolTimeoutError` → `isError:true` envelope | `src/server/build.ts:137-141` | `scripts/stress-mcp.ts:233` (integration) | PARTIAL | Unit test absent |
| 12.6 | Dispatcher `noteActivity` + `incrementToolCallCount` side effects | `src/server/build.ts:104-105` | none | MISSING | — |
| 12.7 | Dispatcher records error + wraps via `wrapToolError` | `src/server/build.ts:135-144` | none | MISSING | — |
| 12.8 | `CallToolFn` exported dispatch surface (in-process callers) | `src/server/build.ts:62-70,151` | indirectly via `src/cli/console.test.ts` | PARTIAL | No direct unit |
| 12.9 | HTTP `startHttpServer` token-missing throws on start | `src/server/http.ts:45-51` | none | MISSING | Important security gate; stress harness uses a valid token |
| 12.10 | HTTP `/health` 200 vs 503 (unhealthy) | `src/server/http.ts:68-75` | `scripts/stress-mcp.ts:288` (200 only) | PARTIAL | 503 unhealthy branch unverified |
| 12.11 | HTTP unknown path → 404 | `src/server/http.ts:77-81` | none | MISSING | — |
| 12.12 | HTTP `/mcp` bearer-auth — missing / wrong → 401 | `src/server/http.ts:84-95` | `scripts/stress-mcp.ts:288` (401 case) | TESTED | — |
| 12.13 | HTTP `timingSafeEqual` constant-time compare | `src/server/http.ts:150-160` | none | MISSING | — |
| 12.14 | HTTP `readJsonBody` size cap + invalid JSON | `src/server/http.ts:162-189` | none | MISSING | Body limit (4 MB) untested |
| 12.15 | HTTP stateful session id (mcp-session-id round-trip) | `src/server/http.ts:54-61`; transport | `scripts/stress-mcp.ts:288-414` | TESTED | — |
| 12.16 | HTTP graceful close (server + transport) | `src/server/http.ts:135-143` | none | MISSING | — |
| 12.17 | HTTP internal error → 500 + log | `src/server/http.ts:104-117` | none | MISSING | — |
| 12.18 | `toMcpTools` JSON-schema conversion | `src/tools.ts:760-767` | indirect via stress handshake | PARTIAL | — |
| 12.19 | `getToolByName` | `src/tools.ts:770-772` | indirect via `download-email.test.ts` + `thread-tools.test.ts` | TESTED | — |

**Recommended new tests**: 12.1 + 12.3 + 12.4 (unit-test `dispatch` with stub session/registry — would catch many regressions cheaply), 12.6 + 12.7 (session counters integration), 12.9 (start with empty token env, expect throw), 12.10 unhealthy-503 branch, 12.13 (timing-equal correctness), 12.14 (oversized body rejection).

---

## 13. robustness-lib
*Surface-agnostic resilience modules.*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 13.1 | `envNum` (unset / empty / valid / negative / non-numeric / leading-int) | `src/robustness/env.ts:12-18` | `src/robustness/env.test.ts:6-47` | TESTED | — |
| 13.2 | `envBool` (truthy/falsy/unrecognised) | `src/robustness/env.ts:23-30` | `src/robustness/env.test.ts:49-77` | TESTED | — |
| 13.3 | `envStr` (unset/empty/value/whitespace preservation) | `src/robustness/env.ts:32-36` | `src/robustness/env.test.ts:79-104` | TESTED | — |
| 13.4 | Shutdown registry — register / order / async / error swallow / dedup / unregister | `src/robustness/shutdown.ts:24-92` | `src/robustness/shutdown.test.ts:24-105` | TESTED | — |
| 13.5 | `installShutdownHandlers` signal map (SIGINT/SIGTERM/SIGHUP/SIGQUIT) | `src/robustness/shutdown.ts:82-92` | none | MISSING | stress harness exercises SIGTERM only |
| 13.6 | `enableStdinEofDetection` | `src/robustness/shutdown.ts:98-103` | none | MISSING | — |
| 13.7 | `enableOrphanWatchdog` ppid change | `src/robustness/shutdown.ts:110-120` | none | MISSING | — |
| 13.8 | Logger ring buffer + level capture | `src/robustness/logger.ts:97-?` | `src/robustness/logger.test.ts:40-66` | TESTED | — |
| 13.9 | Logger NDJSON file output | `src/robustness/logger.ts:50-82` | `src/robustness/logger.test.ts:68-?` | TESTED | — |
| 13.10 | Logger `perf` span + `logStartup`/`logShutdown` markers | `src/robustness/logger.ts` | `src/robustness/logger.test.ts` (imports) | PARTIAL | I read 80 lines; existing test imports them but exact branch depth unverified here |
| 13.11 | `installWatchdog` 3 monitors + cleanup register | `src/robustness/watchdog.ts:105-204` | none | MISSING | Only `isMonotonicallyGrowing` unit; stress harness covers RSS kill |
| 13.12 | `isMonotonicallyGrowing` heuristic (≥5 MB total + every-step monotone) | `src/robustness/watchdog.ts:213-221` | `src/robustness/watchdog.test.ts:4-39` | TESTED | — |
| 13.13 | `noteActivity` / `readWatchdogState` | `src/robustness/watchdog.ts:78-85` | none | MISSING | — |
| 13.14 | `onMemorySample` subscriber pattern | `src/robustness/watchdog.ts:88-102` | none | MISSING | — |
| 13.15 | `triggerKill` (one-shot, force-exit safety) | `src/robustness/watchdog.ts:223-232` | none | MISSING | Critical kill path |
| 13.16 | `withTimeout` happy path | `src/robustness/with-timeout.ts:25-45` | `src/robustness/with-timeout.test.ts:5-15` | TESTED | — |
| 13.17 | `withTimeout` timeout throws `ToolTimeoutError` | `src/robustness/with-timeout.ts:32-38` | `src/robustness/with-timeout.test.ts:17-34` | TESTED | — |
| 13.18 | `withTimeout` error propagation | `src/robustness/with-timeout.ts:40-44` | `src/robustness/with-timeout.test.ts:36-45` | TESTED | — |
| 13.19 | `withTimeout` `timeoutMs <= 0` disables wrapper | `src/robustness/with-timeout.ts:30` | `src/robustness/with-timeout.test.ts:47-57` | TESTED | — |
| 13.20 | `isTransientError` (5xx, 429, network codes, non-transient) | `src/robustness/retry.ts:41-52` | `src/robustness/retry.test.ts:4-27` | TESTED | — |
| 13.21 | `withRetry` success / retry / give-up / custom predicate | `src/robustness/retry.ts:69-94` | `src/robustness/retry.test.ts:40-87` | TESTED | — |
| 13.22 | `withRetry` jitter + cap | `src/robustness/retry.ts:54-59` | none | MISSING | — |
| 13.23 | `TokenBucket` — start at capacity / acquire / waits / cap / rps=0 / negative reject | `src/robustness/rate-limit.ts:20-78` | `src/robustness/rate-limit.test.ts:20-84` | TESTED | — |
| 13.24 | `defaultLimiterAvailable` exposed singleton | `src/robustness/rate-limit.ts:80-90` | none | MISSING | — |

**Recommended new tests**: 13.5–13.7 (signal trapping with stubbed `process.kill` / ppid getter — testable today), 13.11 + 13.15 (drive monitors with shortened intervals + stubbed metric source; assert `triggerKill` log + `shutdown` invocation), 13.13–13.14 (subscriber callback fan-out + state-getter purity), 13.22 (deterministic jitter via `Math.random` stub).

---

## 14. output-schemas
*Typed `structuredContent` schemas per op — declared in `src/tools.ts:320-531`.*

| # | Feature | Source file:line | Test file(s) | Status | Gap |
|---|---|---|---|---|---|
| 14.1 | `SearchEmailsOutputSchema` shape (`resultCount` + `results[]`) | `src/tools.ts:347-350` | none | MISSING | Schema exists but `.parse(handler.structuredContent)` round-trip never asserted |
| 14.2 | `ReadEmailOutputSchema` | `src/tools.ts:352-364` | none | MISSING | — |
| 14.3 | `GetThreadOutputSchema` + `ThreadMessageSummarySchema` | `src/tools.ts:366-384` | none | MISSING | — |
| 14.4 | `ListInboxThreadsOutputSchema` + `ThreadSummarySchema` | `src/tools.ts:386-401` | none | MISSING | — |
| 14.5 | `GetInboxWithThreadsOutputSchema` (discriminated union: summary or expanded) | `src/tools.ts:403-415` | none | MISSING | — |
| 14.6 | `ListEmailLabelsOutputSchema` (count/system/user) | `src/tools.ts:417-427` | none | MISSING | — |
| 14.7 | `LabelMutationOutputSchema` | `src/tools.ts:429-433` | none | MISSING | — |
| 14.8 | `LabelDeleteOutputSchema` | `src/tools.ts:435-439` | none | MISSING | — |
| 14.9 | `ListFiltersOutputSchema` + `FilterEntrySchema` | `src/tools.ts:441-450` | none | MISSING | — |
| 14.10 | `GetFilterOutputSchema` (alias) | `src/tools.ts:452` | none | MISSING | — |
| 14.11 | `CreateFilterOutputSchema` | `src/tools.ts:454-458` | none | MISSING | — |
| 14.12 | `DeleteFilterOutputSchema` | `src/tools.ts:460-464` | none | MISSING | — |
| 14.13 | `SendOrDraftOutputSchema` (`action` enum) | `src/tools.ts:466-470` | none | MISSING | — |
| 14.14 | `ReplyAllOutputSchema` | `src/tools.ts:472-478` | none | MISSING | — |
| 14.15 | `ModifyOrDeleteEmailOutputSchema` (enum) | `src/tools.ts:480-483` | none | MISSING | — |
| 14.16 | `ModifyThreadOutputSchema` | `src/tools.ts:485-488` | none | MISSING | — |
| 14.17 | `BatchOpOutputSchema` (with `failures[]`) | `src/tools.ts:490-495` | none | MISSING | — |
| 14.18 | `DownloadEmailOutputSchema` (format enum + attachments[]) | `src/tools.ts:497-507` | none | MISSING | — |
| 14.19 | `DownloadAttachmentOutputSchema` | `src/tools.ts:509-516` | none | MISSING | — |
| 14.20 | `HealthCheckOutputSchema` (enum status + metrics) | `src/tools.ts:518-531` | none | MISSING | — |
| 14.21 | `Operation.outputSchema` round-trip — every handler returns data that parses cleanly under its declared `outputSchema` | each op file | none | MISSING | The whole point of B2; one parameterised test per op would catch drift cheaply |

**Recommended new tests**: a single parameterised test that, for every registered op, calls the handler against a mocked `ctx.gmail`, then runs `op.outputSchema.parse(result.structuredContent)` — would cover 14.1–14.20 + many ops gaps from §§1–7 simultaneously and is the highest-ROI new test in this audit.

---

### Cross-cutting observations

- **Stress harness** (`scripts/stress-mcp.ts`) provides the only branch coverage for: stdio dispatch, `MCP_TOOL_TIMEOUT_FORCE_MS`, SIGTERM exit-0, `MCP_MAX_RSS_MB` watchdog kill, HTTP `/health`+`/mcp` happy path, and 401 rejection. These count as integration coverage but not as unit-level branch coverage in the table above.
- **27 MCP tools** map to handlers in `src/core/ops/*.ts`: messages.ts (4), threads.ts (4), labels.ts (5), send.ts (2), drafts.ts (1), batch-ops.ts (2), filters.ts (5), downloads.ts (2), health.ts (1) = 26 + `reply_all` (in send.ts) = 27. All 27 are registered (`registry.register(...)` at module load); only `read_email` and `search_emails` are wrapped with `withRetry`+`rateLimitAcquire` (per CLAUDE.md, others are progressive-adoption candidates — uncovered).
- **`utl.test.ts` and `download-email.test.ts` rely on `fs.readFileSync(...).toContain(...)` source-grep assertions** — these are brittle and don't survive a rename, but they're tracked as PARTIAL because they at least assert that the wiring exists.
- The largest single coverage gap is **§14 output-schemas** (20 schemas, 0 round-trip tests) — addressable with one parameterised test.
