#!/usr/bin/env python3
"""
cdp.py — minimal stateful Chrome DevTools Protocol driver.

Drives the Chrome already running on this machine with
--remote-debugging-port=9222 (override with CDP_PORT env var, e.g. for a
second automation profile on another port). Reuses a single tab across invocations
(tab id persisted in a state file) so a multi-step flow can be scripted
as a sequence of CLI calls.

Commands:
  cdp.py open <url>            navigate the working tab to <url> (creates tab if none)
  cdp.py info                  print current url + title
  cdp.py shot <path>           screenshot the working tab to a PNG
  cdp.py eval '<js>'           evaluate JS in the page, print JSON result
  cdp.py evalfile <path>       evaluate JS read from a file (avoids shell quoting hell)
  cdp.py wait <seconds>        sleep (convenience)
  cdp.py reset                 forget the working tab (next open creates fresh)

Exit 0 on success, non-zero on error.
"""

import base64
import json
import os
import sys
import time
import urllib.request

import websocket  # websocket-client

# Port 9222 is the user's automation profile. Set CDP_PORT to drive a second
# profile on another port (a second Chrome with its own profile). Each port
# keeps its own working-tab state file so the two drivers never steal each
# other's tab.
CDP_PORT = os.environ.get("CDP_PORT", "9222")
CDP_HOST = "http://localhost:%s" % CDP_PORT
_STATE_SUFFIX = "" if CDP_PORT == "9222" else "-%s" % CDP_PORT
STATE = os.path.expanduser(
    "~/Dev/edva/data/.cdp-driver-state%s.json" % _STATE_SUFFIX
)
TIMEOUT = 30


def _load_state():
    if os.path.exists(STATE):
        try:
            return json.load(open(STATE))
        except Exception:
            return {}
    return {}


def _save_state(s):
    # Atomic (D15): concurrent cdp.py calls read this; a torn read was {} (lost tab id).
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "lib"))
    from atomic_write import write_json_atomic
    write_json_atomic(STATE, s)


def _http_get(path):
    with urllib.request.urlopen(CDP_HOST + path, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode())


def _list_targets():
    return [t for t in _http_get("/json") if t.get("type") == "page"]


def _new_tab(url="about:blank"):
    # Chrome 148 accepts GET /json/new?<url> only with a PUT; try PUT then GET.
    req = urllib.request.Request(
        CDP_HOST + "/json/new?" + urllib.parse.quote(url, safe=""),
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode())
    except Exception:
        with urllib.request.urlopen(
            CDP_HOST + "/json/new?" + urllib.parse.quote(url, safe=""),
            timeout=TIMEOUT,
        ) as r:
            return json.loads(r.read().decode())


import urllib.parse  # noqa: E402  (after functions for readability)


class CDP:
    def __init__(self, ws_url):
        # Chrome 111+ rejects WS upgrades whose Origin isn't in
        # --remote-allow-origins. Suppressing the Origin header entirely
        # makes Chrome treat it as a non-browser client and allow it.
        self.ws = websocket.create_connection(
            ws_url, timeout=TIMEOUT, suppress_origin=True
        )
        self._id = 0

    def cmd(self, method, params=None, timeout=TIMEOUT):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.ws.settimeout(max(1, deadline - time.time()))
            try:
                msg = json.loads(self.ws.recv())
            except websocket.WebSocketTimeoutException:
                continue
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method} failed: {msg['error']}")
                return msg.get("result", {})
        raise TimeoutError(f"{method} timed out")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def _get_working_tab(create_url=None):
    """Return (target_dict) for the working tab, creating one if needed."""
    state = _load_state()
    tab_id = state.get("tab_id")
    targets = _list_targets()
    by_id = {t["id"]: t for t in targets}

    if tab_id and tab_id in by_id:
        return by_id[tab_id]

    # No valid working tab — create one.
    tab = _new_tab(create_url or "about:blank")
    _save_state({"tab_id": tab["id"]})
    # The freshly created target needs a moment to expose its ws URL.
    for _ in range(10):
        targets = _list_targets()
        by_id = {t["id"]: t for t in targets}
        if tab["id"] in by_id and by_id[tab["id"]].get("webSocketDebuggerUrl"):
            return by_id[tab["id"]]
        time.sleep(0.3)
    return tab


def cmd_open(url):
    tab = _get_working_tab(create_url=url)
    cdp = CDP(tab["webSocketDebuggerUrl"])
    try:
        cdp.cmd("Page.enable")
        cdp.cmd("Runtime.enable")
        cdp.cmd("Page.navigate", {"url": url})
        # crude wait for load
        time.sleep(3)
        res = cdp.cmd(
            "Runtime.evaluate",
            {"expression": "({url: location.href, title: document.title})",
             "returnByValue": True},
        )
        print(json.dumps(res.get("result", {}).get("value", {})))
    finally:
        cdp.close()


def cmd_info():
    tab = _get_working_tab()
    cdp = CDP(tab["webSocketDebuggerUrl"])
    try:
        cdp.cmd("Runtime.enable")
        res = cdp.cmd(
            "Runtime.evaluate",
            {"expression": "({url: location.href, title: document.title, "
             "ready: document.readyState})",
             "returnByValue": True},
        )
        print(json.dumps(res.get("result", {}).get("value", {})))
    finally:
        cdp.close()


def cmd_shot(path):
    tab = _get_working_tab()
    cdp = CDP(tab["webSocketDebuggerUrl"])
    try:
        cdp.cmd("Page.enable")
        res = cdp.cmd("Page.captureScreenshot", {"format": "png"})
        data = base64.b64decode(res["data"])
        with open(os.path.expanduser(path), "wb") as f:
            f.write(data)
        print(f"saved {len(data)} bytes to {path}")
    finally:
        cdp.close()


def cmd_eval(js):
    tab = _get_working_tab()
    cdp = CDP(tab["webSocketDebuggerUrl"])
    try:
        cdp.cmd("Runtime.enable")
        res = cdp.cmd(
            "Runtime.evaluate",
            {"expression": js, "returnByValue": True, "awaitPromise": True},
            timeout=TIMEOUT,
        )
        r = res.get("result", {})
        if "value" in r:
            print(json.dumps(r["value"], ensure_ascii=False, default=str))
        else:
            print(json.dumps(r, ensure_ascii=False, default=str))
        if res.get("exceptionDetails"):
            print("EXCEPTION: " + json.dumps(res["exceptionDetails"], default=str),
                  file=sys.stderr)
            return 1
    finally:
        cdp.close()
    return 0


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd = argv[1]
    if cmd == "open":
        cmd_open(argv[2])
    elif cmd == "info":
        cmd_info()
    elif cmd == "shot":
        cmd_shot(argv[2])
    elif cmd == "eval":
        return cmd_eval(argv[2])
    elif cmd == "evalfile":
        return cmd_eval(open(argv[2]).read())
    elif cmd == "wait":
        time.sleep(float(argv[2]))
        print("waited")
    elif cmd == "reset":
        if os.path.exists(STATE):
            os.remove(STATE)
        print("reset")
    else:
        print(f"unknown command: {cmd}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
