// cdp-runner.mjs — drive the host's automation Chrome via CDP-over-WebSocket
// to run a browsing-skill action against a live URL. No npm deps; uses Node's
// built-in fetch + WebSocket (requires Node 22+ for stable WebSocket global).
//
// This is the proven harness that's been used to verify ~20 skills end-to-end
// during the CDP cutover. Promoted from /tmp/smoke-test-cdp.mjs
// (where it lived during that session) into the repo for survival across host
// reboots + reviewability.
//
// CLI usage:
//   node cdp-runner.mjs <url> <skill-path> [paramsJson] [--cdp-host=<host:port>]
//                                                       [--capture-network=<pattern>]
//                                                       [--capture-frames]
//
// Programmatic usage (from run-action.js):
//   import { runActionCdp } from "./cdp-runner.mjs";
//   const result = await runActionCdp({ url, actionBlock, params, cdpHost,
//                                       captureNetwork, captureFrames });
//
// Skill-path is a .md file containing one or more ```js fenced blocks; the
// LAST block containing an `execute:` is the canonical action body.
//
// The Chrome target must already be running with --remote-debugging-port=9222
// on the host (LaunchAgent com.edva.chrome-cdp keeps it alive per
// system/architecture.md § Host).
//
// ── Network + frame capture ─────────────────────────────────────────────────
// When `captureNetwork` is set, the harness enables CDP's Network domain
// BEFORE running the action and records every Network.requestWillBeSent +
// Network.responseReceived event whose URL matches the pattern. This unlocks
// write-action verification for cases where the form POST navigates the tab
// (killing the inspector before the action's verification poll can read
// post-submit DOM) — the network capture survives the navigation.
//
// `captureNetwork` accepts:
//   - a string: matched as a case-insensitive substring against request URLs
//   - a RegExp: matched against URLs
// Defaults to off (no Network.enable, no overhead).
//
// `captureFrames` (boolean) records Page.frameNavigated events — useful for
// detecting post-submit redirects ("did the popup navigate to /thank-you?").
//
// On "Inspected target navigated or closed" mid-eval, the harness catches the
// error, returns whatever was captured + sets `tabNavigated: true` so the
// caller can distinguish a successful-POST-then-redirect from a real failure.

import fs from "node:fs";

const DEFAULT_CDP_HOST = process.env.CDP_HOST || "localhost:9222";

/** Extract the last `js` fenced block with `execute:` from a markdown file. */
export function extractActionBlock(skillPath) {
  const raw = fs.readFileSync(skillPath, "utf8");
  const blocks = [...raw.matchAll(/```js\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (/\bexecute\b\s*:/.test(blocks[i])) return blocks[i];
  }
  return null;
}

function matchesPattern(url, pattern) {
  if (!pattern) return false;
  if (pattern instanceof RegExp) return pattern.test(url);
  return url.toLowerCase().includes(String(pattern).toLowerCase());
}

/**
 * Run an action against a live URL via CDP.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.actionBlock     - JS source of the action object `({...})`
 * @param {object} [opts.params]        - passed to action.execute(params)
 * @param {string} [opts.cdpHost]       - e.g. "localhost:9222"
 * @param {number} [opts.loadTimeoutMs] - max wait for Page.loadEventFired (default 12000)
 * @param {number} [opts.settleMs]      - post-load settle delay for SPA hydration (default 2500)
 * @param {number} [opts.evalTimeoutMs] - max wait for the action's execute() promise (default 180000).
 *   A page whose in-page fetch never settles used to hang the caller forever
 *   (seen on a skill's dry run); past this the call returns
 *   {ok:false, error:"eval_timeout"} and the tab is still closed.
 * @param {string|RegExp} [opts.captureNetwork] - if set, capture matching network requests/responses
 * @param {boolean} [opts.captureFrames]        - if true, capture Page.frameNavigated events
 * @returns {Promise<{ok: boolean, result?: any, error?: string, stack?: string,
 *                    networkCaptures?: Array, frameNavigations?: Array, tabNavigated?: boolean}>}
 */
export async function runActionCdp({
  url,
  actionBlock,
  params = {},
  cdpHost = DEFAULT_CDP_HOST,
  loadTimeoutMs = 12000,
  settleMs = 2500,
  evalTimeoutMs = 180000,
  captureNetwork = null,
  captureFrames = false,
} = {}) {
  if (!url) throw new Error("url required");
  if (!actionBlock) throw new Error("actionBlock required");

  // Open a new tab pointed at the URL. Chrome's /json/new accepts PUT in
  // newer builds and GET in older ones — try PUT first, fall back to GET.
  let tab;
  const newUrl = `http://${cdpHost}/json/new?${encodeURIComponent(url)}`;
  const putRes = await fetch(newUrl, { method: "PUT", signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (putRes && putRes.ok) tab = await putRes.json();
  else {
    const getRes = await fetch(newUrl, { signal: AbortSignal.timeout(10000) });
    if (!getRes.ok) throw new Error(`could not create new tab: ${await getRes.text()}`);
    tab = await getRes.json();
  }

  const wsUrl = tab.webSocketDebuggerUrl;
  const tabId = tab.id;
  console.error(`[cdp] new tab ${tabId} → ${url}`);

  const ws = new WebSocket(wsUrl);
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("cdp websocket open timeout")), 10000);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener("error", (e) => { clearTimeout(t); reject(e); }, { once: true });
    });
  } catch (e) {
    try { ws.close(); } catch {}
    await fetch(`http://${cdpHost}/json/close/${tabId}`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
    throw e;
  }

  let msgId = 0;
  const pending = new Map();
  // Network capture state. Key by requestId so request + response can be joined.
  const networkByRequestId = new Map();
  const frameNavigations = [];

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);

    // Response to a `send()` call
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }

    // Pretty banner for load events
    if (msg.method === "Page.loadEventFired") {
      console.error("[cdp] load fired");
      return;
    }

    // Network capture (only when enabled)
    if (captureNetwork && msg.method === "Network.requestWillBeSent") {
      const p = msg.params || {};
      const req = p.request || {};
      if (matchesPattern(req.url || "", captureNetwork)) {
        networkByRequestId.set(p.requestId, {
          requestId: p.requestId,
          url: req.url,
          method: req.method,
          postData: req.postData ? req.postData.slice(0, 1000) : null,
          requestHeaders: req.headers,
          requestedAt: new Date().toISOString(),
          // Filled by responseReceived below.
          status: null,
          statusText: null,
          responseUrl: null,
          responseHeaders: null,
          mimeType: null,
          // Track redirect chain via Network.requestWillBeSent.redirectResponse
          redirectFrom: p.redirectResponse ? {
            status: p.redirectResponse.status,
            location: (p.redirectResponse.headers || {}).Location || (p.redirectResponse.headers || {}).location || null,
          } : null,
        });
      }
    }
    if (captureNetwork && msg.method === "Network.responseReceived") {
      const p = msg.params || {};
      const resp = p.response || {};
      const entry = networkByRequestId.get(p.requestId);
      if (entry) {
        entry.status = resp.status;
        entry.statusText = resp.statusText;
        entry.responseUrl = resp.url;
        entry.responseHeaders = resp.headers;
        entry.mimeType = resp.mimeType;
        entry.respondedAt = new Date().toISOString();
      } else if (matchesPattern(resp.url || "", captureNetwork)) {
        // Response without a matching request (rare — e.g. preflight). Record anyway.
        networkByRequestId.set(p.requestId, {
          requestId: p.requestId,
          url: null,
          method: null,
          responseUrl: resp.url,
          status: resp.status,
          statusText: resp.statusText,
          responseHeaders: resp.headers,
          mimeType: resp.mimeType,
          respondedAt: new Date().toISOString(),
        });
      }
    }
    if (captureFrames && msg.method === "Page.frameNavigated") {
      const p = msg.params || {};
      const frame = p.frame || {};
      // Filter out the initial about:blank + sub-frames
      if (frame.url && frame.url !== "about:blank" && !frame.parentId) {
        frameNavigations.push({
          url: frame.url,
          loaderId: frame.loaderId,
          navigatedAt: new Date().toISOString(),
        });
      }
    }
  });

  function send(method, params2 = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, (msg) => {
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params: params2 }));
    });
  }

  // Wraps the result with captured network/frame state when enabled.
  function withCaptures(base, tabNavigated = false) {
    if (!captureNetwork && !captureFrames) return base;
    const out = { ...base };
    if (captureNetwork) out.networkCaptures = [...networkByRequestId.values()];
    if (captureFrames) out.frameNavigations = frameNavigations;
    if (tabNavigated) out.tabNavigated = true;
    return out;
  }

  try {
    await send("Page.enable");
    if (captureNetwork) await send("Network.enable", {});
    // Page.frameNavigated fires under Page domain (already enabled).

    // Wait up to loadTimeoutMs for the load event.
    let loaded = false;
    const t0 = Date.now();
    const onLoad = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === "Page.loadEventFired") loaded = true;
    };
    ws.addEventListener("message", onLoad);
    while (!loaded && Date.now() - t0 < loadTimeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    ws.removeEventListener("message", onLoad);
    console.error(`[cdp] page ${loaded ? "loaded" : "load-timeout"} after ${Date.now() - t0}ms`);

    // Settle to let SPAs hydrate.
    await new Promise((r) => setTimeout(r, settleMs));

    // Build the expression: wrap the action and await its execute. Catch any
    // exception and return as { ok: false, error } instead of propagating —
    // that way the caller always gets a structured result.
    const expr = `(async () => {
      try {
        const action = (${actionBlock});
        const result = await action.execute(${JSON.stringify(params)});
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: String(e), stack: e && e.stack };
      }
    })()`;

    let evalRes;
    let evalTimer;
    try {
      const TIMED_OUT = Symbol("eval_timeout");
      evalRes = await Promise.race([
        send("Runtime.evaluate", {
          expression: expr,
          awaitPromise: true,
          returnByValue: true,
        }),
        new Promise((r) => { evalTimer = setTimeout(() => r(TIMED_OUT), evalTimeoutMs); }),
      ]);
      if (evalRes === TIMED_OUT) {
        console.error(`[cdp] action did not settle within ${evalTimeoutMs}ms — giving up`);
        return withCaptures({ ok: false, error: "eval_timeout", message: `action did not settle within ${evalTimeoutMs}ms` });
      }
    } catch (err) {
      // "Inspected target navigated or closed" is a NORMAL outcome for write
      // actions that submit a form which redirects the popup. The Runtime.evaluate
      // promise rejects mid-flight, but we still have captured network state to
      // surface. Return success-shaped result with tabNavigated:true so the caller
      // can distinguish navigation-after-submit from real failures.
      if (/Inspected target navigated or closed/i.test(String(err.message || ""))) { // lang-regex-ok: Chrome DevTools protocol error string
        console.error("[cdp] tab navigated mid-eval — returning captures");
        // Give Chrome a moment to flush trailing Network events for the response.
        await new Promise((r) => setTimeout(r, 500));
        return withCaptures({
          ok: false,
          error: "tab_navigated_mid_eval",
          message: String(err.message),
        }, true);
      }
      throw err;
    } finally {
      clearTimeout(evalTimer);
    }

    if (evalRes.exceptionDetails) {
      return withCaptures({
        ok: false,
        error: "runtime_exception",
        details: evalRes.exceptionDetails,
      });
    }
    return withCaptures(evalRes.result.value);
  } finally {
    // Always close the tab + ws (don't leak Chrome tabs). A wedged page can stop
    // answering CDP, so the close is bounded and backed by the HTTP endpoint.
    const closed = await Promise.race([
      send("Target.closeTarget", { targetId: tabId }).then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), 5000)),
    ]);
    if (!closed) await fetch(`http://${cdpHost}/json/close/${tabId}`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
    ws.close();
  }
}

// CLI entry — only when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  // Parse trailing flags.
  let cdpHost = DEFAULT_CDP_HOST;
  let captureNetwork = null;
  let captureFrames = false;
  const filtered = [];
  for (const a of args) {
    let m;
    if ((m = a.match(/^--cdp-host=(.+)$/))) cdpHost = m[1];
    else if ((m = a.match(/^--capture-network=(.+)$/))) captureNetwork = m[1];
    else if (a === "--capture-frames") captureFrames = true;
    else filtered.push(a);
  }
  const [url, skillPath, paramsJsonStr] = filtered;
  if (!url || !skillPath) {
    console.error("usage: cdp-runner.mjs <url> <skill.md> [paramsJson] [--cdp-host=<host:port>] [--capture-network=<pattern>] [--capture-frames]");
    process.exit(2);
  }
  const actionBlock = extractActionBlock(skillPath);
  if (!actionBlock) {
    console.error(`no js block with execute: in ${skillPath}`);
    process.exit(2);
  }
  const params = paramsJsonStr ? JSON.parse(paramsJsonStr) : {};
  const result = await runActionCdp({ url, actionBlock, params, cdpHost, captureNetwork, captureFrames });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
