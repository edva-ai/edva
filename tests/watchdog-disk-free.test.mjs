// watchdog-disk-free.test.mjs — pins the data-volume free-space probe in
// agent/scripts/watchdog.sh.
//
// THE ALERTS THIS DEFENDS: "🔴 <host title> disk space critical:" and
// "⚠️ <host title> disk space low:" (host title "Server" here). Hourly memory-DB snapshots
// (bin/wiki-db-snapshot → data/memory-db-snapshots) can quietly
// fill the data volume to 99%; once nearly full, downloads stall and
// database/log writes fail, and without this probe nothing paged.
//
// Behavioral cases run the real functions (and the real section, with the real
// incident_* / notify machinery) in bash, with `df`, `du` and the sender
// replaced by stub executables on PATH. Nothing touches the real machine.
//
// Run against a proposed copy:
//   WATCHDOG_SH=/tmp/x/watchdog.sh node --test tests/watchdog-disk-free.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { REPO_ROOT } from "../lib/root.cjs";
const WATCHDOG_PATH =
  process.env.WATCHDOG_SH || path.join(REPO_ROOT, "agent/scripts/watchdog.sh");
const SRC = fs.readFileSync(WATCHDOG_PATH, "utf8");

const SECTION_HEADER = "# --- Data-volume free space ---";
const SUMMARY_MARKER = '\nif [ -n "$ISSUES" ]; then';
const RELOAD_HEADER = "# --- Supervisor code reload";

const KB_PER_GIB = 1048576;

function fnSrc(name) {
  const start = SRC.indexOf(`\n${name}() {`);
  assert.notEqual(start, -1, `${name} must be defined in watchdog.sh`);
  const end = SRC.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} must be a closed function body`);
  return SRC.slice(start + 1, end + 3);
}

function sectionSrc() {
  const start = SRC.indexOf(SECTION_HEADER);
  assert.notEqual(start, -1, `expected a "${SECTION_HEADER}" section in watchdog.sh`);
  const end = SRC.indexOf(SUMMARY_MARKER, start);
  assert.notEqual(end, -1, "the disk section must end before the ISSUES summary block");
  return SRC.slice(start, end + 1);
}

const codeOnly = (s) =>
  s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

// A `df -Pk` answer shaped like the host's own (header + one filesystem row).
function dfOut(availKb, capPct, { device = "/dev/disk3s5", mount = "/System/Volumes/Data" } = {}) {
  return (
    "Filesystem   1024-blocks      Used Available Capacity  Mounted on\n" +
    `${device}   500000000 340000000 ${availKb}    ${capPct}%    ${mount}\n`
  );
}
const gib = (n) => Math.round(n * KB_PER_GIB);

// ---- stub harness --------------------------------------------------------

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wd-disk-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, "home/Dev/edva/data"), { recursive: true });
  const stub = (name, body) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/bash\n${body}\n`);
    fs.chmodSync(p, 0o755);
    return p;
  };
  // df: prints $FAKE_DF_FILE and exits $FAKE_DF_RC; records every call.
  stub("df", 'echo "$*" >> "$STUB_LOG_DIR/df.calls"\n[ -n "$FAKE_DF_FILE" ] && cat "$FAKE_DF_FILE"\nexit "${FAKE_DF_RC:-0}"');
  // du: prints $FAKE_DU_OUT and exits $FAKE_DU_RC; records every call.
  stub("du", 'echo "$*" >> "$STUB_LOG_DIR/du.calls"\n[ -n "$FAKE_DU_OUT" ] && printf "%s\\n" "$FAKE_DU_OUT"\nexit "${FAKE_DU_RC:-0}"');
  // The system-channel sender: one line per page, args joined by US (0x1f).
  const send = stub("send", 'line=""; for a; do line="$line$a"$\'\\x1f\'; done; printf "%s\\n" "$line" >> "$STUB_LOG_DIR/sent"');
  return { root, bin, home: path.join(root, "home"), send, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function bashEnv(sb, extra = {}) {
  return {
    PATH: `${sb.bin}:/usr/bin:/bin`,
    HOME: sb.home,
    STUB_LOG_DIR: sb.root,
    // The alerts name the machine by the instance's host title / label.
    EDVA_HOST_TITLE: "Server", EDVA_HOST_LABEL: "the server",
    ...extra,
  };
}

function readLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

// Run disk_free_probe once and return its parsed one-line answer.
function probe({ df, dfRc = 0, env = {}, arg } = {}) {
  const sb = makeSandbox();
  try {
    const dfFile = path.join(sb.root, "df.out");
    if (df !== undefined) fs.writeFileSync(dfFile, df);
    const script = `${fnSrc("_disk_gib_threshold")}\n${fnSrc("disk_free_probe")}\ndisk_free_probe ${arg ? JSON.stringify(arg) : ""}\n`;
    const out = execFileSync("bash", ["-c", script], {
      encoding: "utf8",
      env: bashEnv(sb, { FAKE_DF_FILE: df !== undefined ? dfFile : "", FAKE_DF_RC: String(dfRc), ...env }),
    }).trim();
    const [level, free, pct, ...detail] = out.split(" ");
    return { out, level, free, pct, detail: detail.join(" "), dfCalls: readLines(path.join(sb.root, "df.calls")) };
  } finally {
    sb.cleanup();
  }
}

// ---- probe: verdicts -----------------------------------------------------

test("plenty of free space reads ok", () => {
  const r = probe({ df: dfOut(121880000, 74) });
  assert.equal(r.level, "ok");
  assert.equal(r.free, "116.2");
  assert.equal(r.pct, "74");
  assert.equal(r.detail, "/System/Volumes/Data");
});

test("probe asks df -Pk about the volume holding data by default", () => {
  const r = probe({ df: dfOut(121880000, 74) });
  assert.equal(r.dfCalls.length, 1);
  assert.ok(r.dfCalls[0].startsWith("-Pk ") && r.dfCalls[0].endsWith("/Dev/edva/data"), r.dfCalls[0]);
});

test("about 20 GiB free reads low", () => {
  const r = probe({ df: dfOut(gib(20), 96) });
  assert.equal(r.level, "low");
  assert.equal(r.free, "20.0");
  assert.equal(r.pct, "96");
});

test("about 8 GiB free reads critical", () => {
  const r = probe({ df: dfOut(gib(8), 99) });
  assert.equal(r.level, "critical");
  assert.equal(r.free, "8.0");
});

test("a nearly-full reading (7.3 GiB free, 99% used) reads critical", () => {
  const r = probe({ df: dfOut(gib(7.3), 99) });
  assert.equal(r.level, "critical");
  assert.equal(r.free, "7.3");
  assert.equal(r.pct, "99");
});

test("thresholds are strict 'under': exactly 10 GiB is low, exactly 25 GiB is ok", () => {
  assert.equal(probe({ df: dfOut(10 * KB_PER_GIB, 98) }).level, "low");
  assert.equal(probe({ df: dfOut(25 * KB_PER_GIB, 95) }).level, "ok");
  const justUnder = probe({ df: dfOut(10 * KB_PER_GIB - 1, 98) });
  assert.equal(justUnder.level, "critical");
  assert.equal(justUnder.free, "9.9", "free GiB rounds down so a critical reading never prints as 10.0");
});

test("df exiting non-zero is unknown, not ok and not critical", () => {
  const r = probe({ df: "", dfRc: 1 });
  assert.equal(r.level, "unknown");
  assert.equal(r.free, "-");
  assert.equal(r.detail, "df-failed");
});

test("garbage from df is unknown", () => {
  for (const df of ["hello world\n", "", "Filesystem 1024-blocks Used Available Capacity Mounted on\n",
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1 2 lots 74% /x\n",
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1 2 3 74 /x\n"]) {
    const r = probe({ df });
    assert.equal(r.level, "unknown", `expected unknown for df output ${JSON.stringify(df)}`);
    assert.equal(r.detail, "df-unparsed");
  }
});

test("a device name with spaces does not shift the columns", () => {
  const r = probe({ df: dfOut(500, 50, { device: "//operator@nas/My Share", mount: "/Volumes/My Share" }) });
  assert.equal(r.level, "critical");
  assert.equal(r.free, "0.0");
  assert.equal(r.pct, "50");
  assert.equal(r.detail, "/Volumes/My Share");
});

test("thresholds are overridable from the environment", () => {
  const df = dfOut(121880000, 74); // 116.2 GiB free
  assert.equal(probe({ df, env: { WATCHDOG_DISK_WARN_GIB: "200", WATCHDOG_DISK_CRIT_GIB: "150" } }).level, "critical");
  assert.equal(probe({ df, env: { WATCHDOG_DISK_WARN_GIB: "200", WATCHDOG_DISK_CRIT_GIB: "100" } }).level, "low");
  const tight = dfOut(gib(8), 99);
  assert.equal(probe({ df: tight, env: { WATCHDOG_DISK_WARN_GIB: "5", WATCHDOG_DISK_CRIT_GIB: "2" } }).level, "ok");
});

test("a malformed threshold override falls back to the default instead of disabling the check", () => {
  const df = dfOut(gib(8), 99);
  assert.equal(probe({ df, env: { WATCHDOG_DISK_WARN_GIB: "lots", WATCHDOG_DISK_CRIT_GIB: "" } }).level, "critical");
  assert.equal(probe({ df: dfOut(gib(20), 96), env: { WATCHDOG_DISK_WARN_GIB: "-1", WATCHDOG_DISK_CRIT_GIB: "1.5" } }).level, "low");
});

// ---- the section, tick by tick, through the real incident machinery ----------

// Each tick is a fresh bash process, as under cron; incident state persists in
// $HOME/Dev/edva/data/watchdog-incidents between ticks.
function ticker() {
  const sb = makeSandbox();
  const dfFile = path.join(sb.root, "df.out");
  const harness = [
    'LOG="$HOME/watchdog.log"',
    'log() { echo "$(date \'+%Y-%m-%d %H:%M:%S\') $1" >> "$LOG"; }',
    `SEND=${JSON.stringify(sb.send)}`,
    'EMAIL_SEND="/nonexistent/email-send"',
    'PENDING_ALERT_KEY=""',
    'INCIDENT_DIR="$HOME/Dev/edva/data/watchdog-incidents"',
    'mkdir -p "$INCIDENT_DIR"',
    'ISSUES=""',
    fnSrc("log_throttled"),
    fnSrc("notify"),
    fnSrc("_incident_label"),
    fnSrc("incident_seen"),
    fnSrc("incident_clear"),
    fnSrc("incident_should_alert"),
    fnSrc("_disk_gib_threshold"),
    fnSrc("disk_free_probe"),
    fnSrc("disk_alert_body"),
    sectionSrc(),
    'printf "ISSUES=%s\\n" "$ISSUES"',
  ].join("\n");
  let seen = 0;
  const tick = (df, { dfRc = 0, duOut = `${gib(40)}\t${sb.home}/Dev/edva/data/memory-db-snapshots`, duRc = 0, env = {} } = {}) => {
    fs.writeFileSync(dfFile, df);
    const duBefore = readLines(path.join(sb.root, "du.calls")).length;
    const out = execFileSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: bashEnv(sb, { FAKE_DF_FILE: dfFile, FAKE_DF_RC: String(dfRc), FAKE_DU_OUT: duOut, FAKE_DU_RC: String(duRc), ...env }),
    });
    const sent = readLines(path.join(sb.root, "sent"));
    const fresh = sent.slice(seen).map((l) => l.split("\x1f").filter(Boolean));
    seen = sent.length;
    return {
      issues: (out.match(/^ISSUES=(.*)$/m) || [])[1],
      pages: fresh.map((args) => args[args.length - 1]),
      args: fresh,
      duCalls: readLines(path.join(sb.root, "du.calls")).slice(duBefore),
    };
  };
  return { tick, sb, cleanup: sb.cleanup };
}

const OK = dfOut(121880000, 74);
const LOW = dfOut(gib(20), 96);
const CRIT = dfOut(gib(7.3), 99);

test("critical pages on the second consecutive tick, once, on the system channel, with the stable prefix", () => {
  const t = ticker();
  try {
    const t1 = t.tick(CRIT);
    assert.deepEqual(t1.pages, [], "a single critical tick must not page");
    assert.equal(t1.issues, " disk(critical)", "the ISSUES token carries no number");
    assert.deepEqual(t1.duCalls, [], "du runs only while composing a page");

    const t2 = t.tick(CRIT);
    assert.equal(t2.pages.length, 1);
    const page = t2.pages[0];
    assert.ok(page.startsWith("🔴 Server disk space critical: "), page);
    assert.ok(page.includes("7.3 GiB free on the data volume (99% used)"), page);
    assert.ok(page.includes("data/memory-db-snapshots holds 40.0 GiB"), page);
    assert.ok(page.includes("Nothing was deleted."), page);
    assert.ok(page.includes(" stall and database and log writes start failing"), page);
    assert.ok(page.includes("database and log writes start failing"), page);
    assert.ok([...page].length < 350, `page must stay under ~350 characters, got ${[...page].length}`);
    assert.ok(t2.args[0].includes("--channel") && t2.args[0].includes("system"), "pages go to the system channel");
    assert.equal(t2.duCalls.length, 1);
    assert.match(t2.duCalls[0], /^-sk .*\/tools\/data\/memory-db-snapshots$/, "du sizes that one directory only");

    assert.deepEqual(t.tick(CRIT).pages, [], "the 24h cooldown holds the third tick");
  } finally {
    t.cleanup();
  }
});

test("low pages on the second tick with the ⚠️ prefix", () => {
  const t = ticker();
  try {
    assert.deepEqual(t.tick(LOW).pages, []);
    const t2 = t.tick(LOW);
    assert.equal(t2.pages.length, 1);
    assert.ok(t2.pages[0].startsWith("⚠️ Server disk space low: 20.0 GiB free on the data volume (96% used)."), t2.pages[0]);
    assert.equal(t2.issues, " disk(low)");
  } finally {
    t.cleanup();
  }
});

test("recovery after a delivered page sends one ✅ after 3 ok ticks, naming the line it crossed, never 'auto-healed'", () => {
  const t = ticker();
  try {
    t.tick(CRIT);
    assert.equal(t.tick(CRIT).pages.length, 1);
    assert.deepEqual(t.tick(OK).pages, []);
    assert.deepEqual(t.tick(OK).pages, []);
    const t3 = t.tick(OK);
    assert.deepEqual(t3.pages, [
      "✅ Recovered: Server free disk space (critical) is back to normal — free space on the data volume is back above the 10 GiB critical line, stable for 3 checks.",
    ]);
    assert.equal(t3.issues, "");
    assert.deepEqual(t.tick(OK).pages, [], "recovery is sent once");
  } finally {
    t.cleanup();
  }
});

test("a critical reading never clears disk-low (no false ✅ while the disk is fuller)", () => {
  const t = ticker();
  try {
    t.tick(LOW);
    assert.equal(t.tick(LOW).pages.length, 1, "⚠️ low pages first");
    const pages = [];
    for (let i = 0; i < 5; i++) pages.push(...t.tick(CRIT).pages);
    assert.equal(pages.length, 1, `only the 🔴 page, got ${JSON.stringify(pages)}`);
    assert.ok(pages[0].startsWith("🔴 Server disk space critical:"));
  } finally {
    t.cleanup();
  }
});

test("critical easing to low recovers the critical incident and then pages low", () => {
  const t = ticker();
  try {
    t.tick(CRIT);
    assert.equal(t.tick(CRIT).pages.length, 1);
    const all = [];
    for (let i = 0; i < 3; i++) all.push(...t.tick(LOW).pages);
    assert.equal(all.length, 2, JSON.stringify(all));
    assert.ok(all[0].startsWith("⚠️ Server disk space low:"), all[0]);
    assert.ok(all[1].startsWith("✅ Recovered: Server free disk space (critical)"), all[1]);
    assert.ok(all[1].includes("10 GiB critical line"));
  } finally {
    t.cleanup();
  }
});

test("an unreadable df neither counts toward a page nor clears an incident", () => {
  const t = ticker();
  try {
    // unknown alone: silent, no state written
    for (let i = 0; i < 4; i++) {
      const r = t.tick("garbage\n");
      assert.deepEqual(r.pages, []);
      assert.equal(r.issues, " disk(unknown)");
    }
    assert.deepEqual(t.tick("", { dfRc: 1 }).pages, []);
    const incDir = path.join(t.sb.home, "Dev/edva/data/watchdog-incidents");
    assert.deepEqual(fs.readdirSync(incDir).filter((f) => f.startsWith("disk-")), [], "unknown writes no incident state");

    // unknown between two critical ticks does not count: the page needs a second CRITICAL tick
    assert.deepEqual(t.tick(CRIT).pages, []);
    assert.deepEqual(t.tick("garbage\n").pages, []);
    assert.equal(t.tick(CRIT).pages.length, 1);

    // and unknown inside the green streak neither resets it nor counts as green
    assert.deepEqual(t.tick(OK).pages, []);
    assert.deepEqual(t.tick("garbage\n").pages, []);
    assert.deepEqual(t.tick(OK).pages, []);
    const r = t.tick(OK);
    assert.equal(r.pages.length, 1);
    assert.ok(r.pages[0].startsWith("✅ Recovered: Server free disk space (critical)"));
  } finally {
    t.cleanup();
  }
});

test("when du cannot size the snapshot folder the page says so and still goes out", () => {
  const t = ticker();
  try {
    t.tick(CRIT, { duOut: "", duRc: 1 });
    const r = t.tick(CRIT, { duOut: "", duRc: 1 });
    assert.equal(r.pages.length, 1);
    assert.ok(r.pages[0].includes("data/memory-db-snapshots (hourly memory-DB copies, which have filled the disk before) could not be measured."), r.pages[0]);
    assert.ok([...r.pages[0]].length < 350);
  } finally {
    t.cleanup();
  }
});

test("env thresholds also drive the section and its recovery wording", () => {
  const t = ticker();
  const env = { WATCHDOG_DISK_WARN_GIB: "200", WATCHDOG_DISK_CRIT_GIB: "150" };
  try {
    t.tick(OK, { env });
    const r = t.tick(OK, { env });
    assert.equal(r.pages.length, 1);
    assert.ok(r.pages[0].startsWith("🔴 Server disk space critical: 116.2 GiB free"), r.pages[0]);
    const big = dfOut(gib(300), 40);
    t.tick(big, { env });
    t.tick(big, { env });
    const rec = t.tick(big, { env });
    assert.ok(rec.pages[0].includes("back above the 150 GiB critical line"), rec.pages[0]);
  } finally {
    t.cleanup();
  }
});

// ---- structure ---------------------------------------------------------------

test("the section sits before the summary and the supervisor code reload", () => {
  const secIdx = SRC.indexOf(SECTION_HEADER);
  const summaryIdx = SRC.indexOf(SUMMARY_MARKER);
  const reloadIdx = SRC.indexOf(RELOAD_HEADER);
  assert.ok(secIdx !== -1 && summaryIdx !== -1 && reloadIdx !== -1);
  assert.ok(secIdx < summaryIdx, "the disk section must run before the ISSUES summary so disk(...) is logged");
  assert.ok(summaryIdx < reloadIdx, "the summary still precedes the supervisor code reload");
  assert.equal(
    SRC.slice(reloadIdx + RELOAD_HEADER.length).indexOf("\n# --- "),
    -1,
    "the supervisor code reload must remain the last section in the tick",
  );
});

test("the section uses the two incident keys through the shared machinery", () => {
  const sec = codeOnly(sectionSrc());
  for (const key of ["disk-low", "disk-critical"]) {
    assert.ok(sec.includes(`incident_seen "${key}"`), `incident_seen "${key}"`);
    assert.ok(sec.includes(`incident_clear "${key}"`), `incident_clear "${key}"`);
    assert.ok(sec.includes(`[ "$ATTEMPT" -ge 2 ] && incident_should_alert "${key}"`), `2-tick gate for ${key}`);
  }
  assert.ok(sec.includes('notify "🔴 ${EDVA_HOST_TITLE:-Host} disk space critical: '), "stable 🔴 prefix");
  assert.ok(sec.includes('notify "⚠️ ${EDVA_HOST_TITLE:-Host} disk space low: '), "stable ⚠️ prefix");
  assert.match(SRC, /disk-low\)\s+echo "\$\{EDVA_HOST_TITLE:-Host\} free disk space" ;;/);
  assert.match(SRC, /disk-critical\)\s+echo "\$\{EDVA_HOST_TITLE:-Host\} free disk space \(critical\)" ;;/);
});

test("the probe uses df -Pk and env thresholds with 25/10 defaults", () => {
  const body = fnSrc("disk_free_probe");
  assert.match(body, /df -Pk /);
  assert.match(body, /_disk_gib_threshold "\$WATCHDOG_DISK_WARN_GIB" 25/);
  assert.match(body, /_disk_gib_threshold "\$WATCHDOG_DISK_CRIT_GIB" 10/);
  assert.match(fnSrc("disk_alert_body"), /du -sk "\$dir"/);
});

test("no self-heal: the disk probe and its section never delete, prune or move anything", () => {
  const code = codeOnly(
    [sectionSrc(), fnSrc("disk_free_probe"), fnSrc("disk_alert_body"), fnSrc("_disk_gib_threshold")].join("\n"),
  );
  assert.doesNotMatch(code, /(^|[\s;&|(`])(rm|rmdir|mv|unlink|trash|srm|shred|truncate)(\s|$)/m, "no file-removing command");
  assert.doesNotMatch(code, /\s-delete\b|\bfind\b|wiki-db-snapshot|tmutil|\bprune/i, "no find -delete, no snapshot pruning, no tmutil");
  assert.match(sectionSrc(), /NO SELF-HEAL/, "the reason stays written in place");
});
