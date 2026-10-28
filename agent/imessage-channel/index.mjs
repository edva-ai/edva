// imessage-channel: realtime iMessage/SMS watcher. Tails the Messages store
// (chat.db, read-only) and appends every new message, 1:1 and group, both
// directions, to data/imessage-inbox.jsonl within a couple of seconds of
// it landing, with the body decoded from attributedBody, the chat's name and
// the sender's Contacts name. Optionally pings the chat channel for configured
// senders/chats. Sending stays with `imsg send` (Messages.app via AppleScript).
//
// Wakes on a file watch of chat.db-wal (Messages writes through the WAL) with
// a polling fallback, reads rows with ROWID past a persisted cursor, and never
// backfills on first start. GET /health on :9107 reports the cursor and the
// last successful read so a dead watcher is visible.
//
// Push policy, config `imessage-channel` (agent/local/config/), all opt-in
// because the phone already notifies for iMessage:
//   push_direct_messages  push every inbound 1:1 message (default false)
//   push_group_messages   push every inbound group message (default false)
//   always_push_senders   handles (phone/email) always pushed
//   always_push_chats     chat guids always pushed
//   block_chats           chat guids never pushed
// Decided on structure (who/which chat), never on what the text says.

import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { installTools } from "../../lib/root.cjs";
import { queueAlert, recentFromInbox } from "../../lib/message-alert.mjs";

const require = createRequire(import.meta.url);
const idb = require("../../lib/imessage-db.js");
const { localConfig } = require("../../lib/instance.cjs");

const PORT = Number(process.env.IMESSAGE_CHANNEL_PORT || 9107);
const POLL_MS = Number(process.env.IMESSAGE_CHANNEL_POLL_MS || 3000);
const NAMES_REFRESH_MS = 10 * 60 * 1000;
const INBOX = installTools("data/imessage-inbox.jsonl");
const STATE = installTools("data/imessage-channel-state.json");
const CHAT_BIN = installTools("bin/edva-send-curl");
const FAIL_PAGE_AFTER_MS = 10 * 60 * 1000;
const STALE_ALERT_MS = 30 * 60 * 1000;

const CONFIG_DEFAULTS = {
  push_direct_messages: false,
  push_group_messages: false,
  always_push_senders: [],
  always_push_chats: [],
  block_chats: [],
};

function log(msg) {
  console.error(`[imessage-channel] ${new Date().toISOString()} ${msg}`);
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(s) {
  const tmp = `${STATE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATE);
}

function appendInbox(entry) {
  if (!existsSync(path.dirname(INBOX))) mkdirSync(path.dirname(INBOX), { recursive: true });
  appendFileSync(INBOX, JSON.stringify(entry) + "\n");
}

function sendChat(args) {
  try {
    const child = spawn(CHAT_BIN, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch (err) {
    log(`edva-send-curl spawn failed: ${err.message}`);
  }
}

export function pushDecision(entry, config) {
  if (entry.from_me) return { push: false, reason: "from-me" };
  if (entry.kind !== "message") return { push: false, reason: entry.kind };
  if (!entry.text) return { push: false, reason: "no-text" };
  if ((config.block_chats || []).includes(entry.chat_id)) return { push: false, reason: "block-chats" };
  const key = idb.contactKey(entry.sender);
  if ((config.always_push_senders || []).some((h) => idb.contactKey(h) === key && key)) return { push: true, reason: "always-push-sender" };
  if ((config.always_push_chats || []).includes(entry.chat_id)) return { push: true, reason: "always-push-chat" };
  if (entry.is_group) return config.push_group_messages ? { push: true, reason: "group-push" } : { push: false, reason: "group-silent" };
  return config.push_direct_messages ? { push: true, reason: "dm-push" } : { push: false, reason: "dm-silent" };
}

export function inboxEntry(m) {
  return {
    ts: m.ts,
    logged_at: new Date().toISOString(),
    kind: m.kind,
    message_id: m.message_id,
    rowid: m.rowid,
    chat_id: m.chat_id,
    chat_identifier: m.chat_identifier,
    chat_name: m.chat_name,
    is_group: m.is_group,
    from_me: m.from_me,
    sender: m.sender,
    sender_name: m.sender_name,
    service: m.service,
    text: m.text,
    ...(m.attachments.length ? { attachments: m.attachments } : {}),
    ...(m.reply_to ? { reply_to: m.reply_to } : {}),
  };
}

function start() {
  const state = readState();
  const status = { ok: false, cursor: state.last_rowid ?? null, last_read: null, last_error: null, failing_since: null, paged: false };
  let names = null;
  let namesAt = 0;
  let busy = false;
  let again = false;

  const loadNames = () => {
    if (names && Date.now() - namesAt < NAMES_REFRESH_MS) return names;
    try {
      names = idb.nameIndex(idb.readAddressBook());
    } catch (err) {
      if (!names) log(`contacts unreadable (${err.message}); logging handles only`);
    }
    namesAt = Date.now();
    return names;
  };

  const fail = (err) => {
    status.ok = false;
    status.last_error = err.message;
    status.failing_since ??= Date.now();
    log(`read failed: ${err.message}`);
    if (!status.paged && Date.now() - status.failing_since > FAIL_PAGE_AFTER_MS) {
      status.paged = true;
      sendChat(["--channel", "system", "--skip-precheck", `⚠️ imessage-channel cannot read chat.db for 10+ minutes (${err.message}). Inbound iMessages are not being logged.`]);
    }
  };

  const poll = () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    let db;
    try {
      db = new idb.ChatDb(idb.CHAT_DB, { names: loadNames() });
      if (status.cursor == null) {
        status.cursor = db.maxRowid();
        writeState({ last_rowid: status.cursor });
        log(`first start: cursor set to ROWID ${status.cursor} (no backfill)`);
      }
      const config = localConfig("imessage-channel", CONFIG_DEFAULTS);
      for (;;) {
        const batch = db.since(status.cursor, 200);
        if (!batch.length) break;
        for (const m of batch) {
          const entry = inboxEntry(m);
          // A row that lands long after it was sent (watcher downtime, an
          // iCloud history sync) is logged but never alerted on.
          const backlog = Date.now() - Date.parse(entry.ts) > STALE_ALERT_MS;
          appendInbox(entry);
          const d = pushDecision(entry, config);
          if (!entry.from_me) log(`message chat=${entry.chat_id} group=${entry.is_group} push=${d.push} reason=${d.reason}`);
          if (d.push) {
            const who = entry.sender_name || entry.sender;
            const ctx = entry.is_group ? ` (in ${entry.chat_name})` : "";
            sendChat(["--suppress-hook", "--intent", "imessage-inbound", `iMessage from ${who}${ctx}: ${entry.text.slice(0, 280)}`]);
          } else if (!backlog) {
            // Not pushed by config: a model still judges whether it is
            // important or urgent (lib/message-alert.mjs).
            queueAlert({ channel: "imessage", message: entry, recent: recentFromInbox(INBOX, "chat_id", entry.chat_id), log });
          }
          status.cursor = m.rowid;
        }
        writeState({ last_rowid: status.cursor });
        if (batch.length < 200) break;
      }
      status.ok = true;
      status.last_read = new Date().toISOString();
      status.last_error = null;
      status.failing_since = null;
      status.paged = false;
    } catch (err) {
      fail(err);
    } finally {
      db?.close();
      busy = false;
      if (again) {
        again = false;
        setImmediate(poll);
      }
    }
  };

  // Wake on WAL writes (debounced), poll as a fallback for missed events.
  let debounce = null;
  const wake = () => {
    clearTimeout(debounce);
    debounce = setTimeout(poll, 300);
  };
  const dir = path.dirname(idb.CHAT_DB);
  try {
    watch(dir, (_event, file) => {
      if (file && String(file).startsWith("chat.db")) wake();
    });
  } catch (err) {
    log(`file watch unavailable (${err.message}); polling every ${POLL_MS}ms`);
  }
  setInterval(poll, POLL_MS);
  poll();

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...status, port: PORT }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  server.listen(PORT, "127.0.0.1", () => log(`health on :${PORT}, watching ${idb.CHAT_DB}`));

  const shutdown = (signal) => {
    log(`${signal} received, shutting down`);
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.url === `file://${process.argv[1]}`) start();
