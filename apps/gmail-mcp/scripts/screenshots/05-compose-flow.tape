# Compose flow result — `c` suspends Ink → fake $EDITOR → "Email sent" status.
# Output: docs/screenshots/05-compose-flow.png
#
# The fake editor lives at /tmp/gmail-vhs-fake-editor.sh and is materialised
# by the `screenshots` npm script before VHS runs (so the tape stays clean
# of shell heredoc / quoting / escaping). VHS's `Type` parser doesn't
# tolerate $-vars or backslashes inside its quoted argument.

Output docs/screenshots/05-compose-flow.png

Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Width 1400
Set Height 800
Set Padding 20
Set TypingSpeed 60ms
# Disable cursor blink — the blink phase is non-deterministic and was
# producing two distinct PNG hashes between otherwise-identical runs.
Set CursorBlink false

# Drop VISUAL so the parent shell's vim doesn't override our fake editor.
Type "env -u VISUAL EDITOR=/tmp/gmail-vhs-fake-editor.sh GMAIL_FIXTURE_MODE=1 GMAIL_FIXTURE_DIR=./fixtures/gmail GMAIL_ACCOUNT=work node dist/cli/index.js tui"
Enter
Sleep 3s

# `c` → compose: useEditor writes the tmp .eml, spawns the fake editor,
# parses the result, calls send_email. The fixture client returns canned
# success and the status bar flips to "Email sent". `Wait` blocks until
# the steady-state text actually appears — `Sleep` alone gave a race
# between "Opening $EDITOR (compose)…" and "Email sent" depending on
# machine speed, which alternated the captured PNG.
Type "c"
# 5s is comfortably past the fake-editor spawn + .eml write + send_email
# round-trip on every machine the gate runs on. VHS's Wait/Wait+Screen
# don't see Ink's alt-screen output reliably, so we lean on Sleep.
Sleep 5s

Screenshot docs/screenshots/05-compose-flow.png

Type "Q"
Sleep 200ms
