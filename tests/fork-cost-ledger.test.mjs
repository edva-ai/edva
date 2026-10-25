// fork-cost-ledger.test.mjs — Opus forks write cost rows, and the cost report
// sees them (a self-improvement review item).
//
// Before this, every Opus job ran as an ephemeral launchd fork outside the
// three supervisors, wrote no ledger row, and edva-cost-report said
// "opus: 0 dispatches" in a week where four Opus jobs ran.
//
// Run: node --test tests/fork-cost-ledger.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
import { REPO_ROOT as ROOT } from "../lib/root.cjs";
const { rowFromResult } = require("../lib/fork-cost-ledger.cjs");

// The shape `claude -p --output-format json` prints (abridged to what we read).
const ENVELOPE = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1_234_000,
  num_turns: 57,
  result: "Run complete.\n\nReview written.\nEmail sent.\nState file updated.\nNothing left uncommitted.",
  session_id: "abc123de-0000-0000-0000-000000000000",
  total_cost_usd: 11.5,
  usage: { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 },
  modelUsage: {
    "claude-opus-5-5": { inputTokens: 1000, outputTokens: 200_000, cacheReadInputTokens: 10_000_000, cacheCreationInputTokens: 400_000, webSearchRequests: 12 },
    "claude-haiku-4-5": { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0 },
  },
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fork-cost-"));
const readRows = (f) => fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("a fork's row has the supervisors' ledger shape, summed from modelUsage", () => {
  const row = rowFromResult({ job: "nightly-review", result: ENVELOPE, model: "claude-opus-5-5", now: new Date("2026-10-06T10:00:00Z") });
  assert.equal(row.source, "nightly-review");
  assert.equal(row.ts, "2026-10-06T10:00:00.000Z");
  assert.deepEqual(row.models, ["claude-opus-5-5", "claude-haiku-4-5"]);
  assert.equal(row.input_tokens, 1500);
  assert.equal(row.output_tokens, 200_100);
  assert.equal(row.cache_read_tokens, 10_000_000);
  assert.equal(row.cache_creation_tokens, 400_000);
  assert.equal(row.web_search_requests, 12);
  assert.equal(row.num_turns, 57);
  assert.equal(row.total_cost_usd, 11.5);
  assert.equal(row.runner, "ephemeral-fork");
  // Every field the supervisor writes (agent/supervisor/index.mjs) is present.
  for (const k of ["dispatch_id", "short_id", "session_id", "duration_ms", "session_cumulative_cost_usd", "terminal_reason"]) {
    assert.ok(k in row, `missing ${k}`);
  }
});

test("usage-only results (stateless executor) still make a row; empty ones make none", () => {
  const row = rowFromResult({ job: "weekly-report", result: { usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } }, model: "claude-opus-5-5" });
  assert.deepEqual(row.models, ["claude-opus-5-5"]);
  assert.equal(row.cache_creation_tokens, 40);
  // An auth failure / killed run spent nothing measurable: no zero row.
  assert.equal(rowFromResult({ job: "x", result: { is_error: true, result: "Not logged in · Please run /login" } }), null);
  assert.equal(rowFromResult({ job: "x", result: null }), null);
});

test("fork-cost-record writes the row and hands back the plain text; garbage passes through", () => {
  const dir = tmp();
  const ledger = path.join(dir, "ledger.ndjson");
  const env = { ...process.env, EDVA_FORK_COST_LEDGER: ledger };
  const cli = path.join(ROOT, "bin/fork-cost-record");
  try {
    const json = path.join(dir, "out.json");
    fs.writeFileSync(json, JSON.stringify(ENVELOPE));
    const text = execFileSync("node", [cli, "nightly-review", json, "--model", "claude-opus-5-5"], { env, encoding: "utf8" });
    assert.equal(text, ENVELOPE.result + "\n");
    const rows = readRows(ledger);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "nightly-review");

    // The keychain-locked failure the auth guard exists for: its text must
    // still reach the guard verbatim, and no row is written.
    fs.writeFileSync(json, JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }));
    assert.equal(execFileSync("node", [cli, "nightly-review", json], { env, encoding: "utf8" }), "Not logged in · Please run /login\n");
    // Plain text (not JSON) passes through unchanged.
    fs.writeFileSync(json, "Not logged in · Please run /login\n");
    assert.equal(execFileSync("node", [cli, "nightly-review", json], { env, encoding: "utf8" }), "Not logged in · Please run /login\n");
    // A killed run leaves an empty file: empty out, exit 0.
    fs.writeFileSync(json, "");
    assert.equal(execFileSync("node", [cli, "nightly-review", json], { env, encoding: "utf8" }), "");
    assert.equal(readRows(ledger).length, 1, "only the real run wrote a row");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A throwaway $HOME whose Dev/edva points at this checkout's code but has its
// own logs, so nothing here touches a real ledger or log.
function fakeHome() {
  const home = tmp();
  const g = path.join(home, "Dev/edva");
  fs.mkdirSync(path.join(g, "agent/logs"), { recursive: true });
  fs.mkdirSync(path.join(g, "agent/ops-agent"), { recursive: true });
  for (const rel of ["bin", "lib", "agent/config", "agent/scripts"]) {
    fs.symlinkSync(path.join(ROOT, rel), path.join(g, rel));
  }
  return { home, g };
}

test("edva-cost-report counts the fork ledger and prices Opus 5.5 at its own rates", () => {
  const { home, g } = fakeHome();
  try {
    const dir = path.join(g, "agent/logs/ephemeral-forks");
    fs.mkdirSync(dir, { recursive: true });
    const row = rowFromResult({ job: "nightly-review", result: ENVELOPE, model: "claude-opus-5-5", now: new Date() });
    fs.writeFileSync(path.join(dir, "job-costs.ndjson"), JSON.stringify(row) + "\n");
    const out = JSON.parse(execFileSync("node", [path.join(ROOT, "bin/edva-cost-report"), "--since", "7d", "--json"],
      { env: { ...process.env, HOME: home }, encoding: "utf8" }));
    const opus = out.by_tier.find((t) => t.tier === "opus");
    assert.equal(opus.dispatches, 1, "the Opus fork must show up as an opus dispatch");
    // $4/$20/$0.20/$5 per Mtok, not Opus 5's $5/$25/$0.50/$6.25.
    const expected = (1500 * 4 + 200_100 * 20 + 10_000_000 * 0.2 + 400_000 * 5) / 1e6;
    assert.ok(Math.abs(opus.weighted_cost_usd - expected) < 0.01, `weighted ${opus.weighted_cost_usd} vs ${expected}`);
    assert.ok(!out.coverage.blind_tiers.includes("opus"), "opus is measured now, not a blind tier");
    assert.ok(JSON.stringify(out.jobs).includes("nightly-review"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("run-ephemeral-opus.sh runs the pinned model with JSON output, records a row, logs the text", () => {
  const { home, g } = fakeHome();
  try {
    const argsFile = path.join(home, "claude-args");
    const fake = path.join(home, "fake-claude");
    // `auth status` answers as a Max login, or the Max-only guard refuses the run.
    fs.writeFileSync(fake, `#!/bin/bash\nif [ "$1" = auth ]; then echo '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}'; exit 0; fi\necho "$@" > ${JSON.stringify(argsFile)}\ncat > /dev/null\ncat <<'JSON'\n${JSON.stringify(ENVELOPE)}\nJSON\n`);
    fs.chmodSync(fake, 0o755);
    const md = path.join(home, "job.md");
    fs.writeFileSync(md, "# test job\n");
    execFileSync("/bin/bash", [path.join(ROOT, "agent/scripts/lib/run-ephemeral-opus.sh"), "fork-test", md],
      { env: { ...process.env, HOME: home, CLAUDE_BIN: fake }, encoding: "utf8" });

    const args = fs.readFileSync(argsFile, "utf8");
    const { MODELS } = require("../lib/models.cjs");
    assert.ok(args.includes(`--model ${MODELS.opus}`), args);
    assert.ok(args.includes("--output-format json"), args);

    const rows = readRows(path.join(g, "agent/logs/ephemeral-forks/job-costs.ndjson"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "fork-test");
    assert.ok(rows[0].models.includes("claude-opus-5-5"));

    const log = fs.readFileSync(path.join(g, "agent/logs/fork-test.log"), "utf8");
    assert.ok(log.includes("Nothing left uncommitted."), "the run's text reaches the log, not the JSON envelope");
    assert.ok(!log.includes('"modelUsage"'), "the raw envelope must not be what the guard and log see");
    assert.ok(log.includes("exit 0"), log);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
