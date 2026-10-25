// utterance-store — the user's replies must be permanently searchable, dated,
// and attributed: prior responses should be in memory ("on <date> the user
// said <y>").

// A made-up installation (owner "the user", UTC), the same in every checkout.
import "./synthetic-instance.mjs";
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUtterances, searchUtterances } from "../lib/utterance-store.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "utt-"));
const responses = path.join(dir, "responses.jsonl");
const resolved = path.join(dir, "resolved.jsonl");

fs.writeFileSync(responses, [
  JSON.stringify({
    ts: "2026-03-18T20:15:00.000Z", ping_id: "q-1", lane: "general_preference",
    subject: "springfield-stay-booking-gap",
    ping_text: "Your Springfield stretch doesn't have lodging attached",
    reply_text: "Answered this already and it's in the trip notes — don't re-ask.",
    disposition: "answered", source: "hum-answer",
  }),
  JSON.stringify({
    ts: "2026-02-02T14:00:00.000Z", ping_id: "q-2", lane: "restaurant_preference",
    subject: "rooftop-bar", ping_text: "Rooftop bar at the new place?",
    reply_text: "Not for me — I don't care for rooftop bars.",
    disposition: "negative", source: "hum-answer",
  }),
  "{ this is not json",
  JSON.stringify({ ts: "2026-03-01T10:00:00Z", reply_text: "   " }), // empty payload
].join("\n") + "\n");

fs.writeFileSync(resolved, JSON.stringify({
  ts: "2026-03-11T18:00:00.000Z", source_ping_id: "p-9",
  topic: "Morning market news roundup",
  resolution: 'Already reacted to this once — do not re-ask. Alex: "I already replied to this one"',
  suppress_until: "2026-03-25T18:00:00.000Z",
}) + "\n");

const files = { responses, resolved };

test("renders each reply as a dated, attributed statement", () => {
  const rows = readUtterances({ files });
  const stay = rows.find((r) => r.subject === "springfield-stay-booking-gap");
  assert.ok(stay, "the Springfield reply should be present");
  // The speaker label is the owner's name, capitalised ("the user" here).
  assert.match(stay.rendered, /^2026-03-18 · The user said: "Answered this already/); // lang-regex-ok: our own rendered row format
  // The date must be the local calendar date, and the ping it answered must ride
  // along so a reader knows what the reply was responding to.
  assert.strictEqual(stay.date, "2026-03-18");
  assert.match(stay.rendered, /in reply to: Your Springfield stretch/); // lang-regex-ok: our own rendered row format
});

test("skips malformed lines and empty payloads rather than throwing", () => {
  const rows = readUtterances({ files });
  assert.strictEqual(rows.length, 3, "2 real replies + 1 chat ack");
});

test("merges chat acknowledgments as first-class utterances", () => {
  const rows = readUtterances({ files });
  const ack = rows.find((r) => r.source === "chat_ack");
  assert.ok(ack);
  assert.match(ack.rendered, /do not re-ask/i);
});

test("newest first", () => {
  const rows = readUtterances({ files });
  assert.deepStrictEqual(rows.map((r) => r.date), ["2026-03-18", "2026-03-11", "2026-02-02"]);
});

test("sinceDays bounds the window", () => {
  // Everything in the fixture predates "now" by well over a year by the time
  // this is read in the future, so use a wide window to keep the assertion
  // stable: the point is that the filter applies at all.
  const wide = readUtterances({ files, sinceDays: 100000 });
  assert.strictEqual(wide.length, 3);
  const none = readUtterances({ files, sinceDays: 0.0001 });
  assert.strictEqual(none.length, 0);
});

test("finds a settled subject by topic words — the re-ask guard", () => {
  const hits = searchUtterances("springfield lodging booking gap", { files, k: 5 });
  assert.ok(hits.length > 0, "should retrieve the Springfield reply");
  assert.strictEqual(hits[0].subject, "springfield-stay-booking-gap");
  assert.match(hits[0].text, /don't re-ask/);
});

test("retrieves an old durable preference, not just recent rows", () => {
  // An older reply, retrieved in preference to newer but irrelevant rows: overlap
  // must dominate recency, or the log degrades into "last few things they said".
  const hits = searchUtterances("rooftop bar preference", { files, k: 3 });
  assert.strictEqual(hits[0].subject, "rooftop-bar");
});

test("a long query does not score LOWER than a short one for the same reply", () => {
  // The escalation threshold in bin/claim-check reads this score, and
  // claim-check always passes a whole candidate ping (up to 400 chars). When
  // coverage was normalized by query length, the same settled reply scored
  // 0.899 for "springfield lodging gap" and 0.257 for the real 5-line ping —
  // so the richest, most re-ask-prone candidates slipped under the threshold
  // and the memory half of the gate quietly stopped firing in production,
  // while every short-query test kept passing.
  const short = searchUtterances("springfield lodging booking gap", { files, k: 3 });
  const long = searchUtterances(
    "Your Springfield stretch from June 8 to June 24 does not have a hotel " +
    "or rental flat attached to it right now, it is only showing the airport transfer " +
    "segment, and that entry also appears to overlap your flight home " +
    "on the 25th. Want me to add the real lodging booking, or is one of those " +
    "calendar pieces simply wrong and needs correcting?",
    { files, k: 3 },
  );
  assert.equal(short[0].subject, "springfield-stay-booking-gap");
  assert.equal(long[0].subject, "springfield-stay-booking-gap", "the long form must still retrieve it");
  // The operative property: the long form must clear claim-check's escalation
  // floor. Pinned to the same constant claim-check uses.
  const ESCALATION_FLOOR = 0.34;
  assert.ok(
    long[0].score >= ESCALATION_FLOOR,
    `a realistic full-length ping must clear the escalation floor (got ${long[0].score.toFixed(3)})`,
  );
});

test("no token overlap returns nothing (never a spurious match)", () => {
  assert.deepStrictEqual(searchUtterances("quarterly amortization schedule", { files }), []);
});

test("empty query returns nothing rather than everything", () => {
  assert.deepStrictEqual(searchUtterances("", { files }), []);
  assert.deepStrictEqual(searchUtterances("the and for", { files }), []);
});
