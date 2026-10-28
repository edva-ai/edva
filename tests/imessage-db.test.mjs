// imessage-db + imessage-channel: decoding, chat naming, reads, push policy,
// over a synthetic chat.db with the columns the real one has.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const idb = require("../lib/imessage-db.js");
const { pushDecision, inboxEntry } = await import("../agent/imessage-channel/index.mjs");

// An attributedBody blob as macOS writes it: "NSString", 5 header bytes, a
// length prefix, then the UTF-8 string.
function typedstream(str) {
  const body = Buffer.from(str, "utf8");
  const len = body.length < 0x80 ? Buffer.from([body.length]) : Buffer.concat([Buffer.from([0x81]), Buffer.from([body.length & 0xff, body.length >> 8])]);
  return Buffer.concat([Buffer.from([0x04, 0x0b, 0x00]), Buffer.from("streamtyped"), Buffer.from("NSString"), Buffer.from([1, 0x94, 0x84, 1, 0x2b]), len, body, Buffer.from([0x86])]);
}

const nsAt = (iso) => (BigInt(Math.floor(Date.parse(iso) / 1000) - idb.APPLE_EPOCH_S) * 1000000000n);

export function fixture() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imdb-")), "chat.db");
  const d = new DatabaseSync(file);
  d.exec(`
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, is_from_me INTEGER, text TEXT, attributedBody BLOB,
      associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
      service TEXT, thread_originator_guid TEXT, handle_id INTEGER);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, style INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, mime_type TEXT, transfer_name TEXT, filename TEXT);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);
  d.prepare("INSERT INTO handle VALUES (?, ?)").run(1, "+15550001111");
  d.prepare("INSERT INTO handle VALUES (?, ?)").run(2, "+15550002222");
  d.prepare("INSERT INTO chat VALUES (?,?,?,?,?)").run(1, "any;-;+15550001111", "+15550001111", "", 45);
  d.prepare("INSERT INTO chat VALUES (?,?,?,?,?)").run(2, "any;+;chat123", "chat123", "", 43);
  d.prepare("INSERT INTO chat_handle_join VALUES (2,1),(2,2)").run();
  const msg = d.prepare("INSERT INTO message (ROWID,guid,date,is_from_me,text,attributedBody,associated_message_type,cache_has_attachments,service,handle_id) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const join = d.prepare("INSERT INTO chat_message_join VALUES (?, ?)");
  msg.run(1, "g1", nsAt("2026-10-26T12:00:00Z"), 0, null, typedstream("Should I bring ice cream?"), 0, 0, "iMessage", 1); join.run(1, 1);
  msg.run(2, "g2", nsAt("2026-10-26T12:01:00Z"), 1, null, typedstream("Might as well"), 0, 0, "iMessage", 0); join.run(1, 2);
  msg.run(3, "g3", nsAt("2026-10-26T12:02:00Z"), 0, null, typedstream("Loved “Might as well”"), 2000, 0, "iMessage", 1); join.run(1, 3);
  msg.run(4, "g4", nsAt("2026-10-26T13:00:00Z"), 0, null, typedstream("Dinner at 8 tonight"), 0, 0, "iMessage", 2); join.run(2, 4);
  msg.run(5, "g5", nsAt("2026-10-26T13:05:00Z"), 0, null, null, 0, 1, "iMessage", 2); join.run(2, 5);
  d.prepare("INSERT INTO attachment VALUES (1, 'image/jpeg', 'IMG_1.jpg', NULL)").run();
  d.prepare("INSERT INTO message_attachment_join VALUES (5, 1)").run();
  d.close();
  const names = new Map([[idb.contactKey("+15550001111"), "Alice Example"], [idb.contactKey("+15550002222"), "Bob Example"]]);
  return new idb.ChatDb(file, { names });
}

test("typedstreamText decodes short and 0x81-prefixed bodies", () => {
  assert.equal(idb.typedstreamText(typedstream("hi")), "hi");
  const long = "x".repeat(300);
  assert.equal(idb.typedstreamText(typedstream(long)), long);
  assert.equal(idb.messageText(null, typedstream("a\n  b")), "a b");
});

test("ChatDb: since() decodes, names chats and senders, labels reactions and attachments", () => {
  const db = fixture();
  const rows = db.since(0);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].text, "Should I bring ice cream?");
  assert.equal(rows[0].sender_name, "Alice Example");
  assert.equal(rows[0].chat_name, "Alice Example");
  assert.equal(rows[1].from_me, true);
  assert.equal(rows[2].kind, "reaction");
  assert.equal(rows[3].is_group, true);
  assert.equal(rows[3].chat_name, "Alice Example, Bob Example");
  assert.equal(rows[4].text, "[image]");
  db.close();
});

test("ChatDb: read() matches a contact name across 1:1 and groups, skips reactions; sent() and search()", () => {
  const db = fixture();
  assert.deepEqual(db.read("Alice").map((m) => m.message_id), ["g1", "g2", "g4", "g5"]);
  assert.deepEqual(db.read("Alice", { groups: false }).map((m) => m.message_id), ["g1", "g2"]);
  assert.deepEqual(db.sent({ sinceMs: Date.parse("2026-10-26T00:00:00Z") }).map((m) => m.text), ["Might as well"]);
  assert.deepEqual(db.search("dinner").map((m) => m.message_id), ["g4"]);
  assert.deepEqual(db.recentChats(5).map((c) => c.name), ["Alice Example, Bob Example", "Alice Example"]);
  db.close();
});

test("imessage-channel pushDecision: opt-in by structure only", () => {
  const db = fixture();
  const [inDm, mine, reaction, inGroup] = db.since(0).map(inboxEntry);
  const none = { push_direct_messages: false, push_group_messages: false, always_push_senders: [], always_push_chats: [], block_chats: [] };
  assert.equal(pushDecision(inDm, none).reason, "dm-silent");
  assert.equal(pushDecision(mine, { ...none, push_direct_messages: true }).reason, "from-me");
  assert.equal(pushDecision(reaction, { ...none, push_direct_messages: true }).push, false);
  assert.equal(pushDecision(inGroup, none).reason, "group-silent");
  assert.equal(pushDecision(inGroup, { ...none, always_push_chats: ["any;+;chat123"] }).push, true);
  assert.equal(pushDecision(inDm, { ...none, always_push_senders: ["(555) 000-1111"] }).reason, "always-push-sender");
  assert.equal(pushDecision(inGroup, { ...none, push_group_messages: true, block_chats: ["any;+;chat123"] }).reason, "block-chats");
  db.close();
});
