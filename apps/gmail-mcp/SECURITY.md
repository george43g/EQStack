# Security Policy

## Supported Version

Security fixes are applied to the latest `2.x` release. Older fork and upstream releases are not maintained here.

## Reporting

Do not open a public issue for a suspected vulnerability. Use GitHub's **Report a vulnerability** flow in the Security tab of `george43g/gmail-mcp` so details remain private until a fix is available.

Include the affected version, reproduction steps, impact, and any suggested mitigation. Do not include real OAuth tokens, client secrets, email content, or account identifiers.

## Credential Model

- OAuth client keys and account credentials are local secrets and are never intended for the repository.
- File-backed credentials default to mode `0600`; token rotations are persisted only to the file from which that account was loaded.
- `GMAIL_CREDENTIALS_JSON` and `GMAIL_CREDENTIALS_OP` are treated as read-only sources and are never written to disk by token refresh handling.
- HTTP MCP mode requires a bearer token and binds to `127.0.0.1` by default. TLS is expected at a trusted reverse proxy.
- Permanent deletion requires the full `https://mail.google.com/` scope (`gmail.full`).

The `report_phishing` tools apply Gmail's `SPAM` label. The public Gmail API does not expose Gmail's native phishing-report workflow.
