// watchdog-phone-channel-handover.test.mjs — pins the discriminator that keeps
// the duplicate-phone-channel probe in agent/scripts/watchdog.sh from
// false-paging on a chat-supervisor session handover.
//
// History: the legit phone-channel is an MCP stdio child of the chat
// supervisor's `claude -p` session, so every session kill+restart briefly
// overlaps a dying copy with its replacement and `pgrep` counts 2. An earlier
// fix debounced on ">= 2 consecutive ticks", which measures how LONG the
// overlap lasts — and that varies with how fast the old child releases its
// Supabase subscription: 74s, 101s and 140s were measured. The 140s handover walked
// straight through the 2-tick gate and paged. The discriminator is now the
// AGE of the YOUNGEST duplicate: a handover always has one brand-new process,
// a real rogue duplicate is two independently long-lived ones.
//
// Run: node --test tests/watchdog-phone-channel-handover.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { REPO_ROOT } from "../lib/root.cjs";
// WATCHDOG_SH overrides the script under test, so a proposed watchdog.sh can be
// checked from a scratch copy before it lands (cron runs the working-tree file
// directly, so it must never be edited in place to try a change).
const WATCHDOG =
  process.env.WATCHDOG_SH ||
  path.join(REPO_ROOT, "agent/scripts/watchdog.sh");
const SRC = fs.readFileSync(WATCHDOG, "utf8");

/** Extract just the _etime_secs function so it can be sourced without running
 *  the whole watchdog (which would fire real probes). */
function etimeFn() {
  const start = SRC.indexOf("_etime_secs() {");
  assert.notEqual(start, -1, "_etime_secs must be defined in watchdog.sh");
  const end = SRC.indexOf("\n}\n", start);
  assert.notEqual(end, -1, "_etime_secs must be a closed function body");
  return SRC.slice(start, end + 3);
}

/** Run _etime_secs in real bash. Returns {rc, out}. */
function etime(value) {
  const script = `${etimeFn()}\nif out=$(_etime_secs "$1"); then printf '%s' "$out"; exit 0; else exit 1; fi\n`;
  try {
    const out = execFileSync("bash", ["-c", script, "bash", value], {
      encoding: "utf8",
    });
    return { rc: 0, out };
  } catch (err) {
    return { rc: err.status ?? 1, out: (err.stdout || "").toString() };
  }
}

test("_etime_secs parses all four Darwin ps widths", () => {
  // macOS ps has no `etimes` keyword, so etime's [[dd-]hh:]mm:ss must be
  // parsed by hand. Leading zeros must not be read as octal.
  assert.deepEqual(etime("12"), { rc: 0, out: "12" });
  assert.deepEqual(etime("04:02"), { rc: 0, out: "242" });
  assert.deepEqual(etime("1:04:02"), { rc: 0, out: "3842" });
  assert.deepEqual(etime("2-01:04:02"), { rc: 0, out: "176642" });
});

test("_etime_secs tolerates the whitespace ps pads with", () => {
  assert.equal(etime("  00:02:20 ").out, "140");
});

test("_etime_secs refuses unparseable input instead of guessing", () => {
  for (const bad of ["", "abc", "1:2:3:4", "0a:12"]) {
    const r = etime(bad);
    assert.equal(r.rc, 1, `expected non-zero rc for ${JSON.stringify(bad)}`);
    assert.equal(r.out, "", "must print nothing when it cannot parse");
  }
});

test("the grace window covers every handover observed so far", () => {
  const m = SRC.match(/PC_HANDOVER_GRACE_S=(\d+)/);
  assert.ok(m, "PC_HANDOVER_GRACE_S must be defined");
  const grace = Number(m[1]);
  // 140s is the longest handover measured. Keep real headroom;
  // a grace window that only just clears it will fail on the next slow one.
  assert.ok(grace >= 200, `grace ${grace}s leaves no headroom over the 140s handover`);
  for (const observed of [74, 101, 140]) {
    assert.ok(
      observed < grace,
      `handover of ${observed}s must fall inside the ${grace}s grace window`,
    );
  }
});

test("the duplicate page is gated behind the age check, not tick count alone", () => {
  const block = SRC.slice(
    SRC.indexOf('PC_PIDS=$(pgrep -f "phone-channel/index.mjs"'),
    SRC.indexOf('incident_clear "phone-channel-duplicate"'),
  );
  assert.ok(block.length > 0, "duplicate-phone-channel block must exist");
  assert.ok(
    /\[ "\$PC_MIN_AGE_S" -lt "\$PC_HANDOVER_GRACE_S" \]/.test(block),
    "must compare the youngest duplicate's age against the grace window",
  );
  const graceIdx = block.indexOf("PC_MIN_AGE_S\" -lt \"$PC_HANDOVER_GRACE_S");
  const notifyIdx = block.indexOf("notify ");
  assert.ok(
    graceIdx !== -1 && notifyIdx > graceIdx,
    "the notify must sit in the elif AFTER the handover branch, so a young duplicate cannot page",
  );
});

test("an unreadable ps fails OPEN to the old tick-only behaviour", () => {
  const block = SRC.slice(
    SRC.indexOf('PC_PIDS=$(pgrep -f "phone-channel/index.mjs"'),
    SRC.indexOf('incident_clear "phone-channel-duplicate"'),
  );
  assert.ok(
    /-n "\$PC_MIN_AGE_S"/.test(block),
    "the suppress branch must require a parsed age, so no age means no suppression",
  );
  assert.ok(
    /\$ATTEMPT" -ge 2/.test(block),
    "the >=2 consecutive-tick debounce stays as the fallback gate",
  );
});

test("the ps age lookup cannot be silenced by a stale pid", () => {
  // `|| continue` on the assignment means a pid that vanished between pgrep
  // and ps is skipped, not recorded as age 0 (which would suppress the page).
  const block = SRC.slice(
    SRC.indexOf("for _pc_pid in $PC_PIDS"),
    SRC.indexOf("done", SRC.indexOf("for _pc_pid in $PC_PIDS")),
  );
  assert.ok(/\|\| continue/.test(block), "a failed ps lookup must be skipped, not counted as 0");
});
