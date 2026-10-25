// Regression guard: a digest job's email-send failed from a sandboxed tier.
//
// Alert it stops: "⚠️ <job>: email-send failed twice (fetch error) — picks
// built but UNDELIVERED" (and the same shape from haiku-tier watch jobs).
//
// ops-light and ops-haiku run their Bash tool inside the Claude Code sandbox,
// which lets traffic out only through the local proxy it advertises in
// HTTPS_PROXY. curl honours that variable; Node's built-in fetch ignores it
// unless NODE_USE_ENV_PROXY=1 is set, so every Node tool on those tiers
// (email-send, gmail-action, og-card) failed with "fetch failed (ENOTFOUND)".
// agent/supervisor/index.mjs therefore passes NODE_USE_ENV_PROXY=1 to
// every agent session it spawns. The first test pins that line; the second
// pins the Node behaviour the fix relies on, so a Node upgrade that dropped
// the variable would fail here instead of silently undelivering digests.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { REPO_ROOT as ROOT } from "../lib/root.cjs";
const SRC = path.join(ROOT, "agent/supervisor/index.mjs");

test("every ops-tier agent session is spawned with NODE_USE_ENV_PROXY=1", () => {
  const src = fs.readFileSync(SRC, "utf8");
  const start = src.indexOf("async startSession(");
  assert.ok(start >= 0, "startSession() not found in supervisor/index.mjs");
  const body = src.slice(start, start + 8000);
  const envLine = body.split("\n").find((l) => /^\s*env:\s*\{/.test(l)); // lang-regex-ok: matches a JS object key in source code, not anyone's words
  assert.ok(envLine, "startSession() no longer passes an env block to the session");
  assert.match(envLine, /NODE_USE_ENV_PROXY:\s*"1"/); // lang-regex-ok: matches a JS object literal in source code
});

// Starts a fake proxy that records CONNECT requests and refuses them, then
// runs a child Node fetch against a .invalid host with HTTPS_PROXY pointing at
// it. Nothing leaves the machine: with the variable the request stops at the
// fake proxy; without it the child fails DNS on a reserved name.
function runChild(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e",
      "fetch('https://sic-probe.invalid/').then(()=>console.log('ok'),e=>console.log('fail',e.cause&&e.cause.code||e.message))"],
      { env: { PATH: process.env.PATH, ...extraEnv }, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(out.trim()));
  });
}

test("Node's fetch goes through HTTPS_PROXY only when NODE_USE_ENV_PROXY=1", async (t) => {
  const seen = [];
  const proxy = http.createServer((req, res) => { res.writeHead(403); res.end(); });
  proxy.on("connect", (req, socket) => {
    seen.push(req.url);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  try {
    await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  } catch (e) {
    t.skip(`cannot bind a local test proxy here (${e.code || e.message})`);
    return;
  }
  try {
    const HTTPS_PROXY = `http://127.0.0.1:${proxy.address().port}`;

    await runChild({ HTTPS_PROXY });
    assert.deepEqual(seen, [], "without NODE_USE_ENV_PROXY, Node should bypass HTTPS_PROXY (that bypass is the bug this fix exists for)");

    await runChild({ HTTPS_PROXY, NODE_USE_ENV_PROXY: "1" });
    assert.deepEqual(seen, ["sic-probe.invalid:443"], "with NODE_USE_ENV_PROXY=1, Node must tunnel through HTTPS_PROXY");
  } finally {
    proxy.close();
  }
});
