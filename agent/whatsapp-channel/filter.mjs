// filter.mjs: decide whether an inbound WhatsApp message should push to
// the user's phone straight away (structural rules and config overrides only)
// or not. A message this filter does not push, apart from block_chats, goes
// to message-alert (lib/message-alert.mjs), where Jev judges whether it
// is important or urgent from the chat's recent messages. No keyword or name
// matching here: what a message means is a model's call (Rule #0b).
//
// Loaded by index.mjs and consulted on every inbound message. Config lives
// in filter-config.json next to this file; it's re-read on every call so
// edits land without a runner restart.
//
// Decision JSON appended to data/whatsapp-filter-log.jsonl for audit.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installTools } from "../../lib/root.cjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// kernel-closure-ok: the installation's own filter config, optional (loadConfig falls back to 1:1 DMs only)
const CONFIG_PATH = path.join(__dirname, "filter-config.json");
const FILTER_LOG = installTools("data/whatsapp-filter-log.jsonl");

let cachedConfig = null;
let cachedConfigMtime = 0;

function loadConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (cachedConfig && stat.mtimeMs === cachedConfigMtime) return cachedConfig;
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    cachedConfig = JSON.parse(raw);
    cachedConfigMtime = stat.mtimeMs;
    return cachedConfig;
  } catch (err) {
    // Fail safe: if config is missing or unparseable, push 1:1 DMs only.
    return {
      always_push_senders: [],
      block_chats: [],
      silent_protocol_types: ["senderKeyDistributionMessage", "reactionMessage", "protocolMessage"],
      _config_error: err.message,
    };
  }
}

function logDecision(entry, decision) {
  try {
    if (!fs.existsSync(path.dirname(FILTER_LOG))) {
      fs.mkdirSync(path.dirname(FILTER_LOG), { recursive: true });
    }
    fs.appendFileSync(FILTER_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      message_id: entry.message_id,
      chat_id: entry.chat_id,
      sender: entry.sender,
      sender_name: entry.sender_name,
      is_group: entry.is_group,
      type: entry.type,
      text_preview: entry.text ? entry.text.slice(0, 120) : null,
      push: decision.push,
      reason: decision.reason,
    }) + "\n");
  } catch (err) {
    // non-fatal
    console.error(`[whatsapp-filter] log append failed: ${err.message}`);
  }
}

export function classifyForPush(entry) {
  const config = loadConfig();
  const decide = (push, reason) => {
    const decision = { push, reason };
    logDecision(entry, decision);
    return decision;
  };

  // (1) Silent protocol noise. Always drop; we already log to inbox.jsonl
  // for the audit trail.
  if (config.silent_protocol_types?.includes(entry.type)) {
    return decide(false, `protocol:${entry.type}`);
  }
  // Bracketed body with no real text (e.g. "[reactionMessage]") falls here too.
  const text = (entry.text || "").trim();
  if (!text || (text.startsWith("[") && text.endsWith("]") && text.length < 60)) {
    return decide(false, "no-text");
  }

  // (2) Explicit block_chats. Useful for muted social groups.
  if (config.block_chats?.includes(entry.chat_id)) {
    return decide(false, "block-chats");
  }

  // (3) WhatsApp Status (story) broadcasts. These arrive as non-group with a
  // `status@broadcast` chat id and a `status` sender — they are ephemeral
  // story posts a contact published, NOT messages to the user. They never appear
  // in the Chats list (they live in the Updates tab and expire after ~24h), so
  // a push for one is a dead-end notification. Never push; still logged to the
  // inbox for audit.
  if (entry.chat_id === "status@broadcast") {
    return decide(false, "status-broadcast");
  }

  // (4) Explicit always_push_senders. By chat_id (1:1) or by participant JID
  // in groups. Both senders and chats are checked. This is the one override
  // that still fires a push for a direct message — use it for must-see people.
  const senderJid = entry.sender ? `${entry.sender}@s.whatsapp.net` : null;
  if (config.always_push_senders?.some((j) => j === entry.chat_id || j === senderJid)) {
    return decide(true, "always-push-sender");
  }

  // WhatsApp Channels (newsletters) have @newsletter chat IDs and surface
  // as non-group broadcast streams from news outlets, brands, etc.
  const isNewsletter = typeof entry.chat_id === "string" && entry.chat_id.endsWith("@newsletter");

  // (5) 1:1 DMs are not pushed by default: WhatsApp already notifies for direct
  // messages on the phone, so echoing each one into the Edva chat would
  // double it. They stay in whatsapp-inbox.jsonl for the record. Set
  // `push_direct_messages: true` in filter-config.json to push them; use
  // always_push_senders above to force a push for one must-see person.
  if (!entry.is_group && !isNewsletter) {
    if (config.push_direct_messages === true) return decide(true, "dm-push");
    return decide(false, "dm-silent");
  }

  // (6) Groups and newsletters: never pushed by rule. A group message goes on
  // to message-alert, where Jev decides importance from the chat's recent
  // messages; newsletters are not alert candidates there.
  return decide(false, isNewsletter ? "newsletter" : "group-to-judge");
}
