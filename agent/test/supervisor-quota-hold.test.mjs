// supervisor-quota-hold.test.mjs — a refused quota is not finished work.
//
// When the Max allowance is used up, claude -p answers each turn in well under
// a second without doing anything: a rate_limit_event with status "rejected",
// then an ordinary-looking result. The ops dispatcher used to mark that turn
// done, recording hours of dispatches as completed that never ran, while the
// watchdog's no-op check restarted the supervisor over and over. Now the
// refused turn goes back to the head of the queue and dispatch holds until the
// window resets.
//
// Part 1 drives the Dispatcher directly. Part 2 runs the real ops supervisor
// against a fake CLI that refuses its first turn, under a throwaway HOME so
// the supervisor's alerts land in a file instead of the real system channel.
//
// Run: node --test agent/test/supervisor-quota-hold.test.mjs

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { Dispatcher, isQuotaRefusal, isSilentRefusal, rateLimitHoldUntil } from "../supervisor/dispatcher.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The four rate_limit_info shapes seen in the supervisor logs.
const REJECTED_WEEKLY = (resetsAtSec) => ({ status: "rejected", resetsAt: resetsAtSec, rateLimitType: "seven_day", overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false });
const REJECTED_NO_RESET = { status: "rejected", overageDisabledReason: "out_of_credits", isUsingOverage: false };                                 // observed, no reset time
const REJECTED_ON_OVERAGE = { status: "rejected", resetsAt: 1782961200, rateLimitType: "seven_day", overageStatus: "allowed", isUsingOverage: true, overageInUse: true };
const WARNING = { status: "allowed_warning", resetsAt: 1790823600, rateLimitType: "seven_day", utilization: 0.82, isUsingOverage: false };

// total_cost_usd is cumulative per CLI process, as in the real stream: a real
// turn raises it, a refused turn repeats it unchanged.
class MockSession extends EventEmitter {
  constructor() { super(); this.sent = []; this.sessionNotFound = false; this.total = 0; }
  send(content) { this.sent.push(content); }
  rateLimit(info) { this.emit("rate_limit", { type: "rate_limit_event", rate_limit_info: info }); }
  // A refused turn: the event, then (3ms later in the real log) the result.
  // terminal_reason is what the CLI reports (cost.ndjson).
  refuse(info) { this.rateLimit(info); this.silentRefuse(); }
  // Later refusals in the same process arrive with no event at all.
  silentRefuse() { this.emit("result", { num_turns: 1, duration_ms: 398, total_cost_usd: this.total, is_error: false, terminal_reason: "api_error", result: "You've hit your weekly limit" }); }
  complete() { this.total += 0.02; this.emit("result", { num_turns: 1, duration_ms: 4000, total_cost_usd: this.total, is_error: false, terminal_reason: "completed" }); }
  resumeFailure() { this.sessionNotFound = true; this.emit("result", { num_turns: 0, total_cost_usd: 0 }); }
}

describe("quota refusal: classification", () => {
  it("only a rejection that is not running on overage is a refusal", () => {
    assert.equal(isQuotaRefusal(REJECTED_WEEKLY(1789614000)), true);
    assert.equal(isQuotaRefusal(REJECTED_NO_RESET), true);
    assert.equal(isQuotaRefusal(REJECTED_ON_OVERAGE), false, "the turn ran on overage");
    assert.equal(isQuotaRefusal(WARNING), false);
    assert.equal(isQuotaRefusal(null), false);
  });

  it("recognises a silent refusal across CLI versions, by reason string or by flat cost", () => {
    assert.equal(isSilentRefusal({ num_turns: 1, terminal_reason: "api_error", total_cost_usd: 1.57 }, 1.57), true);   // Sept CLI
    assert.equal(isSilentRefusal({ num_turns: 1, terminal_reason: "blocking_limit", total_cost_usd: 2 }, 1), true);    // a later CLI
    assert.equal(isSilentRefusal({ num_turns: 1, terminal_reason: "completed", total_cost_usd: 1.5713 }, 1.5713), true, "June/July CLI: 'completed' but nothing billed");
    assert.equal(isSilentRefusal({ num_turns: 1, terminal_reason: "completed", total_cost_usd: 1.62 }, 1.5713), false, "billed something: a real turn");
    assert.equal(isSilentRefusal({ num_turns: 1, terminal_reason: "completed", total_cost_usd: 0 }, null), true, "fresh process, nothing billed");
    assert.equal(isSilentRefusal({ num_turns: 1, terminal_reason: "completed", total_cost_usd: 0.3 }, null), false);
    assert.equal(isSilentRefusal({ num_turns: 3, terminal_reason: "api_error", total_cost_usd: 1 }, 1), false, "got past the first call");
    assert.equal(isSilentRefusal({ num_turns: 0, terminal_reason: "completed", total_cost_usd: 0.6112 }, 0.6112), false,
      "a no-op /compact (9ms, turns=0, flat total) is not a refusal");
  });

  it("holds until the named reset plus a minute, falls back when there is none, and is capped", () => {
    const now = Date.UTC(2026, 8, 16, 19, 45);
    const reset = Math.floor(now / 1000) + 7 * 3600;
    assert.equal(rateLimitHoldUntil(REJECTED_WEEKLY(reset), now), reset * 1000 + 60_000);
    assert.equal(rateLimitHoldUntil(REJECTED_NO_RESET, now, 900_000), now + 900_000);
    assert.equal(rateLimitHoldUntil(REJECTED_WEEKLY(Math.floor(now / 1000) - 60), now, 900_000), now + 900_000, "a reset already past is no reset");
    assert.equal(rateLimitHoldUntil(REJECTED_WEEKLY(Math.floor(now / 1000) + 30 * 86400), now), now + 8 * 86_400_000);
  });
});

describe("quota refusal: dispatcher", () => {
  const live = [];
  afterEach(() => { for (const d of live.splice(0)) d.dispose(); });
  const make = (opts) => { const s = new MockSession(); const d = new Dispatcher(s, opts); live.push(d); return { s, d }; };

  it("puts a refused turn back at the head of the queue instead of completing it, and holds", () => {
    const { s, d } = make();
    const events = { complete: 0, limited: [] };
    d.on("turn_complete", () => events.complete++);
    d.on("rate_limited", (e) => events.limited.push(e));

    d.dispatch("triage email 1", "gmail:1");
    d.dispatch("location enrich", "location-enrich");
    assert.equal(s.sent.length, 1);

    const reset = Math.floor(Date.now() / 1000) + 3600;
    s.refuse(REJECTED_WEEKLY(reset));

    assert.equal(events.complete, 0, "a refused turn is not a finished turn");
    assert.equal(d.completed, 0);
    assert.equal(d.inFlight, null);
    assert.deepEqual(d.queue.map((q) => q.source), ["gmail:1", "location-enrich"], "refused item first, order kept");
    assert.equal(events.limited.length, 1);
    assert.equal(events.limited[0].until, reset * 1000 + 60_000);
    assert.equal(d.isHeld(), true);
    assert.ok(d.snapshot().holdUntil <= reset * 1000 + 60_000 && d.snapshot().holdUntil > Date.now() + 3500_000, "held up to the reset, at most the re-check interval");

    // Nothing else goes out while held — new work queues behind.
    d.dispatch("newsletter digest", "newsletter-digest");
    assert.equal(s.sent.length, 1, "no turn sent during the hold");
    assert.equal(d.queue.length, 3);
  });

  it("a limit hit mid-turn after tool calls ran is not re-run (no repeated side effects), but still holds", () => {
    const { s, d } = make();
    const events = { complete: [], limited: [] };
    d.on("turn_complete", (e) => events.complete.push(e.message.source));
    d.on("rate_limited", (e) => events.limited.push(e));
    d.dispatch("send the digest", "newsletter-digest");
    d.dispatch("later", "cron");
    s.rateLimit(REJECTED_WEEKLY(Math.floor(Date.now() / 1000) + 3600));
    s.emit("result", { num_turns: 7, duration_ms: 95_000, total_cost_usd: 0.4, is_error: true });
    assert.deepEqual(events.complete, ["newsletter-digest"], "completed as before, not requeued");
    assert.equal(events.limited.length, 1);
    assert.equal(events.limited[0].requeued, false);
    assert.deepEqual(d.queue.map((q) => q.source), ["cron"]);
    assert.equal(d.isHeld(), true, "the next job still waits for the reset");
    assert.equal(s.sent.length, 1);
  });

  it("a turn running on overage, or a mere warning, completes normally", () => {
    for (const info of [REJECTED_ON_OVERAGE, WARNING]) {
      const { s, d } = make();
      let complete = 0;
      d.on("turn_complete", () => complete++);
      d.dispatch("job", "cron");
      s.rateLimit(info);
      s.complete();
      assert.equal(complete, 1, `${info.status}/${info.isUsingOverage}`);
      assert.equal(d.isHeld(), false);
    }
  });

  it("a rejection seen with nothing in flight is not charged to the next turn", () => {
    const { s, d } = make();
    let complete = 0;
    d.on("turn_complete", () => complete++);
    s.rateLimit(REJECTED_NO_RESET);
    d.dispatch("job", "cron");
    s.complete();
    assert.equal(complete, 1);
    assert.equal(d.isHeld(), false);
  });

  it("never holds longer than the re-check interval, even when the named reset is days away", async () => {
    const { s, d } = make({ rateLimitReprobeMs: 60 });
    const limited = [];
    d.on("rate_limited", (e) => limited.push(e));
    let released = 0;
    d.on("hold_released", () => released++);
    d.dispatch("triage email 1", "gmail:1");
    const reset = Math.floor(Date.now() / 1000) + 2 * 86400;
    s.refuse(REJECTED_WEEKLY(reset));
    assert.equal(limited[0].until, reset * 1000 + 60_000, "the event still names the real reset (the alert text reads it)");
    assert.ok(d.holdUntil <= Date.now() + 60, "the hold itself is capped");
    await sleep(120);
    assert.equal(released, 1, "the capped hold ran out and released on its own");
    assert.equal(s.sent.length, 2, "the refused item was re-sent as the probe");
    // Still shut: a silent refusal (no event) re-holds against the remembered
    // reset, capped again, and the item keeps its place.
    s.silentRefuse();
    assert.equal(limited.length, 2);
    assert.equal(limited[1].until, reset * 1000 + 60_000, "a silent refusal re-holds against the remembered reset, not the short fallback");
    assert.equal(d.isHeld(), true);
    assert.deepEqual(d.queue.map((q) => q.source), ["gmail:1"]);
    await sleep(120);
    assert.equal(s.sent.length, 3, "re-checked again after the next interval");
    // The window came back early: the probe is served and dispatch resumes.
    s.complete();
    assert.equal(d.isHeld(), false);
    assert.equal(d.completed, 1);
  });

  it("resumes on its own when the hold runs out, refused item first", async () => {
    const { s, d } = make({ rateLimitFallbackHoldMs: 80 });
    let released = 0, complete = [];
    d.on("hold_released", () => released++);
    d.on("turn_complete", (e) => complete.push(e.message.source));
    d.dispatch("a", "job-a");
    d.dispatch("b", "job-b");
    s.refuse(REJECTED_NO_RESET);
    assert.equal(s.sent.length, 1);
    await sleep(150);
    assert.equal(released, 1);
    assert.equal(d.isHeld(), false);
    assert.equal(s.sent.length, 2, "re-sent after the hold");
    assert.equal(s.sent[1], "a", "the refused job runs first");
    s.complete(); s.complete();
    assert.deepEqual(complete, ["job-a", "job-b"]);
  });

  it("after a hold, a silent refusal (no event, same CLI process) re-holds instead of counting as done", async () => {
    const { s, d } = make({ rateLimitFallbackHoldMs: 60 });
    const complete = [];
    let limited = 0;
    d.on("turn_complete", (e) => complete.push(e.message.source));
    d.on("rate_limited", () => limited++);
    d.dispatch("a", "job-a");
    d.dispatch("b", "job-b");
    s.refuse(REJECTED_NO_RESET);
    await sleep(100);
    assert.equal(s.sent.length, 2, "probe sent after the fallback");
    s.silentRefuse();
    assert.deepEqual(complete, [], "a silent refusal right after a hold is not a finished turn");
    assert.equal(limited, 2);
    assert.equal(d.isHeld(), true);
    assert.deepEqual(d.queue.map((q) => q.source), ["job-a", "job-b"]);
    await sleep(100);
    assert.equal(s.sent.length, 3);
    s.complete();
    assert.deepEqual(complete, ["job-a"]);
    assert.equal(s.sent.length, 4, "a real completion ends the probe and the queue drains");
    s.complete();
    assert.deepEqual(complete, ["job-a", "job-b"]);
  });

  it("an older CLI's silent refusal ('completed', nothing billed) still re-holds after a hold", async () => {
    const { s, d } = make({ rateLimitFallbackHoldMs: 60 });
    const complete = [];
    d.on("turn_complete", (e) => complete.push(e.message.source));
    d.dispatch("a", "job-a");
    s.complete();   // a real turn earlier in this process
    d.dispatch("b", "job-b");
    s.refuse(REJECTED_NO_RESET);
    await sleep(100);
    s.emit("result", { num_turns: 1, duration_ms: 410, total_cost_usd: s.total, terminal_reason: "completed" });
    assert.deepEqual(complete, ["job-a"], "the flat-cost probe was not counted as done");
    assert.equal(d.isHeld(), true);
    assert.equal(d.queue[0].source, "job-b");
  });

  it("a context-guard /compact neither ends nor fails the probe; the next real job does", async () => {
    const { s, d } = make({ rateLimitFallbackHoldMs: 60 });
    const complete = [];
    d.on("turn_complete", (e) => complete.push(e.message?.source));
    d.dispatch("a", "job-a");
    s.complete();
    d.dispatch("b", "job-b");
    s.rateLimit(REJECTED_NO_RESET);
    s.emit("result", { num_turns: 4, total_cost_usd: s.total + 0.3, terminal_reason: "api_error" });   // hit mid-turn: completes, holds
    s.total += 0.3;
    assert.deepEqual(complete, ["job-a", "job-b"]);
    assert.equal(d.queue.length, 0, "the hold started with nothing waiting");
    await sleep(100);
    d.dispatch("/compact", "context-guard");
    s.emit("result", { num_turns: 0, duration_ms: 9, total_cost_usd: s.total, terminal_reason: "completed" });   // instant no-op compact
    assert.deepEqual(complete, ["job-a", "job-b", "context-guard"]);
    assert.equal(d.isHeld(), false, "a /compact is not read as a refusal");
    d.dispatch("c", "job-c");
    s.silentRefuse();
    assert.equal(d.isHeld(), true, "the probe was still armed for the first real job");
    assert.equal(d.queue[0].source, "job-c");
  });

  it("an api_error with no hold behind it completes exactly as before", () => {
    const { s, d } = make();
    let complete = 0;
    d.on("turn_complete", () => complete++);
    d.dispatch("a", "job-a");
    s.silentRefuse();
    assert.equal(complete, 1);
    assert.equal(d.isHeld(), false);
  });

  it("a resume-handshake result does not consume a pending refusal; the real result does", () => {
    const { s, d } = make();
    let complete = 0;
    d.on("turn_complete", () => complete++);
    d.dispatch("a", "job-a");
    s.rateLimit(REJECTED_WEEKLY(Math.floor(Date.now() / 1000) + 3600));
    s.emit("result", { num_turns: 0, total_cost_usd: 0 });   // phantom: zero work, not this turn
    assert.equal(d.inFlight?.source, "job-a");
    assert.equal(d.isHeld(), false);
    s.emit("result", { num_turns: 1, total_cost_usd: 0, terminal_reason: "api_error" });
    assert.equal(complete, 0);
    assert.equal(d.isHeld(), true);
    assert.equal(d.queue[0].source, "job-a");
  });

  it("a resume-failure requeue drops a pending refusal so it cannot follow the item", () => {
    const { s, d } = make();
    let complete = 0;
    d.on("turn_complete", () => complete++);
    d.dispatch("a", "job-a");
    s.rateLimit(REJECTED_NO_RESET);
    s.resumeFailure();
    assert.equal(d.queue[0].source, "job-a");
    s.sessionNotFound = false;
    d._drain();
    s.complete();
    assert.equal(complete, 1, "the re-run completes; the old refusal was not carried onto it");
    assert.equal(d.isHeld(), false);
  });

  it("while held, an identical job joins the one already waiting instead of stacking", () => {
    const { s, d } = make();
    d.dispatch("LOCATION ENRICH", "location-enrich");
    s.refuse(REJECTED_WEEKLY(Math.floor(Date.now() / 1000) + 3600));
    const id = d.queue[0].id;
    for (let i = 0; i < 5; i++) assert.equal(d.dispatch("LOCATION ENRICH", "location-enrich"), id);
    assert.equal(d.queue.length, 1);
    d.dispatch("LOCATION ENRICH for 10/05", "location-enrich");
    d.dispatch("LOCATION ENRICH", "other-source");
    assert.equal(d.queue.length, 3, "different text or source still queues");
  });

  it("auth recovery does not release a quota hold, and the hold does not clear an auth pause", () => {
    const { s, d } = make();
    d.dispatch("a", "job-a");
    s.refuse(REJECTED_WEEKLY(Math.floor(Date.now() / 1000) + 3600));
    d.setPaused(true);
    d.setPaused(false);
    assert.equal(s.sent.length, 1, "setPaused(false) must not drain through a quota hold");
    d.releaseHold();
    assert.equal(s.sent.length, 2);

    const b = make();
    b.d.setPaused(true);
    b.d.hold(Date.now() + 10);
    b.d.releaseHold();
    assert.equal(b.d.paused, true);
  });

  it("hold() only ever extends, and a disposed dispatcher never drains on release", async () => {
    const { s, d } = make();
    d.dispatch("a", "job-a");
    s.refuse(REJECTED_NO_RESET);
    const first = d.holdUntil;
    d.hold(first - 1000);
    assert.equal(d.holdUntil, first, "an earlier deadline does not shorten the hold");

    const old = make();
    old.d.dispatch("x", "job-x");
    old.s.refuse(REJECTED_NO_RESET);
    old.d.holdUntil = 0; // force the timer path below
    old.d.hold(Date.now() + 40);
    old.d.dispose();
    await sleep(80);
    assert.equal(old.s.sent.length, 1, "replaced dispatcher's queue copy was not drained into a dead session");
  });
});

// ─── Part 2: the real supervisor ────────────────────────────────────────

function canChildListen() {
  try {
    execSync(`/opt/homebrew/bin/node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{s.close();process.exit(0)})"`, { timeout: 3000, stdio: "pipe" });
    return true;
  } catch { return false; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPS_SUPERVISOR = path.join(__dirname, "..", "supervisor", "index.mjs");
const REPO_TOOLS = path.resolve(__dirname, "..", "..");
const NODE = "/opt/homebrew/bin/node";
let nextPort = 23000 + Math.floor(Math.random() * 400) * 10;

// Refuses its first turn (with or without a reset time), answers every later
// one normally. Records each received message so the test can count sends.
const QUOTA_CLAUDE = `
import readline from "node:readline";
import fs from "node:fs";
const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : d; };
const mode = val("--mode", "reset");
const record = val("--record", null);
const sid = val("--session-id", null) || val("--resume", null) || "quota-mock";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let n = 0, init = false;
// Exits at end of stdin, as the real CLI does once its turn is done (see
// mock-claude.mjs), so a supervisor killed by afterEach cannot orphan it.
readline.createInterface({ input: process.stdin }).on("close", () => process.exit(0)).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type !== "user" || !m.message?.content) return;
  if (!init) { init = true; emit({ type: "system", subtype: "init", session_id: sid, cwd: process.cwd(), tools: [], mcp_servers: [], model: "mock" }); }
  const content = typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content);
  if (record) fs.appendFileSync(record, JSON.stringify(content) + "\\n");
  n++;
  setTimeout(() => {
    const refused = { type: "result", subtype: "success", is_error: false, duration_ms: 398, num_turns: 1, terminal_reason: "api_error", result: "You've hit your weekly limit", session_id: sid, total_cost_usd: 0, modelUsage: {} };
    if (n === 1) {
      const info = { status: "rejected", rateLimitType: "seven_day", isUsingOverage: false };
      if (mode === "reset") info.resetsAt = Math.floor(Date.now() / 1000) + 3600;
      emit({ type: "rate_limit_event", rate_limit_info: info, session_id: sid });
      emit(refused);
    } else if (n === 2 && mode === "noreset") {
      emit(refused);   // the retry, same process, refused with no event (the observed shape)
    } else {
      emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, session_id: sid });
      emit({ type: "result", subtype: "success", is_error: false, duration_ms: 4000, num_turns: 2, terminal_reason: "completed", result: "ok", session_id: sid, total_cost_usd: 0.01, modelUsage: {} });
    }
  }, 30);
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

describe("quota refusal: ops supervisor end to end", { skip: !canChildListen() && "child process cannot bind ports (sandbox)" }, () => {
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

  // A throwaway HOME: EDVA_ROOT, the queue file, the event log and — most
  // importantly — the alert sender all resolve under it, so no alert reaches
  // the real system channel and no real state is touched. EDVA_HOME
  // outranks HOME (lib/root.cjs), so the child never inherits it.
  async function boot(mode, env = {}) {
    tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "quota-hold-"));
    const root = path.join(tmp, "Dev/edva/tools");
    const bin = path.join(root, "bin");
    for (const d of ["bin", "data", "logs", "agent/ops-agent", "agent/supervisor", "agent/logs"]) fs.mkdirSync(path.join(root, d), { recursive: true });
    // The supervisor imports lib through EDVA_ROOT; point it at the
    // code under test. Everything it writes resolves under the fake HOME.
    fs.symlinkSync(path.join(REPO_TOOLS, "lib"), path.join(root, "lib"));
    fs.copyFileSync(path.join(REPO_TOOLS, "agent/supervisor/mcp-config.json"), path.join(root, "agent/supervisor/mcp-config.json"));
    const sends = path.join(tmp, "sends.log");
    fs.writeFileSync(path.join(bin, "edva-send-curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${sends}"\n`, { mode: 0o755 });
    const mock = path.join(tmp, "quota-claude.mjs");
    fs.writeFileSync(mock, QUOTA_CLAUDE);
    const record = path.join(tmp, "record.log");
    const base = nextPort; nextPort += 10;
    const cfg = path.join(tmp, "agents.json");
    fs.writeFileSync(cfg, JSON.stringify({ agents: { "test-ops": {
      model: "mock", cwd: "agent/ops-agent", runtime: "supervisor", devChannels: [], permissionMode: "bypassPermissions",
      allowedTools: ["Bash"], remoteControlPrefix: "test-ops",
      supervisor: { gmailPubsubPort: base, webhookPort: base + 1, healthPort: base + 2 },
    } } }));
    const stateDir = path.join(tmp, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const childEnv = { ...process.env, HOME: tmp, OPS_HANDOFF_DISABLED: "1", OPS_DISPATCH_PREAMBLE_DISABLED: "1", MEMORY_INDEX_DB: path.join(stateDir, "event-index.db"), ...env };
    delete childEnv.EDVA_HOME;
    proc = spawn(NODE, [OPS_SUPERVISOR, "--agent", "test-ops", "--config", cfg, "--state-dir", stateDir, "--no-resume",
      "--claude-bin", JSON.stringify([NODE, mock, "--mode", mode, "--record", record])], {
      cwd: stateDir, stdio: ["pipe", "pipe", "pipe"], env: childEnv,
    });
    const stderr = [];
    proc.stderr.on("data", (b) => stderr.push(b.toString()));
    proc.stdout.on("data", () => {});
    const port = base + 2;
    const up = await waitFor(() => stderr.join("").includes("control on :"), 12000);
    assert.ok(up, `supervisor didn't start: ${stderr.join("").slice(-2000)}`);
    const sent = () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).length : 0);
    const alerts = () => (fs.existsSync(sends) ? fs.readFileSync(sends, "utf8").trim().split("\n").filter(Boolean) : []);
    return { port, sent, alerts, stderr, record };
  }

  it("holds after a refusal, survives a restart without re-sending, alerts once with a push", async () => {
    const { port, sent, alerts, stderr } = await boot("reset");
    await httpJson("POST", port, "/dispatch", { content: "QUOTA-TEST job one", source: "quota-test" });
    assert.ok(await waitFor(async () => (await httpJson("GET", port, "/health")).rateLimitHoldUntil), `never held: ${stderr.join("").slice(-1500)}`);
    await httpJson("POST", port, "/dispatch", { content: "QUOTA-TEST job two", source: "quota-test" });
    await sleep(400);

    let h = await httpJson("GET", port, "/health");
    assert.equal(sent(), 1, "only the refused turn reached the CLI");
    assert.equal(h.queueDepth, 2, "the refused job is queued again, ahead of the new one");
    assert.equal(h.dispatcherPaused, true);
    assert.equal(h.completed, 0);
    assert.equal(h.consecutiveNoOpTurns, 0, "a refusal is not a no-op turn");
    assert.ok(Date.parse(h.rateLimitHoldUntil) > Date.now() + 3500_000);

    // The watchdog's stale check restarts a supervisor with a queue and no
    // events. The replacement must inherit the hold, not spend a turn.
    await httpJson("POST", port, "/restart");
    assert.ok(await waitFor(async () => (await httpJson("GET", port, "/health")).restartCount >= 1));
    await sleep(2500); // restart backoff + respawn
    h = await httpJson("GET", port, "/health");
    assert.equal(sent(), 1, "no turn sent after the restart");
    assert.equal(h.queueDepth, 2);
    assert.ok(h.rateLimitHoldUntil, "hold carried onto the new dispatcher");

    await sleep(500);
    const a = alerts();
    assert.equal(a.length, 1, `exactly one alert: ${JSON.stringify(a)}`);
    assert.match(a[0], /--push/);
    assert.match(a[0], /Max weekly limit/);
    assert.doesNotMatch(a[0], /test-ops/, "no tier name, so the three tiers' alerts dedup to one");
  });

  it("with no reset time it retries, re-holds on a silent refusal, runs the refused job first, and says it's back once", async () => {
    const { port, sent, alerts, record } = await boot("noreset", { DISPATCHER_RATE_LIMIT_FALLBACK_HOLD_MS: "1500" });
    await httpJson("POST", port, "/dispatch", { content: "QUOTA-TEST first", source: "quota-test" });
    assert.ok(await waitFor(async () => (await httpJson("GET", port, "/health")).rateLimitHoldUntil));
    await httpJson("POST", port, "/dispatch", { content: "QUOTA-TEST second", source: "quota-test" });
    assert.ok(await waitFor(async () => (await httpJson("GET", port, "/health")).completed >= 2, 15000), "both jobs ran after the holds");
    assert.equal(sent(), 4, "refused with an event, refused silently, then each job once");
    const order = fs.readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l).includes("second") ? "second" : "first");
    assert.deepEqual(order, ["first", "first", "first", "second"]);
    await sleep(500);
    const a = alerts();
    assert.equal(a.filter((l) => l.includes("⚠️")).length, 1);
    assert.match(a.find((l) => l.includes("⚠️")), /no reset time/);
    assert.equal(a.filter((l) => l.includes("✅") && l.includes("allowance is back")).length, 1);
  });
});
