// max-auth-guard.test.mjs — the ephemeral runners only ever run on the Max
// subscription (agent/scripts/lib/max-auth-guard.sh, 2026-10-06).
//
// Two halves, both pinned here:
//   - max_auth_scrub removes every variable that can move Claude Code off the
//     subscription, including ANTHROPIC_BASE_URL, which `claude auth status`
//     does NOT reveal (measured on the host: it still reports claude.ai).
//   - max_auth_check accepts only loggedIn + claude.ai + firstParty + max, and
//     fails CLOSED on anything else, including output it cannot read.
// The `auth status` shapes below are the real ones captured under launchd on
// the host (email/org trimmed).
//
// Run: node --test tests/max-auth-guard.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { REPO_ROOT as ROOT } from "../lib/root.cjs";
const GUARD = path.join(ROOT, "agent/scripts/lib/max-auth-guard.sh");
const RUNNER = path.join(ROOT, "agent/scripts/lib/run-ephemeral-opus.sh");

const MAX = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" };
const STATUSES = {
  max: JSON.stringify(MAX, null, 2),
  apiKey: JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }, null, 2),
  bedrock: JSON.stringify({ loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" }, null, 2),
  loggedOut: JSON.stringify({ loggedIn: false }, null, 2),
  pro: JSON.stringify({ ...MAX, subscriptionType: "pro" }, null, 2),
  garbage: "Not logged in · Please run /login",
};

function fakeClaude(dir, status) {
  const f = path.join(dir, "claude");
  const calls = path.join(dir, "calls");
  fs.writeFileSync(f, `#!/bin/bash\necho "$*" >> ${JSON.stringify(calls)}\nif [ "$1" = auth ]; then cat <<'S'\n${status}\nS\nexit 0; fi\ncat > /dev/null\necho '{"type":"result","result":"done"}'\n`);
  fs.chmodSync(f, 0o755);
  return { f, calls };
}

function check(status) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maxauth-"));
  try {
    const { f } = fakeClaude(dir, status);
    const r = spawnSync("/bin/bash", ["-c", `source ${JSON.stringify(GUARD)}; max_auth_check ${JSON.stringify(f)}; echo "rc=$? $MAX_AUTH_SUMMARY"`], { encoding: "utf8" });
    return r.stdout.trim();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("accepts only a claude.ai login on the Max plan", () => {
  assert.match(check(STATUSES.max), /^rc=0 loggedIn=true authMethod=claude\.ai apiProvider=firstParty subscription=max$/);
  for (const k of ["apiKey", "bedrock", "loggedOut", "pro", "garbage"]) {
    assert.match(check(STATUSES[k]), /^rc=1 /, `${k} must be refused`);
  }
});

test("scrub removes every off-subscription variable and keeps unrelated ones", () => {
  const env = {
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "x", ANTHROPIC_BASE_URL: "https://elsewhere.invalid",
    CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "x", AWS_BEARER_TOKEN_BEDROCK: "x",
    PROJECT_ANTHROPIC_API_KEY: "keep", SUPABASE_ACCESS_TOKEN: "keep",
  };
  const r = spawnSync("/bin/bash", ["-c", `source ${JSON.stringify(GUARD)}; max_auth_scrub; env`], { encoding: "utf8", env });
  const left = r.stdout.split("\n").map((l) => l.split("=")[0]);
  for (const k of Object.keys(env)) {
    const keep = k === "PATH" || env[k] === "keep";
    assert.equal(left.includes(k), keep, `${k} should be ${keep ? "kept" : "scrubbed"}`);
  }
});

test("run-ephemeral-opus.sh refuses with exit 78 and never calls the model when not on Max", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maxauth-home-"));
  try {
    const { f, calls } = fakeClaude(home, STATUSES.apiKey);
    const md = path.join(home, "job.md");
    fs.writeFileSync(md, "# job\n");
    const r = spawnSync("/bin/bash", [RUNNER, "guard-test", md, "--model", "claude-opus-5-5"], { encoding: "utf8", env: { ...process.env, HOME: home, CLAUDE_BIN: f } });
    assert.equal(r.status, 78);
    const made = fs.readFileSync(calls, "utf8");
    assert.ok(!/(^|\n)-p\b/.test(made) && !made.includes("--model"), `the model must not be called; calls were:\n${made}`);
    const log = fs.readFileSync(path.join(home, "Dev/edva/agent/logs/guard-test.log"), "utf8");
    assert.match(log, /REFUSED: not on the Max subscription \(loggedIn=true authMethod=api_key/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("every ephemeral runner sources the guard before its claude -p", () => {
  for (const rel of [
    "agent/scripts/lib/run-ephemeral-opus.sh",
  ]) { // (this installation's other runners: max-auth-guard-local.test.mjs)
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const g = src.indexOf("max_auth_check");
    const run = src.search(/"\$CLAUDE" -p/);
    assert.ok(g > 0 && run > g, `${rel}: max_auth_check must run before "$CLAUDE" -p`);
  }
});
