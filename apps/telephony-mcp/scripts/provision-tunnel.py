#!/usr/bin/env python3
"""Provision the named Cloudflare tunnel for telephony-mcp (O-23).

Follows apps/telephony-mcp/docs/TUNNEL_SETUP.md exactly: tunnel `telephony`,
remotely-managed config, ingress gw.agentpipe.top -> http://localhost:8790,
catch-all 404, proxied CNAME.

Every step is idempotent — re-running reuses what exists. NOTHING secret is
printed: the tunnel run-token is never fetched here (a separate step pipes it
straight into 1Password as CLOUDFLARE_TUNNEL_TOKEN, per INV-12 / D-59b).

Already run: the tunnel exists (DECISIONS D-67). Re-running is safe — it reuses
the existing tunnel rather than creating a second one.

Usage — the token never appears in argv, only in the child env:

    CF_TOKEN=$(opkeep get CF_EQSTACK_TELEPHONY_TUNNEL_TOKEN) \
      python3 apps/telephony-mcp/scripts/provision-tunnel.py

Use that token, which is scoped to exactly *Cloudflare Tunnel Write* on this one
account plus *DNS Write* on this one zone. Do NOT reach for `CF_API_TOKEN`: that
vault title is an alias over the account-wide `CF_SHARED_DNS_USER_TOKEN`, it
lacks Tunnel:Edit anyway, and it is consumed by g-home-server infrastructure
(DECISIONS D-68). Prefer `opkeep get` over `op read` — the latter can block on a
biometric prompt and silently yield an empty string, which surfaces as the
misleading Cloudflare error `9106: Missing ... Authorization headers`.
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
API = "https://api.cloudflare.com/client/v4"


def public_port() -> int:
    """Read server.publicPort from the live config — never hardcode it.

    The schema default is 8790, but that port is not guaranteed free: on this
    machine browser-tab-mcp's daemon holds it, which is why the config sets
    8890. An ingress pointing at the default would route the hostname at
    whichever app won the port race, so the origin is derived, not assumed.
    """
    override = os.environ.get("TEL_PUBLIC_PORT")
    if override:
        return int(override)
    cfg = os.path.expanduser("~/.config/telephony-mcp/config.json")
    try:
        with open(cfg) as f:
            return int(json.load(f).get("server", {}).get("publicPort", 8790))
    except (OSError, ValueError, TypeError):
        return 8790


ORIGIN = f"http://localhost:{public_port()}"

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
