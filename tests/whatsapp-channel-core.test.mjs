// whatsapp-channel core: which upserts are logged, own-device machinery, the
// recent-id sets that stop a /send echo being logged twice, the group-metadata
// cache, and resolving a group by its subject.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptUpsert, isOwnMachinery, messageType, extractText,
  createRecentIds, createGroupCache, summarizeGroups, resolveGroupBySubject,
} from "../agent/whatsapp-channel/core.mjs";

test("acceptUpsert: others on notify only; the user's own on notify or append", () => {
  assert.equal(acceptUpsert("notify", false), true);
  assert.equal(acceptUpsert("append", false), false);
  assert.equal(acceptUpsert("notify", true), true);
  assert.equal(acceptUpsert("append", true), true);
  assert.equal(acceptUpsert("history", true), false);
});

test("isOwnMachinery: protocol-only messages are machinery, a text with a key share is not", () => {
  assert.equal(isOwnMachinery({ message: { protocolMessage: {} } }), true);
  assert.equal(isOwnMachinery({ message: { senderKeyDistributionMessage: {}, messageContextInfo: {} } }), true);
  assert.equal(isOwnMachinery({ message: { senderKeyDistributionMessage: {}, conversation: "hi" } }), false);
  assert.equal(isOwnMachinery({ message: { reactionMessage: {} } }), false);
  assert.equal(isOwnMachinery({}), true);
});

test("messageType and extractText", () => {
  assert.equal(messageType({ message: { messageContextInfo: {}, conversation: "x" } }), "conversation");
  // a key share riding with real text: the text's key is the type
  assert.equal(messageType({ message: { senderKeyDistributionMessage: {}, conversation: "x", messageContextInfo: {} } }), "conversation");
  assert.equal(messageType({ message: { senderKeyDistributionMessage: {}, extendedTextMessage: { text: "x" } } }), "extendedTextMessage");
  // a key share alone stays a protocol message, which the filter silences
  assert.equal(messageType({ message: { senderKeyDistributionMessage: {}, messageContextInfo: {} } }), "senderKeyDistributionMessage");
  assert.equal(messageType({ message: {} }), "unknown");
  assert.equal(extractText({ message: { extendedTextMessage: { text: "hello" } } }), "hello");
  assert.equal(extractText({ message: { imageMessage: { caption: "c" } } }), "[image]: c");
  assert.equal(extractText({ message: { pollCreationMessage: {} } }), "[pollCreationMessage]");
});

test("createRecentIds: remembers within ttl, forgets after, bounded by max", () => {
  let t = 0;
  const ids = createRecentIds({ ttlMs: 100, max: 3, now: () => t });
  ids.add("a");
  assert.equal(ids.has("a"), true);
  t = 150;
  assert.equal(ids.has("a"), false);
  ids.add("b"); ids.add("c"); ids.add("d"); ids.add("e");
  assert.equal(ids.size, 3);
  assert.equal(ids.has("b"), false);
  assert.equal(ids.has("e"), true);
  assert.equal(ids.has(null), false);
});

test("createGroupCache: one fetch per ttl, concurrent gets share it, peek never fetches", async () => {
  let t = 0;
  let calls = 0;
  const cache = createGroupCache({ ttlMs: 1000, now: () => t, fetch: async (jid) => { calls++; return { id: jid, subject: "Book club", participants: [1, 2] }; } });
  assert.equal(cache.peek("g@g.us"), undefined);
  const [a, b] = await Promise.all([cache.get("g@g.us"), cache.get("g@g.us")]);
  assert.equal(a.subject, "Book club");
  assert.equal(b.subject, "Book club");
  assert.equal(calls, 1);
  assert.equal(cache.peek("g@g.us").subject, "Book club");
  t = 2000;
  assert.equal(cache.peek("g@g.us"), undefined);
  await cache.get("g@g.us");
  assert.equal(calls, 2);
});

test("createGroupCache: a failed or slow fetch yields null and is not retried until failTtl", async () => {
  let t = 0;
  let calls = 0;
  const failing = createGroupCache({ failTtlMs: 50, now: () => t, fetch: async () => { calls++; throw new Error("boom"); } });
  assert.equal(await failing.get("g@g.us"), null);
  assert.equal(await failing.get("g@g.us"), null);
  assert.equal(calls, 1);
  t = 100;
  await failing.get("g@g.us");
  assert.equal(calls, 2);

  const slow = createGroupCache({ timeoutMs: 20, fetch: () => new Promise((r) => setTimeout(() => r({ id: "s", subject: "late" }), 200)) });
  assert.equal(await slow.get("s@g.us"), null);
});

test("createGroupCache: update merges a rename, invalidate drops an entry", async () => {
  const cache = createGroupCache({ fetch: async (jid) => ({ id: jid, subject: "Old", participants: [] }) });
  await cache.get("g@g.us");
  cache.update({ id: "g@g.us", subject: "New" });
  assert.equal(cache.peek("g@g.us").subject, "New");
  cache.update({ id: "other@g.us", subject: "Partial only" });
  assert.equal(cache.peek("other@g.us"), undefined);
  cache.invalidate("g@g.us");
  assert.equal(cache.peek("g@g.us"), undefined);
});

test("summarizeGroups: id, subject, participant count, sorted by subject", () => {
  const out = summarizeGroups({
    "2@g.us": { id: "2@g.us", subject: "Zeta", participants: [1, 2, 3] },
    "1@g.us": { id: "1@g.us", subject: "Alpha", participants: [1] },
  });
  assert.deepEqual(out, [
    { id: "1@g.us", subject: "Alpha", participants: 1 },
    { id: "2@g.us", subject: "Zeta", participants: 3 },
  ]);
});

test("resolveGroupBySubject: exact first, then unique case-insensitive; ambiguous refused", () => {
  const groups = [
    { id: "1@g.us", subject: "Book Club" },
    { id: "2@g.us", subject: "book club" },
    { id: "3@g.us", subject: "Neighbours" },
    { id: "4@g.us", subject: "Trip" },
    { id: "5@g.us", subject: "Trip" },
  ];
  assert.equal(resolveGroupBySubject(groups, "Book Club").group.id, "1@g.us");
  assert.equal(resolveGroupBySubject(groups, "book club").group.id, "2@g.us");
  assert.equal(resolveGroupBySubject(groups, "BOOK CLUB").error, "ambiguous");
  assert.equal(resolveGroupBySubject(groups, "neighbours").group.id, "3@g.us");
  assert.equal(resolveGroupBySubject(groups, "Trip").error, "ambiguous");
  assert.equal(resolveGroupBySubject(groups, "Neighbour").error, "none");
  assert.equal(resolveGroupBySubject(groups, "").error, "none");
});
