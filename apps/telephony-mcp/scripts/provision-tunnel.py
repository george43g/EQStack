#!/usr/bin/env python3
"""Provision the named Cloudflare tunnel for telephony-mcp (O-23).

Follows apps/telephony-mcp/docs/TUNNEL_SETUP.md exactly: tunnel `telephony`,
remotely-managed config, ingress gw.agentpipe.top -> http://localhost:8790,
catch-all 404, proxied CNAME.

Phase R (consult, D-91): when the live config has `agentPlatform.consult`, a
SECOND hostname joins the same tunnel — tools.agentpipe.top ->
http://127.0.0.1:<server.toolsPort> (default 8792) — with its own proxied
CNAME. The ingress PUT replaces the whole list, so every hostname is sent
every time; a hostname added by hand in the dashboard would be dropped by a
re-run, which is why both live here.

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
import urllib.parse
import urllib.request

ACCOUNT = "0de8624f4e34eaf3ebc22d5290d9b230"
ZONE = "70723edf90f806852c679630db5503c6"
TUNNEL_NAME = "telephony"
HOSTNAME = "gw.agentpipe.top"
TOOLS_HOSTNAME = "tools.agentpipe.top"
API = "https://api.cloudflare.com/client/v4"
CONFIG_PATH = os.path.expanduser("~/.config/telephony-mcp/config.json")


def load_config() -> dict:
    try:
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
            return cfg if isinstance(cfg, dict) else {}
    except (OSError, ValueError):
        return {}


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
    try:
        return int((load_config().get("server") or {}).get("publicPort", 8790))
    except (ValueError, TypeError):
        return 8790


ORIGIN = f"http://localhost:{public_port()}"


def tools_origin() -> str | None:
    """The consult tool listener's origin, or None when consult is not configured.

    127.0.0.1, not localhost: the listener binds IPv4 loopback only, and a
    `localhost` that resolves to ::1 first would be refused.
    """
    cfg = load_config()
    consult = (cfg.get("agentPlatform") or {}).get("consult")
    if not consult and not os.environ.get("TEL_TOOLS_PORT"):
        return None
    if consult:
        base = str(consult.get("toolsBaseUrl", ""))
        if urllib.parse.urlparse(base).hostname != TOOLS_HOSTNAME:
            sys.exit(
                "agentPlatform.consult.toolsBaseUrl does not point at the tools hostname this script "
                "provisions; fix one or the other"
            )
    port = os.environ.get("TEL_TOOLS_PORT") or (cfg.get("server") or {}).get("toolsPort", 8792)
    return f"http://127.0.0.1:{int(port)}"


TOOLS_ORIGIN = tools_origin()
ROUTES = [(HOSTNAME, ORIGIN)] + ([(TOOLS_HOSTNAME, TOOLS_ORIGIN)] if TOOLS_ORIGIN else [])

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

# 2. ingress (remotely-managed config) — the PUT replaces the whole list
cfg = {
    "config": {
        "ingress": [{"hostname": h, "service": o} for h, o in ROUTES]
        + [{"service": "http_status:404"}]
    }
}
must(call("PUT", f"/accounts/{ACCOUNT}/cfd_tunnel/{tid}/configurations", cfg), "setting ingress")
for h, o in ROUTES:
    print(f"ingress set: {h} -> {o}")
print("ingress catch-all: 404")

# 3. DNS CNAME (proxied) per hostname, idempotent
target = f"{tid}.cfargotunnel.com"
for name, _origin in ROUTES:
    recs = must(call("GET", f"/zones/{ZONE}/dns_records?name={name}"), "listing dns")
    if recs:
        rec = recs[0]
        if rec.get("content") == target and rec.get("proxied") and rec.get("type") == "CNAME":
            print(f"dns already correct: {name} CNAME {target} (proxied)")
        else:
            must(
                call(
                    "PUT",
                    f"/zones/{ZONE}/dns_records/{rec['id']}",
                    {"type": "CNAME", "name": name, "content": target, "proxied": True},
                ),
                "updating dns",
            )
            print(f"dns updated: {name} CNAME {target} (proxied)")
    else:
        must(
            call(
                "POST",
                f"/zones/{ZONE}/dns_records",
                {"type": "CNAME", "name": name, "content": target, "proxied": True},
            ),
            "creating dns",
        )
        print(f"dns created: {name} CNAME {target} (proxied)")

# 4. read back the live config as proof, not assumption
live = must(call("GET", f"/accounts/{ACCOUNT}/cfd_tunnel/{tid}/configurations"), "reading back config")
print("live ingress:", json.dumps(live.get("config", {}).get("ingress", []), separators=(",", ":")))
print("TUNNEL_ID=" + tid)
