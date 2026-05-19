# Phase D — TUI MVP (`gmail tui`)

> **Status**: planned, not started. Wired as the `gmail tui` subcommand (lazy-loads `src/tui/index.ts::runTui`); a placeholder export currently makes the subcommand print "not yet implemented" until this plan ships.
> **Prerequisites met**: registry refactor (B1) ✅, typed structured outputs (B2) ✅, CLI fan-out ✅, bin consolidation ✅. The TUI is the last major piece on the master plan.

## Context

The package now ships a single `gmail` bin with subcommands. `gmail mcp` and the per-op CLI (`gmail auth`, `gmail search`, `gmail send`, …) are done. The TUI mode (`gmail tui`) is a full-screen Ink/React terminal client over the same `core/ops/` registry — keyboard-driven, low memory, network-friendly enough to run over `tmux` + SSH/mosh on a remote server.

**Positioning**: this is a Gmail TUI, not a generic email client. We lean on the server (Gmail does search, threading, filtering); the TUI is a thin, fast, keyboard-first viewer + composer. Lean memory, no local mailstore, no background polling. Power users get a vim-style modal interface they can fly around without touching the mouse.

## Goals

- **Multi-pane layout**: sidebar (labels), thread list, message reader. Inspired by `aerc` / `neomutt` / imsg-mcp's TUI, adapted for Gmail.
- **Vim-modal keyboard UX**: normal mode (navigation + actions), insert mode (only inside `/` search and `:` ex-command line), visual mode (multi-select for batch ops — Phase D2).
- **External `$EDITOR` for compose / reply / draft-edit**: suspend the Ink app → exec the user's editor → resume. No PTY multiplex (rejected; see Rationale below).
- **Thin client**: in-memory LRU cache keyed by message-id / thread-id; no SQLite; no background sync.
- **tmux-over-SSH friendly**: no idle polling, no animated spinners, memoized rows so unchanged regions don't repaint, status-bar updates debounced.
- **Themes**: 7+ shipped (`default`, `mono`, `dracula`, `solarized-dark`, `solarized-light`, `nord`, `gruvbox`, `nerd`). `default` is ASCII-only. `nerd` uses nerd-font glyphs and is labelled as such in the theme picker.
- **Dev stats modal**: live heap / RSS / event-loop p99 / cache size / query timings.
- **Config persisted at `~/.gmail-mcp/config.json`**: theme, editor, cache cap, optional keymap overrides.

## Design decisions (with rationale)

### Library: Ink 7 + React 19 + fullscreen-ink (already installed)
- Already in `package.json` (added during Phase A).
- React state model fits multi-pane reactivity. `useReducer` for the AppState; `useInput` for keyboard dispatch.
- `fullscreen-ink` flips the terminal into alternate-screen mode, restores on exit (no scrollback pollution).
- Confirmed by user during the original planning.

### External `$EDITOR` instead of in-TUI text editor
- **Suspend pattern (chosen)**: when the user presses `c` / `r` / `R` / `e`, we write the initial draft to `$TMPDIR/gmail-mcp-compose-<pid>-<ts>.eml`, call Ink's `unmount()`, `spawn(editor, [tmpFile], { stdio: "inherit" })`, await exit, re-render the Ink tree. Industry standard: `aerc`, `mutt`, `neomutt`, `lazygit` all do this.
- **PTY multiplex (rejected)**: Ink and the editor both want full TTY ownership. Embedding `vim` inside an Ink Box via `node-pty` is doable but fragile (terminal capability negotiation, signals, resize, mouse, color depth). Especially bad over SSH/mosh. Few projects manage it; not worth the maintenance cost for a marginal UX win.
- **`tmux` as a dependency (rejected)**: not always installed, not embeddable as a library, would force users to run inside a specific terminal.
- **Editor resolution order**: `process.env.VISUAL` → `process.env.EDITOR` → `config.editor` → `"vi"`.

### Cache: in-memory LRU, no SQLite
- Map keyed by `messageId` / `threadId`. Byte estimate via `JSON.stringify(value).length`. Cap from `GMAIL_TUI_CACHE_MB` (default 50 MB).
- Same session = instant on revisit. New session = re-fetch. Acceptable tradeoff for a thin client.
- SQLite is a Phase D follow-up if/when offline access or cold-start speed becomes a real ask. The cache abstraction (`useCache.ts`) lets us swap the backing store later without touching ops.

### Refresh / SSH-friendliness
- **No background polling**. Fetches happen on user action only:
  - `R` (capital) → refresh current label / thread
  - `gr` → reload sidebar (label list)
  - After any write op → re-fetch the affected thread/list
- Row components (`SidebarRow`, `ThreadRow`, `MessagePane`) wrapped in `React.memo` so unchanged props skip the render.
- Status-bar transient text (e.g. "Loading…", "Sent ✓") debounced to 4 Hz max — over SSH this matters.
- No animated spinners during idle. A static `…` after the bar text if a request is in flight; that's it.

### Themes
- File per theme under `src/tui/themes/`. Each exports a `Theme` object covering: foreground, background, accent, dimmed, error, warning, plus per-element overrides (`selectedBg`, `selectedFg`, `sidebarBg`, `statusBarBg`, etc.).
- `default` and `mono` use ASCII / box-drawing characters only — no assumptions about font.
- `nerd` uses nerd-font glyphs (mail icon, paperclip, star, etc.). Picker UI shows `(requires Nerd Font)` next to it so users know.
- Selection via env (`GMAIL_TUI_THEME=dracula`) or persisted in `~/.gmail-mcp/config.json` `theme` key. `:theme <name>` to switch live.
- User customisation: optional `themes` block in `config.json` for per-element overrides (Phase D2 if requested).

### Dev stats modal
- `:stats` toggles a 20-col-wide pane in the bottom-right (or full overlay if terminal < 80 cols).
- Reads from `snapshotHealth()` in `src/robustness/health.ts` — already exists.
- Tracks per-render: heap MB, RSS MB, event-loop p99 ms, cache entry count + estimated MB, render count since launch, current theme, current editor, uptime.
- Updates on a 1-second tick (rare; the only background work in the whole TUI).

### Config file: `~/.gmail-mcp/config.json`
- Optional. Loaded if present. Keys: `theme`, `editor`, `cacheMB`, `keymapOverrides`, future `themes` block.
- Env vars (`GMAIL_TUI_THEME`, `GMAIL_TUI_EDITOR`, `GMAIL_TUI_CACHE_MB`) override the file.
- Use `GMAIL_CONFIG_DIR` to relocate (already supported across the rest of the codebase).

## How Phase B2 makes Phase D easier

The B2 typed-output work means every op in `core/ops/` declares an `outputSchema` and returns `structuredContent: z.infer<typeof outputSchema>`. TUI hooks bind directly to typed fields — no text parsing, no shape duplication.

```ts
// src/tui/hooks/useGmail.ts (sketch)
import type { z } from "zod";
import type {
  ListInboxThreadsOutputSchema,
  ReadEmailOutputSchema,
} from "../../tools.js";
import { callMcpTool } from "../../index.js";

type ThreadList = z.infer<typeof ListInboxThreadsOutputSchema>;
type ReadEmail = z.infer<typeof ReadEmailOutputSchema>;

export function useGmail() {
  const listInbox = async (query?: string): Promise<ThreadList> => {
    const result = await callMcpTool("list_inbox_threads", {
      query,
      maxResults: 50,
    });
    // structuredContent is typed via the registry's outputSchema
    return result.structuredContent as ThreadList;
  };

  const readEmail = async (messageId: string): Promise<ReadEmail> => {
    const result = await callMcpTool("read_email", { messageId });
    return result.structuredContent as ReadEmail;
  };

  return { listInbox, readEmail /* … */ };
}
```

Components consume typed data directly:

```tsx
<ThreadList
  threads={data.threads}  // ThreadSummarySchema[] — fully typed
  selected={state.cursor}
  onSelect={handleSelect}
/>
```

## Architecture

```
src/tui/
├── index.tsx             # #!/usr/bin/env node — TTY check, theme load, render via withFullScreen
├── App.tsx               # root; layout; useReducer; useInput dispatcher per mode
├── reducer.ts            # AppState + Action union; pure
├── keymap.ts             # Default keybindings; merged with config.json overrides
│
├── themes/
│   ├── index.ts          # Theme type + loadTheme(); themes registry
│   ├── default.ts        # ASCII / box-drawing only (no nerd fonts)
│   ├── mono.ts           # Monochrome (accessibility-friendly)
│   ├── dracula.ts
│   ├── solarized-dark.ts
│   ├── solarized-light.ts
│   ├── nord.ts
│   ├── gruvbox.ts
│   └── nerd.ts           # Uses nerd-font glyphs; flagged in picker
│
├── hooks/
│   ├── useGmail.ts       # Binds core ops registry to typed handles
│   ├── useEditor.ts      # openInEditor(initial): suspend → exec editor → resume
│   ├── useCache.ts       # In-memory LRU; exposes get/put/stats; cap from GMAIL_TUI_CACHE_MB
│   ├── useTheme.ts       # Loads from env / config.json; ":theme" subscribes here
│   └── useDevStats.ts    # Tracks query timings, heap, render counts; powers DevStatsModal
│
└── components/
    ├── Sidebar.tsx          # Label list: Inbox / Starred / Sent / Drafts / custom
    ├── ThreadList.tsx       # Paginated thread list for the selected label
    ├── MessagePane.tsx      # Selected message body (collapsed in list view, expands on Enter)
    ├── StatusBar.tsx        # Mode indicator + selection count + last action
    ├── HelpBar.tsx          # Context-sensitive keybinding hints
    ├── CommandPalette.tsx   # ":" ex-command line input
    ├── SearchBar.tsx        # "/" search input
    ├── ConfirmModal.tsx     # Destructive-action confirm (delete, batch-delete)
    ├── DevStatsModal.tsx    # ":stats" toggle overlay
    └── ThemePicker.tsx      # ":theme" interactive picker (lists themes, marks nerd-font ones)
```

## Modal UX bindings

### Normal mode (default — keyboard navigation + actions)
| Key | Action |
|---|---|
| `j` / `k` | Cursor down / up in active pane |
| `gg` | Top of list |
| `G` | Bottom of list |
| `h` / `l` | Collapse / expand current pane (e.g. message reader) |
| `Enter` | Open selected thread / message |
| `q` | Close current pane (e.g. exit reader → back to list) |
| `Q` | Quit application |
| `r` | Reply to selected message (opens editor) |
| `R` (capital) | Reply-all (opens editor) |
| `c` | Compose new email (opens editor) |
| `e` | Edit selected draft (opens editor) |
| `x` | Delete selected (confirm modal) |
| `s` | Star / unstar |
| `m` | Mark read / unread |
| `Ctrl+R` | Refresh current label / thread |
| `/` | Open search bar (enters insert mode) |
| `:` | Open command palette (enters insert mode) |
| `?` | Show help overlay |
| `~` | Toggle dev stats modal |
| `Tab` | Cycle focus across panes |
| `v` | Enter visual mode (multi-select; Phase D2) |

### Insert mode
- Active only inside `/` search bar and `:` command palette.
- `Esc` → back to normal mode.
- `Enter` → execute search / command.

### Command mode (`:` ex commands)
- `:q` → quit
- `:help` → show help overlay
- `:theme <name>` → switch theme live
- `:editor <bin>` → override editor for this session
- `:auth` → re-run `gmail auth` (suspend, exec, resume — same pattern as editor)
- `:health` → show health snapshot
- `:stats` → toggle dev stats modal
- `:search <query>` → run Gmail search; switches main pane to results
- `:label <name>` → jump to a label in the sidebar

### Visual mode (deferred to Phase D2)
- `v` enters visual mode from normal.
- `j` / `k` extends selection.
- `x` / `m` / `s` / `r` (with selection) → batch op (`batch_modify_emails`, etc.).
- `Esc` exits.

## Editor flow (`useEditor`)

```ts
async function openInEditor(initialContent: string): Promise<string | null> {
  const tmpPath = path.join(os.tmpdir(), `gmail-mcp-compose-${process.pid}-${Date.now()}.eml`);
  fs.writeFileSync(tmpPath, initialContent, "utf8");

  // 1. Unmount Ink — releases raw mode, restores cursor, exits alternate screen
  await unmountInkApp();

  // 2. Spawn editor with inherited stdio so it gets the full terminal
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? cfg.editor ?? "vi";
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(editor, [tmpPath], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 0));
  });

  // 3. Re-render Ink (state preserved via the reducer; composeMode flag flips)
  await remountInkApp();

  if (exitCode !== 0) return null; // editor failed or user aborted
  const content = fs.readFileSync(tmpPath, "utf8");
  fs.unlinkSync(tmpPath);
  return content;
}
```

Compose UX: open the editor with a templated draft (`To:`, `Subject:`, `\n\n[body]\n`). After save, parse the headers + body and call `send_email` / `draft_email` / `reply_all` accordingly.

## Cache design (`useCache`)

```ts
interface CacheEntry<T> {
  value: T;
  bytes: number;
  lastAccess: number;
}

class LruCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  private totalBytes = 0;
  constructor(private capacityBytes: number) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (entry) {
      entry.lastAccess = Date.now();
      // Map preserves insertion order; re-set to mark as most-recent
      this.map.delete(key);
      this.map.set(key, entry);
    }
    return entry?.value;
  }

  put(key: string, value: T): void {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (this.map.has(key)) {
      this.totalBytes -= this.map.get(key)!.bytes;
    }
    this.map.set(key, { value, bytes, lastAccess: Date.now() });
    this.totalBytes += bytes;
    while (this.totalBytes > this.capacityBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      const entry = this.map.get(oldestKey!)!;
      this.totalBytes -= entry.bytes;
      this.map.delete(oldestKey!);
    }
  }

  stats() {
    return { entries: this.map.size, bytes: this.totalBytes };
  }
}
```

Separate caches for messages (`Map<messageId, ReadEmailOutput>`) and threads (`Map<threadId, GetThreadOutput>`). Sidebar (label list) is small enough to live in component state.

## MVP scope (what ships in the first release)

Wired Gmail ops:
- `list_email_labels` — sidebar
- `list_inbox_threads` / `get_inbox_with_threads` — thread list
- `get_thread` — message panel (collapses messages within thread)
- `read_email` — when user expands a single message
- `search_emails` — `/` search bar
- `send_email` — compose flow (`c` key)
- `reply_all` — reply-all (`R` key)
- `draft_email` — saves to drafts (`c` then `:draft` or different command)
- `health_check` — `:health` command

UI features:
- Multi-pane layout (sidebar / thread list / message reader)
- Normal + insert + command modes (visual deferred)
- All keybindings above except `v` (visual)
- Editor suspension flow
- 7 themes including nerd-font opt-in
- `:theme`, `:editor`, `:auth`, `:health`, `:stats`, `:search`, `:label`, `:q` commands
- Dev stats modal
- `~/.gmail-mcp/config.json` reading

## Deferred to Phase D2 (after MVP feedback)

- Visual mode + batch ops via selection
- Filter management UI (`filters list`, `filters create`, …)
- Label CRUD UI beyond viewing
- Attachment preview / download from within the TUI
- Sent / Drafts / custom-label folder UIs (currently only Inbox is first-class)
- Per-element theme overrides via `config.json`
- SQLite local cache (if a real use case appears)
- Multi-account support (single account for now)
- Mouse support

## Verification

- `pnpm dev:tui` boots into the multi-pane layout under 1 second on a fresh terminal.
- `j` / `k` navigates threads; `Enter` opens; reading a thread shows messages collapsed.
- `r` opens `$EDITOR` (vim by default); `:wq` returns to the TUI with the reply sent.
- `:theme dracula` recolors live without re-render flicker.
- `:stats` toggles a live-updating overlay showing heap / RSS / cache size.
- `Q` exits with a clean terminal (cursor restored, alternate screen exited, no scroll pollution).
- Runs over `ssh -t server "tmux attach -t gmail"` without screen tearing or excessive redraws.
- `pnpm run stress` continues to pass 9/9.
- Tests: `ink-testing-library` covers the reducer + at least one component render; `useEditor.test.ts` mocks `child_process.spawn` to verify unmount → exec → remount order.

## Files to create

- `src/tui/{index.tsx,App.tsx,reducer.ts,keymap.ts}` (4 root files)
- `src/tui/themes/{index,default,mono,dracula,solarized-dark,solarized-light,nord,gruvbox,nerd}.ts` (9 files)
- `src/tui/hooks/{useGmail,useEditor,useCache,useTheme,useDevStats}.ts` (5 files)
- `src/tui/components/{Sidebar,ThreadList,MessagePane,StatusBar,HelpBar,CommandPalette,SearchBar,ConfirmModal,DevStatsModal,ThemePicker}.tsx` (10 files)
- Matching `*.test.ts(x)` for the reducer + 1-2 hooks + 1-2 components

## Existing utilities to reuse

- `src/core/ops/*` — all registered ops with typed output schemas (B2). TUI hooks call via `callMcpTool` and read `result.structuredContent`.
- `src/core/session.ts` — `getOAuth2Client` / `getGmail` (after bootstrap).
- `src/cli/runtime.ts::bootstrapForCli()` — already does the right thing for in-process callers; reuse from the TUI entry.
- `src/robustness/health.ts::snapshotHealth()` — powers the dev stats modal.
- `src/auth-errors.ts::wrapToolError` — error formatting (the dispatcher already wraps; just display the text).
- `src/core/config-paths.ts::getConfigDir()` — for `~/.gmail-mcp/config.json` location.

## Risk callouts

- **Editor suspension across SDK versions**: Ink's `unmount()` + remount with a new tree is supported but the exact sequence (restore raw mode, exit alternate screen, then re-enter) needs care. Test against `vim`, `nvim`, `nano`, and `emacs -nw`.
- **Refresh-rate budget on SSH**: avoid React reconciliation churn. Profile with `:stats` open and `tmux` over a high-latency link before declaring MVP done.
- **Color-depth fallback**: themes with 24-bit colors render poorly on terminals stuck at 8 / 16 colors. Detect `process.env.COLORTERM` and `tput colors`; downshift gracefully (Ink does this in v7, but worth verifying per theme).
- **Nerd-font theme on non-nerd-font terminal**: glyphs render as `□` boxes. The picker labels nerd-font themes clearly, but a defensive auto-detect (probe via `\u{e0a0}` width measurement) is a nice-to-have.
- **OAuth credential expiry mid-session**: the underlying `google-auth-library` auto-refreshes via the refresh token. If the refresh fails (token revoked), surface as a normal `wrapToolError` and prompt the user to run `:auth`.

## Estimated effort

Substantial — this is the largest single piece on the master plan, roughly comparable to the entire B1 + B2 + CLI fan-out combined. Realistic split:

- **Session 1** (~3-4 hours): Skeleton + reducer + sidebar + thread list + theme system + basic keymap. Boots into a working browse-only view (read-only).
- **Session 2** (~3-4 hours): `useEditor` suspension flow + compose/reply/draft flows + command palette + search bar.
- **Session 3** (~2 hours): Themes (all 8) + dev stats modal + config file loading + polish + tests + AGENTS.md update.

Total: ~8-10 hours of focused work. Should be done in its own session (or three), not interleaved with other refactors.
