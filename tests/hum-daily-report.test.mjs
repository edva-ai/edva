// hum-daily-report — the nightly chronicle is arithmetic over the current
// trace shape; pin the counting, joins and the deterministic "notable" pick.
// A made-up installation (UTC: the report's day boundary), the same in every checkout.
import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, renderHtml } from "../lib/hum-daily-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const END = Date.parse("2026-10-05T03:00:00Z");
const START = END - 24 * 3600 * 1000;

const runs = [
  { ts: "2026-10-04T14:00:00Z", harvest: { attempted: ["art", "dining"], candidates: [{ topic: "art", urgency: 0.7, signal: "Museum opening" }, { topic: "dining", urgency: 0.3, signal: "x" }] },
    sonnet: { decision: "info", subject: "museum-opening", based_on_topic: "art", score: 0.8, rationale: "fresh" }, outcome: { sent: true, ping_id: "p-1" } },
  { ts: "2026-10-04T15:00:00Z", harvest: { attempted: ["art"], errors: [{ topic: "art", err: "timeout" }] },
    sonnet: { decision: "silent", near_miss_candidates: [{ topic: "music", score: 0.5, signal: "Concert" }], silent_root_cause: "all_below_threshold" }, outcome: { sent: false } },
  { ts: "2026-10-04T16:00:00Z", harvest: { attempted: ["location"], candidates: [{ topic: "location", urgency: 0.6, signal: "stop?" }] },
    sonnet: { decision: "question", subject: "were-you-at", based_on_topic: "location", score: 0.6, memory_hook: "place" }, outcome: { sent: true, question_id: "q-1" } },
  { ts: "2026-10-03T01:00:00Z", sonnet: { decision: "info" }, outcome: { sent: true } }, // out of window
  { ts: "2026-10-04T17:00:00Z", mode: "canary", decision: "CANARY_ASKED" }, // canary rows are not ticks
];

test("aggregate counts decisions, harvesters, joins feedback and learnings", () => {
  const a = aggregate({
    runs,
    feedback: [{ ping_id: "p-1", sent_at: "2026-10-04T14:00:05Z", reaction: "helpful", reaction_at: "2026-10-04T14:10:00Z" }],
    learnings: [{ id: "q-1", answer: "yes, the usual place" }],
    pending: null, audit: { healthy: true, pings_sent_in_runs: 1, pings_logged_in_feedback: 1 },
    startMs: START, endMs: END,
  });
  assert.equal(a.ticks, 3);
  assert.deepEqual({ ...a.decisions }, { silent: 1, info: 1, question: 1, error: 0, legacy: 0 });
  const art = a.harvesters.find((h) => h.topic === "art");
  assert.deepEqual({ attempts: art.attempts, errors: art.errors, candidates: art.candidates, wins: art.wins }, { attempts: 2, errors: 1, candidates: 1, wins: 1 });
  assert.equal(a.discoveries.length, 2); // urgency >= 0.5 only
  assert.equal(a.pings[0].reaction, "helpful");
  assert.equal(a.questions[0].answered, true);
  assert.equal(a.heldBack[0].topic, "music");
  assert.equal(a.reactions.up, 1);
  assert.match(a.notable, /^museum-opening \(art\)/);
});

test("render escapes HTML and includes every section", () => {
  const a = aggregate({ runs: [{ ts: "2026-10-04T14:00:00Z", harvest: { candidates: [{ topic: "art", urgency: 0.9, signal: "<script>" }] }, sonnet: { decision: "silent" }, outcome: { sent: false } }],
    feedback: [], learnings: [], pending: null, audit: null, startMs: START, endMs: END });
  const html = renderHtml(a, { dateLabel: "2026-10-04", startMs: START, endMs: END });
  assert.ok(!html.includes("<script>"));
  for (const s of ["TL;DR", "What hum noticed", "Proactive pulses sent", "Questions asked", "Held back", "Harvester activity", "Reactions", "Plumbing health", "Pending"]) assert.ok(html.includes(s), s);
});

test("bin --dry-run renders from HUM_RUNS_FILE without sending", () => {
  const dir = mkdtempSync(join(tmpdir(), "hum-daily-"));
  const file = join(dir, "hum-runs.jsonl");
  writeFileSync(file, runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = spawnSync(process.execPath, [resolve(HERE, "../bin/hum-daily-run"), "--dry-run"], {
    encoding: "utf8", env: { ...process.env, HUM_RUNS_FILE: file, HUM_DAILY_DATA_DIR: dir, HUM_DAILY_NOW: new Date(END).toISOString() },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /only 3 ticks/); // below MIN_TICKS -> short form
});

test("hum-daily-run records one row per date to hum-daily.jsonl and sends nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hum-daily-"));
  const file = join(dir, "hum-runs.jsonl");
  writeFileSync(file, "");
  const env = { ...process.env, HUM_RUNS_FILE: file, HUM_DAILY_DATA_DIR: dir, HUM_DAILY_NOW: "2026-10-05T23:30:00Z", PATH: "/nonexistent" };
  for (let i = 0; i < 2; i++) {
    const r = spawnSync(process.execPath, [resolve(HERE, "../bin/hum-daily-run")], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /recorded 2026-10-05/);
  }
  const rows = readFileSync(join(dir, "hum-daily.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1, "re-run the same day replaces, never duplicates");
  assert.equal(rows[0].date, "2026-10-05");
  assert.equal(rows[0].low_ticks, true);
});
