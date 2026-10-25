import { test } from "node:test";
import assert from "node:assert/strict";
import { isDraftMessage, DRAFTS_ONLY, GmailSource } from "../agent/supervisor/gmail-source.mjs";

// Regression guard for the recurring system-channel alert:
//   "triage: Gmail connector returned permission-denied fetching msg <id>"
// A DRAFT the user is composing reached triage
// through the INBOX-filtered history feed and could never be read back.

test("isDraftMessage detects the DRAFT label", () => {
  assert.equal(isDraftMessage({ id: "a", labelIds: ["DRAFT", "TRASH"] }), true);
  assert.equal(isDraftMessage({ id: "b", labelIds: ["INBOX", "UNREAD"] }), false);
});

test("isDraftMessage fails open when labels are absent", () => {
  // No labelIds in the payload must NOT be read as "draft" — dropping real
  // inbound mail is far worse than one unreadable draft reaching triage.
  assert.equal(isDraftMessage({ id: "c" }), false);
  assert.equal(isDraftMessage(null), false);
  assert.equal(isDraftMessage(undefined), false);
});

const withHistory = (history) => {
  const src = Object.create(GmailSource.prototype);
  src._fetchHistory = async () => ({ ok: true, body: { history } });
  return src;
};

test("_resolveHistoryToMessageId skips drafts and returns the real message", async () => {
  const src = withHistory([{ messagesAdded: [
    { message: { id: "draft1", labelIds: ["DRAFT"] } },
    { message: { id: "real1", labelIds: ["INBOX"] } },
  ] }]);
  assert.equal(await src._resolveHistoryToMessageId("100"), "real1");
});

test("_resolveHistoryToMessageId reports DRAFTS_ONLY when every record is a draft", async () => {
  const src = withHistory([{ messagesAdded: [
    { message: { id: "draft1", labelIds: ["DRAFT"] } },
    { message: { id: "draft2", labelIds: ["DRAFT", "TRASH"] } },
  ] }]);
  assert.equal(await src._resolveHistoryToMessageId("100"), DRAFTS_ONLY);
});

test("_resolveHistoryToMessageId still returns null when nothing resolves", async () => {
  // null means "could not resolve" and the fallback must keep failing open.
  const src = withHistory([{ messagesAdded: [] }]);
  assert.equal(await src._resolveHistoryToMessageId("100"), null);
});

test("_prefetchSinceWatermark never builds a meta fetch for a draft id", async () => {
  const src = Object.create(GmailSource.prototype);
  src._fetchHistory = async () => ({ ok: true, body: { historyId: "201", history: [
    { messagesAdded: [
      { message: { id: "draft1", labelIds: ["DRAFT"] } },
      { message: { id: "real1", labelIds: ["INBOX"] } },
    ] },
  ] } });
  const fetched = [];
  src._fetchMessageMeta = async (id) => { fetched.push(id); return { messageId: id }; };
  const out = await src._prefetchSinceWatermark("200", {});
  assert.deepEqual(fetched, ["real1"]);
  assert.deepEqual(out.map((m) => m.messageId), ["real1"]);
});
