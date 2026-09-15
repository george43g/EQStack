# HTTP transport mode — gmail-mcp

> Moved out of `apps/gmail-mcp/AGENTS.md` on 2026-09-15 so that guide fits Codex's instruction cap
> (`project_doc_max_bytes`, 32,768 bytes across the root-to-app chain). Content is unchanged except that
> relative link targets gained `../`. The guide keeps the must-hold rules and links here.

## HTTP transport mode (Phase G)

`gmail mcp --http [--port 8080] [--bind 127.0.0.1] [--token-env GMAIL_HTTP_TOKEN]` exposes the MCP via `StreamableHTTPServerTransport` instead of stdio. Single-tenant: one server process = one Gmail account.

- **Endpoints**: `POST /mcp` (MCP protocol; bearer-token required) + `GET /health` (open; for reverse-proxy probes; returns 503 if `unhealthy`).
- **Auth**: `Authorization: Bearer <token>` checked against `process.env[GMAIL_HTTP_TOKEN]` (constant-time compare). Server refuses to start if the env is unset.
- **Sessions**: stateful — server hands out a `mcp-session-id` header on `initialize`; clients echo it on subsequent requests. Required for the MCP handshake to share state.
- **TLS**: out of scope. Bind defaults to `127.0.0.1` so a reverse-proxy (Caddy / nginx / Cloudflare Tunnel / Cloud Run) is the only ingress path. Set `--bind 0.0.0.0` only if you trust the network.
- **Reuses the dispatcher**: same `Server` instance, same OAuth/credentials/retry/rate-limit pipeline, same per-tool timeouts. Only the transport swaps.

Connect any MCP host:
- Claude Code: `claude mcp add --transport http --url https://gmail.example.com/mcp --header "Authorization: Bearer $TOKEN" gmail-remote`
- OpenCode: `opencode.json` → `{ type: "remote", url, headers: { Authorization: "Bearer ${GMAIL_HTTP_TOKEN}" } }`
- Cursor / Warp: stdio-only currently — proxy locally with a thin stub if needed (deferred to Phase G2).
