// hum-chat-inbound — the chat agent's Hum Inbound bookkeeping, in code:
// the [Hum state] block (windows precomputed) and hum-ideas-resolve. The agent
// keeps only the reading of the user's words.
//
// Run: node --test tests/hum-chat-inbound.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { humStateBlock } from "../lib/hum-reply-target.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hum-inbound-"));
const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const NOW = Date.parse("2026-10-04T18:00:00Z");
const ago = (m) => new Date(NOW - m * 60000).toISOString();
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const bin = (name, args, dir) => spawnSync(process.execPath, [path.join(HERE, "../bin", name), ...args], { encoding: "utf8", env: { ...process.env, EDVA_DATA_DIR: dir } });

test("[Hum state] is empty when nothing is open", () => {
  const d = tmp(); dirs.push(d);
  assert.equal(humStateBlock(d, NOW), "");
});

test("[Hum state] states the question, the reaction window and the open ideas ping", () => {
  const d = tmp(); dirs.push(d);
  fs.writeFileSync(path.join(d, "hum-pending-question.json"), JSON.stringify({ id: "q-1", question: "How was the dinner?", asked_at: ago(30), expires_at: new Date(NOW + 3600e3).toISOString() }));
  fs.writeFileSync(path.join(d, "hum-feedback.jsonl"), jl([
    { ping_id: "p-idea", sent_at: ago(200), lane: "ideas", reaction: null, findings: [{ dedup_key: "idea-1" }] },
    { ping_id: "p-new", sent_at: ago(45), lane: "dining", reaction: null, findings: [{ dedup_key: "dining:x" }] },
  ]));
  const b = humStateBlock(d, NOW);
  assert.match(b, /^\[Hum state\]/);
  assert.match(b, /hum-answer q-1/); // lang-regex-ok: asserts on our own generated routing text, not the user's words
  assert.match(b, /edva hum feedback p-new <token>/);
  assert.match(b, /hum-ideas-resolve p-idea/);
});

test("2–6h old ping is flagged ambiguous; expired question says clear", () => {
  const d = tmp(); dirs.push(d);
  fs.writeFileSync(path.join(d, "hum-pending-question.json"), JSON.stringify({ id: "q-2", expires_at: ago(5) }));
  fs.writeFileSync(path.join(d, "hum-feedback.jsonl"), jl([{ ping_id: "p-old", sent_at: ago(180), lane: "art", reaction: null }]));
  const b = humStateBlock(d, NOW);
  assert.match(b, /EXPIRED.*hum-answer --clear/); // lang-regex-ok: asserts on our own generated routing text, not the user's words
  assert.match(b, /AMBIGUOUS/);
});

test("an expired question about changing hum is still answerable (--late); any other expired question says clear", () => {
  const d = tmp(); dirs.push(d);
  fs.writeFileSync(path.join(d, "hum-pending-question.json"), JSON.stringify({ id: "q-imp", question: "Want fewer, better pings?", memory_hook: "hum_improvement:hum-i-1", asked_at: ago(240), expires_at: ago(225) }));
  const b = humStateBlock(d, NOW);
  assert.match(b, /hum-answer q-imp --late/); // lang-regex-ok: asserts on our own generated routing text, not the user's words
  assert.doesNotMatch(b, /has EXPIRED/); // lang-regex-ok: asserts on our own generated routing text, not the user's words
  fs.writeFileSync(path.join(d, "hum-pending-question.json"), JSON.stringify({ id: "q-x", question: "Did the meeting happen?", memory_hook: "event_recap", asked_at: ago(240), expires_at: ago(225) }));
  assert.match(humStateBlock(d, NOW), /EXPIRED.*hum-answer --clear/); // lang-regex-ok: asserts on our own generated routing text, not the user's words
});

test("hum-ideas-resolve sweeps siblings by task_id AND thread_id and writes resolved-topics", () => {
  const d = tmp(); dirs.push(d);
  fs.writeFileSync(path.join(d, "hum-feedback.jsonl"), jl([{ ping_id: "p-1", sent_at: ago(10), lane: "ideas", findings: [{ dedup_key: "idea-a" }] }]));
  fs.writeFileSync(path.join(d, "hum-ideas.jsonl"), jl([
    { id: "idea-a", subject: "vendor email", supporting_data: { task_id: "t1", thread_id: "th1" } },
    { id: "idea-a", consumed: true },
    { id: "idea-b", supporting_data: { gmail_thread_id: "th1" } },
    { id: "idea-c", supporting_data: { task_id: "t1" } },
    { id: "idea-d", supporting_data: { task_id: "other" } },
    { id: "idea-e", supporting_data: { thread_id: "th1" }, consumed: true },
  ]));
  const r = bin("hum-ideas-resolve", ["p-1", "--resolution", "already replied to them"], d);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.swept.sort(), ["idea-b", "idea-c"]);
  const topics = fs.readFileSync(path.join(d, "hum-resolved-topics.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(topics[0].thread_id, "th1");
  assert.equal(topics[0].topic, "vendor email");
});

test("hum-ideas-resolve exits 3 for an unknown ping", () => {
  const d = tmp(); dirs.push(d);
  assert.equal(bin("hum-ideas-resolve", ["p-x", "--resolution", "x"], d).status, 3);
});
