// hum-reply-target.test.mjs — the reply_to → hum-item join.
//
// This resolver decides where the user's threaded replies get FILED. A wrong
// answer here is silent: the reply reads fine in chat and lands on the wrong
// hum item, which is the exact bug threaded replies were built to kill. The
// cases below are the ones that actually bite — an old ping answered after
// newer ones arrived, and a threaded reply to something that isn't hum at all
// while a question sits pending.
//
// Run: node --test tests/hum-reply-target.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { splitMultiAnswer } from "../lib/hum-reply-segments.mjs";
import {
  resolveHumTarget, pendingSlots, humRoutingLine, humRoutingBlock, openHumItems,
} from "../lib/hum-reply-target.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hum-reply-target-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const MSG = {
  oldPing: "11111111-1111-1111-1111-111111111111",
  newPing: "22222222-2222-2222-2222-222222222222",
  question: "33333333-3333-3333-3333-333333333333",
  approval: "44444444-4444-4444-4444-444444444444",
  canary: "55555555-5555-5555-5555-555555555555",
  notHum: "99999999-9999-9999-9999-999999999999",
};

const future = new Date(Date.now() + 3600e3).toISOString();
const past = new Date(Date.now() - 3600e3).toISOString();

function write(name, obj) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
}

fs.writeFileSync(path.join(dir, "hum-feedback.jsonl"), [
  JSON.stringify({
    ping_id: "p-old", sent_at: "2026-07-27T12:00:00Z", lane: "dining",
    message_id: MSG.oldPing, reaction: null,
    findings: [{ dedup_key: "dining:cafe-uno", summary: "Cafe Uno has a 1pm table" }],
  }),
  JSON.stringify({
    ping_id: "p-approval", sent_at: "2026-07-27T13:00:00Z", lane: "watchlist",
    message_id: MSG.approval, reaction: null,
    findings: [{ dedup_key: 'watchlist-approval:Example Show', summary: "Add Example Show?" }],
  }),
  JSON.stringify({
    ping_id: "p-new", sent_at: "2026-07-27T15:00:00Z", lane: "news",
    message_id: MSG.newPing, reaction: null,
    findings: [{ dedup_key: "news:fire-cloud", summary: "Fire cloud over the forest" }],
  }),
].join("\n") + "\n");

write("hum-pending-question.json", {
  id: "q-20260727-0924-72f8", subject: "hum exercise decay",
  question: "What's not working with the exercise lane?",
  delivered_msg_id: MSG.question, asked_at: past, expires_at: future,
});
write("hum-pending-approval.json", {
  title: "Example Show", recommended_target: "together", expires_at: future,
});
write("hum-canary-pending.json", {
  canary_id: "c-20260727", message_id: MSG.canary, expires_at: future,
  candidates: [{ id: "c-20260727-1", score: 0.62, summary: "a" }],
});

test("an OLDER ping still resolves to itself after newer pings arrived", () => {
  const t = resolveHumTarget(MSG.oldPing, dir);
  assert.equal(t.kind, "ping");
  assert.equal(t.ping_id, "p-old");
  assert.equal(t.lane, "dining");
  // The whole point: it is NOT the newest, and the caller is told so.
  assert.equal(t.is_current_pending, false);
  assert.match(t.route, /hum feedback p-old <token>/);
});

test("the newest ping is flagged as also being the time-based match", () => {
  const t = resolveHumTarget(MSG.newPing, dir);
  assert.equal(t.ping_id, "p-new");
  assert.equal(t.is_current_pending, true);
});

test("a delivered question resolves via delivered_msg_id and routes to hum-answer", () => {
  const t = resolveHumTarget(MSG.question, dir);
  assert.equal(t.kind, "question");
  assert.equal(t.id, "q-20260727-0924-72f8");
  assert.equal(t.expired, false);
  assert.match(t.route, /^hum-answer q-20260727-0924-72f8 /); // lang-regex-ok: asserts on our own generated routing text, not the user's words
});

test("a reply to a question whose window closed still routes to hum-answer, with --late", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hum-late-"));
  fs.writeFileSync(path.join(d, "hum-pending-question.json"), JSON.stringify({
    id: "q-late", question: "How would you want the quiet hours to work?",
    delivered_msg_id: MSG.question, asked_at: past, expires_at: past,
  }));
  try {
    const t = resolveHumTarget(MSG.question, d);
    assert.equal(t.expired, true);
    assert.match(t.route, /^hum-answer q-late --late /); // lang-regex-ok: asserts on our own generated routing text, not the user's words
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("a watchlist-approval ping routes to the watchlist CLI, not hum feedback", () => {
  const t = resolveHumTarget(MSG.approval, dir);
  assert.equal(t.kind, "approval");
  assert.equal(t.title, "Example Show");
  assert.equal(t.recommended_target, "together");
  assert.match(t.route, /watchlist approve "Example Show"/);
});

test("a canary message resolves to its batch", () => {
  const t = resolveHumTarget(MSG.canary, dir);
  assert.equal(t.kind, "canary");
  assert.equal(t.canary_id, "c-20260727");
});

test("a reply to a non-hum message resolves to nothing", () => {
  assert.equal(resolveHumTarget(MSG.notHum, dir), null);
  assert.equal(resolveHumTarget(null, dir), null);
});

test("routing line for a non-hum parent WARNS against the pending slots", () => {
  const line = humRoutingLine(MSG.notHum, dir);
  assert.match(line, /NOT a hum ping/);
  assert.match(line, /q-20260727-0924-72f8/);   // names what would have been wrongly used
  assert.match(line, /Example Show/);
});

test("routing line for an old ping tells the agent not to use the newest", () => {
  const line = humRoutingLine(MSG.oldPing, dir);
  assert.match(line, /hum feedback p-old/);
  assert.match(line, /NOT against whatever is newest\/pending/);
});

test("routing line for the newest ping omits the mismatch warning", () => {
  const line = humRoutingLine(MSG.newPing, dir);
  assert.match(line, /hum feedback p-new/);
  assert.doesNotMatch(line, /NOT against whatever is newest/);
});

test("an expired question is still honored, with the expiry called out", () => {
  write("hum-pending-question.json", {
    id: "q-expired", subject: "s", question: "q",
    delivered_msg_id: MSG.question, asked_at: past, expires_at: past,
  });
  const t = resolveHumTarget(MSG.question, dir);
  assert.equal(t.kind, "question");
  assert.equal(t.expired, true);
  assert.match(humRoutingLine(MSG.question, dir), /expired, but the user is clearly answering it/); // lang-regex-ok: asserts on our own generated routing text, not the user's words
  // pendingSlots drops it — the time-based rules would have found nothing.
  assert.equal(pendingSlots(dir).question, null);
});

// --- open-items roster + multi-answer block ---------------------------------
// Own fixture with clock-relative timestamps: the roster is windowed on "how
// long ago was this sent", so hard-coded dates would rot.

const rosterDir = fs.mkdtempSync(path.join(os.tmpdir(), "hum-roster-"));
after(() => fs.rmSync(rosterDir, { recursive: true, force: true }));

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
// Chronological, like the real append-only log — with the too-old row first so
// a regression to `break`-on-first-old-row would still be caught by the
// out-of-order row further down.
fs.writeFileSync(path.join(rosterDir, "hum-feedback.jsonl"), [
  JSON.stringify({ ping_id: "p-ancient", sent_at: hoursAgo(72), lane: "news", reaction: null,
    message_id: "dddd", findings: [{ dedup_key: "news:y", subject_display: "something from three days ago" }] }),
  JSON.stringify({ ping_id: "p-uno", sent_at: hoursAgo(5), lane: "dining", reaction: null,
    message_id: "bbbb", findings: [{ dedup_key: "dining:uno", subject_display: "Cafe Uno has a 1pm table" }] }),
  // Answered already — must not appear as open.
  JSON.stringify({ ping_id: "p-done", sent_at: hoursAgo(3), lane: "music", reaction: "helpful",
    message_id: "aaaa", findings: [{ dedup_key: "music:x", subject_display: "A blues singer at the theater" }] }),
  JSON.stringify({ ping_id: "p-museum", sent_at: hoursAgo(2), lane: "art", reaction: null,
    message_id: "cccc", findings: [{ dedup_key: "art:museum", subject_display: "Museum painting exhibit closing" }] }),
  // Out-of-order straggler, older than the window — must not truncate the scan.
  JSON.stringify({ ping_id: "p-straggler", sent_at: hoursAgo(96), lane: "news", reaction: null,
    message_id: "eeee", findings: [{ dedup_key: "news:z", subject_display: "four days ago, written late" }] }),
].join("\n") + "\n");

test("openHumItems lists only answerable items, newest first", () => {
  const open = openHumItems(rosterDir);
  const keys = open.map((i) => i.key);
  assert.deepEqual(keys, ["ping:p-museum", "ping:p-uno"]);
  assert.ok(!keys.includes("ping:p-done"), "an already-reacted ping is closed");
  assert.ok(!keys.includes("ping:p-ancient"), "a 3-day-old ping is outside the window");
  assert.match(open[0].route, /hum feedback p-museum/);
});

test("an UN-threaded catch-up reply gets the roster + attribution rule", () => {
  const block = humRoutingBlock(
    { text: "Cafe Uno was too expensive. Skip the museum thing." },
    rosterDir,
  );
  assert.match(block, /\[Hum open items\]/);
  assert.match(block, /ONE reply can answer several/); // lang-regex-ok: asserts on our own generated routing text, not the user's words
  assert.match(block, /do NOT treat answering one as closing the others/i);
  assert.match(block, /hum feedback p-uno/);
  assert.match(block, /hum feedback p-museum/);
});

test("an ordinary single-topic message gets NO roster (prompt stays quiet)", () => {
  assert.equal(humRoutingBlock({ text: "what's on my calendar tomorrow?" }, rosterDir), "");
  assert.equal(humRoutingBlock({ text: "Cafe Uno was great" }, rosterDir), "");
});

test("a threaded reply gets the routing line AND the roster", () => {
  const block = humRoutingBlock({ replyTo: "bbbb", text: "sure" }, rosterDir);
  assert.match(block, /\[Hum routing\].*p-uno/s);
  assert.match(block, /\[Hum open items\]/);
});

// Findings copied in shape from 8 live pings on the host: `signal`
// is present about half the time, `subject_display` is usually absent or the
// literal "(idea)", `summary` never appears, and `dedup_key` is always there
// and carries the real topic words. Matching on subject_display/summary — as a
// first cut did — would essentially never fire in production, so this fixture
// exists to keep that from silently coming back.
const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), "hum-prod-shape-"));
after(() => fs.rmSync(prodDir, { recursive: true, force: true }));

fs.writeFileSync(path.join(prodDir, "hum-feedback.jsonl"), [
  JSON.stringify({ ping_id: "p-sam", sent_at: hoursAgo(6), lane: "ideas", reaction: null,
    message_id: "f1", findings: [{ dedup_key: "idea-20300101a-acme-sam-momentum-reply",
      subject_display: "(idea)", signal: "Sam (Acme) just flipped to 'yes, let's keep exploring' — reply while it's warm" }] }),
  JSON.stringify({ ping_id: "p-castle", sent_at: hoursAgo(4), lane: "ideas", reaction: null,
    message_id: "f2", findings: [{ dedup_key: "ideas:0a1b2c3d",
      signal: "Castle tour needs booking now - summer slots sell out" }] }),
  // No signal at all — only the dedup_key slug describes it.
  JSON.stringify({ ping_id: "p-firecloud", sent_at: hoursAgo(1), lane: "news", reaction: null,
    message_id: "f3", findings: [{ dedup_key: "news:https://news.example.com/2026/07/27/world/pyrocumulonimbus-fire-cloud-forest-wildfires.html" }] }),
].join("\n") + "\n");

test("production-shaped findings still yield a usable label and match text", () => {
  const open = openHumItems(prodDir);
  const byId = Object.fromEntries(open.map((i) => [i.id, i]));
  // `(idea)` is a placeholder, not a label — the signal wins.
  assert.match(byId["p-sam"].subject, /Sam/);
  assert.doesNotMatch(byId["p-sam"].subject, /^\(idea\)$/);
  // No signal anywhere: the dedup-key slug has to carry it.
  assert.match(byId["p-firecloud"].subject, /fire cloud forest wildfires/);
});

test("a catch-up reply attributes across production-shaped pings", async () => {
  const block = humRoutingBlock(
    { text: "Booked Castle already. Skip the fire cloud story — saw it." },
    prodDir,
  );
  assert.match(block, /\[Hum open items\]/);
  // WHICH item each part answers is a model pick (Rule #0b) — stubbed here so
  // the test pins the plumbing: the item descriptions the model sees, and that
  // only picked items become targets.
  const open = openHumItems(prodDir);
  let seen = null;
  const pick = async (segments, items) => {
    seen = items.map((i) => i.matchText);
    return segments.map((s) => items.findIndex((i) => i.id === (s.startsWith("Booked") ? "p-castle" : "p-firecloud")));
  };
  const multi = await splitMultiAnswer("Booked Castle already. Skip the fire cloud story — saw it.", open, { pick });
  const byKey = Object.fromEntries(multi.map((t) => [t.item.id, t.segments.join(" ")]));
  assert.match(byKey["p-castle"], /Booked Castle/);
  assert.match(byKey["p-firecloud"], /fire cloud/);
  assert.equal(byKey["p-sam"], undefined, "an unmentioned ping stays open");
  // The model is handed the slug-derived description, not the raw URL.
  assert.ok(seen.some((t) => /fire cloud forest wildfires/.test(t)));
});

test("missing/corrupt state files degrade to null instead of throwing", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "hum-reply-empty-"));
  assert.equal(resolveHumTarget(MSG.oldPing, empty), null);
  assert.equal(humRoutingLine(MSG.oldPing, empty), "");
  fs.writeFileSync(path.join(empty, "hum-feedback.jsonl"), "{not json\n");
  fs.writeFileSync(path.join(empty, "hum-pending-question.json"), "garbage");
  assert.equal(resolveHumTarget(MSG.oldPing, empty), null);
  assert.deepEqual(pendingSlots(empty), { question: null, approval: null, canary: null });
  fs.rmSync(empty, { recursive: true, force: true });
});
