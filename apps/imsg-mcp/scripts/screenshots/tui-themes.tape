# Safe theme variants — same scene rendered with different accents so the
# README screenshots never require Nerd Fonts or Powerline glyph support.

Set FontSize 13
Set FontFamily "JetBrains Mono"
Set Width 1400
Set Height 800
Set Padding 5
Set TypingSpeed 50ms

# ── 1. default safe theme + iMessage blue accent ─────────────────────────
Output docs/screenshots/theme-safe-blue.png
Hide
Type "mkdir -p /tmp/imsg-demo && HOME=/tmp/imsg-demo IMSG_TUI_THEME=safe node --env-file=.env.test dist/cli.js tui"
Enter
Wait+Screen@15s /Conversations/
Sleep 1s
Show
Type "j"
Sleep 200ms
Tab
Sleep 1s
Screenshot docs/screenshots/theme-safe-blue.png
Type "q"
Sleep 500ms

# ── 2. safe theme + warm orange accent ──────────────────────────────────
Output docs/screenshots/theme-safe-orange.png
Hide
Type 'HOME=/tmp/imsg-demo IMSG_TUI_THEME=safe IMSG_TUI_ACCENT="#FF6B35" node --env-file=.env.test dist/cli.js tui'
Enter
Wait+Screen@15s /Conversations/
Sleep 1s
Show
Type "j"
Sleep 200ms
Tab
Sleep 1s
Screenshot docs/screenshots/theme-safe-orange.png
Type "q"
Sleep 500ms

# ── 3. safe theme + green accent ────────────────────────────────────────
Output docs/screenshots/theme-safe-green.png
Hide
Type 'HOME=/tmp/imsg-demo IMSG_TUI_THEME=safe IMSG_TUI_ACCENT="#34C759" node --env-file=.env.test dist/cli.js tui'
Enter
Wait+Screen@15s /Conversations/
Sleep 1s
Show
Type "j"
Sleep 200ms
Tab
Sleep 1s
Screenshot docs/screenshots/theme-safe-green.png
Type "q"
Sleep 500ms

# ── 4. safe theme + magenta accent ──────────────────────────────────────
Output docs/screenshots/theme-safe-magenta.png
Hide
Type 'HOME=/tmp/imsg-demo IMSG_TUI_THEME=safe IMSG_TUI_ACCENT="#FF00FF" node --env-file=.env.test dist/cli.js tui'
Enter
Wait+Screen@15s /Conversations/
Sleep 1s
Show
Type "j"
Sleep 200ms
Tab
Sleep 1s
Screenshot docs/screenshots/theme-safe-magenta.png
Type "q"
Sleep 500ms
