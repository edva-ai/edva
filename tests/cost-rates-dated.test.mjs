// cost-rates-dated.test.mjs — the cost tools price a token at the rate in
// force when it was spent (a self-improvement review, item 13).
//
// On 2026-10-07 Anthropic cut Sonnet 5.5 cache reads from $0.20 to $0.10 per
// Mtok and launched Haiku 5.5 (claude-haiku-5-5). All three cost tools kept
// $0.20 for every Sonnet 5.5 cache read, overstating Sonnet by ~$41 a week,
// and none could price Haiku 5.5: the report fell back to Haiku 4.5's rate and
// the two transcript scanners dropped its tokens altogether.
//
// Run: node --test tests/cost-rates-dated.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { REPO_ROOT as ROOT } from "../lib/root.cjs";
const near = (got, want, what) => assert.ok(Math.abs(got - want) < 0.005, `${what}: ${got} vs ${want}`);

// A throwaway $HOME whose Dev/edva points at this checkout's code but has its
// own logs and transcripts, so nothing here reads a real ledger or session.
function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cost-rates-"));
  const g = path.join(home, "Dev/edva");
  fs.mkdirSync(path.join(g, "agent/logs"), { recursive: true });
  fs.mkdirSync(path.join(g, "agent/ops-agent"), { recursive: true });
  fs.mkdirSync(path.join(g, "data"), { recursive: true });
  for (const rel of ["bin", "lib", "agent/config", "agent/scripts"]) {
    fs.symlinkSync(path.join(ROOT, rel), path.join(g, rel));
  }
  return { home, g };
}

// Sonnet 5.5 the day before and the day after the cut, Sonnet 5 after it (its
// cache read never changed), and Haiku 5.5 on each side of its 100k-token
// prompt threshold.
const ROWS = [
  { source: "sonnet55-before", ts: "2026-10-06T12:00:00.000Z", models: ["claude-sonnet-5-5"], input_tokens: 1000, output_tokens: 10_000, cache_read_tokens: 10_000_000, cache_creation_tokens: 100_000 },
  { source: "sonnet55-after", ts: "2026-10-08T12:00:00.000Z", models: ["claude-sonnet-5-5", "claude-haiku-4-5-20251001"], input_tokens: 1000, output_tokens: 10_000, cache_read_tokens: 10_000_000, cache_creation_tokens: 100_000 },
  { source: "sonnet5-after", ts: "2026-10-08T12:00:00.000Z", models: ["claude-sonnet-5"], input_tokens: 1000, output_tokens: 10_000, cache_read_tokens: 10_000_000, cache_creation_tokens: 100_000 },
  { source: "haiku55-short", ts: "2026-10-08T12:00:00.000Z", models: ["claude-haiku-5-5"], input_tokens: 1000, output_tokens: 1_000_000, cache_read_tokens: 60_000, cache_creation_tokens: 20_000 },
  { source: "haiku55-long", ts: "2026-10-08T12:00:00.000Z", models: ["claude-haiku-5-5"], input_tokens: 1000, output_tokens: 100_000, cache_read_tokens: 5_000_000, cache_creation_tokens: 200_000 },
].map((r, i) => ({ dispatch_id: `d${i}`, short_id: `s${i}`, session_id: `sess-${i}`, duration_ms: 1000, num_turns: 3,
  total_cost_usd: 1, session_cumulative_cost_usd: 1, web_search_requests: 0, terminal_reason: "completed", ...r }));

test("edva-cost-report: Sonnet 5.5 cache reads are $0.10 from 2026-10-07, Haiku 5.5 has its own rate", () => {
  const { home, g } = fakeHome();
  try {
    const dir = path.join(g, "agent/logs/supervisor-ops-light");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "job-costs.ndjson"), ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const out = JSON.parse(execFileSync("node", [path.join(ROOT, "bin/edva-cost-report"), "--since", "2026-10-01", "--json"],
      { env: { ...process.env, HOME: home }, encoding: "utf8" }));
    const job = (s) => out.jobs.find((j) => j.source === s).weighted_cost_usd;
    // $2 in / $10 out / $2.50 5m write either side; only the cache read moved.
    const rest = (1000 * 2 + 10_000 * 10 + 100_000 * 2.5) / 1e6;
    near(job("sonnet55-before"), rest + 10_000_000 * 0.20 / 1e6, "Sonnet 5.5 before the cut keeps $0.20");
    near(job("sonnet55-after"), rest + 10_000_000 * 0.10 / 1e6, "Sonnet 5.5 after the cut is $0.10");
    near(job("sonnet5-after"), rest + 10_000_000 * 0.20 / 1e6, "Sonnet 5 never changed");
    // Whole row under 100k prompt tokens: every request in it was short.
    near(job("haiku55-short"), (1000 * 0.10 + 1_000_000 * 0.50 + 60_000 * 0.01 + 20_000 * 0.125) / 1e6, "Haiku 5.5 short prompt");
    // Over it, the per-request split is unknown: priced at the long-prompt rate.
    near(job("haiku55-long"), (1000 * 0.50 + 100_000 * 2.50 + 5_000_000 * 0.05 + 200_000 * 0.625) / 1e6, "Haiku 5.5 long prompt");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// One transcript line per API request, in the shape Claude Code writes.
const line = (id, model, ts, usage) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, role: "assistant", usage } });
const userLine = (text) => JSON.stringify({ type: "user", timestamp: "2026-10-06T11:59:00.000Z", message: { role: "user", content: text } });
const U = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });

// Expected list USD for the transcript below, at the rates in force.
const SONNET_BEFORE = (1000 * 2 + 10_000 * 10 + 100_000 * 2.5 + 10_000_000 * 0.20) / 1e6;
const SONNET_AFTER = (1000 * 2 + 10_000 * 10 + 100_000 * 2.5 + 10_000_000 * 0.10) / 1e6;
const HAIKU_SHORT = (1000 * 0.10 + 1_000_000 * 0.50 + 60_000 * 0.01 + 20_000 * 0.125) / 1e6;
const HAIKU_LONG = (1000 * 0.50 + 100_000 * 2.50 + 5_000_000 * 0.05 + 200_000 * 0.625) / 1e6;

test("edva-allowance-coverage prices each transcript request at its own date and prompt length", () => {
  const { home } = fakeHome();
  try {
    const proj = path.join(home, ".claude/projects/-Users-operator-Dev-edva");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "a.jsonl"), [
      userLine("hello"),
      line("m1", "claude-sonnet-5-5", "2026-10-06T12:00:00.000Z", U(1000, 10_000, 10_000_000, 100_000)),
      line("m2", "claude-sonnet-5-5", "2026-10-08T12:00:00.000Z", U(1000, 10_000, 10_000_000, 100_000)),
      line("m3", "claude-haiku-5-5", "2026-10-08T12:00:00.000Z", U(1000, 1_000_000, 60_000, 20_000)),
      line("m4", "claude-haiku-5-5", "2026-10-08T12:00:00.000Z", U(1000, 100_000, 5_000_000, 200_000)),
    ].join("\n") + "\n");
    const out = JSON.parse(execFileSync("node", [path.join(ROOT, "bin/edva-allowance-coverage"), "--since", "2026-10-01T00:00:00Z", "--json"],
      { env: { ...process.env, HOME: home }, encoding: "utf8" }));
    near(out.account_usd_list, SONNET_BEFORE + SONNET_AFTER + HAIKU_SHORT + HAIKU_LONG, "account list USD");
    // The Haiku 5.5 tokens are counted, not skipped as an unknown id.
    assert.equal(out.account_tokens, 2 * (1000 + 10_000 + 10_000_000 + 100_000) + (1000 + 1_000_000 + 60_000 + 20_000) + (1000 + 100_000 + 5_000_000 + 200_000));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
