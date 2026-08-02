# Messages.app AppleScript — Expansion Reference

> **Status:** Illustrative / not wired up. Sample patterns for the next round of API expansion. See `src/applescript.ts` for the live surface.

The Messages.app SDEF exposes a handful of capabilities that are not (yet) covered by `chat.db` reads. The snippets below show how to wrap each one, with a thin Node wrapper that calls into `runAppleScript()` (already exported from `src/applescript.ts:35`).

When you're ready to ship these for real, consider:

1. Moving the inline strings to `applescripts/*.applescript` files and compiling with `osacompile -o build/applescripts/*.scpt`. Then `runCompiledScript(scptPath, ...args)` instead of `-e "..."`. Saves ~50-100ms parse latency per call.
2. JXA (JavaScript for Automation) is supported via `osacompile -l JavaScript ... .js`. Messages-specific glue (chat lookups, send) is more stable in classic AppleScript than in JXA, so start with `.applescript` source.
3. All snippets here have been compile-checked with `osacompile -c` — they parse but they have not been wired into the codebase.

---

## 1. `getActiveChat()` — read the foremost chat in Messages.app

The user's currently-focused conversation isn't in chat.db; it's only readable through Messages.app via AppleScript.

```applescript
-- get_active_chat.applescript
-- Note: the Messages SDEF does NOT expose a "selected chat" property, so
-- "active" here means the most-recently-modified chat (a reasonable proxy).
-- For true sidebar-focus reading you'd need to scrape via System Events UI
-- accessibility — see the activate_chat_by_id snippet below for that pattern.
tell application "Messages"
  if (count of chats) is 0 then return ""
  set theChat to first chat
  return (id of theChat) & "|" & (name of theChat)
end tell
```

Node wrapper:

```ts
// src/applescript.ts (future addition)
export async function getActiveChat(): Promise<{ guid: string; name: string } | null> {
  if (MOCK) return null;
  const out = await runAppleScript(`
    tell application "Messages"
      if (count of chats) is 0 then return ""
      try
        set theChat to selected chat
        return id of theChat & "|" & name of theChat
      on error
        set theChat to first chat
        return id of theChat & "|" & name of theChat
      end try
    end tell
  `);
  if (!out) return null;
  const [guid, name] = out.split("|");
  return { guid, name };
}
```

---

## 2. `getBuddyStatus(handle)` — query a buddy's presence

The SDEF exposes participant first/last/full name from Contacts AND service info. Useful for detecting iMessage-vs-SMS reachability before sending.

```applescript
-- get_buddy_status.applescript
on run argv
  set targetHandle to item 1 of argv
  tell application "Messages"
    try
      set b to buddy targetHandle of (service 1 whose service type is iMessage)
      return "iMessage|" & (handle of b) & "|" & (full name of b)
    on error
      try
        set b to buddy targetHandle of (service 1 whose service type is SMS)
        return "SMS|" & (handle of b) & "|" & (full name of b)
      on error
        return "unknown"
      end try
    end try
  end tell
end run
```

Run with: `osascript get_buddy_status.applescript "+15555550100"`

Node wrapper:

```ts
export async function getBuddyStatus(
  handle: string,
): Promise<{ service: "iMessage" | "SMS"; handle: string; fullName: string } | null> {
  if (MOCK) return { service: "iMessage", handle, fullName: handle };
  // We bypass appleScriptEscape here because the handle goes through argv, not
  // an interpolated string — safer.
  const result = await execFileAsync("osascript", [
    "/path/to/get_buddy_status.applescript",
    handle,
  ]);
  const [service, h, name] = result.stdout.trim().split("|");
  if (service === "unknown") return null;
  return { service: service as "iMessage" | "SMS", handle: h, fullName: name };
}
```

---

## 3. `listFileTransfers()` — enumerate in-flight + recent file transfers

The `file transfer` class in the Messages SDEF exposes everything you'd want to surface as a progress UI in the TUI.

```applescript
-- list_file_transfers.applescript
tell application "Messages"
  set out to ""
  repeat with ft in file transfers
    set out to out & (id of ft) & "|" & (name of ft) & "|" & (direction of ft as string) ¬
      & "|" & (transfer status of ft as string) & "|" & (file size of ft) ¬
      & "|" & (file progress of ft) & linefeed
  end repeat
  return out
end tell
```

Node wrapper:

```ts
export interface FileTransfer {
  id: string;
  name: string;
  direction: "incoming" | "outgoing";
  status: "preparing" | "waiting" | "transferring" | "finalizing" | "finished" | "failed";
  sizeBytes: number;
  progressBytes: number;
}

export async function listFileTransfers(): Promise<FileTransfer[]> {
  if (MOCK) return [];
  const out = await runAppleScript(`
    tell application "Messages"
      set out to ""
      repeat with ft in file transfers
        set out to out & (id of ft) & "|" & (name of ft) & "|" & (direction of ft as string) ¬
          & "|" & (transfer status of ft as string) & "|" & (file size of ft) ¬
          & "|" & (file progress of ft) & linefeed
      end repeat
      return out
    end tell
  `);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, name, direction, status, size, progress] = line.split("|");
      return {
        id,
        name,
        direction: direction as FileTransfer["direction"],
        status: status as FileTransfer["status"],
        sizeBytes: Number.parseInt(size, 10) || 0,
        progressBytes: Number.parseInt(progress, 10) || 0,
      };
    });
}
```

---

## 4. `activateChatById(guid)` — bring a specific chat into focus in Messages.app

Useful for "open this thread in Messages.app" actions from the TUI.

```applescript
-- activate_chat_by_id.applescript
on run argv
  set targetGuid to item 1 of argv
  tell application "Messages"
    activate
    try
      set theChat to text chat id targetGuid
      -- AppleScript can't directly "focus" a chat — workaround: send an empty
      -- string fails harmlessly but does scroll to the chat in some macOS
      -- versions. Most reliable path: use System Events to script the sidebar.
      tell application "System Events"
        tell process "Messages"
          set frontmost to true
        end tell
      end tell
      return "ok"
    on error errMsg
      return "error: " & errMsg
    end try
  end tell
end run
```

Node wrapper:

```ts
export async function activateChatById(guid: string): Promise<boolean> {
  if (MOCK) return true;
  const result = await execFileAsync("osascript", [
    "/path/to/activate_chat_by_id.applescript",
    guid,
  ]);
  return result.stdout.trim() === "ok";
}
```

---

## Verification

Each snippet can be compile-checked without running it:

```bash
osacompile -o /tmp/check.scpt get_active_chat.applescript
osacompile -o /tmp/check.scpt get_buddy_status.applescript
osacompile -o /tmp/check.scpt list_file_transfers.applescript
osacompile -o /tmp/check.scpt activate_chat_by_id.applescript
```

A successful compile returns exit code 0 with no output.

---

## Notes

- AppleScript timeouts: `runAppleScript()` in `src/applescript.ts` has a 30s timeout. File-transfer queries can be slow on large histories — consider raising the timeout for `listFileTransfers()` or capping the iteration count in the script.
- Mock mode (`VITE_ENV=ai` or `VITEST=true`) intercepts all sends today. Read-only AppleScript queries (`getActiveChat`, `getBuddyStatus`, `listFileTransfers`) could be allowed to run even in dev test mode since they don't mutate state — your call.
- Argument escaping: prefer passing args via `execFile` argv (as `osascript script.scpt arg1 arg2`) over inline string interpolation. The script reads them via `on run argv ... item N of argv`. This avoids quoting bugs.
