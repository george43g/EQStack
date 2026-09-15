# CLI subcommands and typed outputs — gmail-mcp

> Moved out of `apps/gmail-mcp/AGENTS.md` on 2026-09-15 so that guide fits Codex's instruction cap
> (`project_doc_max_bytes`, 32,768 bytes across the root-to-app chain). Content is unchanged except that
> relative link targets gained `../`. The guide keeps the must-hold rules and links here.

## gmail subcommand catalogue

Every Gmail tool has a corresponding `gmail` CLI subcommand. All commands accept `--json` (emits the typed `OperationResult.structuredContent` payload — see B2 below) and exit with `0` on success, `1` general error, `2` auth error (credentials missing / `invalid_grant`), `3` schema / usage error.

| Subcommand | Tool | Notes |
|---|---|---|
| `auth` | (deprecated) | Stub only. Exits non-zero and tells users to run `gmail account`. |
| `account` | (account CRUD + OAuth) | Bare command opens the Inquirer manager. Scriptable ops: `auth [id]`, `list`, `current`, `use <id>`, `rm <id>`, `check [id|--all]`, `rename <old> <new>`. |
| `health` | `health_check` | No Gmail call; local canary. `--json` returns typed `HealthSnapshot` |
| `inbox` | `list_inbox_threads` | Shortcut for `threads list -q in:inbox` |
| `search <query>` | `search_emails` | `--max N`. `--json` returns `{resultCount, results[]}` |
| `read <messageId>` | `read_email` | `--json` returns full message body + attachments metadata |
| `threads list` | `list_inbox_threads` | `--query`, `--max` |
| `threads get <id>` | `get_thread` | `--format full|metadata|minimal` |
| `threads modify <id>` | `modify_thread` | `--add ids`, `--remove ids` |
| `threads inbox` | `get_inbox_with_threads` | `--expand` to fetch full message content per thread |
| `send` | `send_email` | `-t`, `-s`, `-b` (literal / `'-'` for stdin / `'@file'`), `--cc`, `--bcc`, `--attach` (repeatable), `--thread-id`, `--in-reply-to`, `--from` (send-as alias), `--mime-type` |
| `draft` | `draft_email` | Same flags as `send`; creates draft instead of sending |
| `send-draft <draftId>` | `send_draft` | Atomically sends and removes an existing draft |
| `update-draft <draftId>` | `update_draft` | Same message flags as `send`; replaces draft content |
| `delete-draft <draftId>` | `delete_draft` | Deletes a draft |
| `list-drafts` | `list_drafts` | Lists saved drafts (subject, recipients, thread id, snippet). `--max`, `--page-token`, `--json` |
| `reply-all <messageId>` | `reply_all` | Auto-builds To/CC and threading headers from the original; `-b` body required |
| `modify <messageId>` | `modify_email` | `--add ids`, `--remove ids` |
| `delete <messageId>` | `delete_email` | Permanent (irreversible) |
| `batch-modify` | `batch_modify_emails` | `--ids` comma-separated or `@file.txt`; `--add`, `--remove`, `--batch-size`; max 500 |
| `batch-delete` | `batch_delete_emails` | `--ids` same syntax; `--batch-size`; max 500 |
| `report-phishing <messageId>` | `report_phishing` | Applies SPAM; Gmail has no native public phishing endpoint |
| `batch-report-phishing` | `batch_report_phishing` | Applies SPAM to `--ids`; max 500 |
| `labels list` | `list_email_labels` | |
| `labels create <name>` | `create_label` | `--show`, `--label-list` |
| `labels update <id>` | `update_label` | `--name`, `--show`/`--hide`, `--label-list` |
| `labels delete <id>` | `delete_label` | |
| `labels get-or-create <name>` | `get_or_create_label` | Idempotent |
| `filters list` | `list_filters` | |
| `filters get <id>` | `get_filter` | |
| `filters create` | `create_filter` | `--from`, `--to`, `--subject`, `--query`, `--has-attachment`, `--add-label`, `--remove-label`, `--forward` |
| `filters delete <id>` | `delete_filter` | |
| `filters template <name>` | `create_filter_from_template` | Templates: `fromSender`, `withSubject`, `withAttachments`, `largeEmails`, `containingText`, `mailingList` |
| `download-email <id>` | `download_email` | `-o save-dir`, `-f json|eml|txt|html` |
| `download-attachment <id> <attId>` | `download_attachment` | `-o save-dir`, `--filename` |
| `mcp [--http]` | (transport) | Starts the MCP server; supports `--tool-prefix`, plus HTTP `--port`, `--bind`, `--token-env` |
| `tui` | — | Full multi-pane Ink/React terminal client |
| `console` | — | Interactive REPL. Supports snappy aliases plus `accounts` and `switch <id>` / `sw <id>` for in-session account switching. |

CLI commands are thin wrappers over `callMcpTool(name, args)` (in-process; no child-process spawn). The common boilerplate is `runCliOp(toolName, args, {json}) -> Promise<never>` in `src/cli/runtime.ts`.

## Typed structured outputs (Phase B2)

Every registered op declares an `outputSchema` (a zod schema in `src/tools.ts`) and populates `OperationResult.structuredContent: z.infer<typeof outputSchema>` on its return. The MCP wire protocol still ships the legacy `content: [{type:"text", text:"..."}]` envelope unchanged; the typed JSON rides alongside.

Three consumers benefit:
- **`gmail … --json`** — emits the typed structured payload directly. `gmail search "in:inbox" --json` returns `{resultCount, results: [{id, subject, from, date}, ...]}` ready for `jq`, not the wrapped text envelope.
- **TUI hooks (Phase D)** — bind to typed `result.structuredContent` fields without parsing text.
- **MCP hosts that respect `outputSchema`** — get type info per tool, can validate responses.

Op handlers without an `outputSchema` stay text-only (no breakage; just no `--json` benefit). To opt a new op in: add a `*OutputSchema` to `src/tools.ts`, set `outputSchema` on the registry entry, and populate `structuredContent` on the return.
