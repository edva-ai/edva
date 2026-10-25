// Guards the structural half of email-inbound (lib/email-inbound-gate.mjs):
// allowlist drop, Worker-retry dedup on Message-ID, reply-to-Edva lookup,
// and the handled/dropped log rows. None of it reads what the message says.
// A made-up installation (owner and agent addresses), the same in every checkout.
import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareInbound, findRepliedTo, baseSubject, isAllowlisted, ALLOWLIST } from "../lib/email-inbound-gate.mjs";

// The owner: whichever address heads the gate's allowlist.
const OWNER = ALLOWLIST[0];

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), "inbound-gate-")); }
const read = (d, f) => fs.readFileSync(path.join(d, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("allowlist is an exact, case-insensitive address match", () => {
  assert.equal(isAllowlisted(` ${OWNER.toUpperCase()} `), true);
  assert.equal(isAllowlisted(`${OWNER}.evil.com`), false);
  assert.equal(isAllowlisted(""), false);
});

test("a sender off the allowlist is dropped and logged, never dispatched", () => {
  const d = dir();
  const r = prepareInbound({ from: "stranger@example.com", subject: "hi", message_id: "<m1@x>" }, { dataDir: d });
  assert.equal(r.action, "drop");
  assert.equal(read(d, "email-inbound-dropped.jsonl")[0].reason, "not-allowlisted");
  assert.equal(fs.existsSync(path.join(d, "email-inbound-handled.jsonl")), false);
});

test("the same Message-ID is dispatched once", () => {
  const d = dir();
  const email = { from: OWNER, subject: "do x", message_id: "<m2@x>" };
  assert.equal(prepareInbound(email, { dataDir: d }).action, "dispatch");
  assert.equal(prepareInbound(email, { dataDir: d }).action, "duplicate");
  assert.equal(read(d, "email-inbound-handled.jsonl").length, 1);
});

test("reply context resolves by message id first, then by exact subject + recipient", () => {
  const sent = [
    { ts: "t1", email_id: "1qAbCdEfGh", to: [OWNER], subject: "Morning Digest", originating_task: "md" },
    { ts: "t2", email_id: "9zZzZzZzZz", to: [OWNER], subject: "Weekly Digest", originating_task: "vw" },
  ];
  const byId = findRepliedTo({ from: OWNER, subject: "Re: whatever", in_reply_to: "<1qAbCdEfGh@relay.example>" }, sent);
  assert.equal(byId.matched_by, "message-id");
  assert.equal(byId.originating_task, "md");
  const bySubj = findRepliedTo({ from: OWNER, subject: "RE: Fwd: Weekly Digest", in_reply_to: "<other@x>" }, sent);
  assert.equal(bySubj.matched_by, "subject");
  assert.equal(bySubj.originating_task, "vw");
  assert.equal(findRepliedTo({ from: "friend@example.org", subject: "Re: Weekly Digest" }, sent), null);
});

test("baseSubject strips only leading reply/forward markers", () => {
  assert.equal(baseSubject("Re: RE: fwd: Hello Re: there"), "Hello Re: there");
  assert.equal(baseSubject(""), "");
});

// ── Held mail from an unknown person ──────────────────────────────────────
// A known contact writing from a second address used to be dropped silently.
// A verified email from an unknown PERSON is now held (never dispatched, never
// granted anything) and produces exactly one chat notice per address.
import { looksAutomated, isHoldable, heldNotice, pendingHoldsFor } from "../lib/email-inbound-gate.mjs";

const person = (over = {}) => ({
  from: "newcontact@example.net", subject: "Quick question", message_id: `<p-${Math.random()}@x>`,
  auth: { aligned: true }, envelope: { from: "newcontact@example.net", to: "agent@example.com" }, bulk: {}, ...over,
});

test("a verified unknown person is held, logged, and asks once", () => {
  const d = dir();
  const r = prepareInbound(person(), { dataDir: d });
  assert.equal(r.action, "hold");
  assert.equal(r.notify, true);
  assert.equal(r.held.from, "newcontact@example.net");
  assert.ok(fs.existsSync(path.join(d, "email-inbound-held", `${r.held.hold_id}.json`)), "the email is kept for replay");
  assert.equal(fs.existsSync(path.join(d, "email-inbound-handled.jsonl")), false, "never dispatched");
  const r2 = prepareInbound(person({ subject: "and another" }), { dataDir: d });
  assert.equal(r2.action, "hold");
  assert.equal(r2.notify, false, "second email from the same pending address does not ping again");
  assert.equal(pendingHoldsFor("NewContact@example.net", d).length, 2);
});

test("a Worker retry of a held email is a duplicate", () => {
  const d = dir();
  const e = person({ message_id: "<same@x>" });
  assert.equal(prepareInbound(e, { dataDir: d }).action, "hold");
  assert.equal(prepareInbound(e, { dataDir: d }).action, "duplicate");
});

test("newsletters, robots and unverified mail are still dropped, not held", () => {
  const d = dir();
  // Supabase's notices: envelope sender on the ESP's bounce domain.
  assert.equal(prepareInbound(person({ from: "noreply@supabase.com", envelope: { from: "pm_bounces@pm-bounces.mtasv.net" } }), { dataDir: d }).action, "drop");
  assert.equal(prepareInbound(person({ bulk: { list_unsubscribe: true } }), { dataDir: d }).action, "drop");
  assert.equal(prepareInbound(person({ bulk: { auto_submitted: "auto-replied" } }), { dataDir: d }).action, "drop");
  assert.equal(prepareInbound(person({ bulk: { precedence: "bulk" } }), { dataDir: d }).action, "drop");
  assert.equal(prepareInbound(person({ auth: { aligned: false } }), { dataDir: d }).action, "drop");
  assert.equal(prepareInbound(person({ auth: undefined }), { dataDir: d }).action, "drop");
  assert.equal(read(d, "email-inbound-dropped.jsonl").length, 6);
  assert.equal(looksAutomated(person({ bulk: { auto_submitted: "no" } })), false);
  assert.equal(isHoldable(person()), true);
});

test("the chat notice names the exact address and subject", () => {
  const n = heldNotice({ from: "newcontact@example.net", subject: "Quick question" });
  assert.ok(n.includes("newcontact@example.net"));
  assert.ok(n.includes('"Quick question"'));
  assert.ok(n.includes('"add newcontact@example.net"'));
});
