// claim-freshness-rewrite-check.test.mjs — the truth gate's rewrite is checked
// before it replaces anything (two weekly-review findings).
// Of one week's in-place chat corrections a weekly review counted four that
// changed meaning; three were the rewrite's own doing: a question marked
// answered before the user answered it, the user's own fresh report replaced by
// an older email, a question the rewrite added itself. The fixtures below are
// synthetic copies of those shapes, plus the rewrites that must keep shipping
// (a plain dating, a dated-row correction on an undated reply, a question the
// user dismissed, a timeline-backed correction).
//
// Hermetic: `claude` is a stub that answers per stage (extract / adjudicate /
// check) from env and records every prompt; memory (unified-recall.mjs) is
// swapped for a fake through a module resolve hook; the travel CLI is a stub;
// Jev is a stubbed fetch; every log, health and shadow path is a temp dir. No
// model is called.
// Run: node --test tests/claim-freshness-rewrite-check.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks, createRequire } from "node:module";
import { makeFixture, choice } from "./jev-gate-harness.mjs";

// The owner-named rewrite kinds end in instance().owner_id (closed_by_user by default).
const OWNER_ID = createRequire(import.meta.url)("../lib/instance.cjs").instance().owner_id;

const FAKE_RECALL = "export async function recall() { return JSON.parse(process.env.FAKE_RECALL || '{\"results\":[]}'); }";
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "./unified-recall.mjs") return { url: `data:text/javascript,${encodeURIComponent(FAKE_RECALL)}`, shortCircuit: true };
    return next(spec, ctx);
  },
});

const f = makeFixture("claim-freshness");
const PROMPTS = path.join(f.tmp, "prompts.jsonl");
const LOG = path.join(f.tmp, "cf-log.jsonl");
const STUB = path.join(f.tmp, "claude-stage-stub.mjs");
fs.writeFileSync(STUB, `#!${process.execPath}
import fs from "node:fs";
let p = ""; for await (const c of process.stdin) p += c;
const kind = p.includes("List every assertion in this message") ? "extract"
  : p.includes("deciding whether a message is still TRUE") ? "adjudicate" : "check";
fs.appendFileSync(${JSON.stringify(PROMPTS)}, JSON.stringify({ kind, prompt: p }) + "\\n");
process.stdout.write(process.env["STUB_" + kind.toUpperCase()] || "");
`, { mode: 0o755 });
const iso = (days, hhmm) => `${new Date(Date.now() + days * 864e5).toISOString().slice(0, 10)}T${hhmm}:00+00:00`;
const TRAVEL = path.join(f.tmp, "travel");
fs.writeFileSync(TRAVEL, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify([
  { metro: "transit", place_label: "AAA→BBB (flight)", arrive_at: iso(11, "17:40"), depart_at: iso(12, "06:15"), source: "flights" },
  { metro: "northport", place_label: "Northport", arrive_at: iso(12, "06:15"), depart_at: iso(26, "19:30"), source: "flights" },
])}\nEOF\n`, { mode: 0o755 });
const SEND = path.join(f.tmp, "send"), SENT = path.join(f.tmp, "sent.txt"), HEALTH = path.join(f.tmp, "health.json");
fs.writeFileSync(SEND, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${SENT}"\n`, { mode: 0o755 });
Object.assign(process.env, {
  JEV_CONFIG_FILE: f.CFG, JEV_QUESTIONS_DIR: f.qdir, JEV_SHADOW_DIR: f.SHADOW,
  JEV_ENDPOINT: "https://jev.test/v1/evaluate", JEV_NO_ALERT: "1", TYPESAFE_API_KEY: "test-key", JEV_PRIVATE_SCREEN: "off",
  CLAIM_FRESHNESS_CLAUDE_BIN: STUB, CLAIM_FRESHNESS_TRAVEL_BIN: TRAVEL, CLAIM_FRESHNESS_LOG: LOG,
  CLAIM_FRESHNESS_HEALTH: HEALTH, CLAIM_FRESHNESS_NO_ALERT: "1", CLAIM_FRESHNESS_SEND_BIN: SEND,
});

// Jev answers per site, told apart by the question's options (accept/reject = the check).
let jevFor = {};
let jevCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("/v1/evaluate")) throw new Error("offline: " + url);
  const site = JSON.parse(init.body).questions?.verdict?.criteria?.accept ? "check" : "adjudicate";
  jevCalls.push(site);
  return jevFor[site] ? new Response(JSON.stringify({ answers: jevFor[site] }), { status: 200 })
    : new Response(JSON.stringify({ error: "no answer" }), { status: 500 });
};
after(() => { globalThis.fetch = realFetch; f.cleanup(); });

const QSRC = new URL("../agent/config/jev-questions/claim-freshness-rewrite-check.json", import.meta.url); // the kernel definition
function checkShadowUntil(until) {
  if (!fs.existsSync(QSRC)) return; // HEAD has no such site
  const q = JSON.parse(fs.readFileSync(QSRC, "utf8"));
  fs.writeFileSync(path.join(f.qdir, "claim-freshness-rewrite-check.json"), JSON.stringify({ ...q, shadow_until: until }));
}
const PAST = "2020-01-01T00:00:00Z", FUTURE = "2099-01-01T00:00:00Z";
beforeEach(() => {
  f.reset(); jevFor = {}; jevCalls = []; checkShadowUntil(PAST);
  for (const p of [PROMPTS, LOG, HEALTH, SENT]) fs.rmSync(p, { force: true });
  delete process.env.FAKE_RECALL;
});

const cf = await import("../lib/claim-freshness.mjs");
const readJsonl = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const prompts = (kind) => readJsonl(PROMPTS).filter((r) => r.kind === kind).map((r) => r.prompt);
function stage({ claims, rewrite, check, rows = [] }) {
  process.env.STUB_EXTRACT = JSON.stringify({ claims: claims.map((c) => ({ claim: c, why_mutable: "could move", memory_query: c })) });
  process.env.STUB_ADJUDICATE = JSON.stringify({ verdict: "rewrite", reason: "memory row says otherwise", corrected_text: rewrite });
  process.env.STUB_CHECK = check == null ? "" : typeof check === "string" ? check : JSON.stringify(check);
  process.env.FAKE_RECALL = JSON.stringify({ results: rows, sources: ["inbox"] });
}
const reply = (text, conversation) => cf.checkFreshness({ text, solicited: true, conversation });

// ─── the three shapes that made a true reply wrong ────────────────────────

const MATCH_DAY = {
  text: "Got it, you and Dana were at the book fair downtown. I've added that to the Saturday summary fix. Two more questions on that day are still open: whether Sam was with you the whole day, and whether the 2:10 and 4:45 stops by the library were just parking.",
  conversation: "Edva: Were you and Dana at the book fair downtown on Saturday?\nUser: Yes, we were.",
  rewrite: "Got it, you and Dana were at the book fair downtown, and the 2:10 and 4:45 stops by the library were just parking. I've added both to the Saturday summary fix. One question is still open on that day: was Sam with you the whole day?",
};

test("a rewrite that closes a question the user had not answered is rejected; the original stands", async () => {
  stage({ claims: ["the parking question is still open"], rewrite: MATCH_DAY.rewrite,
    check: { verdict: "reject", kind: "changed_open_questions", reason: "'Yes, we were.' answered the book fair question" } });
  const out = await reply(MATCH_DAY.text, MATCH_DAY.conversation);
  assert.equal(out.verdict, "pass");
  assert.equal(out.corrected_text, undefined);
  assert.ok(out.reasons.includes("rewrite_rejected:changed_open_questions"), out.reasons.join(" | "));
  const [p] = prompts("check");
  assert.ok(p.includes(MATCH_DAY.text) && p.includes(MATCH_DAY.rewrite), "the checker reads both texts");
  assert.ok(p.includes("User: Yes, we were."), "and the exchange, which the adjudicator never sees");
  assert.equal(readJsonl(LOG).at(-1).rejected_rewrite, MATCH_DAY.rewrite, "the refused text is kept in the log");
});

test("a rewrite that swaps the user's fresh report for an older email is rejected", async () => {
  stage({ claims: ["the permit office has the application"],
    rewrite: "That's a relief after the back and forth with the permit office. As of their Monday email, the application was missing documents, so I'm treating it as not yet complete.",
    rows: [{ source: "inbox", title: "Permit office", snippet: "documents missing, upload link", created_at: "2026-03-02T09:00:00Z" }],
    check: { verdict: "reject", kind: `contradicts_${OWNER_ID}`, reason: "the user said the office confirmed receipt" } });
  const out = await reply(
    "That's a relief after the back and forth with the permit office. They have your application, and either they ask for something or it is issued in about 4 days.",
    "User: The permit office texted me this morning, they received the application.");
  assert.equal(out.verdict, "pass");
  assert.ok(out.reasons.includes(`rewrite_rejected:contradicts_${OWNER_ID}`));
  assert.ok(prompts("check")[0].includes("documents missing"), "the memory rows reach the checker with their dates");
});

test("a rewrite that adds a question of its own is rejected", async () => {
  stage({ claims: ["the return is set for the 14th at 6pm"],
    rewrite: "I've set the 14th at 6pm on your calendar. One thing to flag: check-in is at 5:20pm that evening, so the return overlaps. Is that timing still workable?",
    check: { verdict: "reject", kind: "added_question", reason: "asks about check-in, which the original never raised" } });
  const out = await reply("I searched the last 4 days of chat. I've now set the 14th at 6pm on your calendar from today's message.", "User: It's the 14th, 6pm.");
  assert.equal(out.verdict, "pass");
  assert.ok(out.reasons.includes("rewrite_rejected:added_question"));
});

// ─── what must keep shipping ──────────────────────────────────────────────

test("a plain vintage rewrite still ships", async () => {
  const rewrite = "As of Wednesday's email from the contractor, the replacement part was still on backorder, so the repair couldn't be scheduled yet.";
  stage({ claims: ["the part is still on backorder"], rewrite, check: { verdict: "accept", kind: "dated_or_removed", reason: "dating only" } });
  const out = await reply("The contractor's replacement part is still on backorder, so the repair can't be scheduled yet.", "User: Any news on the repair?");
  assert.equal(out.verdict, "rewrite");
  assert.equal(out.corrected_text, rewrite);
  assert.equal(out.rewrite_check?.verdict, "accept");
});

test("a correction the live timeline backs ships, and the checker is shown the timeline", async () => {
  // The timeline held one arrival time, but that value was wrong: the flight
  // store kept the local time with the summer offset after the clocks changed,
  // so the original time was right. A separate card fixes the
  // timeline. The check still accepts a timeline-backed correction, because it
  // judges whether the rewrite stayed inside its limits, and the timeline is the
  // declared source of record.
  const rewrite = "Your car to the airport is booked for Mar 3, and your flight lands in Northport at 6:15am on Mar 4, so the ride home is all that's left to arrange.";
  stage({ claims: ["the flight lands at 7:15am on Mar 4"], rewrite, check: { verdict: "accept", kind: "corrected_from_timeline", reason: "the timeline says 6:15" } });
  const out = await reply("Your car to the airport is booked for Mar 3, and your flight lands in Northport at 7:15am on Mar 4, so the ride home is all that's left to arrange.", "User: Do I need a ride home too?");
  assert.equal(out.verdict, "rewrite");
  assert.equal(out.corrected_text, rewrite);
  assert.ok(prompts("check")[0].includes("AAA→BBB (flight)"));
});

test("the undated form: the same time change taken from an UNDATED page is refused", async () => {
  // That rewrite cited an undated wiki Travel Schedule, not the timeline.
  stage({ claims: ["the flight lands at 7:15am on Mar 4"],
    rewrite: "Your flight lands in Northport early on Mar 4 (6:15am per your travel schedule).",
    rows: [{ source: "wiki", title: "Travel Schedule", snippet: "the flight lands Mar 4 06:15" }],
    check: { verdict: "reject", kind: "older_or_undated_source", reason: "6:15 comes from an undated page" } });
  const out = await reply("Your flight lands in Northport at 7:15am on Mar 4.", "User: think about it for a second.");
  assert.equal(out.verdict, "pass");
  assert.ok(out.reasons.includes("rewrite_rejected:older_or_undated_source"));
  assert.ok(prompts("check")[0].includes("[undated] wiki"), "the checker sees that the row carries no date");
});

test("on an undated reply, a dated row may still correct a value", async () => {
  // Phone-channel replies carry no evidence date, and most real catches are
  // this shape (a game at 8pm per a dated invite, not 7pm).
  const rewrite = "Monday has you in the city until 7pm and the game at 8pm. Are you heading back after?";
  stage({ claims: ["the game is at 7pm"], rewrite,
    rows: [{ source: "inbox", title: "Invite: game", snippet: "8pm-10pm Mon Mar 16", created_at: "2026-03-09T10:00:00Z" }],
    check: { verdict: "accept", kind: "corrected_from_dated_row", reason: "8pm from the dated Mar 9 invite" } });
  const out = await reply("Monday has you in the city until 7pm and the game at 7pm. Are you heading back early?", "User: What's Monday look like?");
  assert.equal(out.verdict, "rewrite");
  assert.equal(out.corrected_text, rewrite);
  const p = prompts("check")[0];
  assert.ok(p.includes("[2026-03-09T10:00] inbox"), "the row reaches the checker with its date");
  assert.ok(p.includes("when the evidence is undated, any dated row will do"));
});

test("dropping a question the user already dismissed is allowed", async () => {
  const rewrite = "The office has visitors next week and both crews come in then, so the visitors should hear before they arrive.";
  stage({ claims: ["the Mar 20 access question is open"], rewrite,
    check: { verdict: "accept", kind: `closed_by_${OWNER_ID}`, reason: "the user's Mar 15 reply dismissed the access question" } });
  const out = await reply(`${rewrite} The Mar 20 access question is also still open.`, "User: Forget the Mar 20 access thing, it's handled.");
  assert.equal(out.verdict, "rewrite");
  assert.ok(prompts("check")[0].includes("one answer settles one question"));
});

// ─── failing safe ─────────────────────────────────────────────────────────

test("an 'accept' that names a rejecting change is a reject", async () => {
  stage({ claims: ["x"], rewrite: "As of Monday, x. Want me to chase it?", check: { verdict: "accept", kind: "added_question", reason: "fine" } });
  const out = await reply("x.", "User: and x?");
  assert.equal(out.verdict, "pass");
  assert.ok(out.reasons.includes("rewrite_rejected:added_question"));
});

test("a checker that cannot judge sends the original, never the unchecked rewrite", async () => {
  for (const check of ["I can't judge this one.", ""]) {
    stage({ claims: ["x"], rewrite: "As of Monday, x.", check });
    const out = await reply("x.", "User: and x?");
    assert.equal(out.verdict, "pass", `check output ${JSON.stringify(check)}`);
    assert.ok(out.reasons.includes("rewrite_check_unavailable"));
    assert.equal(out.corrected_text, undefined);
  }
});

// ─── who judges ───────────────────────────────────────────────────────────

test("a chat reply's check never reaches Jev, even with privacy exclusions off", async () => {
  f.reset({ privacy_exclusions: false }); checkShadowUntil(PAST);
  jevFor.check = choice("accept", 0.99, ["accept", "reject"]);
  stage({ claims: ["x"], rewrite: MATCH_DAY.rewrite, check: { verdict: "reject", kind: "changed_open_questions", reason: "r" } });
  const out = await reply(MATCH_DAY.text, MATCH_DAY.conversation);
  assert.equal(out.verdict, "pass");
  assert.ok(!jevCalls.includes("check"), "the exchange stays off Jev");
  const row = f.rows().find((r) => r.site === cf.REWRITE_CHECK_SITE);
  assert.equal(row?.reason, "solicited-exchange-excluded");
});

const proactive = { text: "The contractor's part is still on backorder, so nothing can be booked yet.", created_at: new Date(Date.now() - 3 * 864e5).toISOString(), subject: "hum:ideas:repair" };

test("proactive: a confident Jev reject sends the original", async () => {
  f.reset({ shadow_until: PAST }); checkShadowUntil(PAST);
  jevFor = { adjudicate: choice("pass", 0.5, ["pass", "rewrite", "drop"]), check: choice("reject", 0.97, ["accept", "reject"]) };
  stage({ claims: ["the part is on backorder"], rewrite: "The part arrived, so book the repair now.", check: { verdict: "accept", kind: "dated_or_removed", reason: "r" } });
  const out = await cf.checkFreshness(proactive);
  assert.equal(out.verdict, "pass");
  assert.equal(out.rewrite_check?.source, "jev");
  assert.equal(prompts("check").length, 0, "past its shadow week Jev decides alone");
});

test("proactive, own shadow week: a Sonnet reject beats a confident Jev accept", async () => {
  f.reset({ shadow_until: PAST }); checkShadowUntil(FUTURE);
  jevFor = { adjudicate: choice("pass", 0.5, ["pass", "rewrite", "drop"]), check: choice("accept", 0.97, ["accept", "reject"]) };
  stage({ claims: ["the part is on backorder"], rewrite: "The part arrived, so book the repair now.", check: { verdict: "reject", kind: "older_or_undated_source", reason: "r" } });
  const out = await cf.checkFreshness(proactive);
  assert.equal(out.verdict, "pass");
  assert.equal(out.rewrite_check?.source, "sonnet-conservative");
});

// ─── refusals are counted, and a check that refuses nearly everything pages once

test("the refusal rate is tracked beside the extractor's, and pages once per episode", async () => {
  stage({ claims: ["x"], rewrite: "As of Monday, x.", check: { verdict: "reject", kind: "added_claim", reason: "r" } });
  const out = await reply("x.", "User: and x?");
  assert.deepEqual(out.rewrite_check.health, { window: 1, failures: 1, rate: 1 });
  const h = JSON.parse(fs.readFileSync(HEALTH, "utf8"));
  assert.equal(h.rewrite_check.by_kind["rejected:added_claim"], 1);
  assert.ok(!(h.by_kind || {})["rejected:added_claim"], "the extractor's own counters are untouched");

  delete process.env.CLAIM_FRESHNESS_NO_ALERT;
  try {
    fs.rmSync(HEALTH, { force: true });
    // 16 refused of 20 is exactly the line (80%): silent. The 17th crosses it once.
    for (let i = 0; i < 20; i++) cf.noteRewriteCheckOutcome(i < 4 ? "" : "rejected:added_claim");
    cf.noteRewriteCheckOutcome("rejected:added_claim");
    cf.noteRewriteCheckOutcome("unavailable");
    await new Promise((r) => setTimeout(r, 400));
    const pages = fs.readFileSync(SENT, "utf8").trim().split("\n");
    assert.equal(pages.length, 1, "one page per episode");
    assert.ok(pages[0].includes("--channel system") && pages[0].includes("claim-freshness-health") && pages[0].includes("rewrite check"));
    fs.rmSync(SENT, { force: true });
    for (let i = 0; i < 20; i++) cf.noteRewriteCheckOutcome("");
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(fs.readFileSync(SENT, "utf8").includes("✅"), "and one recovery ping");
  } finally { process.env.CLAIM_FRESHNESS_NO_ALERT = "1"; }
});

// ─── the adjudicator is told the limits ───────────────────────────────────

test("both adjudicator prompts carry the rewrite limits, and the vintage case is intact", () => {
  assert.equal(typeof cf.REWRITE_LIMITS, "string");
  const sol = cf.ADJUDICATE_PROMPT("b", null, "2026-10-20T00:00:00Z", "c", true);
  const pro = cf.ADJUDICATE_PROMPT("b", "2026-10-17T00:00:00Z", "2026-10-20T00:00:00Z", "c", false);
  for (const p of [sol, pro]) assert.ok(p.includes(cf.REWRITE_LIMITS));
  assert.ok(cf.REWRITE_LIMITS.includes("when the evidence is undated, any dated row"), "undated replies keep dated-row corrections");
  assert.ok(sol.includes("Case (b) IS available here"));
});
