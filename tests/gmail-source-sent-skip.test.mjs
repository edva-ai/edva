// A made-up installation (the agent's inbound address), the same in every checkout.
import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
// _fetchMessageMeta registers each sender in triage_decisions; keep that out of the repo's DB.
process.env.TRIAGE_DECISIONS_DB = path.join(os.tmpdir(), `td-sent-skip-${process.pid}.db`);
import { isOwnSentToThirdParty, isAddressedToEdva, EDVA_INBOUND_ADDRESSES, GmailSource } from "../agent/supervisor/gmail-source.mjs";

const OWNER = "Alex Owner <owner@example.com>";
const EDVA = EDVA_INBOUND_ADDRESSES[0];
const VENDOR = "support@vendor.example";

// Regression guard for the own-sent intake leak. When the user replies inside
// an INBOX-labelled thread, the INBOX-filtered history feed carries a
// messagesAdded record for the OUTGOING message too — the same path
// isDraftMessage already guards one step earlier. A follow-up to a third party
// was classified and had `personal` written onto the user's own sent mail.
// Mail addressed to Edva's inbound address MUST keep reaching triage: that
// is the approve/RECLASSIFY/freeform-instruction channel.

test("a reply to a third party is skipped", () => {
  assert.equal(isOwnSentToThirdParty(["STARRED", "SENT"], VENDOR), true);
  assert.equal(isOwnSentToThirdParty(["SENT"], "Sam Friend <friend@example.org>"), true);
  assert.equal(isOwnSentToThirdParty(["SENT"], ""), true);
});

test("a reply addressed to Edva is NEVER skipped — that is the command channel", () => {
  for (const addr of EDVA_INBOUND_ADDRESSES) {
    assert.equal(isOwnSentToThirdParty(["SENT"], addr), false);
    assert.equal(isOwnSentToThirdParty(["SENT"], addr.toUpperCase()), false);
    assert.equal(isOwnSentToThirdParty(["SENT"], `someone@x.com, Edva <${addr}>`), false);
  }
});

test("a message the user sent to themselves carries INBOX too and must still be triaged", () => {
  assert.equal(isOwnSentToThirdParty(["SENT", "INBOX", "UNREAD"], OWNER), false);
});

test("ordinary inbound mail is untouched", () => {
  assert.equal(isOwnSentToThirdParty(["INBOX", "UNREAD"], OWNER), false);
  assert.equal(isOwnSentToThirdParty(["DRAFT"], ""), false);
});

test("missing labels fail OPEN", () => {
  // Dropping real inbound mail is far worse than one outgoing message reaching
  // triage — same discipline as isDraftMessage.
  assert.equal(isOwnSentToThirdParty(null, "x@y.com"), false);
  assert.equal(isOwnSentToThirdParty(undefined, "x@y.com"), false);
});

const sourceWithMessage = (msg) => {
  const src = Object.create(GmailSource.prototype);
  const logged = [];
  src.triageLog = (line) => logged.push(line);
  src._getAccessToken = async () => "token";
  src._fetchedUrl = null;
  globalThis.fetch = async (url) => { src._fetchedUrl = url; return { ok: true, json: async () => msg }; };
  return { src, logged };
};
const hdrs = (o) => ({ payload: { headers: Object.entries(o).map(([name, value]) => ({ name, value })) } });

test("_fetchMessageMeta drops the user's outgoing mail and logs why", async () => {
  const { src, logged } = sourceWithMessage({
    labelIds: ["STARRED", "SENT"],
    ...hdrs({ From: OWNER, Subject: "Re: [100000000001] Developer Support", To: VENDOR }),
  });
  assert.equal(await src._fetchMessageMeta("fake-msg-a01"), null);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /own-sent skip fake-msg-a01/); // lang-regex-ok: our own log line, not the user's words
  // The To/Cc/Bcc headers the guard reads must actually be requested.
  assert.match(src._fetchedUrl, /metadataHeaders=To/);
});

test("_fetchMessageMeta still returns meta for the user's reply to Edva", async () => {
  const { src, logged } = sourceWithMessage({
    labelIds: ["SENT"],
    ...hdrs({ From: OWNER, Subject: "Re: Cost review", To: EDVA }),
  });
  const meta = await src._fetchMessageMeta("fake-msg-a02");
  assert.deepEqual(meta, { messageId: "fake-msg-a02", from: OWNER, subject: "Re: Cost review", to: EDVA, date: "", rfcMessageId: "", rfcReferences: "", toEdva: true });
  assert.equal(logged.length, 0);
});

// Command-channel guard. Keeping this mail out of the own-sent skip was only
// half the job: the cascade's auto-handling filters then filed it at P3 and
// skipped the dispatch, swallowing instructions the user had addressed to
// Edva.

test("isAddressedToEdva matches every inbound address, any case, among many recipients", () => {
  for (const addr of EDVA_INBOUND_ADDRESSES) {
    assert.equal(isAddressedToEdva(addr), true);
    assert.equal(isAddressedToEdva(addr.toUpperCase()), true);
    assert.equal(isAddressedToEdva(`someone@x.com, Edva <${addr}>`), true);
  }
});

test("isAddressedToEdva is false for ordinary recipients and for nothing at all", () => {
  assert.equal(isAddressedToEdva(VENDOR), false);
  assert.equal(isAddressedToEdva("owner@example.com, friend@example.org"), false);
  assert.equal(isAddressedToEdva(""), false);
  assert.equal(isAddressedToEdva(null), false);
  assert.equal(isAddressedToEdva(undefined), false);
});

test("the flag rides on the meta for ordinary inbound mail too, as false", async () => {
  const { src } = sourceWithMessage({
    labelIds: ["INBOX", "UNREAD"],
    ...hdrs({ From: "Example Store <hello@store.example>", Subject: "Onboarding reminders", To: OWNER }),
  });
  const meta = await src._fetchMessageMeta("fake-msg-a03");
  assert.equal(meta.toEdva, false);
});

test("a Cc to Edva on inbound mail still counts as the command channel", async () => {
  const { src } = sourceWithMessage({
    labelIds: ["INBOX", "UNREAD"],
    ...hdrs({ From: OWNER, Subject: "Fwd: backup issue", To: "someone@x.com", Cc: EDVA }),
  });
  const meta = await src._fetchMessageMeta("fake-msg-a04");
  assert.equal(meta.toEdva, true);
});

test("_fetchMessageMeta still returns meta for ordinary inbound mail", async () => {
  const { src } = sourceWithMessage({
    labelIds: ["INBOX", "UNREAD"],
    ...hdrs({ From: `Vendor Support <${VENDOR}>`, Subject: "[100000000001] Developer Support", To: OWNER }),
  });
  const meta = await src._fetchMessageMeta("fake-msg-a05");
  assert.equal(meta.from, `Vendor Support <${VENDOR}>`);
});
