// hum-ideas — who owns a hum improvement idea: questions in the chat, safe
// changes applied automatically, high-risk ones as a card, big structural ones
// in the weekly review. (This installation's reconcile and weekly-brief bins:
// hum-ideas-local.test.mjs.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeFor, manualScope, pickAsk, lastAsks, ASK_COOLDOWN_H, ASK_MAX_PER_DAY, REASK_AFTER_DAYS } from "../lib/hum-ideas.mjs";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin");
const MANUAL = manualScope();
const idea = (o) => ({ id: "i", scope: "edva_autonomous", risk: "low", effort: "quick", status: "proposed", ...o });

test("routeFor: each kind of idea has exactly one home", () => {
  assert.equal(routeFor(idea({})), "build_auto");
  assert.equal(routeFor(idea({ risk: "moderate", effort: "half-day" })), "build_auto");
  assert.equal(routeFor(idea({ risk: "high" })), "build_card");
  assert.equal(routeFor(idea({ scope: MANUAL })), "ask_in_chat");
  assert.equal(routeFor(idea({ scope: MANUAL, status: "approved" })), "build");
  assert.equal(routeFor(idea({ effort: "multi-day" })), "weekly_email");
  assert.equal(routeFor(idea({ scope: MANUAL, effort: "multi-day" })), "weekly_email");
  assert.equal(routeFor(idea({ effort: undefined })), "weekly_email");
  assert.equal(routeFor(idea({ status: "awaiting_approval" })), "reconcile");
  for (const status of ["applied", "superseded", "declined", "no_change_recommended"]) assert.equal(routeFor(idea({ status })), "done");
});

// The manual scope is manual_<owner_id>: generic by default, and an
// installation whose ledger predates the generic name keeps its own value.
test("manualScope: manual_user by default, manual_<owner_id> per installation", () => {
  const scopeWith = (inst) => {
    const dir = mkdtempSync(join(tmpdir(), "hum-ideas-local-"));
    if (inst) writeFileSync(join(dir, "instance.json"), JSON.stringify(inst));
    const env = { ...process.env, EDVA_LOCAL_DIR: dir };
    delete env.EDVA_OWNER_ID; delete env.EDVA_OWNER_NAME;
    const lib = new URL("../lib/hum-ideas.mjs", import.meta.url).href;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(lib)}); const s = m.manualScope(); process.stdout.write(s + " " + m.routeFor({ scope: s, status: "proposed", effort: "quick" }) + " " + m.routeFor({ scope: "manual_user", status: "proposed", effort: "quick" }));`], { env, encoding: "utf8" });
    return r.stdout;
  };
  assert.equal(scopeWith(null), "manual_user ask_in_chat ask_in_chat");
  assert.equal(scopeWith({ owner_name: "Alex" }), "manual_alex ask_in_chat none");
  assert.equal(scopeWith({ owner_name: "Alex", owner_id: "legacy" }), "manual_legacy ask_in_chat none");
});

const NOW = Date.parse("2026-10-10T12:00:00Z");
const sent = (id, ts) => JSON.stringify({ ts, outcome: { sent: true }, sonnet: { dedup_key: `hum_asks:${id}` } });
const ask = (id, o) => idea({ id, scope: MANUAL, proposed_at: "2026-06-01", ...o });

test("pickAsk: easiest yes first, then oldest; nothing when nothing waits", () => {
  const ideas = [ask("hi", { risk: "high" }), ask("lo-new", { risk: "low", proposed_at: "2026-08-01" }), ask("lo-old", { risk: "low" }), idea({ id: "auto" })];
  assert.equal(pickAsk(ideas, "", NOW).idea.id, "lo-old");
  assert.equal(pickAsk(ideas, "", NOW).waiting, 3);
  assert.ok(pickAsk([idea({})], "", NOW).none);
});

test("pickAsk: one ask per cooldown, and an unanswered idea waits before it is asked again", () => {
  const ideas = [ask("a"), ask("b", { proposed_at: "2026-07-01" })];
  const justNow = new Date(NOW - 5 * 3600000).toISOString();
  assert.match(pickAsk(ideas, sent("a", justNow), NOW).none, /cooldown/);
  const past = new Date(NOW - (ASK_COOLDOWN_H + 1) * 3600000).toISOString();
  assert.equal(pickAsk(ideas, sent("a", past), NOW).idea.id, "b"); // a was asked, b was not
  const long = new Date(NOW - (REASK_AFTER_DAYS + 1) * 86400000).toISOString();
  assert.equal(pickAsk(ideas, sent("a", long), NOW).idea.id, "a"); // a unanswered for a week: ask again
  // A tick that did not send, or another lane's ping, is not an ask.
  const notSent = JSON.stringify({ ts: justNow, outcome: { sent: false }, sonnet: { dedup_key: "hum_asks:a" } });
  assert.equal(lastAsks(notSent).lastAnyMs, 0);
});

test("pickAsk: a couple a day is allowed spaced out, never a third", () => {
  const ideas = [ask("a"), ask("b", { proposed_at: "2026-07-01" }), ask("c", { proposed_at: "2026-08-01" })];
  assert.equal(ASK_MAX_PER_DAY, 2);
  const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
  // One ask yesterday evening and the cooldown has passed: ask again today.
  const one = sent("a", hoursAgo(ASK_COOLDOWN_H + 1));
  assert.equal(pickAsk(ideas, one, NOW).idea.id, "b");
  // Two inside 24h: that is the day's allowance, even though the cooldown has passed.
  const two = [sent("a", hoursAgo(23)), sent("b", hoursAgo(ASK_COOLDOWN_H + 1))].join("\n");
  assert.match(pickAsk(ideas, two, NOW).none, /max 2/);
  // The same two, once the older one is more than 24h old, free a slot.
  const aged = [sent("a", hoursAgo(25)), sent("b", hoursAgo(ASK_COOLDOWN_H + 1))].join("\n");
  assert.equal(pickAsk(ideas, aged, NOW).idea.id, "c");
});

test("hum_asks: the idea's reasoning goes out dated, never as today's state", () => {
  // 2026-10-11: labelled "What is wrong today", a May 31 metric snapshot became
  // "lately very little of it seems to land with you" in a delivered question.
  const dir = mkdtempSync(join(tmpdir(), "hask-"));
  const f = join(dir, "ideas.jsonl"), r = join(dir, "runs.jsonl");
  writeFileSync(f, JSON.stringify(ask("x", { risk: "moderate", proposed_at: "2026-05-31T13:27:25.563461Z", hypothesis: "A week at signal_per_surfaced~0." })) + "\n");
  writeFileSync(r, "");
  const res = spawnSync(process.execPath, [join(BIN, "../agent/scripts/hum-harvesters/hum_asks.mjs")], {
    input: "{}", encoding: "utf8",
    env: { ...process.env, HUM_IDEAS_FILE: f, HUM_RUNS_FILE: r, HUM_HARVEST_PREVIEW: "1" },
  });
  assert.equal(res.status, 0, res.stderr);
  const c = JSON.parse(res.stdout);
  assert.equal(c.dedup_key, "hum_asks:x");
  assert.ok(c.signal.includes("as written on 2026-05-31"), c.signal);
  assert.ok(!c.signal.includes("What is wrong today"), c.signal);
  // The real date rides along, so hum-ping stamps --evidence-as-of with it.
  assert.equal(c.supporting_data.evidence_as_of, "2026-05-31T13:27:25.563461Z");
});

function decide(args, rows, runs = []) {
  const dir = mkdtempSync(join(tmpdir(), "hid-"));
  const f = join(dir, "ideas.jsonl"), r = join(dir, "runs.jsonl");
  writeFileSync(f, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(r, runs.join("\n") + "\n");
  const res = spawnSync(process.execPath, [join(BIN, "hum-idea-decide"), ...args], { encoding: "utf8", env: { ...process.env, HUM_IDEAS_FILE: f, HUM_RUNS_FILE: r } });
  return { ...res, ledger: readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}

test("hum-idea-decide: a yes in chat approves the idea the question was about", () => {
  const run = JSON.stringify({ ts: "2026-10-09T10:00:00Z", outcome: { sent: true, question_id: "q-1" }, sonnet: { dedup_key: "hum_asks:x" } });
  const res = decide(["--question", "q-1", "approve", "--note", "yes do it"], [ask("x")], [run]);
  assert.equal(res.status, 0, res.stderr);
  const last = res.ledger.at(-1);
  assert.equal(last.id, "x");
  assert.equal(last.status, "approved");
  assert.equal(last.decision_note, "yes do it");
});

test("hum-idea-decide: an answer that says HOW, not just yes, rides along as the spec", () => {
  const run = JSON.stringify({ ts: "2026-10-09T10:00:00Z", outcome: { sent: true, question_id: "q-3" }, sonnet: { dedup_key: "hum_asks:x" } });
  const how = "Only the non-essential lanes, and keep health and money as they are. ".repeat(10).trim();
  const res = decide(["--question", "q-3", "approve", "--note", how], [ask("x")], [run]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.ledger.at(-1).status, "approved");
  assert.equal(res.ledger.at(-1).decision_note, how.slice(0, 800));
});

test("hum-idea-decide: a no closes it; a question that was not an improvement ask is refused", () => {
  assert.equal(decide(["x", "decline"], [ask("x")]).ledger.at(-1).status, "declined");
  const other = JSON.stringify({ ts: "2026-10-09T10:00:00Z", outcome: { sent: true, question_id: "q-2" }, sonnet: { dedup_key: "idea_feedback:foo" } });
  const res = decide(["--question", "q-2", "approve"], [ask("x")], [other]);
  assert.equal(res.status, 3);
  assert.equal(res.ledger.length, 1); // nothing written
});

test("hum-idea-decide: an idea that is not waiting on a decision is left alone", () => {
  const res = decide(["x", "approve"], [ask("x", { status: "applied" })]);
  assert.equal(res.status, 3);
  assert.equal(res.ledger.length, 1);
});
