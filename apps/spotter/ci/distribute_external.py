#!/usr/bin/env python3
"""Poll ASC until a build is VALID, then add it to an external beta group.

Generic ASC poll-and-distribute helper.
"""
import os, sys, re, jwt, time, json, argparse
import urllib.parse, urllib.request, urllib.error

BASE = "https://api.appstoreconnect.apple.com/v1"
POLL_INTERVAL = 30
MAX_WAIT = 1800
DEFAULT_GROUP = "Spotter External"


def log(msg):
    print(msg, file=sys.stderr)


def make_token():
    key_id = os.environ["ASC_KEY_ID"]
    issuer_id = os.environ["ASC_ISSUER_ID"]
    raw = os.environ["ASC_PRIVATE_KEY"].strip()
    if "\\n" in raw:
        raw = raw.replace("\\n", "\n")
    b64 = re.sub(r"-----(BEGIN|END) PRIVATE KEY-----", "", raw)
    b64 = re.sub(r"\s+", "", b64)
    pad = 4 - len(b64) % 4
    if pad != 4:
        b64 += "=" * pad
    lines = [b64[i:i+64] for i in range(0, len(b64), 64)]
    pem = "-----BEGIN PRIVATE KEY-----\n" + "\n".join(lines) + "\n-----END PRIVATE KEY-----"
    now = int(time.time())
    return jwt.encode(
        {"iss": issuer_id, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"},
        pem, algorithm="ES256", headers={"kid": key_id, "typ": "JWT"},
    )


def api_get(path, token):
    req = urllib.request.Request(f"{BASE}{path}")
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


def api_post(path, token, body):
    req = urllib.request.Request(f"{BASE}{path}", data=json.dumps(body).encode(), method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as r:
        return r.status


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--build-number", required=True)
    p.add_argument("--group", default=DEFAULT_GROUP)
    args = p.parse_args()

    app_id = os.environ["ASC_APP_ID"]
    token = make_token()

    groups = api_get(f"/apps/{app_id}/betaGroups?limit=50", token)
    group_id = None
    for g in groups.get("data", []):
        if g["attributes"]["name"] == args.group:
            group_id = g["id"]
            break
    if not group_id:
        log(f"Beta group '{args.group}' not found — skipping external distribution")
        return

    log(f"Found beta group '{args.group}' (id={group_id})")

    build_id = None
    elapsed = 0
    while elapsed < MAX_WAIT:
        if elapsed > 0 and elapsed % 900 == 0:
            token = make_token()
        params = urllib.parse.urlencode({
            "filter[app]": app_id,
            "filter[version]": args.build_number,
            "limit": "1",
        })
        builds = api_get(f"/builds?{params}", token)
        for b in builds.get("data", []):
            status = b["attributes"]["processingState"]
            log(f"Build {args.build_number}: {status} (waited {elapsed}s)")
            if status == "VALID":
                build_id = b["id"]
                break
            elif status in ("FAILED", "INVALID"):
                log(f"Build processing {status} — aborting")
                sys.exit(1)
        if build_id:
            break
        time.sleep(POLL_INTERVAL)
        elapsed += POLL_INTERVAL

    if not build_id:
        log(f"Timed out waiting for build {args.build_number}")
        sys.exit(1)

    log(f"Submitting build {build_id} for beta review...")
    try:
        api_post("/betaAppReviewSubmissions", token, {
            "data": {"type": "betaAppReviewSubmissions",
                     "relationships": {"build": {"data": {"type": "builds", "id": build_id}}}}
        })
    except urllib.error.HTTPError as e:
        if e.code != 409:
            log(f"Beta review submission failed: HTTP {e.code}: {e.read().decode()[:300]}")

    log(f"Adding build {build_id} to '{args.group}'...")
    try:
        api_post(f"/betaGroups/{group_id}/relationships/builds", token,
                 {"data": [{"type": "builds", "id": build_id}]})
        log("Done.")
    except urllib.error.HTTPError as e:
        if e.code != 409:
            log(f"Failed: HTTP {e.code}: {e.read().decode()[:300]}")
            sys.exit(1)


if __name__ == "__main__":
    main()
