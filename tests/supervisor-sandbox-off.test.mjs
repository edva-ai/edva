// Regression guard: sandboxed tiers whose gates could not see the Max login.
//
// Alerts it stops: "🟠 Truth gate partly blind: the claim-freshness extractor
// failed 11 of the last 50 checks (22%; unparseable 11)" and "⚠️ Relevance
// check partly blind: the outbound precheck got no usable answer for 6 of the
// last 21 messages (29%; no_json 6)".
//
// The host's ~/.claude/settings.json turns the Claude Code Bash sandbox on and
// denies reading ~/Library/Keychains. ops-agent/ and chat-agent/ switch it off
// in gitignored .claude/settings.local.json files; ops-light-agent/ and
// ops-haiku-agent/ had none. So a edva-send-curl run from an ops-light turn
// forked the precheck's `claude -p` inside the sandbox, the fork could not
// read the Max login, printed "Not logged in · Please run /login", and the gate
// failed open. agent/supervisor/index.mjs now passes
// --settings '{"sandbox":{"enabled":false}}' to every ops-tier session.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSession } from "../agent/supervisor/claude-session.mjs";

import { REPO_ROOT as ROOT } from "../lib/root.cjs";
const SRC = path.join(ROOT, "agent/supervisor/index.mjs");

test("startSession() turns the Bash sandbox off for every ops-tier session", () => {
  const src = fs.readFileSync(SRC, "utf8");
  const start = src.indexOf("async startSession(");
  assert.ok(start >= 0, "startSession() not found in supervisor/index.mjs");
  const body = src.slice(start, src.indexOf("new ClaudeSession(sessionOpts)", start));
  const line = body.split("\n").find((l) => l.trim().startsWith("settings:"));
  assert.ok(line, "startSession() no longer passes a settings option to the session");
  assert.ok(line.includes("sandbox: { enabled: false }"),
    `the ops tiers must run with sandbox.enabled false, got: ${line.trim()}`);
});

test("ClaudeSession passes the settings JSON through as --settings", () => {
  const settings = JSON.stringify({ sandbox: { enabled: false } });
  const sess = new ClaudeSession({ sessionId: "00000000-0000-4000-8000-000000000000", model: "m", cwd: ROOT, settings });
  const args = sess._buildArgs({ resume: false });
  const i = args.indexOf("--settings");
  assert.ok(i >= 0, "--settings missing from the claude argv");
  assert.equal(args[i + 1], settings);
});

test("ClaudeSession omits --settings when none is given", () => {
  const sess = new ClaudeSession({ sessionId: "00000000-0000-4000-8000-000000000000", model: "m", cwd: ROOT });
  assert.equal(sess._buildArgs({ resume: false }).includes("--settings"), false);
});
