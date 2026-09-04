#!/usr/bin/env python3
"""Fetch the named tunnel's RUN token and store it in 1Password (runbook step 4).

Already run once for tunnel `telephony` (DECISIONS D-67); this exists so the step
is reproducible if the token is ever rotated or the tunnel recreated, and so the
safe-handling pattern does not have to be re-derived.

The secret goes API response -> 0600 temp file -> `op item create` -> file
overwritten and unlinked. It never reaches stdout, argv, or an agent transcript
(INV-12: config carries the NAME, the value only ever lives in the cloudflared
child env). Only lengths and ids are printed.

Usage:

    CF_TOKEN=$(opkeep get CF_EQSTACK_TELEPHONY_TUNNEL_TOKEN) \
      python3 apps/telephony-mcp/scripts/store-tunnel-token.py [tunnel-id]

Prefer `opkeep get` over `op read`: the latter can block on a biometric prompt
and silently yield an empty string, which surfaces as the misleading Cloudflare
error `9106: Missing ... Authorization headers`.

Re-running overwrites nothing by itself — `op item create` will refuse a
duplicate title, which is deliberate: rotating means editing the existing item,
a decision a human should make explicitly.
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

ACCOUNT = "0de8624f4e34eaf3ebc22d5290d9b230"
DEFAULT_TUNNEL_ID = "5cdf3c85-cb71-4212-971e-d17221524856"
TITLE = "CLOUDFLARE_TUNNEL_TOKEN"
VAULT = "key-vault"

tunnel_id = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TUNNEL_ID
api = os.environ.get("CF_TOKEN")
if not api:
    sys.exit("CF_TOKEN not set — see the usage block in this file's docstring")

req = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/cfd_tunnel/{tunnel_id}/token",
    headers={"Authorization": f"Bearer {api}"},
)
try:
    with urllib.request.urlopen(req) as r:
        res = json.loads(r.read())
except urllib.error.HTTPError as e:
    res = json.loads(e.read() or b"{}")

if not res.get("success"):
    msgs = ["{}: {}".format(er.get("code"), er.get("message")) for er in res.get("errors", [])]
    sys.exit("TOKEN FETCH FAILED: " + str(msgs))

value = res["result"]
print(f"run-token fetched ({len(value)} chars) — not printed")

template = {
    "title": TITLE,
    "category": "API_CREDENTIAL",
    "fields": [
        {"id": "credential", "type": "CONCEALED", "label": "credential", "value": value},
        {
            "id": "notesPlain",
            "type": "STRING",
            "purpose": "NOTES",
            "label": "notesPlain",
            "value": (
                f"cloudflared RUN token for named tunnel 'telephony' (id {tunnel_id}) on account "
                f"{ACCOUNT}, hostname gw.agentpipe.top. Consumed by apps/telephony-mcp's tunnel "
                "supervisor via config tunnel.tokenRef -> this NAME. This is NOT an API token: it "
                "only runs this one tunnel."
            ),
        },
    ],
}
blob = json.dumps(template)
fd, tmp = tempfile.mkstemp(suffix=".json")
os.chmod(tmp, 0o600)
try:
    with os.fdopen(fd, "w") as f:
        f.write(blob)
    out = subprocess.run(
        ["op", "item", "create", "--template", tmp, "--vault", VAULT],
        capture_output=True,
        text=True,
    )
    print("op item create rc:", out.returncode)
    for line in (out.stdout or out.stderr).splitlines()[:5]:
        if "credential" not in line.lower():
            print("   ", line)
finally:
    with open(tmp, "r+b") as f:
        f.write(b"\0" * len(blob))
        f.flush()
        os.fsync(f.fileno())
    os.unlink(tmp)
    print("temp template overwritten and removed")
