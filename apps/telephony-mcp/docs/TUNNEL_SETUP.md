# Named tunnel — one-time provisioning (Phase D, D-10/D-36)

Status: **code shipped, tunnel not yet provisioned.** `tunnel.enabled` defaults
to `false`; everything below is the one-time setup, after which
`server.publicBaseUrl` is a constant that never changes again and the Twilio
webhook never needs re-pointing.

Settled inputs (DECISIONS D-36/D-59): zone **agentpipe.top** (active, account
"George Personal + Melbourne Web Co"), gateway hostname **gw.agentpipe.top**
(carries Twilio webhooks + the ConversationRelay WSS — one origin, one
hostname; `mcp.` / `assets.` stay separate per D-36), style **remotely-managed
token** (one secret by name, ingress lives at Cloudflare, nothing local to
drift).

> **✅ Status 2026-09-05: steps 1–4 are DONE (DECISIONS D-67). Steps 5–8 remain.**
>
> | Fact | Value |
> |---|---|
> | Tunnel | `telephony`, id `5cdf3c85-cb71-4212-971e-d17221524856`, `remote_config: true` |
> | Ingress | `gw.agentpipe.top` → `http://localhost:8790`, catch-all 404 |
> | DNS | proxied CNAME → `<tunnel-id>.cfargotunnel.com` |
> | Run token | stored as `CLOUDFLARE_TUNNEL_TOKEN` in key-vault; `opkeep get` resolves it |
> | API token used | `CF_EQSTACK_TELEPHONY_TUNNEL_TOKEN` — Tunnel Write on the one account + DNS Write on the one zone, nothing else |
>
> Verified publicly rather than from the API's own word: `dig gw.agentpipe.top`
> returns Cloudflare proxy IPs and `curl https://gw.agentpipe.top/` returns
> **530** — route exists, no connector running. That 530 is the *correct*
> state until step 7, and is what you should see if you check now.
>
> **Steps 7 and 8 are held together on purpose.** Installing the LaunchAgent
> puts a live public hostname in front of the gateway, which achieves nothing
> until the Twilio webhooks are re-pointed at it — and that re-point is
> George's authority (O-19). Do 5–7 as one deliberate "go live" step with 8.
>
> Steps 1–3 remain automated and idempotent in
> [`scripts/provision-tunnel.py`](../scripts/provision-tunnel.py); re-running it
> reuses the existing tunnel rather than creating a second one.

## Steps (George, or an agent with Cloudflare API + opkeep access)

1. Create the tunnel (dashboard → Zero Trust → Networks → Tunnels, or API
   `POST /accounts/<id>/cfd_tunnel` with `config_src: "cloudflare"`). Name:
   `telephony`.
2. Ingress (remotely-managed config): `gw.agentpipe.top` →
   `http://localhost:8790` (the `server.publicPort`). Catch-all: 404.
3. DNS: the dashboard flow adds the `gw` CNAME → `<uuid>.cfargotunnel.com`
   automatically; via API create it explicitly (proxied).
4. Put the tunnel TOKEN into opkeep under the name
   **CLOUDFLARE_TUNNEL_TOKEN** (INV-12: the config carries only this name via
   `tunnel.tokenRef`). Never paste the token into config, argv, or a doc.
5. Config:

   ```json
   "server": { "publicBaseUrl": "https://gw.agentpipe.top" },
   "tunnel": { "enabled": true, "tunnelName": "telephony", "hostname": "gw.agentpipe.top" }
   ```

   The schema refuses a hostname that differs from the `publicBaseUrl` host —
   that mismatch would 403 every Twilio webhook (signature is computed against
   `publicBaseUrl`).
6. `pnpm build && node dist/cli.js doctor` → cloudflared / token / hostname
   checks green.
7. `node dist/cli.js daemon install` → LaunchAgent bootstraps; `tel daemon
   status` shows launchd + gateway + tunnel, one line each.
8. Re-point the Twilio number's voice/status webhooks at
   `https://gw.agentpipe.top/…` — **once, never again** (George's authority —
   O-19 governs later inbound changes).

## Live verification (paid; separately authorised — INV-14)

One call end-to-end over the named tunnel, then reboot the Mac and confirm the
hostname answers with `publicBaseUrl` never edited.
