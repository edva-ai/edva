// message-alert — ping the user about an important or urgent inbound message
// on any messaging channel (iMessage, WhatsApp, Slack), not just email.
//
// Each channel runner hands every inbound message here after its own
// structural push decision. Code decides only which messages are candidates
// (not the user's own, a real message with words, not a status/newsletter/bot
// stream, not already pushed by the channel's own filter); a model decides
// what the message means (Rule #0b): Jev site `message-alert` first
// (agent/config/jev-questions/message-alert.json), a toolless Sonnet
// judgment with the same rubric as shadow and fallback. `urgent` and
// `important` become a chat-channel ping through edva-send-curl, which
// still runs the outbound precheck and the motion gate.
//
// A channel runner can ask for the stricter `rubric: "channel"` on ordinary
// traffic in a many-member channel that is not addressed to the user (Slack:
// a channel message with no @-mention of them). That message is judged on Jev
// site `message-alert-channel` instead, whose rubric (its question file, which
// the Sonnet rung reads too) pings only when the message calls the user by
// name or reports a really major issue.
//
// Judgments run on a small queue (MAX_CONCURRENT) so a burst in a busy group
// never fans out into dozens of model calls at once. Every judgment is logged
// to data/message-alert-log.jsonl.
//
// Off switch: `touch data/.message-alert-off`.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { installTools } from "./root.cjs";
import { decide } from "./jev-shadow.mjs";
import { answerConfidence, jevSiteDef } from "./jev.mjs";
import { runToolless, parseModelJson } from "./jev-claude.mjs";

const require = createRequire(import.meta.url);
const SITE = "message-alert";
export const CHANNEL_SITE = "message-alert-channel";
const LOG = installTools("data/message-alert-log.jsonl");
const OFF = installTools("data/.message-alert-off");
const SEND_BIN = installTools("bin/edva-send-curl");
const LEVELS = ["urgent", "important", "normal"];
const MAX_CONCURRENT = 2;
const MAX_QUEUE = 200;
const TEXT_MAX = 1200;
// How many earlier messages in the same chat the judge sees as context.
export const RECENT_N = 10;

const CHANNEL_LABEL = { imessage: "iMessage", whatsapp: "WhatsApp", slack: "Slack" };

function hasWords(text) {
  const t = String(text || "").trim();
  return !!t && !(t.startsWith("[") && t.endsWith("]") && !t.includes(" "));
}

/**
 * Is this inbound message a candidate for a judgment? Structure only.
 * `m`: { channel, kind, from_me, text, chat_id, is_bot? }
 */
export function alertCandidate(m) {
  if (!m || m.from_me) return false;
  if (m.kind && m.kind !== "message") return false;
  if (m.is_bot) return false;
  const chat = String(m.chat_id || "");
  if (chat === "status@broadcast" || chat.endsWith("@newsletter")) return false;
  return hasWords(m.text);
}

/**
 * The last `n` messages of one chat from a channel's JSONL inbox, oldest
 * first, read from the file's tail. Rows: { ts, text, from_me|kind, sender_name|user_name, <chatKey> }.
 */
export function recentFromInbox(file, chatKey, chatId, n = RECENT_N, tailBytes = 512 * 1024) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, tailBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const out = [];
      for (const line of buf.toString("utf8").split("\n").reverse()) {
        if (out.length >= n + 1) break;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (r[chatKey] !== chatId || !hasWords(r.text)) continue;
        const mine = r.from_me === true || r.kind === "sent";
        out.push({ at: r.ts, from: mine ? "me" : r.sender_name || r.user_name || r.sender || "them", text: String(r.text).slice(0, 300) });
      }
      // The newest row is usually the message being judged itself.
      return out.reverse();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function ownerName() {
  try { return require("./instance.cjs").instance().owner_name || "the user"; } catch { return "the user"; }
}

function legacyPrompt(state) {
  const name = ownerName();
  return [
    `You triage incoming messages for ${name}'s personal assistant. Decide whether ${name} needs a ping about ONE message, on top of what their phone already does.`,
    "Levels:",
    `- urgent: needs ${name} within the hour (emergency, safety or health scare about them or their people, someone stuck or waiting on them now, a time-critical problem at a property or with a guest or tenant, a deadline today only they can meet).`,
    `- important: ${name} should see it today (a direct question or request needing their answer or decision, a change of plans affecting them, significant personal news from family or close friends, a work matter needing them, a non-emergency vendor/tenant/guest issue).`,
    "- normal: everything else: chatter, greetings, thanks, jokes, photos, forwards, group banter, news, marketing, automated texts, verification codes. A group message is important only when addressed to them or needing something from them. When in doubt, normal.",
    "Judge ONLY `message`; `recent` is earlier messages in the same chat, for context.",
    'Reply with JSON only: {"level":"urgent|important|normal","reason":"<= 12 words"}',
    "",
    JSON.stringify(state),
  ].join("\n");
}

// The Sonnet rung for a site whose rubric lives only in its question file
// (`def`, the site's definition as Jev reads it).
export function rubricPrompt(site, state, def = jevSiteDef(site)) {
  const q = def?.questions?.level;
  if (!q?.instructions || !q.criteria) throw new Error(`message-alert: no rubric on file for ${site}`);
  return [
    `You triage incoming messages for ${ownerName()}'s personal assistant.`,
    q.instructions,
    "Levels:",
    ...LEVELS.map((l) => `- ${l}: ${q.criteria[l]}`),
    'Reply with JSON only: {"level":"urgent|important|normal","reason":"<= 12 words"}',
    "",
    JSON.stringify(state),
  ].join("\n");
}

async function legacyJudge(prompt) {
  const { sonnet } = require("./models.cjs").MODELS;
  const out = await runToolless({ model: sonnet, prompt, timeoutMs: 60000 });
  const j = parseModelJson(out);
  const level = LEVELS.includes(j?.level) ? j.level : null;
  if (!level) throw new Error(`message-alert legacy: unparseable answer (${String(out || "").slice(0, 80)})`);
  return { level, reason: String(j.reason || "").slice(0, 120) };
}

/**
 * The site and state one message is judged on. `rubric: "channel"` (channel
 * traffic not addressed to the user) adds `owner_names`, the names the user
 * goes by in that channel.
 */
export function judgeInput({ channel, message, recent = [], rubric = "standard", ownerNames = [] }) {
  const state = {
    channel: CHANNEL_LABEL[channel] || channel,
    chat: message.chat_name || null,
    is_group: !!message.is_group,
    message: { from: message.sender_name || message.sender || "unknown", text: String(message.text).slice(0, TEXT_MAX) },
    recent: recent.filter((r) => r.text !== message.text).slice(-RECENT_N),
  };
  return rubric === "channel"
    ? { site: CHANNEL_SITE, state: { ...state, owner_names: ownerNames.slice(0, 8) } }
    : { site: SITE, state };
}

/** Judge one message. Resolves { level, reason, used, confidence }. */
export async function judgeMessage({ channel, message, recent = [], rubric = "standard", ownerNames = [] }) {
  const { site, state } = judgeInput({ channel, message, recent, rubric, ownerNames });
  const r = await decide({
    site,
    id: message.message_id || null,
    state,
    interpret: (answers) => {
      const a = answers.level;
      const level = a?.choice;
      if (!LEVELS.includes(level)) throw new Error("jev: no level answer");
      return { value: { level, reason: "jev" }, confidence: answerConfidence(a) };
    },
    legacy: () => legacyJudge(site === SITE ? legacyPrompt(state) : rubricPrompt(site, state)),
    same: (a, b) => a?.level === b?.level,
    logInput: { channel, chat: state.chat, from: state.message.from, text: state.message.text.slice(0, 200) },
  });
  return { ...r.value, used: r.used, confidence: r.confidence ?? null };
}

function logRow(row) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
  } catch {
    // non-fatal
  }
}

export function alertText(channel, message, level) {
  const who = message.sender_name || message.sender || "someone";
  const where = message.is_group && message.chat_name ? ` (in ${message.chat_name})` : "";
  const tag = level === "urgent" ? "Urgent" : "Important";
  return `${tag} ${CHANNEL_LABEL[channel] || channel} from ${who}${where}: ${String(message.text).slice(0, 280)}`;
}

function push(channel, message, level) {
  try {
    const child = spawn(SEND_BIN, ["--suppress-hook", "--intent", "message-alert", alertText(channel, message, level)], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (err) {
    logRow({ channel, message_id: message.message_id, error: `push spawn failed: ${err.message}` });
  }
}

const queue = [];
let running = 0;

function pump(log) {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running++;
    judgeMessage(job)
      .then((j) => {
        const alert = j.level === "urgent" || j.level === "important";
        logRow({ channel: job.channel, message_id: job.message.message_id, chat: job.message.chat_name || null, ...(job.rubric === "channel" ? { rubric: "channel" } : {}), level: j.level, used: j.used, confidence: j.confidence, alert });
        if (alert) push(job.channel, job.message, j.level);
        log?.(`message-alert ${job.channel} id=${job.message.message_id} level=${j.level} used=${j.used}`);
      })
      .catch((err) => {
        logRow({ channel: job.channel, message_id: job.message.message_id, error: String(err?.message || err).slice(0, 200) });
        log?.(`message-alert ${job.channel} judge failed: ${err?.message || err}`);
      })
      .finally(() => {
        running--;
        pump(log);
      });
  }
}

/**
 * Queue an inbound message for a judgment (fire and forget). `message` uses
 * the channel's log row fields mapped to: message_id, chat_id, chat_name,
 * is_group, sender, sender_name, text, from_me, kind.
 * `recent` is optional chat context (see recentFromInbox). `rubric: "channel"`
 * with `ownerNames` judges it as channel traffic not addressed to the user.
 */
export function queueAlert({ channel, message, recent = [], log = null, rubric = "standard", ownerNames = [] }) {
  if (fs.existsSync(OFF)) return false;
  if (!alertCandidate({ ...message, channel })) return false;
  if (queue.length >= MAX_QUEUE) {
    logRow({ channel, message_id: message.message_id, error: "queue full, dropped" });
    return false;
  }
  queue.push({ channel, message, recent, rubric, ownerNames });
  pump(log);
  return true;
}
