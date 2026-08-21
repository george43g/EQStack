#!/usr/bin/env bash
# Materialise a deterministic fake `$EDITOR` for the compose-flow tape.
#
# VHS's `Type` parser can't escape `$` / `\` / `"` inside its argument,
# so we can't write the heredoc inline in the tape. This script materialises
# the editor once before VHS runs; the tape just points `EDITOR` at it.
#
# The fake editor writes a templated .eml to the tmp path the TUI passed in
# (its first argument), then exits 0. The TUI's useEditor reads the file
# back, parses the headers, and dispatches send_email.

set -euo pipefail

cat > /tmp/gmail-vhs-fake-editor.sh <<'MAIL'
#!/usr/bin/env bash
cat > "$1" <<'EOF'
To: hello@fixture.test
Cc:
Bcc:
Subject: VHS demo

Hello from the VHS-driven compose flow.
EOF
MAIL

chmod +x /tmp/gmail-vhs-fake-editor.sh
