// watchdog-phone-channel-orphan.test.mjs — pins the orphan reaping in the
// duplicate-phone-channel probe of agent/scripts/watchdog.sh.
//
// History: when the turn watchdog SIGKILLs a hung chat `claude -p`, its
// phone-channel MCP child is re-parented to launchd (ppid 1) and lingers as a
// second Supabase subscriber — long enough that chat is effectively down
// beside the replacement session, while the probe paged the operator to "kill
// the non-supervisor one" by hand. The probe now SIGTERMs (then SIGKILLs) a ppid-1
// phone-channel itself — but ONLY when a live-parented one is positively seen —
// and pages only about duplicates that are still live-parented.
//
// The probe block is extracted from watchdog.sh and run in real bash with
// `ps`, `pgrep` and `kill` replaced by shell functions (functions shadow both
// builtins and PATH binaries), so nothing is ever signalled: every kill is
// RECORDED, never sent. notify/log/incident_should_alert/incident_clear are
// recorders too; incident_seen is the real one, against a scratch dir.
//
// Run: node --test tests/watchdog-phone-channel-orphan.test.mjs
// Against a proposed copy:
//   WATCHDOG_SH=/tmp/pc/watchdog.sh node --test tests/watchdog-phone-channel-orphan.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { REPO_ROOT } from "../lib/root.cjs";
const WATCHDOG =
  process.env.WATCHDOG_SH ||
  path.join(REPO_ROOT, "agent/scripts/watchdog.sh");
const SRC = fs.readFileSync(WATCHDOG, "utf8");

const GRACE_OLD = "1:00:00"; // 3600s — well past the 300s handover grace
const ORPHAN_FILE = "phone-channel-duplicate.orphans_termed";

function fnBody(name) {
  const start = SRC.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} must be defined in watchdog.sh`);
  const end = SRC.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} must be a closed function body`);
  return SRC.slice(start, end + 3);
}

/** From the _etime_secs helper through the end of the duplicate-probe if/else. */
function probeBlock() {
  const start = SRC.indexOf("_etime_secs() {");
  assert.notEqual(start, -1, "_etime_secs must be defined in watchdog.sh");
  const tail = 'incident_clear "phone-channel-duplicate"\nfi\n';
  const end = SRC.indexOf(tail, start);
  assert.notEqual(end, -1, "duplicate-phone-channel block must end with incident_clear + fi");
  return SRC.slice(start, end + tail.length);
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * procs: [{ pid, ppid (string | null = unreadable), etime }]
 * Runs ONE watchdog tick against `dir` (persisting incident state across
 * ticks) and returns the recorded side effects as lines.
 */
function tick(dir, procs) {
  const rec = path.join(dir, "rec.log");
  fs.writeFileSync(rec, "");
  const psCases = [];
  for (const p of procs) {
    if (p.ppid !== null) psCases.push(`    ${shq(`ppid=:${p.pid}`)}) printf '%s\\n' ${shq(p.ppid)} ;;`);
    psCases.push(`    ${shq(`etime=:${p.pid}`)}) printf '%s\\n' ${shq(p.etime)} ;;`);
  }
  const pgrepOut = procs.map((p) => p.pid).join("\n");
  const script = `
REC=${shq(rec)}
INCIDENT_DIR=${shq(dir)}
ISSUES=""
log() { printf 'LOG %s\\n' "$1" >> "$REC"; }
notify() { printf 'NOTIFY %s\\n' "$1" >> "$REC"; }
incident_should_alert() { printf 'SHOULD_ALERT %s\\n' "$1" >> "$REC"; return 0; }
incident_clear() { printf 'CLEAR %s\\n' "$1" >> "$REC"; }
kill() { printf 'SIGNAL %s\\n' "$*" >> "$REC"; return 0; }
pgrep() { ${pgrepOut ? `printf '%s\\n' ${procs.map((p) => p.pid).join(" ")}` : "return 1"}; }
ps() {
  case "$2:$4" in
${psCases.join("\n")}
    *) return 1 ;;
  esac
}
${fnBody("incident_seen")}
${probeBlock()}
`;
  execFileSync("bash", ["-c", script], { encoding: "utf8" });
  return fs.readFileSync(rec, "utf8").split("\n").filter(Boolean);
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wd-pc-orphan-"));
}
const signals = (lines) => lines.filter((l) => l.startsWith("SIGNAL "));
const notifies = (lines) => lines.filter((l) => l.startsWith("NOTIFY "));
const clears = (lines) => lines.filter((l) => l.startsWith("CLEAR "));

test("(a) one live + one orphan: the orphan gets SIGTERM, no page, no clear", () => {
  const dir = scratch();
  try {
    const out = tick(dir, [
      { pid: 5001, ppid: "4242", etime: "00:40" }, // replacement session's child
      { pid: 4001, ppid: "1", etime: "06:10" }, // left behind by the SIGKILLed claude
    ]);
    assert.deepEqual(signals(out), ["SIGNAL -TERM 4001"]);
    assert.deepEqual(notifies(out), []);
    assert.deepEqual(clears(out), [], "incident_clear waits for a tick where pgrep counts one");
    assert.ok(
      out.some((l) => /orphaned phone-channel 4001 \(ppid 1, up 370s\).*the live one is 5001/.test(l)),
      `expected the orphan log line, got:\n${out.join("\n")}`,
    );
    assert.equal(fs.readFileSync(path.join(dir, ORPHAN_FILE), "utf8"), "pid 4001\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(b) two LIVE-parented duplicates past grace still page exactly as before", () => {
  const dir = scratch();
  try {
    const procs = [
      { pid: 5001, ppid: "4242", etime: GRACE_OLD },
      { pid: 7001, ppid: "6100", etime: GRACE_OLD }, // e.g. a stray desktop MCP entry
    ];
    const t1 = tick(dir, procs);
    assert.deepEqual(signals(t1), []);
    assert.deepEqual(notifies(t1), [], "first tick is debounced (ATTEMPT 1)");
    const t2 = tick(dir, procs);
    assert.deepEqual(signals(t2), [], "a live-parented phone-channel is never signalled");
    assert.equal(notifies(t2).length, 1);
    assert.match(notifies(t2)[0], /2 phone-channel processes running \(expected 1\) for 2 consecutive ticks/);
    assert.match(notifies(t2)[0], /Kill the non-supervisor one/);
    assert.ok(!fs.existsSync(path.join(dir, ORPHAN_FILE)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(c) all orphans: nothing is killed, today's behaviour is unchanged", () => {
  const dir = scratch();
  try {
    const procs = [
      { pid: 4001, ppid: "1", etime: GRACE_OLD },
      { pid: 4002, ppid: "1", etime: GRACE_OLD },
    ];
    const t1 = tick(dir, procs);
    const t2 = tick(dir, procs);
    assert.deepEqual(signals(t1), []);
    assert.deepEqual(signals(t2), []);
    assert.equal(notifies(t2).length, 1, "with no live instance seen, it falls through to the old page");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(d) an unreadable ppid is never killed and never counts as the live one", () => {
  const dir = scratch();
  try {
    // orphan + unknown: no positively-live instance, so the orphan is spared too.
    const t1 = tick(dir, [
      { pid: 4001, ppid: "1", etime: GRACE_OLD },
      { pid: 5001, ppid: null, etime: GRACE_OLD },
    ]);
    assert.deepEqual(signals(t1), []);
    // live + unknown: no orphan, nothing to reap.
    const dir2 = scratch();
    try {
      const t2 = tick(dir2, [
        { pid: 5001, ppid: "4242", etime: GRACE_OLD },
        { pid: 5002, ppid: "garbage", etime: GRACE_OLD },
      ]);
      assert.deepEqual(signals(t2), []);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(d2) live + orphan + unknown: only the orphan goes, the unknown stays in the paging set", () => {
  const dir = scratch();
  try {
    const procs = [
      { pid: 5001, ppid: "4242", etime: GRACE_OLD },
      { pid: 4001, ppid: "1", etime: GRACE_OLD },
      { pid: 5002, ppid: null, etime: GRACE_OLD },
    ];
    const t1 = tick(dir, procs);
    assert.deepEqual(signals(t1), ["SIGNAL -TERM 4001"]);
    const t2 = tick(dir, procs);
    assert.deepEqual(signals(t2), ["SIGNAL -KILL 4001"]);
    assert.equal(notifies(t2).length, 1, "two non-orphans past grace remain a duplicate worth paging");
    assert.match(notifies(t2)[0], /^NOTIFY ⚠️ 2 phone-channel processes running/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(e) an orphan still present on the next tick escalates to SIGKILL, still no page", () => {
  const dir = scratch();
  try {
    // Both past grace and ATTEMPT reaches 2 on tick 2 — without the reaping
    // this exact shape paged the operator.
    const procs = [
      { pid: 5001, ppid: "4242", etime: GRACE_OLD },
      { pid: 4001, ppid: "1", etime: GRACE_OLD },
    ];
    const t1 = tick(dir, procs);
    assert.deepEqual(signals(t1), ["SIGNAL -TERM 4001"]);
    const t2 = tick(dir, procs);
    assert.deepEqual(signals(t2), ["SIGNAL -KILL 4001"]);
    assert.deepEqual(notifies(t2), []);
    assert.ok(t2.some((l) => /4001 survived SIGTERM/.test(l)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("orphan state is dropped once the duplicate clears, so a later orphan starts at SIGTERM", () => {
  const dir = scratch();
  try {
    const live = { pid: 5001, ppid: "4242", etime: GRACE_OLD };
    const orphan = { pid: 4001, ppid: "1", etime: GRACE_OLD };
    tick(dir, [live, orphan]);
    assert.ok(fs.existsSync(path.join(dir, ORPHAN_FILE)));
    const t2 = tick(dir, [live]);
    assert.deepEqual(clears(t2), ["CLEAR phone-channel-duplicate"]);
    assert.ok(!fs.existsSync(path.join(dir, ORPHAN_FILE)));
    const t3 = tick(dir, [live, orphan]);
    assert.deepEqual(signals(t3), ["SIGNAL -TERM 4001"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every signal in the block is aimed at a pid re-checked to have ppid 1", () => {
  const block = probeBlock();
  const kills = block.match(/^\s*kill\s.*$/gm) || [];
  assert.equal(kills.length, 2, `expected exactly the TERM and KILL calls, got:\n${kills.join("\n")}`);
  for (const k of kills) assert.match(k, /kill -(TERM|KILL) "\$_pco_pid"/);
  const recheck = block.indexOf('[ "$(_pc_ppid "$_pco_pid")" = "1" ] || continue');
  assert.ok(recheck !== -1, "the ppid must be re-read right before signalling");
  assert.ok(recheck < block.indexOf("kill -TERM"), "re-check must precede the signal");
});
