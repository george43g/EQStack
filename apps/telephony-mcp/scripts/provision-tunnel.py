#!/usr/bin/env python3
"""Provision the named Cloudflare tunnel for telephony-mcp (O-23).

Follows apps/telephony-mcp/docs/TUNNEL_SETUP.md exactly: tunnel `telephony`,
remotely-managed config, ingress gw.agentpipe.top -> http://localhost:8790,
catch-all 404, proxied CNAME.

Every step is idempotent — re-running reuses what exists. NOTHING secret is
printed: the tunnel run-token is never fetched here (a separate step pipes it
straight into 1Password as CLOUDFLARE_TUNNEL_TOKEN, per INV-12 / D-59b).

Usage — the token never appears in argv, only in the child env:

    CF_TOKEN=$(op read "op://key-vault/CF_API_TOKEN/credential") \
      python3 apps/telephony-mcp/scripts/provision-tunnel.py

The token needs **Account · Cloudflare Tunnel · Edit** and **Zone · DNS · Edit**
on agentpipe.top. As of 2026-09-04 neither CF_API_TOKEN nor
CF_GLOBAL_ADMIN_USER_TOKEN has the Tunnel:Edit half — both can read tunnels but
`POST /cfd_tunnel` returns `10000: Authentication error`. That is DECISIONS
O-28, and re-scoping a token is George's call alone.
"""
import json
import os
import sys
import urllib.error
import urllib.request

ACCOUNT = "0de8624f4e34eaf3ebc22d5290d9b230"
ZONE = "70723edf90f806852c679630db5503c6"
TUNNEL_NAME = "telephony"
HOSTNAME = "gw.agentpipe.top"
ORIGIN = "http://localhost:8790"
API = "https://api.cloudflare.com/client/v4"

token = os.environ.get("CF_TOKEN")
if not token:
    sys.exit("CF_TOKEN not set")


def call(method, path, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        payload = json.loads(e.read() or b"{}")
        return payload if isinstance(payload, dict) else {"success": False, "errors": [{"message": str(e)}]}


def must(res, what):
    if not res.get("success"):
        msgs = [f"{er.get('code')}: {er.get('message')}" for er in res.get("errors", [])]
        sys.exit(f"FAILED {what}: {msgs}")
    return res["result"]


# 1. tunnel (reuse if present)
existing = must(call("GET", f"/accounts/{ACCOUNT}/cfd_tunnel?is_deleted=false"), "listing tunnels")
match = [t for t in existing if t["name"] == TUNNEL_NAME]
if match:
    tid = match[0]["id"]
    print(f"reused existing tunnel {TUNNEL_NAME} id={tid}")
else:
    created = must(
        call("POST", f"/accounts/{ACCOUNT}/cfd_tunnel", {"name": TUNNEL_NAME, "config_src": "cloudflare"}),
        "creating tunnel",
    )
    tid = created["id"]
    print(f"created tunnel {TUNNEL_NAME} id={tid}")

# 2. ingress (remotely-managed config)
cfg = {
    "config": {
        "ingress": [
            {"hostname": HOSTNAME, "service": ORIGIN},
            {"service": "http_status:404"},
        ]
    }
}
must(call("PUT", f"/accounts/{ACCOUNT}/cfd_tunnel/{tid}/configurations", cfg), "setting ingress")
print(f"ingress set: {HOSTNAME} -> {ORIGIN}, catch-all 404")

# 3. DNS CNAME (proxied), idempotent
target = f"{tid}.cfargotunnel.com"
recs = must(call("GET", f"/zones/{ZONE}/dns_records?name={HOSTNAME}"), "listing dns")
if recs:
    rec = recs[0]
    if rec.get("content") == target and rec.get("proxied") and rec.get("type") == "CNAME":
        print(f"dns already correct: {HOSTNAME} CNAME {target} (proxied)")
    else:
        must(
            call(
                "PUT",
                f"/zones/{ZONE}/dns_records/{rec['id']}",
                {"type": "CNAME", "name": HOSTNAME, "content": target, "proxied": True},
            ),
            "updating dns",
        )
        print(f"dns updated: {HOSTNAME} CNAME {target} (proxied)")
else:
    must(
        call(
            "POST",
            f"/zones/{ZONE}/dns_records",
            {"type": "CNAME", "name": HOSTNAME, "content": target, "proxied": True},
        ),
        "creating dns",
    )
    print(f"dns created: {HOSTNAME} CNAME {target} (proxied)")

# 4. read back the live config as proof, not assumption
live = must(call("GET", f"/accounts/{ACCOUNT}/cfd_tunnel/{tid}/configurations"), "reading back config")
print("live ingress:", json.dumps(live.get("config", {}).get("ingress", []), separators=(",", ":")))
print("TUNNEL_ID=" + tid)
