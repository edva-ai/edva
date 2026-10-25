// supervisor-hang-dead-letter.test.mjs — a dropped request is never silent.
//
// The failure this guards: an emailed request from the owner hung twice, the
// turn watchdog dropped it, and the only trace was a silent System-tab row. Now
// a dropped item is dead-lettered, and when it is the owner's own request they
// get one chat note and it is retried exactly once
// (agent/supervisor/dead-letter.mjs).
//
// Part 1 tests the decision helpers. Part 2 runs the real ops supervisor under
// a throwaway HOME (supervisor-quota-hold.test.mjs pattern) against a fake CLI
// that goes silent on chosen tasks. To get a hang in seconds rather than 12
// minutes, the supervisor runs from a scratch directory holding a byte-identical
// copy of index.mjs, a copy of turn-watchdog.mjs with ONLY the idle constant
// shortened, and symlinks to every other supervisor file.
//
// Run: node --test agent/test/supervisor-hang-dead-letter.test.mjs

// A made-up installation (the owner's address), the same in every checkout.
import "../../tests/synthetic-instance.mjs";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { ownRequestFor, sentSince, jobsSince, planForDrop, buildRetryItem, stuckNotice, emailAgo, OWNER_ADDRESS } from "../supervisor/dead-letter.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
// The owner's address is whatever dead-letter.mjs matches against.
const OWNER = OWNER_ADDRESS;
const SUBJECT = "Re: Garden club agenda for March 3 (revised)";
const ledgerRow = (gmailId, from, extra = {}) => ({ ts: "2026-03-04T10:05:47.736Z", message_id: `<${gmailId}@mail.gmail.com>`, from, subject: SUBJECT, action_taken: "dispatched-via-gmail-command-channel", gmail_id: gmailId, ...extra });

describe("dead letter: decisions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dead-letter-unit-"));
  const ledger = path.join(dir, "ledger.jsonl");
  fs.writeFileSync(ledger, jsonl([
    ledgerRow("aaa1", `Alex Owner <${OWNER}>`),
    ledgerRow("bbb2", "Sam Friend <friend@example.org>"),
    { ts: "2026-03-05T13:53:08Z", message_id: "<c@x>", from: OWNER, subject: "Re: x", action_taken: "dispatched", gmail_id: "ccc3" },
  ]));
  const since = Date.parse("2026-03-04T10:05:47Z");
  const writeSent = (name, rows) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof rows === "string" ? rows : jsonl(rows)); return f; };

  it("the owner's own request is a command-channel email from OWNER_ADDRESS, found in the ledger", () => {
    const own = ownRequestFor({ source: "gmail:aaa1" }, { ledgerFile: ledger });
    assert.deepEqual(own, { kind: "email", gmailId: "aaa1", rfcMessageId: "<aaa1@mail.gmail.com>", subject: SUBJECT, receivedAt: "2026-03-04T10:05:47.736Z" });
    assert.equal(ownRequestFor({ source: "gmail:bbb2" }, { ledgerFile: ledger }), null, "another allowlisted sender is not the owner");
    assert.equal(ownRequestFor({ source: "gmail:ccc3" }, { ledgerFile: ledger }), null, "not a command-channel dispatch row");
    assert.equal(ownRequestFor({ source: "gmail:zzz9" }, { ledgerFile: ledger }), null, "no row");
    assert.equal(ownRequestFor({ source: "daily-summary" }, { ledgerFile: ledger }), null);
    assert.equal(ownRequestFor({ source: "gmail:aaa1" }, { ledgerFile: path.join(dir, "missing.jsonl") }), null, "no ledger fails to null");
  });

  it("only the owner's request is retried, only once; the first note is skipped only when a reply surely went out", () => {
    const own = { kind: "email" };
    assert.deepEqual(planForDrop({}, own, { replyState: "not-replied" }), { retry: true, notice: "first" });
    assert.deepEqual(planForDrop({}, own, { replyState: "unknown" }), { retry: true, notice: "first" }, "unknown still tells the owner");
    assert.deepEqual(planForDrop({}, own, { replyState: "replied" }), { retry: true, notice: null }, "no promise of an answer that already went out");
    assert.deepEqual(planForDrop({}, null), { retry: false, notice: null });
    for (const replyState of ["replied", "not-replied", "unknown"]) assert.deepEqual(planForDrop({ hangRetry: true }, own, { replyState }), { retry: false, notice: "final" });
    assert.deepEqual(planForDrop({ hangRetry: true }, null), { retry: false, notice: null });
  });

  it("the sent-mail check answers replied / not-replied / unknown, never guessing", () => {
    const rfc = "<aaa1@mail.gmail.com>";
    const base = [
      { ts: "2026-03-04T09:53:12Z", subject: "Garden club agenda for March 3 (revised)", in_reply_to: null },
      { ts: "2026-03-04T10:50:27Z", subject: "Garden club agenda for March 3", in_reply_to: null },
    ];
    const notReplied = sentSince(since, rfc, { file: writeSent("s1.jsonl", base) });
    assert.equal(notReplied.state, "not-replied");
    assert.deepEqual(notReplied.rows.map((r) => r.subject), ["Garden club agenda for March 3"]);
    const replied = sentSince(since, rfc, { file: writeSent("s2.jsonl", [...base, { ts: "2026-03-04T10:51:00Z", subject: SUBJECT, in_reply_to: "<AAA1@mail.gmail.com>" }]) });
    assert.equal(replied.state, "replied");
    assert.equal(sentSince(since, rfc, { file: path.join(dir, "no-such.jsonl") }).state, "unknown", "log unreadable");
    assert.equal(sentSince(since, null, { file: writeSent("s3.jsonl", base) }).state, "unknown", "ledger row had no Message-ID");
    assert.equal(sentSince(since, rfc, { file: writeSent("s4.jsonl", jsonl(base) + "{not json\n") }).state, "unknown", "a line did not parse");
  });

  it("jobs started since the request: running, gone, or finished; older files are not opened", () => {
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    const put = (id, j) => fs.writeFileSync(path.join(jobsDir, `${id}.json`), JSON.stringify({ id, ...j }));
    // The second attempt launched a rebuild job seconds before its kill.
    put("20260304-104617-agenda-rebuild-0303-5c2d", { name: "agenda-rebuild-0303", status: "running", pid: process.pid, started_at: "2026-03-04T10:46:17.308Z" });
    put("20260304-101100-dead-pid-0000", { name: "dead-pid", status: "running", pid: 999999, started_at: "2026-03-04T10:11:00Z" });
    put("20260304-102100-finished-0000", { name: "finished", status: "done", pid: 1, started_at: "2026-03-04T10:21:00Z" });
    put("20260304-091100-older-0000", { name: "older", status: "running", pid: process.pid, started_at: "2026-03-04T09:11:00Z" });
    put("20260303-120000-misdated-0000", { name: "misdated", status: "running", pid: process.pid, started_at: "2026-03-04T10:31:00Z" });
    const jobs = jobsSince(since, { dir: jobsDir });
    assert.deepEqual(jobs.map((j) => [j.name, j.label]), [
      ["dead-pid", "ended (process gone; last status running)"],
      ["finished", "done"],
      ["agenda-rebuild-0303", "STILL RUNNING"],
    ], "a file dated before the request is skipped by name");
  });

  it("the retry is a fresh, flagged item whose header (agent-only) shows what was already sent and started", () => {
    const sent = sentSince(since, "<aaa1@mail.gmail.com>", { file: writeSent("s5.jsonl", [{ ts: "2026-03-04T10:51:00Z", subject: SUBJECT, in_reply_to: "<aaa1@mail.gmail.com>" }]) });
    const item = { id: "orig", source: "gmail:aaa1", content: "New email received. MessageId: aaa1", enqueuedAt: since, hangCount: 2 };
    const own = ownRequestFor(item, { ledgerFile: ledger });
    const jobs = [{ id: "20260304-104617-agenda-rebuild-0303-5c2d", name: "agenda-rebuild-0303", label: "STILL RUNNING" }];
    const r = buildRetryItem(item, { own, sent: sent.rows, replyState: sent.state, jobs, noticeQueued: true, now: since + 3_600_000 });
    assert.notEqual(r.id, "orig");
    assert.equal(r.source, "gmail:aaa1");
    assert.equal(r.hangRetry, true);
    assert.equal(r.retryOf, "orig");
    assert.equal(r.hangCount, undefined, "starts with a clean hang count");
    assert.deepEqual(r.ownRequest, own);
    assert.ok(r.content.startsWith("[supervisor] RETRY."));
    assert.ok(r.content.endsWith("--- original task ---\nNew email received. MessageId: aaa1"));
    assert.ok(r.content.includes(`Their email's subject: "${SUBJECT}".`));
    assert.ok(r.content.includes("(a reply on THIS email's thread)"));
    assert.ok(r.content.includes("Never send a second reply"));
    assert.ok(r.content.includes("20260304-104617-agenda-rebuild-0303-5c2d agenda-rebuild-0303 STILL RUNNING"));
    assert.ok(r.content.includes("do not relaunch it"));
    assert.ok(r.content.includes("was queued and may have been held back; don't refer to it"));
    assert.ok(!buildRetryItem(item, { own, replyState: "not-replied" }).content.includes("held back"), "no note mentioned when none was queued");
    assert.ok(buildRetryItem(item, { own, replyState: "not-replied" }).content.includes("No background job (job-run) was started"));
    assert.ok(buildRetryItem(item, { own, replyState: "unknown" }).content.includes("could NOT be determined"));
  });

  it("the notes to the owner name the email by when it was sent, never by subject, and the closing one stands alone", () => {
    const own = ownRequestFor({ source: "gmail:aaa1" }, { ledgerFile: ledger });
    const atDrop = Date.parse("2026-03-04T10:46:48Z"), atFinal = Date.parse("2026-03-04T10:59:00Z");
    assert.equal(stuckNotice("first", own, { replyState: "not-replied", now: atDrop }),
      "I got stuck twice on your email from about 40 minutes ago, so I've set it aside for now rather than hold everything else up. I'll take one more run at it once I've cleared what's ahead, and answer you on that thread.");
    assert.equal(stuckNotice("final", own, { replyState: "not-replied", now: atFinal }),
      "I kept getting stuck on your email from about an hour ago, three tries in all, so I've stopped rather than keep looping. Nothing has gone back on that thread yet; if you still need it, a quick reply there will start me on it fresh.");
    assert.equal(stuckNotice("final", own, { replyState: "replied", now: atFinal }),
      "I kept getting stuck on your email from about an hour ago, three tries in all, so I've stopped rather than keep looping. A reply on that thread did go out earlier; if anything is still missing, a quick reply there will start me on it fresh.");
    assert.equal(stuckNotice("final", own, { replyState: "unknown", now: atFinal }),
      "I kept getting stuck on your email from about an hour ago, three tries in all, so I've stopped rather than keep looping. If you still need it, a quick reply on that thread will start me on it fresh.", "unknown says nothing about the thread");
    for (const kind of ["first", "final"]) for (const replyState of ["replied", "not-replied", "unknown"]) {
      const t = stuckNotice(kind, own, { replyState, now: atFinal });
      assert.ok(!t.includes("Garden club agenda") && !t.includes('"'), `no subject in: ${t}`);
      for (const word of ["dispatch", "watchdog", "supervisor", "dead-letter", "retry", "—"]) assert.ok(!t.toLowerCase().includes(word), `${kind} note says "${word}": ${t}`);
    }
    assert.equal(emailAgo("2026-03-04T10:05:47Z", Date.parse("2026-03-04T10:06:30Z")), "the email you just sent me");
    assert.equal(emailAgo("2026-03-04T10:05:47Z", Date.parse("2026-03-04T13:11:00Z")), "your email from about 3 hours ago");
    assert.equal(emailAgo("2026-03-04T10:05:47Z", Date.parse("2026-03-05T11:11:00Z")), "your email from yesterday");
    assert.equal(emailAgo(null), "your last email to me");
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
const SUP_DIR = path.join(__dirname, "..", "supervisor");
const REPO_TOOLS = path.resolve(__dirname, "..", "..");
const NODE = "/opt/homebrew/bin/node";
const IDLE_LINE = "export const TURN_WATCHDOG_IDLE_MS = 12 * 60 * 1000;";
let nextPort = 25000 + Math.floor(Math.random() * 400) * 10;

// Goes silent (a hang: no event after init) on HANG-ALWAYS, and on the first
// two HANG-TWICE dispatches; answers everything else. The record file outlives
// each SIGKILLed process, so the count spans restarts.
const HANG_CLAUDE = `
import readline from "node:readline";
import fs from "node:fs";
const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : d; };
const record = val("--record", null);
const sid = val("--session-id", null) || val("--resume", null) || "hang-mock";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let init = false;
// Exits at end of stdin, as the real CLI does once its turn is done (see
// mock-claude.mjs), so a supervisor killed by afterEach cannot orphan it.
readline.createInterface({ input: process.stdin }).on("close", () => process.exit(0)).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type !== "user" || !m.message?.content) return;
  if (!init) { init = true; emit({ type: "system", subtype: "init", session_id: sid, cwd: process.cwd(), tools: [], mcp_servers: [], model: "mock" }); }
  const content = typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content);
  fs.appendFileSync(record, JSON.stringify(content) + "\\n");
  const seen = fs.readFileSync(record, "utf8").trim().split("\\n").filter((l) => l.includes("HANG-TWICE")).length;
  if (content.includes("HANG-ALWAYS") || (content.includes("HANG-TWICE") && seen <= 2)) return;
  setTimeout(() => {
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, session_id: sid });
    emit({ type: "result", subtype: "success", is_error: false, duration_ms: 900, num_turns: 3, terminal_reason: "completed", result: "ok", session_id: sid, total_cost_usd: 0.01, modelUsage: {} });
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

async function waitFor(fn, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { if (await fn()) return true; } catch {} await sleep(150); }
  return false;
}

const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);

describe("dead letter: ops supervisor end to end", { skip: !canChildListen() && "child process cannot bind ports (sandbox)" }, () => {
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

  // Everything — EDVA_ROOT, queue file, event log, dead-letter file, the
  // ledger and sent log it reads, and both send paths (_sendPush and the new
  // chat note) — resolves under the throwaway HOME. edva-send-curl is a
  // fake that only writes its arguments to a file.
  async function boot({ ledger = [] } = {}) {
    tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "hang-dl-"));
    const root = path.join(tmp, "Dev/edva/tools");
    for (const d of ["bin", "data", "logs", "agent/ops-agent", "agent/supervisor", "agent/logs"]) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.symlinkSync(path.join(REPO_TOOLS, "lib"), path.join(root, "lib"));
    const sup = path.join(root, "agent/supervisor");
    for (const f of fs.readdirSync(SUP_DIR)) {
      if (!/\.(mjs|json)$/.test(f)) continue;
      if (f === "index.mjs") fs.copyFileSync(path.join(SUP_DIR, f), path.join(sup, f));
      else if (f === "turn-watchdog.mjs") {
        const src = fs.readFileSync(path.join(SUP_DIR, f), "utf8");
        assert.equal(src.split(IDLE_LINE).length, 2, "turn-watchdog.mjs idle constant moved — update this test's patch");
        fs.writeFileSync(path.join(sup, f), src.replace(IDLE_LINE, "export const TURN_WATCHDOG_IDLE_MS = 1500;"));
      } else fs.symlinkSync(path.join(SUP_DIR, f), path.join(sup, f));
    }
    const data = path.join(root, "data");
    fs.writeFileSync(path.join(data, "email-inbound-handled.jsonl"), ledger.length ? jsonl(ledger) : "");
    const sends = path.join(tmp, "sends.log");
    fs.writeFileSync(path.join(root, "bin/edva-send-curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${sends}"\n`, { mode: 0o755 });
    const mock = path.join(tmp, "hang-claude.mjs");
    fs.writeFileSync(mock, HANG_CLAUDE);
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
    const env = { ...process.env, HOME: tmp, OPS_HANDOFF_DISABLED: "1", OPS_DISPATCH_PREAMBLE_DISABLED: "1", MEMORY_INDEX_DB: path.join(stateDir, "event-index.db") };
    delete env.EMAIL_INBOUND_HANDLED_FILE;
    delete env.EDVA_HOME;   // outranks HOME (lib/root.cjs): the child's installation is the sandbox
    proc = spawn(NODE, [path.join(sup, "index.mjs"), "--agent", "test-ops", "--config", cfg, "--state-dir", stateDir, "--no-resume",
      "--claude-bin", JSON.stringify([NODE, mock, "--record", record])], { cwd: stateDir, stdio: ["pipe", "pipe", "pipe"], env });
    const stderr = [];
    proc.stderr.on("data", (b) => stderr.push(b.toString()));
    proc.stdout.on("data", () => {});
    const port = base + 2;
    assert.ok(await waitFor(() => stderr.join("").includes("control on :"), 12000), `supervisor didn't start: ${stderr.join("").slice(-2000)}`);
    const records = () => readLines(record).map((l) => JSON.parse(l));
    const deadLetters = () => readLines(path.join(data, "dead-letter.jsonl")).map((l) => JSON.parse(l));
    const allSends = () => readLines(sends);
    const notices = () => allSends().filter((l) => !l.includes("--channel system"));
    const events = (kind) => readLines(path.join(root, "agent/logs/supervisor-test-ops/events.ndjson")).map((l) => JSON.parse(l)).filter((e) => e.kind === kind);
    return { port, data, records, deadLetters, allSends, notices, events, stderr };
  }

  it("the owner's email that hangs twice: one dead-letter row, one chat note, one retry that runs and finishes, nothing more", async () => {
    const sb = await boot({ ledger: [ledgerRow("fake-msg-a01", `Alex Owner <${OWNER}>`, { ts: new Date().toISOString() })] });
    await httpJson("POST", sb.port, "/dispatch", { content: "New email received. MessageId: fake-msg-a01 HANG-TWICE", source: "gmail:fake-msg-a01" });
    // What the killed attempt managed to send before it hung.
    fs.writeFileSync(path.join(sb.data, "edva-sent-mail.jsonl"), jsonl([{ ts: new Date().toISOString(), subject: "Garden club agenda for March 3", in_reply_to: null }]));
    fs.mkdirSync(path.join(sb.data, "jobs"));
    const jobId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")}-agenda-rebuild-0303-5c2d`;
    fs.writeFileSync(path.join(sb.data, "jobs", `${jobId}.json`), JSON.stringify({ id: jobId, name: "agenda-rebuild-0303", status: "running", pid: process.pid, started_at: new Date().toISOString() }));
    assert.ok(await waitFor(async () => (await httpJson("GET", sb.port, "/health")).completed >= 1, 40000), `retry never finished: ${sb.stderr.join("").slice(-2500)}`);
    await sleep(1500);

    const recs = sb.records();
    assert.equal(recs.length, 3, "two hung attempts and one retry, no fourth");
    assert.ok(!recs[0].includes("RETRY") && !recs[1].includes("RETRY"));
    assert.ok(recs[2].startsWith("[supervisor] RETRY."), recs[2].slice(0, 200));
    assert.ok(recs[2].includes('"Garden club agenda for March 3"'), "the retry sees what was already sent");
    assert.ok(recs[2].includes("agenda-rebuild-0303 STILL RUNNING") && recs[2].includes("do not relaunch it"), "and the job still running");
    assert.ok(recs[2].includes(`Their email's subject: "${SUBJECT}".`), "the subject reaches the agent only");
    assert.ok(recs[2].includes("may have been held back; don't refer to it"));
    assert.ok(recs[2].endsWith("New email received. MessageId: fake-msg-a01 HANG-TWICE"));

    const dl = sb.deadLetters();
    assert.equal(dl.length, 1);
    assert.equal(dl[0].action, "retry-queued");
    assert.equal(dl[0].hangCount, 2);
    assert.equal(dl[0].ownRequest.gmailId, "fake-msg-a01");
    assert.equal(dl[0].replyState, "not-replied");
    assert.ok(dl[0].item.content.includes("HANG-TWICE"));

    const n = sb.notices();
    assert.equal(n.length, 1, `exactly one note to the owner: ${JSON.stringify(sb.allSends())}`);
    assert.ok(n[0].includes("--intent stuck-request") && n[0].includes("--evidence-as-of live"));
    assert.ok(!n[0].includes("--skip-precheck") && !n[0].includes("--channel"), "the normal gated chat path");
    assert.ok(n[0].includes("I got stuck twice on the email you just sent me"), n[0]);
    assert.ok(!sb.allSends().some((l) => l.includes("Garden club agenda")), "no subject in any outbound line");
    assert.ok(sb.allSends().some((l) => l.includes("--channel system") && l.includes("dropping it and restarting")), "the drop alert still clusters");

    const hangs = sb.events("turn_watchdog.hang");
    assert.deepEqual(hangs.map((h) => [h.hangCount, h.dropped, h.hangRetry]), [[1, false, false], [2, true, false]]);
    const retryRuns = sb.events("dispatcher.dispatching").filter((e) => e.item?.hangRetry);
    assert.ok(retryRuns.length >= 1 && retryRuns.every((e) => e.item.retryOf === dl[0].itemId), "the retry is identifiable in the event log");
    assert.equal(sb.events("turn_watchdog.recovered").length, 1, "the retry's success gets its ✅");
    const h = await httpJson("GET", sb.port, "/health");
    assert.equal(h.queueDepth, 0);
    assert.equal(h.inFlight, null);
  });

  it("a reply already went out, then its one retry hangs too: dropped for good, and only a closing note that stands alone", async () => {
    const sb = await boot({ ledger: [ledgerRow("abc", OWNER, { ts: new Date().toISOString() })] });
    await httpJson("POST", sb.port, "/dispatch", { content: "New email received. MessageId: abc HANG-ALWAYS", source: "gmail:abc" });
    // The first attempt got its threaded reply out before it hung.
    fs.writeFileSync(path.join(sb.data, "edva-sent-mail.jsonl"), jsonl([{ ts: new Date().toISOString(), subject: `Re: ${SUBJECT}`, in_reply_to: "<abc@mail.gmail.com>" }]));
    assert.ok(await waitFor(() => sb.deadLetters().length >= 2, 45000), `second drop never came: ${sb.stderr.join("").slice(-2500)}`);
    const h = await httpJson("GET", sb.port, "/health");
    assert.equal(h.queueDepth, 0, "nothing left to run");
    assert.equal(h.inFlight, null);
    await sleep(1500);

    const recs = sb.records();
    assert.equal(recs.length, 3, "two attempts plus the one retry");
    assert.ok(recs[2].includes("(a reply on THIS email's thread)") && !recs[2].includes("held back"), "no note was queued, so the header claims none");
    const dl = sb.deadLetters();
    assert.deepEqual(dl.map((r) => [r.action, r.hangRetry, r.replyState]), [["retry-queued", false, "replied"], ["dropped", true, "replied"]]);
    assert.equal(dl[1].retryOf, dl[0].itemId);
    assert.equal(dl[1].itemId, dl[0].retryItemId);
    const hangs = sb.events("turn_watchdog.hang");
    assert.deepEqual(hangs.map((x) => [x.hangCount, x.dropped, x.hangRetry]), [[1, false, false], [2, true, false], [1, true, true]]);
    const n = sb.notices();
    assert.equal(n.length, 1, `the first note was skipped (a reply had gone out), only the closing one: ${JSON.stringify(sb.allSends())}`);
    assert.ok(n[0].includes("I kept getting stuck on the email you just sent me, three tries in all"), n[0]);
    assert.ok(n[0].includes("A reply on that thread did go out earlier") && !n[0].includes("Nothing has gone back"));
    // system-issue-review's generic-turn-hangs cluster matches "dropping it and restarting".
    assert.ok(sb.allSends().some((l) => l.includes("--channel system") && l.includes("on its one retry") && l.includes("dropping it and restarting")));
  });

  it("mail to Edva from anyone else is dead-lettered only: no note, no retry", async () => {
    const sb = await boot({ ledger: [ledgerRow("other1", "Sam Friend <friend@example.org>")] });
    await httpJson("POST", sb.port, "/dispatch", { content: "New email received. MessageId: other1 HANG-TWICE", source: "gmail:other1" });
    assert.ok(await waitFor(() => sb.deadLetters().length >= 1, 30000), `never dropped: ${sb.stderr.join("").slice(-2500)}`);
    const h = await httpJson("GET", sb.port, "/health");
    assert.equal(h.queueDepth, 0);
    assert.equal(h.inFlight, null);
    await sleep(1500);
    assert.equal(sb.records().length, 2);
    const dl = sb.deadLetters();
    assert.equal(dl.length, 1);
    assert.equal(dl[0].action, "dropped");
    assert.equal(dl[0].ownRequest, null);
    assert.equal(sb.notices().length, 0);
  });
});
