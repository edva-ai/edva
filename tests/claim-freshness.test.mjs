// claim-freshness.test.mjs — the deterministic half of the release gate.
//
// What is covered here is everything that decides WHETHER to spend anything:
// provenance resolution, the age arithmetic, the stale/fresh boundary, and the
// Gmail window the mailbox re-check is scoped to. That is the half that must
// never be wrong, because a bug there either silently exempts a stale message
// (the autopay failure) or bills a Sonnet call on every ping.
//
// The model stages (extract → adjudicate) are not unit-tested: they fork
// `claude -p` and hit the mailbox. Their contract is enforced structurally
// instead — every parse failure funnels through parseModelJson and every
// unparseable result returns "pass", which is asserted below.

// A made-up installation (owner "the user"), the same in every checkout.
import "./synthetic-instance.mjs";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import {
  STALE_AFTER_MS,
  evidenceAsOf,
  evidenceAgeMs,
  needsRecheck,
  mailboxWindowStart,
  parseModelJson,
  checkFreshness,
  ADJUDICATE_PROMPT,
} from "../lib/claim-freshness.mjs";

const results = [];
function test(name, fn) {
  try { fn(); results.push(["ok", name]); }
  catch (e) { results.push(["FAIL", `${name} — ${e.message}`]); }
}
async function testAsync(name, fn) {
  try { await fn(); results.push(["ok", name]); }
  catch (e) { results.push(["FAIL", `${name} — ${e.message}`]); }
}

const NOW = Date.parse("2026-01-31T14:00:00Z");

// ─── provenance ───────────────────────────────────────────────────────────

test("explicit evidence_as_of wins over created_at", () => {
  const at = evidenceAsOf({
    created_at: "2026-01-20T00:00:00Z",
    supporting_data: { evidence_as_of: "2026-01-29T09:00:00Z" },
  });
  assert.equal(at.iso, "2026-01-29T09:00:00.000Z");
  assert.equal(at.from, "evidence_as_of");
});

test("a top-level evidence_as_of is honoured — the CLI's field", () => {
  // edva-send-curl --evidence-as-of and hum-ping put the stamp here. It was
  // forwarded but unread for one revision, which left every ping "undated".
  const at = evidenceAsOf({ evidence_as_of: "2026-01-29T14:10:00Z", created_at: "2026-01-20T00:00:00Z" });
  assert.equal(at.iso, "2026-01-29T14:10:00.000Z");
  assert.equal(at.from, "evidence_as_of");
  assert.equal(needsRecheck({ evidence_as_of: "2026-01-29T14:10:00Z" }, NOW).stale, true);
});

test("a nested source email dates the evidence", () => {
  const at = evidenceAsOf({
    supporting_data: { source_email: { date: "2026-01-29T13:22:00Z", from: "Example Property Co" } },
  });
  assert.equal(at.iso, "2026-01-29T13:22:00.000Z");
  assert.equal(at.from, "source_email.date");
});

test("created_at is the fallback when nothing else dates it", () => {
  const at = evidenceAsOf({ created_at: "2026-01-29T09:00:00Z", supporting_data: {} });
  assert.equal(at.from, "created_at");
});

test("a bare date is anchored at midday, not midnight", () => {
  // Midnight would make a same-day observation look up to 24h old and trip the
  // stale line for no reason; midday keeps the error symmetric at ±12h.
  const at = evidenceAsOf({ supporting_data: { evidence_as_of: "2026-01-29" } });
  assert.equal(at.iso, "2026-01-29T12:00:00.000Z");
});

test("no dateable provenance yields null, not a guess", () => {
  assert.equal(evidenceAsOf({ supporting_data: { note: "no dates here" } }), null);
  assert.equal(evidenceAgeMs({ supporting_data: {} }), null);
});

// ─── the stale line ───────────────────────────────────────────────────────

test("the autopay ping is stale — the case this gate exists for", () => {
  const verdict = needsRecheck({
    created_at: "2026-01-29T09:00:00Z",
    supporting_data: { source_email: { date: "2026-01-29T09:00:00Z" } },
  }, NOW);
  assert.equal(verdict.stale, true);
  assert.equal(verdict.reason, "stale_evidence");
  assert.ok(verdict.age_ms > 48 * 3600e3, "should read as more than two days old");
});

test("a candidate harvested this tick is fresh and costs nothing", () => {
  const verdict = needsRecheck({ created_at: new Date(NOW - 10 * 60e3).toISOString() }, NOW);
  assert.equal(verdict.stale, false);
  assert.equal(verdict.reason, "fresh_evidence");
});

test("the boundary is inclusive — exactly STALE_AFTER_MS old is stale", () => {
  const at = new Date(NOW - STALE_AFTER_MS).toISOString();
  assert.equal(needsRecheck({ created_at: at }, NOW).stale, true);
  const justUnder = new Date(NOW - STALE_AFTER_MS + 1000).toISOString();
  assert.equal(needsRecheck({ created_at: justUnder }, NOW).stale, false);
});

test("undated evidence is stale by default, never assumed current", () => {
  const verdict = needsRecheck({ supporting_data: {} }, NOW);
  assert.equal(verdict.stale, true);
  assert.equal(verdict.reason, "undated_evidence");
});

test('evidence_as_of "live" is the only way to skip without a timestamp', () => {
  assert.equal(needsRecheck({ evidence_as_of: "live" }, NOW).stale, false);
  assert.equal(needsRecheck({ supporting_data: { evidence_as_of: "live" } }, NOW).stale, false);
});

test("a future timestamp clamps to zero rather than going negative", () => {
  const verdict = needsRecheck({ created_at: new Date(NOW + 3600e3).toISOString() }, NOW);
  assert.equal(verdict.age_ms, 0);
  assert.equal(verdict.stale, false);
});

// ─── the mailbox window ───────────────────────────────────────────────────

test("a dated claim anchors the mailbox window at the observation", () => {
  const st = needsRecheck({ created_at: "2026-01-29T09:00:00Z" }, NOW);
  assert.equal(mailboxWindowStart(st, NOW), "2026-01-29T09:00:00.000Z");
});

test("an UNDATED claim searches WIDE, not narrow — the inverted-window bug", () => {
  // The first cut anchored undated at now - 90min, so a two-day-old follow-up
  // fell outside `after:` and the gate reported the mailbox silent while the
  // resolving mail sat right there. Not knowing the age must widen the search.
  const st = needsRecheck({ supporting_data: {} }, NOW);
  const startMs = Date.parse(mailboxWindowStart(st, NOW));
  const backDays = (NOW - startMs) / 86400e3;
  assert.ok(backDays >= 13, `undated window should look back ~2 weeks, got ${backDays.toFixed(1)}d`);
  assert.ok(NOW - startMs > STALE_AFTER_MS * 20, "undated must be far wider than the stale threshold");
});

// ─── the window is a retrieval hint, never a provenance claim ─────────────
//
// The outage. mailboxWindowStart's output was handed to both model
// prompts as "the evidence behind it was observed at <date>", so an undated
// message was described as being exactly UNDATED_LOOKBACK_MS old. A hum ping
// composed from a GPS fix seconds earlier ("Up at the old cathedral just now?") was
// presented as 14-day-old evidence; the extractor asked memory about "around
// January 21", the adjudicator found a 1/29 chat line about a later trip, and
// dropped the ping while the user was standing at the cathedral. Across 01-31 to
// 02-04 this suppressed ~35-40% of all outbound.
//
// The invariant: an undated message has an UNKNOWN observation time. Anything
// that reports a specific one is reporting a number it made up.

test("an undated message reports NO observation time — the fabricated-provenance bug", () => {
  const st = needsRecheck({ supporting_data: { lane: "location_context" } }, NOW);
  assert.equal(st.stale, true, "undated is still checked");
  assert.equal(st.as_of, null, "but it must not claim to know WHEN it was observed");
  assert.equal(st.age_ms, null, "and it must not claim to know how old it is");
});

test("a dated message keeps its real observation time", () => {
  const st = needsRecheck({ created_at: "2026-01-29T09:00:00Z" }, NOW);
  assert.equal(st.as_of, "2026-01-29T09:00:00.000Z");
});

test("the retrieval window and the observation time are different values", () => {
  // Both remain available; conflating them is what broke. Wide search, no
  // invented date.
  const st = needsRecheck({}, NOW);
  assert.notEqual(mailboxWindowStart(st, NOW), st.as_of);
  assert.equal(st.as_of, null);
  assert.ok(mailboxWindowStart(st, NOW), "the search hint still resolves to a real date");
});

// ─── live-composed messages must be free ──────────────────────────────────
//
// claim-freshness's cost model rests on "a message composed from evidence
// observed minutes ago exits at Stage 0 having spent nothing". hum-ping only
// ever declared provenance for reservoir (`idea-`) findings, so every sensor
// lane — location, exercise, health, dining — went out undated and paid the
// full ladder on a fresh observation.

await testAsync('"live" exits at stage 0 for free, from either position', async () => {
  const a = await checkFreshness({ text: "Up at the old cathedral just now?", evidence_as_of: "live" }, { nowMs: NOW });
  assert.equal(a.verdict, "pass");
  assert.equal(a.stage, 0, "live evidence must never reach the model stages");
  assert.equal(a.reasons[0], "live_evidence");

  const b = await checkFreshness(
    { text: "Up at the old cathedral just now?", supporting_data: { evidence_as_of: "live" } },
    { nowMs: NOW },
  );
  assert.equal(b.stage, 0);
});

// ─── model-output parsing ─────────────────────────────────────────────────

test("JSON survives a markdown fence and surrounding prose", () => {
  const parsed = parseModelJson('Sure!\n```json\n{"verdict":"drop","reason":"resolved"}\n```\n');
  assert.equal(parsed.verdict, "drop");
});

test("unparseable model output yields null, never a throw", () => {
  assert.equal(parseModelJson("I could not comply."), null);
  assert.equal(parseModelJson("{ not json at all "), null);
  assert.equal(parseModelJson(""), null);
});

// ─── the authority is memory ──────────────────────────────────────────────

await testAsync("the module's authority is memory, and the mailbox one is gone", async () => {
  // Guards a real failure: the gate was repointed from Gmail to
  // memory, but one caller still read the renamed `gmail_query` field behind a
  // ternary. It silently took the else branch on every claim, so the gate ran
  // twice in production without ever asking memory — no error, because the dead
  // call was never reached. A rename that leaves a caller behind must fail here.
  const mod = await import("../lib/claim-freshness.mjs");
  assert.equal(typeof mod.recheckMemory, "function", "recheckMemory must be the authority");
  assert.equal(mod.recheckMailbox, undefined, "the direct-mailbox authority must not come back");
  const src = fs.readFileSync(new URL("../lib/claim-freshness.mjs", import.meta.url), "utf8");
  assert.ok(!src.includes("gmail_query"), "no caller may still read the renamed gmail_query field");
});

await testAsync("an empty query reports unreachable rather than pretending to have looked", async () => {
  const { recheckMemory } = await import("../lib/claim-freshness.mjs");
  const r = await recheckMemory("", "2026-01-29T14:10:00Z");
  assert.equal(r.ok, false);
  assert.deepEqual(r.hits, []);
});

// ─── the gate's fail-open contract ────────────────────────────────────────

await testAsync("empty text passes without touching a model", async () => {
  const out = await checkFreshness({ text: "   " });
  assert.equal(out.verdict, "pass");
  assert.equal(out.stage, 0);
});

await testAsync("fresh evidence exits at stage 0 with no verdict of substance", async () => {
  const out = await checkFreshness(
    { text: "The customer still hasn't enrolled in autopay.", created_at: new Date(NOW - 60e3).toISOString() },
    { nowMs: NOW },
  );
  assert.equal(out.verdict, "pass");
  assert.equal(out.stage, 0);
  assert.equal(out.reasons[0], "fresh_evidence");
});

await testAsync("noLlm short-circuits a stale message instead of blocking on a fork", async () => {
  // The path hum's harvesters take when they want the free half only.
  const out = await checkFreshness(
    { text: "The customer still hasn't enrolled in autopay.", created_at: "2026-01-29T09:00:00Z" },
    { nowMs: NOW, noLlm: true },
  );
  assert.equal(out.verdict, "pass");
  assert.equal(out.reasons[0], "stale_evidence_unjudged");
});

await testAsync("an expired deadline never blocks delivery", async () => {
  const out = await checkFreshness(
    { text: "The customer still hasn't enrolled in autopay.", created_at: "2026-01-29T09:00:00Z", solicited: true },
    { nowMs: NOW, deadlineMs: 0 },
  );
  assert.equal(out.verdict, "pass");
  assert.ok(String(out.reasons[0]).startsWith("deadline"), `expected a deadline reason, got ${out.reasons[0]}`);
});

// ── The vintage rewrite is solicited-only ─────────────────────────────────
//
// Case (b) — keep the message, attach its vintage — is the right trade when
// the user asked, because the alternative is not answering them. It is the wrong
// trade for a ping nobody asked for, where the alternative is one fewer
// interruption. Two that shipped and should not have:
//   "As of the last watchlist scan (Jan 18), 4 candidates were queued for hum
//    approval — worth checking if you've already answered any of those pings."
//   "As of when I found it on January 18, the band was touring the city's arena —
//    worth double-checking it's still on."
// Both are Edva asking the user to do Edva's verification.

const solicitedPrompt = ADJUDICATE_PROMPT("body", "2026-01-18T00:00:00Z", "2026-02-04T00:00:00Z", "claims", true);
const proactivePrompt = ADJUDICATE_PROMPT("body", "2026-01-18T00:00:00Z", "2026-02-04T00:00:00Z", "claims", false);

test("a solicited message keeps the vintage-rewrite option", () => {
  assert.ok(solicitedPrompt.includes("Case (b) IS available here"));
  assert.ok(!solicitedPrompt.includes("DO NOT HEDGE A PING NOBODY ASKED FOR"));
});

test("a proactive message loses the vintage-rewrite option", () => {
  assert.ok(proactivePrompt.includes("Case (b) is NOT available for this message"));
  assert.ok(proactivePrompt.includes("DO NOT HEDGE A PING NOBODY ASKED FOR"));
});

test("only the proactive prompt bans asking the user to verify Edva's own state", () => {
  const ban = /NEVER ASK THE USER TO VERIFY EDVA'S OWN STATE/; // lang-regex-ok: matching our own prompt text
  assert.ok(ban.test(proactivePrompt));
  // Solicited keeps its existing drop-is-unavailable protection instead.
  assert.ok(solicitedPrompt.includes('"drop" is not available'));
});

test("the proactive prompt still prefers rewrite when the message survives without the stale claim", () => {
  // The narrowing must not become "drop everything unverifiable" — a message
  // that works with the stale part removed should keep shipping.
  assert.ok(proactivePrompt.includes("survives WITHOUT the stale claim"));
});

// ─── report ───────────────────────────────────────────────────────────────

let failed = 0;
for (const [status, name] of results) {
  if (status === "FAIL") failed++;
  console.log(`${status === "ok" ? "  ok" : "FAIL"}  ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
