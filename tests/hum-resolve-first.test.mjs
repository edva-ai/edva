// hum-resolve-first.test.mjs — the "work it out before asking" gate.
//
// The rule: work out the answer before asking, for EVERY question and hum
// comment before it is floated. The model reads; code owns the citation check,
// the action table, fail-open, the privacy redaction and the memory. All of
// that is pinned here with a stubbed model and a stubbed bundle — no network,
// no claude, no real data files.
//
// Run: node --test tests/hum-resolve-first.test.mjs

// A made-up installation with no prompt wording of its own (the kernel
// defaults), the same in every checkout.
import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  laneOf, kindOf, isPrivateLane, validateVerdict, decideAction, resolveFirst, buildPrompt,
  logRow, rememberIfSettled, writeCaptureArtifacts, readSidecar, sidecarPath,
} from "../lib/hum-resolve-first.mjs";
import { resolvedKeys, recentResolved, forgetResolved, recordResolved } from "../lib/hum-resolve-first-store.mjs";
import { preRankFilter } from "../lib/hum-vetoes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "../bin/hum-resolve-first");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hrf-"));

const QUESTION = "Jordan's month at the Elm Street workshop runs out Mar 31. Are they heading out or extending?";
const SECTIONS = [
  { id: "bookings", title: "Bookings", as_of: "read live", text: "booking 20260225A · Elm Street workshop · booked by: Jordan Reyes · term 2026-03-01 → 2026-03-31" },
  { id: "trip_timeline", title: "Travel", as_of: "read live", text: "a1b2c3d4 transit 2026-03-31 22:05 → 2026-04-01 08:55 [flights] NPT→SVL (Example Air)\ne5f6a7b8 southvale 2026-04-01 08:55 → 2026-04-15" },
];
const gather = async () => [...SECTIONS, { id: "calendar", error: "timeout" }];
const model = (obj) => async () => ({ out: typeof obj === "string" ? obj : JSON.stringify(obj), error: null });
const RESOLVED = {
  floats: "is Jordan leaving", verdict: "resolved", answer: "Booking ends Mar 31; the user lands in Southvale Apr 1 and uses the Elm Street workshop.",
  remaining_gap: null, sources: ["bookings", "trip_timeline"], checked: "the booking and your flight",
  useful_fyi: true, fyi_text: "Jordan's booking ends Mar 31 and your flight lands Apr 1, so the workshop is yours. I checked the booking and your flight.",
  gap_text: null, choices_still_fit: false,
};

// ── machine labels ─────────────────────────────────────────────────────────

test("lane and kind come from the intent label (or the sender's context)", () => {
  assert.equal(laneOf("hum:ideas:jordan"), "ideas");
  assert.equal(laneOf("hum:explore:art"), "art");
  assert.equal(laneOf("p1-email"), "unknown");
  assert.equal(laneOf("hum:ideas:x", { lane: "workshop" }), "workshop");
  assert.equal(kindOf("hum:ideas:question"), "question");
  assert.equal(kindOf("hum:finance:lane-diagnosis"), "question");
  assert.equal(kindOf("hum:nearby:fact"), "ping");
  assert.equal(kindOf("hum:ideas:x", { kind: "question" }), "question");
  assert.equal(isPrivateLane("finance"), true);
  assert.equal(isPrivateLane("health"), true);
  assert.equal(isPrivateLane("ideas"), false);
});

// ── schema check ───────────────────────────────────────────────────────────

test("a resolution must cite a section that was actually in the bundle", () => {
  const ids = new Set(["bookings", "trip_timeline"]);
  assert.equal(validateVerdict(RESOLVED, ids).ok, true);
  const v = validateVerdict({ ...RESOLVED, sources: ["calendar", "made_up"] }, ids);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /cites no section/);
  // [brackets] as printed in the prompt are tolerated
  assert.deepEqual(validateVerdict({ ...RESOLVED, sources: ["[bookings]"] }, ids).verdict.sources, ["bookings"]);
});

test("schema: unknown verdicts, a partial with no gap, an FYI with no text, overlong text", () => {
  const ids = new Set(["bookings"]);
  assert.equal(validateVerdict({ verdict: "maybe" }, ids).ok, false);
  assert.equal(validateVerdict({ verdict: "partial", answer: "x", sources: ["bookings"] }, ids).ok, false);
  assert.equal(validateVerdict({ ...RESOLVED, sources: ["bookings"], fyi_text: null }, ids).ok, false);
  assert.equal(validateVerdict({ ...RESOLVED, sources: ["bookings"], fyi_text: "x".repeat(700) }, ids).ok, false);
  assert.equal(validateVerdict({ verdict: "unresolved", sources: [] }, ids).ok, true);
  assert.equal(validateVerdict({ verdict: "nothing_to_resolve" }, ids).ok, true);
  assert.equal(validateVerdict(null, ids).ok, false);
  assert.equal(validateVerdict([], ids).ok, false);
});

test("the action table", () => {
  assert.deepEqual(decideAction({ verdict: "resolved", useful_fyi: true, fyi_text: "fyi" }),
    { action: "rewrite", text: "fyi", still_question: false, keep_choices: false });
  assert.deepEqual(decideAction({ verdict: "resolved", useful_fyi: false }), { action: "drop" });
  assert.deepEqual(decideAction({ verdict: "partial", gap_text: "gap?", choices_still_fit: true }),
    { action: "rewrite", text: "gap?", still_question: true, keep_choices: true });
  assert.deepEqual(decideAction({ verdict: "unresolved" }), { action: "send" });
  assert.deepEqual(decideAction({ verdict: "unresolved", gap_text: "Are they staying? The booking doesn't say.", choices_still_fit: false }),
    { action: "rewrite", text: "Are they staying? The booking doesn't say.", still_question: true, keep_choices: false });
  assert.deepEqual(decideAction({ verdict: "nothing_to_resolve" }), { action: "send" });
});

// ── the whole pass, stubbed ────────────────────────────────────────────────

const input = { message: QUESTION, intent: "hum:ideas:jordan-workshop-booking", context: { kind: "question", dedup_key: "idea-jordan" } };

test("resolved and worth knowing → rewritten to a short FYI, no longer a question", async () => {
  const d = await resolveFirst(input, { gather, model: model(RESOLVED), killSwitch: false });
  assert.equal(d.action, "rewrite");
  assert.equal(d.still_question, false);
  assert.equal(d.keep_choices, false);
  assert.match(d.text, /yours/);
  assert.deepEqual(d.sources, ["bookings", "trip_timeline"]);
  assert.equal(d.dedup_key, "idea-jordan");
  assert.deepEqual(d.evidence.find((e) => e.id === "calendar"), { id: "calendar", ok: false, error: "timeout" });
});

test("resolved but adds nothing → dropped", async () => {
  const d = await resolveFirst(input, { gather, model: model({ ...RESOLVED, useful_fyi: false, fyi_text: null }), killSwitch: false });
  assert.equal(d.action, "drop");
  assert.equal(d.verdict, "resolved");
});

test("partial → only the gap is asked; choices kept only if the model says they still fit", async () => {
  const partial = { ...RESOLVED, verdict: "partial", useful_fyi: false, fyi_text: null, remaining_gap: "checkout time", gap_text: "When are they handing back the keys?", choices_still_fit: true };
  const d = await resolveFirst(input, { gather, model: model(partial), killSwitch: false });
  assert.equal(d.action, "rewrite");
  assert.equal(d.still_question, true);
  assert.equal(d.keep_choices, true);
  assert.equal(d.text, "When are they handing back the keys?");
});

test("unresolved and nothing-to-resolve → sent as written", async () => {
  for (const verdict of ["unresolved", "nothing_to_resolve"]) {
    const d = await resolveFirst(input, { gather, model: model({ verdict, sources: [] }), killSwitch: false });
    assert.equal(d.action, "send", verdict);
  }
});

test("unresolved question → asked as the specific gap, with what was checked (point 3 of the rule)", async () => {
  const d = await resolveFirst(input, { gather, model: model({ verdict: "unresolved", sources: ["bookings"], checked: "the booking", gap_text: "Is Jordan staying on after Mar 31? The booking doesn't say either way." }), killSwitch: false });
  assert.equal(d.action, "rewrite");
  assert.equal(d.still_question, true);
  assert.match(d.text, /doesn't say/);
});

test("FAIL-OPEN: model down, garbage twice, no records, a throwing bundle, the kill switch", async () => {
  let d = await resolveFirst(input, { gather, model: async () => ({ out: "", error: { kind: "timeout" } }), killSwitch: false });
  assert.equal(d.action, "send"); assert.equal(d.verdict, "error"); assert.match(d.reason, /timeout/);

  let calls = 0;
  d = await resolveFirst(input, { gather, model: async () => { calls++; return { out: "not json", error: null }; }, killSwitch: false });
  assert.equal(d.action, "send"); assert.equal(calls, 2); assert.match(d.reason, /invalid model answer/); // lang-regex-ok: matches our own reason code, not the user's words

  d = await resolveFirst(input, { gather: async () => [{ id: "bookings", error: "down" }], model: model(RESOLVED), killSwitch: false });
  assert.equal(d.action, "send"); assert.match(d.reason, /no records/);

  d = await resolveFirst(input, { gather: async () => { throw new Error("boom"); }, model: model(RESOLVED), killSwitch: false });
  assert.equal(d.action, "send"); assert.match(d.reason, /gate error/);

  d = await resolveFirst(input, { gather, model: model(RESOLVED), killSwitch: true });
  assert.equal(d.action, "send"); assert.equal(d.verdict, "skipped");

  d = await resolveFirst({ message: "  ", intent: "hum:x" }, { gather, model: model(RESOLVED), killSwitch: false });
  assert.equal(d.action, "send");
});

test("a citation of a section that failed to load is not a citation; the retry is used", async () => {
  const answers = [{ ...RESOLVED, sources: ["calendar"] }, RESOLVED];
  const d = await resolveFirst(input, { gather, model: async () => ({ out: JSON.stringify(answers.shift()), error: null }), killSwitch: false });
  assert.equal(d.action, "rewrite");
  assert.equal(d.attempts, 2);
});

test("the prompt carries every loaded section, the rule, and the privacy line only for private lanes", () => {
  const p = buildPrompt({ message: QUESTION, intent: "hum:ideas:x", lane: "ideas", kind: "question", sections: SECTIONS, nowMs: Date.parse("2026-03-15T06:00:00Z"), tz: "America/Denver" });
  assert.ok(p.includes("### [bookings]") && p.includes("### [trip_timeline]"));
  assert.ok(p.includes("work out the answer before asking"));
  assert.ok(p.includes(QUESTION));
  assert.ok(p.includes("Do not add any money amount"), "every lane gets the no-new-figures line");
  assert.ok(!p.includes("private money or health"));
  const priv = buildPrompt({ message: "Fee paid: $40", intent: "hum:finance:fee", lane: "finance", kind: "ping", sections: SECTIONS, isPrivate: true });
  assert.ok(priv.includes("private money or health"));
});

// ── side effects ───────────────────────────────────────────────────────────

test("private lanes keep no text in the log; others keep it", async () => {
  const d = await resolveFirst({ message: "Late fee $40 on the card", intent: "hum:finance:fee" }, { gather, model: model(RESOLVED), killSwitch: false });
  const row = logRow(d);
  assert.equal(row.private, true);
  assert.equal(typeof row.original, "object");
  assert.equal(row.original.len, "Late fee $40 on the card".length);
  assert.equal(typeof row.answer, "object");
  assert.equal(typeof row.sent_text, "object");
  assert.ok(!JSON.stringify(row).includes("$40"));
  const open = logRow(await resolveFirst(input, { gather, model: model(RESOLVED), killSwitch: false }));
  assert.equal(open.original, QUESTION);
});

test("memory: settled answers veto their key for the window; forget lifts it; private rows keep no text", async () => {
  const file = path.join(tmp(), "store.jsonl");
  const d = await resolveFirst(input, { gather, model: model(RESOLVED), killSwitch: false });
  assert.equal(rememberIfSettled(d, { file }), true);
  const sent = await resolveFirst(input, { gather, model: model({ verdict: "unresolved" }), killSwitch: false });
  assert.equal(rememberIfSettled(sent, { file }), false);

  assert.ok(resolvedKeys({ file }).has("idea-jordan"));
  assert.equal(resolvedKeys({ file, nowMs: Date.now() + 8 * 86_400_000 }).size, 0); // past the 7-day window
  assert.equal(recentResolved({ file })[0].question, QUESTION);

  const priv = await resolveFirst({ message: "Fee $40", intent: "hum:finance:fee", context: { dedup_key: "finance:fee:1" } }, { gather, model: model(RESOLVED), killSwitch: false });
  rememberIfSettled(priv, { file });
  assert.ok(resolvedKeys({ file }).has("finance:fee:1"));
  assert.ok(!fs.readFileSync(file, "utf8").includes("$40"));
  assert.ok(recentResolved({ file }).every((r) => !r.private));

  forgetResolved("idea-jordan", { file });
  assert.equal(resolvedKeys({ file }).has("idea-jordan"), false);
  forgetResolved(priv.decision_id, { file });
  assert.equal(resolvedKeys({ file }).has("finance:fee:1"), false);
});

test("a partial resolution is remembered but does not veto (its gap was still worth asking)", () => {
  const file = path.join(tmp(), "store.jsonl");
  recordResolved({ decision_id: "hr-p", verdict: "partial", dedup_key: "k1", answer: "a" }, { file });
  assert.equal(resolvedKeys({ file }).has("k1"), false);
});

test("capture artifacts: a drop writes the tagged sentinel + sidecar, a rewrite only the sidecar, a send clears a stale one", () => {
  const cap = path.join(tmp(), "cap");
  writeCaptureArtifacts(cap, { action: "drop", decision_id: "hr-1", verdict: "resolved", answer: "booking ends Mar 31" });
  const sentinel = JSON.parse(fs.readFileSync(cap, "utf8"));
  assert.equal(sentinel.suppressed, true);
  assert.equal(sentinel.by, "hum-resolve-first");
  assert.equal(readSidecar(cap).action, "drop");
  assert.equal(fs.existsSync(sidecarPath(cap)), false, "readSidecar consumes it");

  const cap2 = path.join(tmp(), "cap");
  writeCaptureArtifacts(cap2, { action: "rewrite", decision_id: "hr-2", verdict: "partial", still_question: true, text: "gap?" });
  assert.equal(fs.existsSync(cap2), false, "the id is edva-send-curl's to write");
  assert.deepEqual(readSidecar(cap2), { by: "hum-resolve-first", decision_id: "hr-2", action: "rewrite", verdict: "partial", still_question: true, text: "gap?" });

  fs.writeFileSync(sidecarPath(cap2), JSON.stringify({ by: "hum-resolve-first", action: "drop" }));
  writeCaptureArtifacts(cap2, { action: "send" });
  assert.equal(readSidecar(cap2), null);
  writeCaptureArtifacts(null, { action: "drop" }); // no capture file: nothing to do, no throw
});

test("pre-rank: a key the gate already settled is vetoed as resolved_first; urgent and Rule #1 lanes pass to be re-judged", async () => {
  const resolved = new Map([
    ["idea-jordan", { ts: "2026-03-15T06:00:00Z", decision_id: "hr-1" }],
    ["travel:XY123:2026-04-01", { ts: "2026-03-15T06:00:00Z", decision_id: "hr-2" }],
  ]);
  const { eligible, vetoed } = await preRankFilter([
    { topic: "ideas", dedup_key: "idea-jordan", urgency: 0.5, signal: "Jordan booking" },
    { topic: "travel", dedup_key: "travel:XY123:2026-04-01", urgency: 0.95, signal: "gate change" },
    { topic: "ideas", dedup_key: "idea-other", urgency: 0.5, signal: "Other" },
  ], {
    nowMs: Date.parse("2026-03-15T08:00:00Z"), feedbackPath: "/nonexistent/fb.jsonl", runsPath: "/nonexistent/runs.jsonl",
    embed: async () => null, checkPingBudget: () => ({ ok: true }), resolvedKeys: resolved, preview: true,
  });
  assert.deepEqual(eligible.map((c) => c.dedup_key), ["travel:XY123:2026-04-01", "idea-other"]);
  assert.deepEqual(vetoed.map((v) => [v.dedup_key, v.gate]), [["idea-jordan", "resolved_first"]]);
});

// ── the CLI, end to end with fixtures ──────────────────────────────────────

function cli(args, stdin, extraEnv = {}) {
  const dir = tmp();
  const ev = path.join(dir, "ev.json");
  const mf = path.join(dir, "model.json");
  fs.writeFileSync(ev, JSON.stringify(SECTIONS));
  fs.writeFileSync(mf, JSON.stringify(extraEnv.__answer || { ...RESOLVED, useful_fyi: false, fyi_text: null }));
  const env = {
    ...process.env,
    HUM_RESOLVE_FIRST_EVIDENCE_FIXTURE: ev, HUM_RESOLVE_FIRST_MODEL_FIXTURE: mf,
    HUM_RESOLVE_FIRST_LOG: path.join(dir, "log.jsonl"), HUM_RESOLVE_FIRST_STORE: path.join(dir, "store.jsonl"),
    HUM_RESOLVE_FIRST_OFF: "0", ...extraEnv,
  };
  delete env.__answer;
  const r = spawnSync(process.execPath, [CLI, ...args], { input: stdin, encoding: "utf8", env });
  return { ...r, dir, out: r.stdout ? JSON.parse(r.stdout.trim().split("\n").pop()) : null };
}

test("CLI: a drop writes the sentinel, the log row and the memory; exit 0", () => {
  const cap = path.join(tmp(), "cap");
  const r = cli(["--capture-id", cap], JSON.stringify(input));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.action, "drop");
  assert.equal(JSON.parse(fs.readFileSync(cap, "utf8")).by, "hum-resolve-first");
  const log = fs.readFileSync(path.join(r.dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].verdict, "resolved");
  assert.ok(fs.readFileSync(path.join(r.dir, "store.jsonl"), "utf8").includes("idea-jordan"));
});

test("CLI: a rewrite returns the text and choices flag for edva-send-curl", () => {
  const r = cli([], JSON.stringify(input), { __answer: { ...RESOLVED, verdict: "partial", remaining_gap: "x", gap_text: "Only this?", choices_still_fit: false } });
  assert.equal(r.out.action, "rewrite");
  assert.equal(r.out.text, "Only this?");
  assert.equal(r.out.still_question, true);
  assert.equal(r.out.keep_choices, false);
});

test("CLI: --dry-run writes nothing; bad input and the kill switch send as written", () => {
  const cap = path.join(tmp(), "cap");
  const r = cli(["--dry-run", "--capture-id", cap], JSON.stringify(input));
  assert.equal(r.out.action, "drop");
  assert.equal(r.out.dry_run, true);
  assert.equal(fs.existsSync(path.join(r.dir, "log.jsonl")), false);
  assert.equal(fs.existsSync(path.join(r.dir, "store.jsonl")), false);
  assert.equal(fs.existsSync(cap), false);

  assert.equal(cli([], "not json").out.action, "send");
  assert.equal(cli([], JSON.stringify(input), { HUM_RESOLVE_FIRST_OFF: "1" }).out.verdict, "skipped");
});

test("CLI: forget writes a withdraw row", () => {
  const dir = tmp();
  const store = path.join(dir, "store.jsonl");
  const r = spawnSync(process.execPath, [CLI, "forget", "idea-jordan", "--reason", "the user: they're extending"], {
    encoding: "utf8", env: { ...process.env, HUM_RESOLVE_FIRST_STORE: store },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(store, "utf8")).forget, "idea-jordan");
});
