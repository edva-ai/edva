// hum-topic-match.test.mjs — embedding topic matching for the ideas reservoir
// (ideation Rules 10/11 and the hum-reservoir-review sweep), 2026-10-04.
// No Ollama needed: the matcher is pure over vectors, and the CLIs are tested
// in their embedder-down (fail-safe) direction via a dead OLLAMA_URL.
// Run: node --test tests/hum-topic-match.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { embedAll, nearest, resolvedText, sweepMatches, ideaText } from "../lib/hum-topic-match.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const DEAD = { OLLAMA_URL: "http://127.0.0.1:9" };
const bin = (name, args, dir, extra = {}) => spawnSync(process.execPath, [path.join(HERE, "../bin", name), ...args], { encoding: "utf8", env: { ...process.env, EDVA_DATA_DIR: dir, ...extra }, input: extra.__input });

// unit vectors at a given angle from [1,0] → cosine = cos(angle)
const at = (cos) => [cos, Math.sqrt(1 - cos * cos)];

test("sweepMatches keeps only ideas above the floor, best first", () => {
  const rows = [{ id: "a", subject: "A", vec: at(0.95) }, { id: "b", subject: "B", vec: at(0.5) }, { id: "c", subject: "C", vec: at(0.85) }];
  const r = sweepMatches([1, 0], rows, { threshold: 0.8, max: 6 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.matched.map((m) => m.id), ["a", "c"]);
});

test("sweepMatches refuses a too-broad topic instead of emptying the reservoir", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: `i${i}`, vec: at(0.9) }));
  const r = sweepMatches([1, 0], rows, { threshold: 0.8, max: 6 });
  assert.match(r.refused, /too broad: 8/);
});

test("nearest finds the max-cosine row", () => {
  const n = nearest([1, 0], [{ id: "x", vec: at(0.3) }, { id: "y", vec: at(0.9) }]);
  assert.equal(n.best.id, "y");
  assert.ok(Math.abs(n.sim - 0.9) < 1e-9);
  assert.equal(nearest([1, 0], []).best, null);
});

test("embedAll reports the embedder down when the first embed fails, and skips later gaps", async () => {
  const down = await embedAll([{ id: "a", text: "x" }], { embedFn: async () => null });
  assert.equal(down.available, false);
  let n = 0;
  const partial = await embedAll([{ id: "a", text: "x" }, { id: "b", text: "y" }, { id: "c", text: "" }], { embedFn: async () => (n++ === 1 ? null : [1, 0]) });
  assert.equal(partial.available, true);
  assert.deepEqual(partial.rows.map((r) => r.id), ["a"]);
  assert.equal((await embedAll([])).available, true);
});

test("resolvedText prefers the topic phrase, falls back to legacy keywords", () => {
  assert.equal(resolvedText({ topic: "permit email", keywords: ["x"] }), "permit email");
  assert.equal(resolvedText({ keywords: ["google", "tv"] }), "google tv");
  assert.equal(ideaText({ subject: " A friend's birthday " }), "A friend's birthday");
});

test("hum-reservoir-review consumes NOTHING when the embedder is down (exit 3)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hum-review-")); dirs.push(d);
  const rows = jl([{ id: "idea-a", subject: "Acclaimed jazz show" }, { id: "idea-b", subject: "Claim the deposit" }]);
  fs.writeFileSync(path.join(d, "hum-ideas.jsonl"), rows);
  const r = bin("hum-reservoir-review", ["--topic", "claim", "--json"], d, DEAD);
  assert.equal(r.status, 3, r.stderr);
  assert.match(JSON.parse(r.stdout).refused, /embedder unavailable/);
  assert.equal(fs.readFileSync(path.join(d, "hum-ideas.jsonl"), "utf8"), rows);
});

test("hum-reservoir-review requires a topic (exit 2); legacy positional words still parse", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hum-review-")); dirs.push(d);
  fs.writeFileSync(path.join(d, "hum-ideas.jsonl"), jl([{ id: "idea-a", subject: "x" }]));
  assert.equal(bin("hum-reservoir-review", ["--reason", "r"], d, DEAD).status, 2);
  const legacy = bin("hum-reservoir-review", ["google", "tv", "--reason", "done", "--json"], d, DEAD);
  assert.equal(JSON.parse(legacy.stdout).topic, "google tv");
});

test("hum-ideas-append still writes when the embedder is down (Rules 1/10/11 fail open)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hum-append-")); dirs.push(d);
  const now = Date.now();
  fs.writeFileSync(path.join(d, "hum-ideas-digest.json"), JSON.stringify({ unconsumed: [{ id: "idea-old", subject: "A friend's birthday is Tuesday" }], consumed_recent: [{ id: "idea-c", subject: "Book the dentist" }] }));
  fs.writeFileSync(path.join(d, "hum-resolved-topics.jsonl"), jl([{ topic: "permit email", suppress_until: new Date(now + 3600e3).toISOString() }]));
  const idea = { id: "idea-new", subject: "A friend's birthday is tomorrow", rationale: "r", why_now: "w", category: "family", idea_lens: "adapt", urgency: 0.5, draws_on: ["calendar"], supporting_data: {}, confidence: "high" };
  const r = bin("hum-ideas-append", ["--no-claim-check"], d, { ...DEAD, __input: JSON.stringify(idea) });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.deepEqual(out.written, ["idea-new"]);
  assert.equal(out.novelty_checked, false);
});
