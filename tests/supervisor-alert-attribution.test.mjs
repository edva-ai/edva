// Regression guard for a Max-auth flap.
//
// agent/supervisor/index.mjs is spawned once per agent — ops, ops-light,
// ops-haiku and chat all run this same file — so an alert string that says
// "Edva ops" or "Ops turn" is wrong for three of the four supervisors.
// Observed: three identical
//   "✅ Edva back up: Max auth restored — resuming."
// pings landed seconds apart with nothing to tell them apart, while the
// watchdog's own page for the same outage correctly named ops-light and
// ops-haiku. The system channel's text is also an input to
// system-issue-review's clustering, so a misattributed emitter root-causes to
// the wrong process.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT as ROOT } from "../lib/root.cjs";
const SRC = path.join(ROOT, "agent/supervisor/index.mjs");

// The alert strings are exactly the lines carrying a severity marker. Comments
// are stripped first so the explanatory note above _sendPush — which quotes the
// old wording on purpose — is not mistaken for a live alert.
function alertLines() {
  return fs
    .readFileSync(SRC, "utf8")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l)) // lang-regex-ok: strips JS line comments from source code, not from anyone's words
    .filter((l) => l.includes("⚠️") || l.includes("✅") || l.includes("🔴"));
}

test("no supervisor alert hardcodes an agent name", () => {
  const lines = alertLines();
  assert.ok(lines.length >= 8, `expected to find the supervisor's alert strings, found ${lines.length}`);
  for (const line of lines) {
    for (const bad of ["Edva ops", "Ops turn"]) {
      assert.ok(!line.includes(bad), `supervisor alert hardcodes the agent (${bad}):\n  ${line.trim()}`);
    }
  }
});

test("every process-naming supervisor alert interpolates this.args.agent", () => {
  const src = fs.readFileSync(SRC, "utf8");
  for (const frag of [
    "⚠️ Edva ${this.args.agent} queue depth=",
    "✅ Edva ${this.args.agent} recovered: queue drained",
    "✅ Edva ${this.args.agent} recovered: the fresh session",
    "⚠️ ${this.args.agent} turn from ${src} hung ${mins}min again",
    "⚠️ ${this.args.agent} turn from ${src} hung for ${mins}min",
    "Max auth broken on ${HOST_LABEL} for the ${this.args.agent} supervisor",
    "Max auth restored on ${HOST_LABEL} — ${this.args.agent} is resuming.",
    "⚠️ Edva ${this.args.agent} crash-loop:",
  ]) {
    assert.ok(src.includes(frag), `missing agent-attributed alert: ${frag}`);
  }
});
