"use strict";

// imessage-db — read-only access to the Messages store (chat.db) and the
// macOS AddressBook, shared by the imsg CLI, the imessage-channel watcher and
// chat-people.
//
// chat.db facts this module owns:
//   - On current macOS message.text is NULL for almost every row; the body is
//     only in attributedBody (an NSArchiver typedstream). Every reader must go
//     through messageText(), or it sees attachment-free silence.
//   - Dates are nanoseconds since 2001-01-01 (seconds on very old rows), past
//     2^53, so they are folded to seconds in SQL before reaching JavaScript.
//   - chat.style 43 is a group chat, 45 a 1:1 chat. A group's display_name is
//     empty unless someone named it; its participants name it then.
//   - associated_message_type 2000-2006 are tapbacks/reactions, 3000-3006 their
//     removals; item_type != 0 rows are group events (renames, joins).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const HOME = os.homedir();
const CHAT_DB = process.env.IMESSAGE_CHAT_DB || path.join(HOME, "Library/Messages/chat.db");
const ADDRESS_BOOK = process.env.IMESSAGE_ADDRESS_BOOK || path.join(HOME, "Library/Application Support/AddressBook");

const APPLE_EPOCH_S = 978307200;
const CHAT_STYLE_GROUP = 43;
const CHAT_STYLE_DIRECT = 45;

const SEC = (col) => `(CASE WHEN ${col} > 1000000000000 THEN ${col} / 1000000000 ELSE ${col} END)`;
const appleToMs = (sec) => (Number(sec) + APPLE_EPOCH_S) * 1000;
const msToAppleNs = (ms) => BigInt(Math.floor(ms / 1000) - APPLE_EPOCH_S) * 1000000000n;

function openReadOnly(file) {
  return new DatabaseSync(file, { readOnly: true });
}

// ── Message bodies ──

// The string follows the "NSString" class name, after 5 header bytes and a
// length prefix (one byte, or 0x81 + uint16 LE, or 0x82 + uint32 LE).
function typedstreamText(buf) {
  if (!buf || !buf.length) return "";
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const at = b.indexOf("NSString");
  if (at < 0) return "";
  let i = at + "NSString".length + 5;
  if (i >= b.length) return "";
  let len = b[i++];
  if (len === 0x81) {
    if (i + 2 > b.length) return "";
    len = b.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    if (i + 4 > b.length) return "";
    len = b.readUInt32LE(i);
    i += 4;
  }
  if (len <= 0 || i + len > b.length) return "";
  return b.subarray(i, i + len).toString("utf8");
}

// The attachment placeholder (U+FFFC) and the replacement character (U+FFFD)
// are not words; named by code point so no invisible character sits in source.
const DROPPED_CODE_POINTS = new Set([0xfffc, 0xfffd]);

function dropChars(s) {
  let out = "";
  for (const ch of s) if (!DROPPED_CODE_POINTS.has(ch.codePointAt(0))) out += ch;
  return out;
}

// The visible words of a message: its text, or the decoded attributedBody,
// with the attachment placeholder and invalid bytes dropped.
function messageText(text, body) {
  const s = text != null && text !== "" ? String(text) : typedstreamText(body);
  // lang-regex-ok: collapses whitespace; decides nothing about meaning
  return dropChars(s).replace(/\s+/g, " ").trim();
}

// "[image]", "[video]", "[voice note]", "[file: name]" for each attachment.
function attachmentLabel(a) {
  const mime = String(a.mime_type || "");
  if (mime.startsWith("image/")) return "[image]";
  if (mime.startsWith("video/")) return "[video]";
  if (mime.startsWith("audio/")) return "[voice note]";
  const name = a.transfer_name || (a.filename ? path.basename(a.filename) : "");
  return `[file${name ? `: ${name}` : ""}]`;
}

function isReaction(associatedType) {
  const t = Number(associatedType || 0);
  return t >= 2000 && t < 4000;
}

// ── Contacts (macOS AddressBook) ──

function addressBookFiles(root = ADDRESS_BOOK) {
  const files = [path.join(root, "AddressBook-v22.abcddb")];
  try {
    for (const source of fs.readdirSync(path.join(root, "Sources"))) {
      files.push(path.join(root, "Sources", source, "AddressBook-v22.abcddb"));
    }
  } catch {
    // no Sources directory
  }
  return files.filter((f) => fs.existsSync(f));
}

// Every Contacts card with its numbers and emails. Throws when no AddressBook
// can be read (Full Disk Access), so a caller never mistakes that for "nobody".
function readAddressBook(root = ADDRESS_BOOK) {
  const cards = [];
  let readable = 0;
  let lastErr = null;
  for (const file of addressBookFiles(root)) {
    let ab;
    try {
      ab = openReadOnly(file);
      const owners = new Map();
      for (const r of ab.prepare("SELECT Z_PK pk, ZFIRSTNAME first, ZLASTNAME last, ZORGANIZATION org FROM ZABCDRECORD").all()) {
        owners.set(r.pk, { id: `${path.basename(path.dirname(file))}:${r.pk}`, first: r.first || "", last: r.last || "", org: r.org || "", phones: [], emails: [] });
      }
      for (const r of ab.prepare("SELECT ZOWNER o, ZFULLNUMBER v FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL").all()) {
        owners.get(r.o)?.phones.push(r.v);
      }
      for (const r of ab.prepare("SELECT ZOWNER o, ZADDRESS v FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL").all()) {
        owners.get(r.o)?.emails.push(r.v);
      }
      for (const c of owners.values()) if (c.phones.length || c.emails.length) cards.push(c);
      readable++;
    } catch (err) {
      lastErr = err;
    } finally {
      try {
        ab?.close();
      } catch {
        // already closed
      }
    }
  }
  if (!readable) throw new Error(`AddressBook unreadable${lastErr ? `: ${lastErr.message}` : ""}`);
  return cards;
}

// A handle's lookup key: a lowercased email, or the last 10 digits of a phone.
function contactKey(handle) {
  const s = String(handle || "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("@")) return s;
  let digits = "";
  for (const ch of s) if (ch >= "0" && ch <= "9") digits += ch;
  return digits.length >= 7 ? digits.slice(-10) : "";
}

// Map(contactKey -> display name) from readAddressBook() cards.
function nameIndex(cards) {
  const out = new Map();
  for (const c of cards) {
    const name = `${c.first} ${c.last}`.trim() || c.org;
    if (!name) continue;
    for (const h of [...c.phones, ...c.emails]) {
      const k = contactKey(h);
      if (k && !out.has(k)) out.set(k, name);
    }
  }
  return out;
}

// ── chat.db queries ──

const MESSAGE_COLUMNS = `
  m.ROWID AS rowid, m.guid, ${SEC("m.date")} AS date_s, m.is_from_me, m.text, m.attributedBody,
  m.associated_message_type, m.item_type, m.cache_has_attachments, m.service,
  m.thread_originator_guid, h.id AS handle,
  c.ROWID AS chat_rowid, c.guid AS chat_guid, c.chat_identifier, c.display_name, c.style`;

const MESSAGE_FROM = `
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h ON h.ROWID = m.handle_id`;

class ChatDb {
  constructor(file = CHAT_DB, { names = null } = {}) {
    this.file = file;
    this.db = openReadOnly(file);
    this.names = names; // Map(contactKey -> name) or null
    this._participants = new Map();
  }

  close() {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  nameFor(handle) {
    return (this.names && this.names.get(contactKey(handle))) || null;
  }

  maxRowid() {
    return Number(this.db.prepare("SELECT MAX(ROWID) AS r FROM message").get().r || 0);
  }

  participants(chatRowid) {
    if (this._participants.has(chatRowid)) return this._participants.get(chatRowid);
    const rows = this.db
      .prepare("SELECT h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = ?")
      .all(chatRowid)
      .map((r) => r.id);
    this._participants.set(chatRowid, rows);
    return rows;
  }

  // A chat's human name: its display_name, else its participants by name.
  chatName(row) {
    if (row.display_name) return row.display_name;
    if (row.style !== CHAT_STYLE_GROUP) return this.nameFor(row.chat_identifier) || row.chat_identifier;
    const people = this.participants(row.chat_rowid).map((h) => this.nameFor(h) || h);
    return people.length ? people.join(", ") : row.chat_identifier;
  }

  attachments(rowid) {
    return this.db
      .prepare(
        "SELECT a.mime_type, a.transfer_name, a.filename FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id WHERE maj.message_id = ?",
      )
      .all(rowid);
  }

  // One raw row -> the shape every caller uses.
  toMessage(row) {
    const isGroup = row.style === CHAT_STYLE_GROUP;
    let text = messageText(row.text, row.attributedBody);
    const atts = row.cache_has_attachments ? this.attachments(row.rowid) : [];
    if (atts.length) text = [...atts.map(attachmentLabel), text].filter(Boolean).join(" ");
    const fromMe = row.is_from_me === 1;
    return {
      rowid: Number(row.rowid),
      message_id: row.guid,
      ts: new Date(appleToMs(row.date_s)).toISOString(),
      kind: isReaction(row.associated_message_type) ? "reaction" : row.item_type ? "event" : "message",
      chat_id: row.chat_guid,
      chat_identifier: row.chat_identifier,
      chat_name: this.chatName(row),
      is_group: isGroup,
      from_me: fromMe,
      sender: fromMe ? "me" : row.handle || row.chat_identifier,
      sender_name: fromMe ? null : this.nameFor(row.handle || row.chat_identifier),
      service: row.service || null,
      text,
      attachments: atts.map((a) => ({ mime: a.mime_type || null, name: a.transfer_name || null })),
      reply_to: row.thread_originator_guid || null,
    };
  }

  // Messages with ROWID > afterRowid, oldest first.
  since(afterRowid, limit = 500) {
    return this.db
      .prepare(`SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM} WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?`)
      .all(afterRowid, limit)
      .map((r) => this.toMessage(r));
  }

  // Recent conversations, newest first: [{chat_id, name, is_group, last_ts, count}].
  recentChats(limit = 25) {
    const rows = this.db
      .prepare(
        `SELECT c.ROWID AS chat_rowid, c.guid AS chat_guid, c.chat_identifier, c.display_name, c.style,
                MAX(${SEC("m.date")}) AS last_s, COUNT(m.ROWID) AS n
         FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID JOIN message m ON m.ROWID = cmj.message_id
         WHERE (m.associated_message_type IS NULL OR m.associated_message_type = 0) AND m.item_type = 0
         GROUP BY c.ROWID ORDER BY MAX(m.date) DESC LIMIT ?`,
      )
      .all(limit);
    return rows.map((r) => ({
      chat_id: r.chat_guid,
      chat_identifier: r.chat_identifier,
      name: this.chatName(r),
      is_group: r.style === CHAT_STYLE_GROUP,
      last_ts: new Date(appleToMs(r.last_s)).toISOString(),
      count: Number(r.n),
    }));
  }

  // Chats whose handle, identifier, guid, display name or (for groups) any
  // participant's handle or contact name contains `query` (case-insensitive).
  findChats(query) {
    const q = String(query || "").toLowerCase();
    if (!q) return [];
    const qKey = contactKey(query);
    const all = this.db.prepare("SELECT ROWID AS chat_rowid, guid AS chat_guid, chat_identifier, display_name, style FROM chat").all();
    const hits = [];
    for (const r of all) {
      const hay = [r.chat_guid, r.chat_identifier, r.display_name, this.nameFor(r.chat_identifier)];
      if (r.style === CHAT_STYLE_GROUP) {
        for (const h of this.participants(r.chat_rowid)) hay.push(h, this.nameFor(h));
      }
      const hit =
        hay.some((v) => v && String(v).toLowerCase().includes(q)) ||
        (qKey && !qKey.includes("@") && hay.some((v) => v && contactKey(v) === qKey));
      if (hit) hits.push({ ...r, name: this.chatName(r), is_group: r.style === CHAT_STYLE_GROUP });
    }
    return hits;
  }

  // Messages across the chats matching `query`, oldest first (the last `limit`).
  read(query, { limit = 30, days = null, groups = true } = {}) {
    const chats = this.findChats(query).filter((c) => groups || !c.is_group);
    if (!chats.length) return [];
    const ids = chats.map((c) => c.chat_rowid);
    const params = [...ids];
    let dateFilter = "";
    if (days) {
      dateFilter = "AND m.date > ?";
      params.push(msToAppleNs(Date.now() - days * 86400000));
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM}
         WHERE c.ROWID IN (${ids.map(() => "?").join(",")}) AND m.item_type = 0
           AND (m.associated_message_type IS NULL OR m.associated_message_type = 0) ${dateFilter}
         ORDER BY m.date DESC LIMIT ?`,
      )
      .all(...params);
    return rows.reverse().map((r) => this.toMessage(r));
  }

  // Messages whose text contains `query`, newest first. attributedBody holds
  // NUL bytes (a text LIKE stops at the first), so it is matched with a byte
  // instr() on the query as typed, lowercased and capitalized; the decoded
  // text is then filtered case-insensitively.
  search(query, { limit = 20 } = {}) {
    const q = String(query);
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const variants = [...new Set([q, q.toLowerCase(), q.charAt(0).toUpperCase() + q.slice(1).toLowerCase()])];
    const blobHit = variants.map(() => "instr(m.attributedBody, CAST(? AS BLOB)) > 0").join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM}
         WHERE m.item_type = 0 AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
           AND (m.text LIKE ? ESCAPE '\\' OR ${blobHit})
         ORDER BY m.date DESC LIMIT ?`,
      )
      .all(like, ...variants, limit * 3);
    const ql = q.toLowerCase();
    return rows
      .map((r) => this.toMessage(r))
      .filter((m) => m.text.toLowerCase().includes(ql))
      .slice(0, limit);
  }

  // The user's own messages between two instants, oldest first.
  sent({ sinceMs = null, untilMs = null, limit = 500 } = {}) {
    const params = [];
    let f = "";
    if (sinceMs != null) {
      f += " AND m.date >= ?";
      params.push(msToAppleNs(sinceMs));
    }
    if (untilMs != null) {
      f += " AND m.date <= ?";
      params.push(msToAppleNs(untilMs));
    }
    params.push(limit);
    return this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM}
         WHERE m.is_from_me = 1 AND m.item_type = 0
           AND (m.associated_message_type IS NULL OR m.associated_message_type = 0) ${f}
         ORDER BY m.date ASC LIMIT ?`,
      )
      .all(...params)
      .map((r) => this.toMessage(r))
      .filter((m) => m.text);
  }
}

// A ChatDb with contact names when the AddressBook is readable, without them
// otherwise (the caller still gets handles).
function openChatDb(file = CHAT_DB, { withNames = true } = {}) {
  let names = null;
  if (withNames) {
    try {
      names = nameIndex(readAddressBook());
    } catch {
      names = null;
    }
  }
  return new ChatDb(file, { names });
}

module.exports = {
  CHAT_DB,
  ADDRESS_BOOK,
  APPLE_EPOCH_S,
  CHAT_STYLE_GROUP,
  CHAT_STYLE_DIRECT,
  SEC,
  appleToMs,
  msToAppleNs,
  openReadOnly,
  typedstreamText,
  messageText,
  attachmentLabel,
  isReaction,
  addressBookFiles,
  readAddressBook,
  contactKey,
  nameIndex,
  ChatDb,
  openChatDb,
};
