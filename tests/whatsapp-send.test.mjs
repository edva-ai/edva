// whatsapp-send — the em-dash gate on messages to the user's own number. The
// number comes from WHATSAPP_OWNER_NUMBER, or from an older env name an
// installation lists in local config whatsapp-send.json extend_owner_number_env.
// No runner: an unreachable WHATSAPP_RUNNER_URL means a message that passes the
// gate fails at the send, with a different error. The group tests below run a
// fake runner for --list-groups and --to "<group name>".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync, spawn } from "node:child_process";

const BIN = new URL("../bin/whatsapp-send", import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-send-"));
const local = path.join(tmp, "local");
fs.mkdirSync(path.join(local, "config"), { recursive: true });
fs.mkdirSync(path.join(tmp, "data"), { recursive: true }); // the sent-log mirror, under EDVA_HOME=tmp

function send(to, env) {
  const base = { PATH: process.env.PATH, HOME: tmp, EDVA_LOCAL_DIR: local, WHATSAPP_RUNNER_URL: "http://127.0.0.1:9" };
  return spawnSync(process.execPath, [BIN, "--to", to, "--text", "one — two"], { env: { ...base, ...env }, encoding: "utf8" });
}
const gated = (r) => r.status === 1 && /em\/en dash found/.test(r.stderr);

test("WHATSAPP_OWNER_NUMBER: dashes to the user's number are refused, to others not gated", () => {
  assert.ok(gated(send("+1 555 010 0001", { WHATSAPP_OWNER_NUMBER: "+15550100001" })));
  const other = send("+15550100002", { WHATSAPP_OWNER_NUMBER: "+15550100001" });
  assert.ok(!gated(other) && /runner unreachable/.test(other.stderr));
  assert.ok(!gated(send("+15550100001", { WHATSAPP_OWNER_NUMBER: "+15550100001", WHATSAPP_ALLOW_DASHES: "1" })));
});

test("an older env name listed in local config is honoured; unlisted, it is not", () => {
  assert.ok(!gated(send("+15550100001", { OLD_OWNER_WA: "+15550100001" })));
  fs.writeFileSync(path.join(local, "config", "whatsapp-send.json"), JSON.stringify({ extend_owner_number_env: ["OLD_OWNER_WA"] }));
  assert.ok(gated(send("+15550100001", { OLD_OWNER_WA: "+15550100001" })));
  // the generic name still wins when both are set
  assert.ok(!gated(send("+15550100001", { OLD_OWNER_WA: "+15550100001", WHATSAPP_OWNER_NUMBER: "+15550100009" })));
  fs.rmSync(path.join(local, "config", "whatsapp-send.json"));
});

// A fake runner serving GET /groups and POST /send, so the group paths are
// exercised without a paired session.
const GROUPS = [
  { id: "111@g.us", subject: "Book Club", participants: 4 },
  { id: "222@g.us", subject: "Trip", participants: 3 },
  { id: "333@g.us", subject: "trip", participants: 2 },
];
async function withRunner(fn) {
  const sends = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/groups") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, groups: GROUPS }));
      return;
    }
    if (req.method === "POST" && req.url === "/send") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        sends.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message_id: "MSG1" }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(url, sends); } finally { server.close(); }
}
function run(args, url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, HOME: tmp, EDVA_HOME: tmp, EDVA_LOCAL_DIR: local, WHATSAPP_RUNNER_URL: url },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("--list-groups prints each group's id, subject and size", async () => {
  await withRunner(async (url) => {
    const r = await run(["--list-groups"], url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /111@g\.us\tBook Club\t4 members/);
    const j = await run(["--list-groups", "--json"], url);
    assert.deepEqual(JSON.parse(j.stdout), GROUPS);
  });
});

test("--to a group name resolves to its id; an ambiguous or unknown name is refused and nothing is sent", async () => {
  await withRunner(async (url, sends) => {
    const ok = await run(["--to", "book club", "--text", "hello"], url);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, "111@g.us");

    const exact = await run(["--to", "trip", "--text", "hello"], url);
    assert.equal(exact.status, 0, exact.stderr);
    assert.equal(sends[1].to, "333@g.us");

    const ambiguous = await run(["--to", "TRIP", "--text", "hello"], url);
    assert.equal(ambiguous.status, 2);
    assert.match(ambiguous.stderr, /matches 2 groups/);

    const none = await run(["--to", "Nobody here", "--text", "hello"], url);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /no group named/);
    assert.equal(sends.length, 2);

    // A phone number or chat id goes straight through, no group lookup.
    const phone = await run(["--to", "+1 555 010 0003", "--text", "hello"], url);
    assert.equal(phone.status, 0, phone.stderr);
    assert.equal(sends[2].to, "+1 555 010 0003");
  });
});
