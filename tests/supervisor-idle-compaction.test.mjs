// Claude Code 2.1.299 added
// "idle compaction" (a long conversation is compacted after ~54 idle minutes);
// 2.1.302 made it switchable with `"idleCompaction": false`. Edva's
// long-running supervisor sessions (chat + every ops tier) turn it off through
// the per-session --settings JSON, so the operator's own Claude Code sessions keep the
// default. This guards both spawn paths.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSession } from "../agent/supervisor/claude-session.mjs";

import { REPO_ROOT as ROOT } from "../lib/root.cjs";

function settingsLine(file) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const start = src.indexOf("async startSession(");
  assert.ok(start >= 0, `startSession() not found in ${file}`);
  const body = src.slice(start, src.indexOf("new ClaudeSession(sessionOpts)", start));
  const line = body.split("\n").find((l) => l.trim().startsWith("settings:"));
  assert.ok(line, `${file} startSession() passes no settings option`);
  return line;
}

for (const file of ["agent/supervisor/index.mjs", "agent/supervisor/chat-supervisor.mjs"]) {
  test(`${path.basename(file)} turns idle compaction off for its supervisor session`, () => {
    assert.match(settingsLine(file), /idleCompaction: false/);
  });
}

test("the idleCompaction setting reaches the claude argv as --settings JSON", () => {
  const settings = JSON.stringify({ sandbox: { enabled: false }, idleCompaction: false });
  const sess = new ClaudeSession({ sessionId: "00000000-0000-4000-8000-000000000000", model: "m", cwd: ROOT, settings });
  const args = sess._buildArgs({ resume: true });
  const v = JSON.parse(args[args.indexOf("--settings") + 1]);
  assert.equal(v.idleCompaction, false);
  assert.equal(v.sandbox.enabled, false);
});
