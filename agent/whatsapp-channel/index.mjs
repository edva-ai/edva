// whatsapp-channel: Baileys runner. Pairs with the user's personal WhatsApp via
// QR scan + Linked Devices, holds the WebSocket session open, persists
// session state to disk, routes inbound messages into data/whatsapp-inbox.jsonl
// (other people's messages, and the user's own messages typed on their phone or
// another linked device, marked from_me), pushes filter-passing inbound to the
// chat channel, and exposes a tiny localhost HTTP server: POST /send,
// GET /groups, GET /health. Pure pieces live in core.mjs.
//
// This is an unofficial-protocol client (Baileys speaks WhatsApp's binary
// WebSocket protocol directly). See docs/whatsapp-gateway-setup.md
// for the pairing flow and TOS notes.

import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  isJidGroup,
  jidNormalizedUser,
  Browsers,
  generateMessageIDV2,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { createServer } from "node:http";
import { classifyForPush } from "./filter.mjs";
import { queueAlert, recentFromInbox } from "../../lib/message-alert.mjs";
import { acceptUpsert, isOwnMachinery, messageType, extractText, createRecentIds, createGroupCache, summarizeGroups } from "./core.mjs";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { installTools } from "../../lib/root.cjs";
const require = createRequire(import.meta.url);
const { loadEnv } = require("../../lib/load-env.js");

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WHATSAPP_CHANNEL_PORT || 9100);
const SESSION_DIR = path.join(__dirname, "wa-auth", "baileys");
const INBOX = installTools("data/whatsapp-inbox.jsonl");
const NOTIFY_BIN = installTools("bin/edva-notify");
const CHAT_BIN = installTools("bin/edva-send-curl");
const PAIR_MODE = process.argv.includes("--pair");
// Optional: pair via 8-digit code instead of QR. More reliable on flaky
// QR rendering paths. Pass `--phone +15551234567` (your WhatsApp number).
const PAIR_PHONE_ARG_IDX = process.argv.indexOf("--phone");
const PAIR_PHONE = PAIR_PHONE_ARG_IDX > -1 ? process.argv[PAIR_PHONE_ARG_IDX + 1] : null;

function log(msg) {
  console.error(`[whatsapp-channel] ${new Date().toISOString()} ${msg}`);
}

if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });

// Ids /send has just sent: their own-device echo (an "append" upsert) is
// already logged as kind "sent" and must not be logged again as a message.
const sentIds = createRecentIds({ ttlMs: 10 * 60 * 1000 });
// The user's own messages already logged (one can arrive as notify and append).
const ownLogged = createRecentIds({ ttlMs: 6 * 60 * 60 * 1000, max: 5000 });

function appendInbox(entry) {
  if (!existsSync(path.dirname(INBOX))) mkdirSync(path.dirname(INBOX), { recursive: true });
  appendFileSync(INBOX, JSON.stringify(entry) + "\n");
}

// Surface push-worthy inbound on the main Edva chat channel. Goes through
// edva-send-curl so the message lands in the iOS app chat (which also
// triggers its own lock-screen push). --suppress-hook prevents the chat-agent
// from auto-reasoning on the pointer; per-sender auto-handling (specific contacts)
// is wired separately via an inbox watcher.
function fireChatPing(body) {
  try {
    const child = spawn(CHAT_BIN, [
      "--suppress-hook",
      "--intent", "whatsapp-inbound",
      body,
    ], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (err) {
    log(`edva-send-curl spawn failed: ${err.message}`);
  }
}

// Baileys message JIDs come in two shapes: <number>@s.whatsapp.net for
// individuals, <id>@g.us for groups. The CLI accepts +E164 and digit
// strings; this normalizer maps everything to the WhatsApp-native form.
function normalizeJid(to) {
  if (!to) return null;
  if (to.endsWith("@s.whatsapp.net") || to.endsWith("@g.us") || to.endsWith("@c.us")) {
    return to.replace("@c.us", "@s.whatsapp.net");
  }
  const digits = String(to).replace(/[\s\-\(\)+]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  return `${digits}@s.whatsapp.net`;
}

function buildHttpServer(socketRef, groupsRef) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      const sock = socketRef.current;
      const host = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: !!sock?.user,
        port: PORT,
        host_jid: host,
        host_name: sock?.user?.name || null,
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/groups") {
      const sock = socketRef.current;
      if (!sock || !sock.user) { res.writeHead(503); res.end("socket not connected"); return; }
      try {
        const all = await sock.groupFetchAllParticipating();
        for (const meta of Object.values(all || {})) groupsRef.cache?.set(meta.id, meta);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, groups: summarizeGroups(all) }));
      } catch (err) {
        log(`groups fetch failed: ${err.message}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/send") {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => { size += c.length; if (size > 64 * 1024) { req.destroy(); return; } chunks.push(c); });
      req.on("end", async () => {
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch (err) { res.writeHead(400); res.end(`bad json: ${err.message}`); return; }
        const jid = normalizeJid(payload.to);
        if (!jid) { res.writeHead(400); res.end("missing or invalid 'to'"); return; }
        if (!payload.text) { res.writeHead(400); res.end("missing 'text'"); return; }
        const sock = socketRef.current;
        if (!sock || !sock.user) { res.writeHead(503); res.end("socket not connected"); return; }
        try {
          // The id is made here, before the send, so the echo Baileys emits for
          // our own send is recognised whichever of the two lands first.
          const preId = generateMessageIDV2(sock.user.id);
          sentIds.add(preId);
          const result = await sock.sendMessage(jid, { text: payload.text }, { messageId: preId });
          const messageId = result?.key?.id || preId;
          sentIds.add(messageId);
          const groupName = isJidGroup(jid) ? groupsRef.cache?.peek(jid)?.subject || null : null;
          appendInbox({
            ts: new Date().toISOString(),
            kind: "sent",
            message_id: messageId,
            chat_id: jid,
            is_group: isJidGroup(jid),
            ...(groupName ? { group_name: groupName } : {}),
            text: payload.text,
            originating_task: payload.originating_task || null,
          });
          log(`sent to=${jid} id=${messageId}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, message_id: messageId }));
        } catch (err) {
          log(`send failed: ${err.message}`);
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
}

function isLidUser(jid) {
  return typeof jid === "string" && jid.endsWith("@lid");
}

// `<n>@lid` -> `<phone>@s.whatsapp.net` when resolvable; anything else as is.
async function toPhoneJid(socketRef, jid, altJid) {
  if (!isLidUser(jid)) return jid;
  if (typeof altJid === "string" && altJid.endsWith("@s.whatsapp.net")) return jidNormalizedUser(altJid);
  try {
    const pn = await socketRef.current?.signalRepository?.lidMapping?.getPNForLID(jid);
    if (pn) return jidNormalizedUser(pn);
  } catch {}
  return jid;
}

async function onMessagesUpsert(socketRef, groupCache, { messages, type: upsertType }) {
  for (const message of messages) {
    if (!message.message) continue;
    const fromMe = !!message.key.fromMe;
    if (!acceptUpsert(upsertType, fromMe)) continue;
    if (fromMe) {
      // Our own /send, echoed back: already logged as kind "sent".
      if (sentIds.has(message.key.id)) continue;
      if (ownLogged.has(message.key.id)) continue;
      if (isOwnMachinery(message)) continue;
      ownLogged.add(message.key.id);
    }

    const sock = socketRef.current;
    const chatJid = message.key.remoteJid;
    const isGroup = isJidGroup(chatJid);
    const hostJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null;
    // WhatsApp now addresses many 1:1 chats by a privacy id (`<n>@lid`) while
    // our sends use the phone JID, so log the phone form whenever it is known
    // (the key's *Alt field, else the session's LID mapping) and keep the LID
    // beside it. One contact then has one chat_id across inbound and sent.
    let chatId, senderJid, rawSenderJid;
    if (fromMe) {
      // The user wrote it: the sender is the host; in a 1:1 chat the chat is
      // the other party, whose phone form is resolved the same way.
      chatId = isGroup ? chatJid : await toPhoneJid(socketRef, chatJid, message.key.remoteJidAlt);
      senderJid = hostJid;
      rawSenderJid = hostJid;
    } else {
      rawSenderJid = isGroup ? (message.key.participant || chatJid) : chatJid;
      senderJid = await toPhoneJid(socketRef, rawSenderJid, isGroup ? message.key.participantAlt : message.key.remoteJidAlt);
      chatId = isGroup ? chatJid : senderJid;
    }
    const senderNumber = senderJid?.split("@")[0] || null;
    const text = extractText(message) || "[no-content]";

    // Group name first, so it is stored on the entry (cached, so one lookup per
    // group per TTL rather than one per message).
    const groupName = isGroup ? (await groupCache.get(chatJid))?.subject || null : null;

    const entry = {
      ts: new Date().toISOString(),
      kind: "message",
      message_id: message.key.id,
      chat_id: chatId,
      ...(isLidUser(chatJid) && chatId !== chatJid ? { chat_lid: chatJid } : {}),
      is_group: isGroup,
      ...(groupName ? { group_name: groupName } : {}),
      ...(fromMe ? { from_me: true } : {}),
      sender: senderNumber,
      ...(isLidUser(rawSenderJid) && senderJid !== rawSenderJid ? { sender_lid: rawSenderJid.split("@")[0] } : {}),
      sender_name: fromMe ? (sock?.user?.name || null) : (message.pushName || null),
      type: messageType(message),
      text,
      timestamp: message.messageTimestamp,
    };
    appendInbox(entry);

    if (fromMe) {
      log(`own message chat=${chatJid} upsert=${upsertType}`);
      continue; // the user's own words are never pushed back to them
    }

    const decision = classifyForPush(entry);
    log(`message from=${entry.sender} chat=${chatJid} push=${decision.push} reason=${decision.reason} preview=${JSON.stringify(text.slice(0, 80))}`);

    if (!decision.push) {
      // Not pushed by the channel's own filter: a model still judges whether
      // it is important or urgent (lib/message-alert.mjs). A chat in
      // block_chats stays silent.
      if (decision.reason !== "block-chats") queueAlert({
        channel: "whatsapp",
        message: { ...entry, chat_name: entry.group_name || null },
        recent: recentFromInbox(INBOX, "chat_id", entry.chat_id),
        log,
      });
      continue;
    }

    const who = entry.sender_name || entry.sender;
    const ctx = isGroup ? ` (in ${groupName || "group"})` : "";
    fireChatPing(`WhatsApp from ${who}${ctx}: ${text.slice(0, 280)}`);
  }
}

async function start() {
  log(`starting Baileys runner (session_dir=${SESSION_DIR} pair_mode=${PAIR_MODE})`);
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  log(`baileys WA version=${version.join(".")} latest=${isLatest}`);

  const baileysLogger = pino({ level: process.env.WHATSAPP_LOG_LEVEL || "warn" });

  const socketRef = { current: null };
  // One cache across reconnects; it fetches through whichever socket is live.
  const groupCache = createGroupCache({
    fetch: (jid) => socketRef.current ? socketRef.current.groupMetadata(jid) : null,
  });
  const groupsRef = { cache: groupCache };

  const connect = () => {
    const sock = makeWASocket({
      version,
      logger: baileysLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false, // we render the QR ourselves so it lands in our log
      // Browser tuple must use a CANONICAL browser name. WhatsApp's April-2026
      // companion_hello validator cross-checks companion_platform_id (derived
      // from browser[1] via the PlatformType enum) against the
      // companion_platform_display string `${browser[1]} (${browser[0]})`.
      // "Desktop" is not a PlatformType value → id falls back to Chrome while
      // display says "Desktop", and the mismatch is rejected with 400
      // bad-request after the pairing code is issued ("couldn't link device";
      // socket dies 408). "Chrome" keeps id and display consistent. See
      // WhiskeySockets/Baileys #2590 / PR #2559.
      browser: Browsers.macOS("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      // Lets Baileys reuse our cache when it sends to a group instead of
      // querying the group's metadata on every send.
      cachedGroupMetadata: async (jid) => groupCache.peek(jid),
    });
    socketRef.current = sock;

    sock.ev.on("creds.update", saveCreds);

    // If pairing by phone number, request the 8-digit code after the socket
    // opens but before any QR is shown. WhatsApp will accept the code via
    // "Link with phone number instead" on the Linked Devices screen.
    let pairingCodeRequested = false;
    const maybeRequestPairingCode = async () => {
      if (pairingCodeRequested) return;
      if (!PAIR_PHONE) return;
      if (sock.authState.creds.registered) return;
      pairingCodeRequested = true;
      const digits = PAIR_PHONE.replace(/[^\d]/g, "");
      try {
        const code = await sock.requestPairingCode(digits);
        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        log(`pairing code for +${digits}: ${formatted}`);
        log(`In WhatsApp on the phone: Settings, Linked Devices, Link a Device, then tap "Link with phone number instead" and enter the code above. Code is valid for ~3 minutes.`);
      } catch (err) {
        log(`requestPairingCode failed: ${err.message}`);
      }
    };

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (PAIR_PHONE && !pairingCodeRequested) {
        // requestPairingCode needs the socket to have completed its Noise
        // handshake (i.e. be in "connecting" state with a QR generated, or
        // just past it). Fire on the first non-close update.
        maybeRequestPairingCode().catch(() => {});
      }
      if (qr && !PAIR_PHONE) {
        log("QR code received — scan with WhatsApp (Settings, Linked Devices, Link a Device):");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        log(`connection closed code=${code} reconnect=${shouldReconnect}`);
        if (shouldReconnect) {
          setTimeout(connect, 2000);
        } else {
          log("logged out — session token revoked. Delete wa-auth/baileys and re-pair.");
          process.exit(1);
        }
      } else if (connection === "open") {
        const me = jidNormalizedUser(sock.user.id);
        log(`paired host=${me} name=${JSON.stringify(sock.user.name || "")}`);
        if (PAIR_MODE) log("pair mode complete; stop with Ctrl+C and restart with `npm start`");
      } else if (connection) {
        log(`connection=${connection}`);
      }
    });

    sock.ev.on("messages.upsert", (upsert) => {
      if (upsert.type !== "notify" && upsert.type !== "append") return;
      onMessagesUpsert(socketRef, groupCache, upsert).catch((err) => log(`onMessagesUpsert error: ${err.message}`));
    });

    // Keep the group cache honest: a renamed group, a joined group, a changed
    // member list.
    sock.ev.on("groups.update", (updates) => { for (const u of updates || []) groupCache.update(u); });
    sock.ev.on("groups.upsert", (metas) => { for (const m of metas || []) groupCache.set(m.id, m); });
    sock.ev.on("group-participants.update", ({ id }) => { if (id) groupCache.invalidate(id); });
  };

  connect();

  const server = buildHttpServer(socketRef, groupsRef);
  server.listen(PORT, () => log(`HTTP send-server on :${PORT}`));

  const shutdown = (signal) => {
    log(`${signal} received, shutting down`);
    server.close();
    try { socketRef.current?.end(undefined); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  log(`fatal: ${err.message}\n${err.stack}`);
  process.exit(1);
});
