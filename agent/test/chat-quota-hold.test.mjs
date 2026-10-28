// chat-quota-hold.test.mjs — chat never relays the CLI's usage-limit error as
// the user's answer, and a refused message waits for the reset.
//
// The failure this guards: a chat message got back, as its reply, "You've hit
// your weekly limit · resets 8pm (America/Vancouver)", and the message was
// never answered. Part 1 covers the pure pieces; part 2 runs
// the real chat supervisor against a fake CLI that refuses in exactly that
// shape, under a throwaway HOME with no Supabase key and a fake
// edva-send-curl, so nothing can reach the real chat or system channel.
// The sandbox holds whatever the caller exports: EDVA_HOME, which outranks
// HOME in lib/root.cjs, is removed from the child's environment, and
// SUPABASE_URL points at a closed local port (see the "never posts" test).
//
// Also here, because it shares the harness: a retry on a resumed session keeps
// its safety net through the resume handshake's zero-work result.
//
// Run: node --test agent/test/chat-quota-hold.test.mjs

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { PriorityDispatcher } from "../lib/priority-dispatcher.mjs";
import { isCliQuotaMessage, resetLabel, chatQuotaNotice, chatQuotaDroppedNotice } from "../supervisor/chat-quota.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OBSERVED = "You've hit your weekly limit · resets 8pm (America/Vancouver)";

describe("chat quota: pure pieces", () => {
  it("recognises the CLI's synthetic limit message by its error class, not its text", () => {
    assert.equal(isCliQuotaMessage({ type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: OBSERVED }] } }), true);
    assert.equal(isCliQuotaMessage({ type: "assistant", message: { content: [{ type: "text", text: OBSERVED }] } }), false, "the agent quoting it is not it");
    assert.equal(isCliQuotaMessage({ type: "assistant", error: "authentication_failed" }), false);
  });

  it("names the reset in the user's current time zone", () => {
    const now = Date.UTC(2026, 9, 1, 0, 52);       // 5:52pm PT, 3:52am in Nairobi
    const reset = Date.UTC(2026, 9, 1, 3, 0);      // 8pm PT
    assert.equal(resetLabel(reset, "America/Vancouver", now), "at 8pm");
    assert.equal(resetLabel(reset, "Africa/Nairobi", now), "at 6am");
    assert.equal(resetLabel(Date.UTC(2026, 9, 1, 14, 30), "America/Vancouver", now), "tomorrow at 7:30am");
    assert.equal(resetLabel(Date.UTC(2026, 9, 3, 6, 0), "America/Vancouver", now), "Friday at 11pm");
    const info = { status: "rejected", rateLimitType: "seven_day", resetsAt: reset / 1000 };
    assert.equal(chatQuotaNotice({ info, until: reset + 60_000, tz: "America/Vancouver", now }),
      "I've hit this week's Claude limit, so I can't answer right now. It resets at 8pm your time, and I'll pick your message up then.");
    assert.equal(chatQuotaNotice({ info: { status: "rejected" }, until: now + 15 * 60_000, tz: "America/Vancouver", now }),
      "I've hit my Claude usage limit, so I can't answer right now. I'll try again in about 15 minutes and pick your message up then.");
    assert.equal(chatQuotaNotice({ info, until: reset, tz: "America/Vancouver", now, requeued: false }),
      "I've hit this week's Claude limit partway through your last message, so I couldn't finish it. It resets at 8pm your time; ask me again then if anything's missing.");
    assert.equal(chatQuotaDroppedNotice({ info: {}, tz: "America/Vancouver", now }),
      "Sorry, I tried your message again but I'm still over my Claude usage limit, so I've had to set it aside. Please send it again in a little while.");
    assert.equal(chatQuotaDroppedNotice({ info, tz: "America/Vancouver", now, several: true }),
      "Sorry, I tried your messages again but I'm still over this week's Claude limit, so I've had to set them aside. It resets at 8pm your time; please send them again then.");
  });

  it("PriorityDispatcher sends nothing while held, keeps a requeued item first, and drains on release", () => {
    const s = new EventEmitter(); s.sent = []; s.send = (c) => s.sent.push(c);
    const d = new PriorityDispatcher(s, { coalesce: false });
    d.dispatch("first", "edva", { priority: "high" });
    d.dispatch("later", "edva", { priority: "high" });
    d.hold(Date.now() + 60_000);
    d.requeueInFlight({ front: true });
    assert.deepEqual(d.queue.map((i) => i.content), ["first", "later"], "refused item keeps its place");
    d.dispatch("third", "edva", { priority: "high" });
    assert.equal(s.sent.length, 1, "nothing sent while held");
    assert.ok(d.snapshot().rateLimitHoldUntil);
    d.releaseHold();
    assert.deepEqual(s.sent, ["first", "first"]);
    assert.equal(d.snapshot().rateLimitHoldUntil, null);
  });
});

// ─── watchdog.sh: a holding chat is quiet, not stale ────────────────────
// Runs watchdog.sh's own chat-staleness block (cut out of the script between
// its two comment headers) under bash with curl and log stubbed, so the test
// exercises the shipped lines, not a copy of them.

const WATCHDOG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "watchdog.sh");

function runChatStaleBlock(health) {
  const src = fs.readFileSync(WATCHDOG, "utf8");
  const start = src.indexOf("    # Chat event staleness");
  const end = src.indexOf("    # Chat queue-depth early-alert", start);
  assert.ok(start !== -1 && end > start, "chat staleness block not found in watchdog.sh");
  const script = [
    'log() { echo "LOG $*"; }',
    'curl() { CALLS="$CALLS CURL $*"; }',   // the script sends curl's output to /dev/null
    "STALE_EVENT_MS=600000; CHAT_HEALTH_PORT=9094; ISSUES=''",
    `CHAT_HEALTH=${JSON.stringify(JSON.stringify(health))}`,
    src.slice(start, end),
    'echo "CALLS=$CALLS"; echo "ISSUES=$ISSUES"',
  ].join("\n");
  return execSync("bash", { input: script, encoding: "utf8", env: { PATH: process.env.PATH } });
}

describe("chat quota: watchdog leaves a holding chat alone", () => {
  const stale = { lastEventAgeMs: 900_000, queueDepth: 2 };

  it("does not restart chat while it is holding for the usage limit", () => {
    const out = runChatStaleBlock({ ...stale, rateLimitHoldUntil: "2026-10-01T03:01:00.000Z" });
    assert.ok(!out.includes("CURL"), out);
    assert.ok(out.includes("holding for the Claude usage limit until 2026-10-01T03:01:00.000Z"), out);
    assert.ok(out.includes("ISSUES=\n") || out.trim().endsWith("ISSUES="), out);
  });

  it("still restarts a stale chat that is not holding (field null or absent)", () => {
    for (const h of [{ ...stale, rateLimitHoldUntil: null }, stale]) {
      const out = runChatStaleBlock(h);
      assert.ok(out.includes("CURL -sf -X POST http://127.0.0.1:9094/restart"), out);
      assert.ok(out.includes("chat-supervisor(stale)"), out);
    }
  });

  it("does nothing when the queue is empty, held or not", () => {
    const out = runChatStaleBlock({ lastEventAgeMs: 900_000, queueDepth: 0, rateLimitHoldUntil: "2026-10-01T03:01:00.000Z" });
    assert.ok(!out.includes("CURL") && !out.includes("LOG"), out);
  });
});

// ─── Part 2: the real chat supervisor ───────────────────────────────────

function canChildListen() {
  try {
    execSync(`/opt/homebrew/bin/node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{s.close();process.exit(0)})"`, { timeout: 3000, stdio: "pipe" });
    return true;
  } catch { return false; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_SUPERVISOR = path.join(__dirname, "..", "supervisor", "chat-supervisor.mjs");
const NODE = "/opt/homebrew/bin/node";
let nextPort = 28000 + Math.floor(Math.random() * 1000) * 3;

// Refuses the first `--refusals` QUOTA-TEST messages in the observed shape
// (rate_limit_event on this process's first refusal only, then the synthetic
// message and an is_error result); answers everything else through the reply
// tool. The count is kept in the record file, so a restart (a new fake) does
// not reset it. `--delay` is how long a turn takes.
const QUOTA_CLAUDE = `
import readline from "node:readline";
import fs from "node:fs";
const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : d; };
const mode = val("--mode", "reset"), refusals = Number(val("--refusals", "1")), record = val("--record", null), delay = Number(val("--delay", "30"));
const sid = val("--session-id", null) || val("--resume", null) || "quota-mock";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let refused = 0, init = false;
// Exits when stdin closes, as the real CLI does: ClaudeSession.stop() ends
// stdin first, and a fake that ignored it outlived its test (one orphan per
// run, stopped mid-restart by afterEach).
readline.createInterface({ input: process.stdin }).on("close", () => process.exit(0)).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type !== "user" || !m.message?.content) return;
  const content = typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content);
  if (!init) { init = true; emit({ type: "system", subtype: "init", session_id: sid, cwd: process.cwd(), tools: [], mcp_servers: [], model: "mock" }); }
  // PHANTOM-TEST: the first process never answers (the test restarts it
  // mid-turn); the resumed one sends the handshake's zero-work result, then an
  // answer written without the reply tool.
  if (content.includes("PHANTOM-TEST")) {
    if (!args.includes("--resume")) return;
    setTimeout(() => emit({ type: "result", subtype: "success", is_error: false, duration_ms: 3, num_turns: 0, result: "", session_id: sid, total_cost_usd: 0, modelUsage: {} }), 100);
    setTimeout(() => {
      emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "It is in the hallway closet." }] }, session_id: sid });
      emit({ type: "result", subtype: "success", is_error: false, duration_ms: 900, num_turns: 2, terminal_reason: "completed", result: "It is in the hallway closet.", session_id: sid, total_cost_usd: 0.5, modelUsage: {} });
    }, 700);
    return;
  }
  const ours = content.includes("QUOTA-TEST");
  if (record && ours) fs.appendFileSync(record, JSON.stringify(content) + "\\n");
  const nth = ours ? fs.readFileSync(record, "utf8").split("\\n").filter(Boolean).length : 0;
  setTimeout(() => {
    if (ours && nth <= refusals) {
      if (refused++ === 0) {
        const info = { status: "rejected", rateLimitType: "seven_day", overageStatus: "rejected", isUsingOverage: false };
        if (mode === "reset") info.resetsAt = Math.floor(Date.now() / 1000) + 7200;
        emit({ type: "rate_limit_event", rate_limit_info: info, session_id: sid });
      }
      const text = ${JSON.stringify(OBSERVED)};
      emit({ type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] }, error: "rate_limit", is_api_error_message: true, session_id: sid });
      emit({ type: "result", subtype: "success", is_error: true, duration_ms: 577, num_turns: 1, terminal_reason: "api_error", api_error_status: 429, result: text, session_id: sid, total_cost_usd: 1.4686, modelUsage: {} });
    } else {
      const block = ours ? { type: "tool_use", id: "tu" + Date.now(), name: "mcp__phone-channel__reply", input: { message: "ok" } } : { type: "text", text: "standing by" };
      emit({ type: "assistant", message: { role: "assistant", content: [block] }, session_id: sid });
      emit({ type: "result", subtype: "success", is_error: false, duration_ms: 4000, num_turns: 2, terminal_reason: "completed", result: "ok", session_id: sid, total_cost_usd: 1.5, modelUsage: {} });
    }
  }, delay);
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 60000);
`;

function httpJson(method, port, p, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : undefined;
    const req = http.request(`http://127.0.0.1:${port}${p}`, {
      method, headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {},
    }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function waitFor(fn, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { if (await fn()) return true; } catch {} await sleep(150); }
  return false;
}

describe("chat quota: supervisor end to end", { skip: !canChildListen() && "child process cannot bind ports (sandbox)" }, () => {
  let proc = null, tmp = null;

  afterEach(async () => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.on("exit", r));
    }
    proc = null;
    await sleep(250);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  // The throwaway installation: one per test, shared by every supervisor
  // process the test starts in it.
  function sandbox() {
    tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "chat-quota-"));
    const root = path.join(tmp, "Dev/edva/tools");
    for (const d of ["bin", "data", "agent/chat-agent", "agent/logs"]) fs.mkdirSync(path.join(root, d), { recursive: true });
    const sends = path.join(tmp, "sends.log");
    fs.writeFileSync(path.join(root, "bin/edva-send-curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${sends}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, "data/user-timezone.json"), JSON.stringify({ timezone: "Africa/Nairobi" }));
    const mock = path.join(tmp, "quota-claude.mjs");
    fs.writeFileSync(mock, QUOTA_CLAUDE);
    const stateDir = path.join(tmp, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    return { mock, record: path.join(tmp, "record.log"), stateDir };
  }

  async function boot(claudeArgs, env = {}) {
    return start(sandbox(), claudeArgs, env);
  }

  async function start(box, claudeArgs, env = {}) {
    const { mock, record, stateDir } = box;
    const port = nextPort; nextPort += 3;
    const cfg = path.join(tmp, `agents-${port}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ agents: { "test-chat": {
      model: "mock", cwd: "agent/chat-agent", runtime: "supervisor", devChannels: [], permissionMode: "bypassPermissions",
      allowedTools: ["Bash"], remoteControlPrefix: "test-chat", supervisor: { healthPort: port },
    } } }));
    const childEnv = { ...process.env, HOME: tmp, SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_URL: "http://127.0.0.1:9", CHAT_SUBSTRATE: "loop", MEMORY_INDEX_DB: path.join(stateDir, "event-index.db"),
      // These cases pin the hold to the named reset; the hourly re-check cap
      // (RATE_LIMIT_REPROBE_MS) is exercised in supervisor-quota-hold.test.mjs.
      DISPATCHER_RATE_LIMIT_REPROBE_MS: String(4 * 3_600_000), ...env };
    // Never the caller's installation, even when a test passes one in.
    delete childEnv.EDVA_HOME;
    proc = spawn(NODE, [CHAT_SUPERVISOR, "--agent", "test-chat", "--config", cfg, "--state-dir", stateDir, "--no-resume",
      "--claude-bin", JSON.stringify([NODE, mock, "--record", record, ...claudeArgs])], {
      cwd: stateDir, stdio: ["pipe", "pipe", "pipe"], env: childEnv,
    });
    const stderr = [];
    proc.stderr.on("data", (b) => stderr.push(b.toString()));
    proc.stdout.on("data", () => {});
    assert.ok(await waitFor(() => stderr.join("").includes("HTTP on :"), 12000), `chat supervisor didn't start: ${stderr.join("").slice(-2000)}`);
    const log = () => stderr.join("");
    const sent = () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    // The supervisor logs each notice as "quota notice to <user>: <text>".
    const NOTICE = /quota notice to [^:]+: (.*)$/;
    const notices = () => log().split("\n").map((l) => l.match(NOTICE)).filter(Boolean).map((m) => m[1]);
    const dispatch = (content, msgId, source = "edva", priority = "high") => httpJson("POST", port, "/dispatch", { content, source, priority, msgId });
    return { port, log, sent, notices, dispatch, box };
  }

  // Old code: the raw string went to the user as their answer and the turn was done.
  const assertNoRawRelay = (log) => {
    assert.ok(!log.includes("orphaned text lost: You've hit"), "the CLI's error string must never be posted as the reply");
    assert.ok(!log.includes("SAFETY NET: orphaned assistant text"), "the safety net must not fire on a refused turn");
  };

  it("holds a refused message for the reset, tells the user once in their time zone, and survives a restart without re-sending", async () => {
    const { port, log, sent, notices, dispatch } = await boot(["--mode", "reset"]);
    await dispatch("QUOTA-TEST pick up groceries on the way home", "m1");
    assert.ok(await waitFor(async () => (await httpJson("GET", port, "/health")).rateLimitHoldUntil), `never held: ${log().slice(-2000)}`);
    let h = await httpJson("GET", port, "/health");
    assertNoRawRelay(log());
    assert.ok(log().includes('RATE LIMIT: {"status":"rejected"'), "logs the RATE LIMIT line index.mjs writes");
    assert.ok(log().includes("QUOTA REFUSED: edva ("), "logs the refusal");
    assert.ok(log().includes("put back at the front of the queue"));
    assert.equal(h.inFlight, null);
    assert.ok(h.queueDepth >= 1, "the refused message is queued again");
    const resetMs = Date.parse(h.rateLimitHoldUntil) - 60_000;
    assert.deepEqual(notices(), [`I've hit this week's Claude limit, so I can't answer right now. It resets ${resetLabel(resetMs, "Africa/Nairobi")} your time, and I'll pick your message up then.`]);

    await dispatch("QUOTA-TEST and a second thought", "m2");
    await sleep(400);
    assert.equal(sent().length, 1, "nothing else reaches the CLI while held");
    assert.equal(notices().length, 1, "one line per outage");

    await httpJson("POST", port, "/restart");
    assert.ok(await waitFor(async () => (await httpJson("GET", port, "/health")).restartCount >= 1));
    await sleep(3500); // restart backoff + respawn + the init timer
    h = await httpJson("GET", port, "/health");
    assert.equal(sent().length, 1, "no turn sent after the restart");
    assert.ok(h.rateLimitHoldUntil, "hold carried onto the new dispatcher");
    assert.equal(notices().length, 1);
  });

  it("with no reset time it retries once after the hold, answers, and marks the header", async () => {
    const { port, log, sent, notices, dispatch } = await boot(["--mode", "noreset", "--refusals", "1"], { DISPATCHER_RATE_LIMIT_FALLBACK_HOLD_MS: "1500" });
    await dispatch("QUOTA-TEST pick up groceries on the way home", "m1");
    assert.ok(await waitFor(() => log().includes("quota cleared"), 12000), `never recovered: ${log().slice(-2000)}`);
    assertNoRawRelay(log());
    const s = sent();
    assert.equal(s.length, 2, "refused once, then answered once");
    assert.ok(s[1].startsWith("[supervisor] This message waited for a Claude usage limit"), "the retry says it is late");
    assert.deepEqual(notices(), ["I've hit this week's Claude limit, so I can't answer right now. I'll try again in about a minute and pick your message up then."]);
    assert.equal((await httpJson("GET", port, "/health")).rateLimitHoldUntil, null);
  });

  it("a message refused again on its one retry is set aside, not looped, and the user is told", async () => {
    const { port, log, sent, notices, dispatch } = await boot(["--mode", "noreset", "--refusals", "5"], { DISPATCHER_RATE_LIMIT_FALLBACK_HOLD_MS: "1000" });
    await dispatch("QUOTA-TEST pick up groceries on the way home", "m1");
    assert.ok(await waitFor(() => notices().length >= 2, 12000), `no closing line: ${log().slice(-2000)}`);
    assertNoRawRelay(log());
    assert.ok(log().includes("refused again on its one retry, so it is dropped"));
    assert.ok(notices()[1].startsWith("Sorry, I tried your message again"));
    await sleep(1500);
    assert.equal(sent().length, 2, "tried twice, never a third time");
    assert.equal((await httpJson("GET", port, "/health")).queueDepth <= 1, true, "only a held init may remain");
  });

  it("sets aside a second message refused in the same outage without a second set-aside line", async () => {
    const { log, sent, notices, dispatch } = await boot(["--mode", "noreset", "--refusals", "9"], { DISPATCHER_RATE_LIMIT_FALLBACK_HOLD_MS: "800" });
    await dispatch("QUOTA-TEST pick up groceries on the way home", "m1");
    assert.ok(await waitFor(() => notices().length >= 2, 12000), `no set-aside line: ${log().slice(-2000)}`);
    await dispatch("QUOTA-TEST and call the plumber", "m2");
    const drops = () => log().split("\n").filter((l) => l.includes("refused again on its one retry, so it is dropped")).length;
    assert.ok(await waitFor(() => drops() >= 2, 15000), `second message never set aside: ${log().slice(-2500)}`);
    await sleep(300);
    assertNoRawRelay(log());
    assert.equal(notices().length, 2, `one hold line and one set-aside line: ${notices().join(" | ")}`);
    assert.ok(notices()[1].startsWith("Sorry, I tried your message again"));
    assert.ok(log().includes("set-aside notice already sent this outage"));
    assert.equal(sent().length, 4, "each message tried twice, never a third time");
  });

  it("a new supervisor process started mid-outage keeps the hold and sends no second line", async () => {
    const first = await boot(["--mode", "reset"]);
    await first.dispatch("QUOTA-TEST pick up groceries on the way home", "m1");
    assert.ok(await waitFor(async () => (await httpJson("GET", first.port, "/health")).rateLimitHoldUntil), `never held: ${first.log().slice(-2000)}`);
    const { rateLimitHoldUntil } = await httpJson("GET", first.port, "/health");
    assert.equal(first.notices().length, 1);
    proc.kill("SIGTERM");
    await new Promise((r) => proc.on("exit", r));

    const second = await start(first.box, ["--mode", "reset"]);
    assert.ok(second.log().includes("quota outage restored from session.json"), second.log().slice(-1500));
    assert.equal((await httpJson("GET", second.port, "/health")).rateLimitHoldUntil, rateLimitHoldUntil, "the same hold, carried across processes");
    await second.dispatch("QUOTA-TEST and a second thought", "m2");
    await sleep(3500); // past the new process's init timer
    assert.deepEqual(second.notices(), [], "the new process does not announce the outage again");
    assert.equal(second.sent().length, 1, "nothing reaches the CLI while held");
  });

  it("never posts to a real chat, even when the caller's environment names an installation with a key", async () => {
    // A caller that exports EDVA_HOME (a scratch copy of the repo, say)
    // would otherwise make the child read that installation's .env and
    // post the test's notices for real. A decoy installation with a key and a
    // local stand-in for the Supabase endpoint show whether anything goes out.
    const posts = [];
    const sink = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => { posts.push({ url: req.url, body: b }); res.writeHead(201, { "content-type": "application/json" }); res.end("[]"); });
    });
    await new Promise((r) => sink.listen(0, "127.0.0.1", r));
    const decoy = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "chat-quota-decoy-"));
    try {
      for (const d of ["data", "agent/chat-agent", "agent/logs"]) fs.mkdirSync(path.join(decoy, "tools", d), { recursive: true });
      fs.writeFileSync(path.join(decoy, ".env"), "SUPABASE_SERVICE_ROLE_KEY=decoy-key\n");
      const { log, notices, dispatch } = await boot(["--mode", "reset"], { EDVA_HOME: decoy, SUPABASE_URL: `http://127.0.0.1:${sink.address().port}` });
      await dispatch("QUOTA-TEST pick up groceries on the way home", "m1");
      assert.ok(await waitFor(() => notices().length === 1, 8000), `no notice: ${log().slice(-2000)}`);
      await sleep(500);
      assert.deepEqual(posts, [], "nothing was posted");
      assert.ok(log().includes("SUPABASE_SERVICE_ROLE_KEY not available"), "the notice had no key to post with");
    } finally {
      sink.closeAllConnections?.();
      await new Promise((r) => sink.close(r));
      fs.rmSync(decoy, { recursive: true, force: true });
    }
  });

  it("never posts from inside a test run, even handed a live-shaped key and a reachable endpoint", async () => {
    // The guard on its own, with the sandbox's own seals taken away: node
    // --test's NODE_TEST_CONTEXT reaches the supervisor, so its safety net holds
    // no key (see "Test runs" in lib/load-env.js) and the notice goes
    // nowhere, though a key shaped like the live one sits in its environment.
    const posts = [];
    const sink = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => { posts.push({ url: req.url, body: b }); res.writeHead(201, { "content-type": "application/json" }); res.end("[]"); });
    });
    await new Promise((r) => sink.listen(0, "127.0.0.1", r));
    const liveShaped = [{ alg: "HS256", typ: "JWT" }, { iss: "supabase", ref: "example", role: "service_role" }]
      .map((o) => Buffer.from(JSON.stringify(o)).toString("base64url")).join(".") + ".not-a-signature";
    try {
      const { log, notices, dispatch } = await boot(["--mode", "reset"], { SUPABASE_SERVICE_ROLE_KEY: liveShaped, SUPABASE_URL: `http://127.0.0.1:${sink.address().port}` });
      await dispatch("QUOTA-TEST pick up groceries on the way home", "m1");
      assert.ok(await waitFor(() => notices().length === 1, 8000), `no notice: ${log().slice(-2000)}`);
      await sleep(500);
      assert.deepEqual(posts, [], "a test-run supervisor posted with the key it was handed");
      assert.ok(log().includes("SUPABASE_SERVICE_ROLE_KEY not available (withheld in a test run)"), "the safety net did not say why it held back");
    } finally {
      sink.closeAllConnections?.();
      await new Promise((r) => sink.close(r));
    }
  });

  it("tells the user once when a background turn hits the limit while their message waits behind it", async () => {
    const { port, log, sent, notices, dispatch } = await boot(["--mode", "reset", "--refusals", "1", "--delay", "800"]);
    await dispatch("QUOTA-TEST background wake", "w1", "check-later", "normal");
    await sleep(150);
    await dispatch("pick up groceries on the way home", "m1");
    assert.ok(await waitFor(async () => (await httpJson("GET", port, "/health")).rateLimitHoldUntil), `never held: ${log().slice(-2000)}`);
    await sleep(400);
    assertNoRawRelay(log());
    assert.equal(sent().length, 1, "only the background turn reached the CLI");
    assert.equal(notices().length, 1, `one line: ${notices().join(" | ")}`);
    assert.ok(notices()[0].startsWith("I've hit this week's Claude limit, so I can't answer right now."), notices()[0]);
  });

  it("a hold that runs out during a restart: the retry is sent as a tracked turn, answered and cleared", async () => {
    // Draining the handed-over queue before the "dispatching" listener is
    // attached would run this retry with no currentTurn.
    const { port, log, sent, dispatch } = await boot(["--mode", "noreset", "--refusals", "1"], { DISPATCHER_RATE_LIMIT_FALLBACK_HOLD_MS: "800" });
    await dispatch("QUOTA-TEST pick up groceries on the way home", "m1");
    assert.ok(await waitFor(() => log().includes("QUOTA REFUSED: edva"), 8000), `never refused: ${log().slice(-2000)}`);
    await httpJson("POST", port, "/restart");   // 2 s backoff: the 0.8 s hold expires mid-restart
    assert.ok(await waitFor(() => log().includes("quota cleared"), 15000), `retry not tracked: ${log().slice(-2500)}`);
    assert.equal(sent().length, 2, "refused once, then answered once");
    assert.equal(log().split("\n").filter((l) => l.includes("dispatch → edva")).length, 2, "both sends are tracked turns");
    assertNoRawRelay(log());
  });

  it("a retry on a resumed session keeps its safety net through the handshake's empty result", async () => {
    // A result listener that takes the resume handshake's zero-work result as
    // the retry's end clears the tracked turn, and the answer that follows
    // (written without the reply tool) is never posted.
    const { port, log, dispatch } = await boot([]);
    await dispatch("PHANTOM-TEST Where did I leave the umbrella?", "p1");
    assert.ok(await waitFor(() => log().includes("dispatch → edva"), 8000), `never dispatched: ${log().slice(-1500)}`);
    await sleep(300);
    await httpJson("POST", port, "/restart");   // stops the turn mid-flight; it is requeued and retried on --resume
    assert.ok(await waitFor(() => log().includes("ignored resume-handshake result"), 15000), `no handshake result: ${log().slice(-2500)}`);
    assert.ok(await waitFor(() => log().includes("SAFETY NET: orphaned assistant text"), 8000), `answer not rescued: ${log().slice(-2500)}`);
  });
});
