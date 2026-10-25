import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";
import { sendApnsPush, sendClearPush } from "../../lib/apns-push.mjs";
import { writeFileAtomic } from "../../lib/atomic-write.js";
import { autoRecallBlock, useWarmJudge } from "../../lib/auto-recall.mjs";
import { WarmClaude } from "../../lib/warm-claude.mjs";
import { spoolEvent } from "../../lib/hum-events.mjs";
import { displayableDraft } from "../../lib/reply-stream.mjs";
import { composeReply } from "../../lib/reply-file.mjs";
import { recordSuperseded } from "../../lib/superseded-replies.mjs";
import { ShareBundler, laterTimestamp } from "./share-bundle.mjs";
import { loadHook } from "../../lib/ext-hooks.mjs";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { installTools } from "../../lib/root.cjs";
const require = createRequire(import.meta.url);
const { loadEnv } = require("../../lib/load-env.js");
const { instance, localConfig } = require("../../lib/instance.cjs");

// Who this installation serves (lib/instance.cjs).
const INSTANCE = instance();
// The operator's name as the agent reads it ("the user" in a fresh install);
// OWNER_LABEL starts a sentence or a transcript line.
const OWNER = INSTANCE.owner_name;
const OWNER_LABEL = OWNER.charAt(0).toUpperCase() + OWNER.slice(1);
// Hum lanes a location edge fans out to (agent/local/config/location-lanes.json).
const LOCATION_LANES = localConfig("location-lanes", {
  arrival: ["nearby", "location_context", "dining", "situation"],
  departure: ["location_context", "situation", "calendar"],
});
// Typed-reply hints for an installation's own card kinds:
// phone-channel/_ext/reply-hints.mjs exports `cardHints = { <kind>: (choices) => text }`.
// Fail-open: a broken hook never keeps the channel from starting.
let REPLY_HINTS = {};
try {
  REPLY_HINTS = (await loadHook(path.dirname(fileURLToPath(import.meta.url)), "reply-hints"))?.cardHints || {};
} catch (e) {
  console.error(`[phone-channel] reply-hints hook failed to load: ${e?.message || e}`);
}

// Load .env first — service_role key must come from env, not source code.
loadEnv();

const SUPABASE_URL = INSTANCE.supabase_project
  ? `https://${INSTANCE.supabase_project}.supabase.co`
  : (process.env.SUPABASE_URL || "");

// ── Single-instance guard (a rogue duplicate once caused an outage). A 2nd
// phone-channel double-processes the channel + Supabase Realtime/acks and can
// saturate the DB compute. The legit instance is spawned by the chat supervisor's
// MCP config (supervisor/chat-mcp-config.json), which sets EDVA_PHONE_PRIMARY=1.
// FAIL-SAFE: exit ONLY when this is an unblessed launch (env flag unset — e.g.
// spawned by Claude Desktop or by hand) AND another phone-channel is already
// running. A sole instance, or the blessed primary, always proceeds — so a missing
// env var can never take the channel down.
if (process.env.EDVA_PHONE_PRIMARY !== "1") {
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("pgrep", ["-f", "phone-channel/index.mjs"], { encoding: "utf8" });
    const others = out.split("\n").map((s) => parseInt(s, 10)).filter((p) => p && p !== process.pid);
    if (others.length > 0) {
      console.error(`[phone-channel] refusing to start: another phone-channel (pid ${others.join(",")}) is already running and this is not the supervisor's primary (EDVA_PHONE_PRIMARY unset). Exiting to avoid a duplicate Supabase subscriber.`);
      process.exit(0);
    }
  } catch {
    // pgrep unavailable / errored → fail-open (do not block startup).
  }
}

const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) {
  console.error("[phone-channel] FATAL: SUPABASE_SERVICE_ROLE_KEY not set in .env — phone-channel cannot connect");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Persistent cursor for sweep ---
const CURSOR_PATH = installTools("data/phone-channel-cursor.json");
const CURSOR_FALLBACK_MS = 30 * 60 * 1000;

function loadCursor() {
  try {
    const data = JSON.parse(fs.readFileSync(CURSOR_PATH, "utf8"));
    if (data.lastSeenAt) return data.lastSeenAt;
  } catch {}
  return new Date(Date.now() - CURSOR_FALLBACK_MS).toISOString();
}

function saveCursor(ts) {
  if (!ts) return;
  try {
    const tmp = CURSOR_PATH + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ lastSeenAt: ts, updated: new Date().toISOString() }));
    fs.renameSync(tmp, CURSOR_PATH);
  } catch (err) {
    console.error(`[phone-channel] cursor save failed: ${err.message}`);
  }
}

let _cachedUserTz = null; // skip redundant timezone writes when unchanged

// Instance ID for tracing which phone-channel process handles what
const INSTANCE_ID = `pc-${process.pid}`;
const ACK_LOG = installTools("agent/logs/ack-trace.log");
const log = (msg) => {
  const line = `${new Date().toISOString()} [${INSTANCE_ID}] ${msg}\n`;
  console.error(line.trim());
  fs.appendFileSync(ACK_LOG, line);
};

// ─── Release gate for chat-agent replies: send first, correct in place ─────
//
// Rule #2 (agent/CLAUDE.md): every message into the chat must be checked
// for truth, and chat-agent replies are not exempt — an
// answer composed in-turn may still repeat a stale state claim from a stored
// idea, wiki page or old email. A reply is SOLICITED, so the gate can only
// ever rewrite it, never withhold it; that is what makes it safe to run after
// the reply has landed and correct the same row if it says rewrite. The app
// already renders in-place updates (that is how the ack becomes the reply).
//
// Fire-and-forget: it never delays or fails a reply. The deadline is wider than
// the old 12s inline budget because nobody is waiting on it now, but still
// bounded so a correction cannot arrive minutes after the user has moved on.
const REPLY_GATE_DEADLINE_MS = 45_000;

// The exchange a reply answers, handed to the gate's claim extractor as
// "<user>: …" / "Edva: …" lines, oldest first. Read alone, a reply cannot
// be told apart from a stale status: a reply confirming a name or address the
// user had just given gets re-checked against stored data and "corrected"
// away from the user's own words.
// It reaches the extractor only (see checkFreshness). Fail-soft: on any error,
// just the user's message, or nothing.
const REPLY_EXCHANGE_ROWS = 4;

async function replyExchange(rowId, repliedTo) {
  const fallback = repliedTo ? `${OWNER_LABEL}: ${String(repliedTo).slice(0, 500)}` : "";
  try {
    const { data, error } = await supabase
      .from("edva_messages")
      .select("id, role, content, metadata")
      .eq("channel", "chat")
      .neq("id", rowId)
      .order("created_at", { ascending: false })
      .limit(REPLY_EXCHANGE_ROWS * 2);
    if (error || !Array.isArray(data)) return fallback;
    const rows = data
      .filter((m) => m?.metadata?.is_ack !== "1" && typeof m.content === "string" && m.content.trim())
      .slice(0, REPLY_EXCHANGE_ROWS)
      .reverse();
    if (!rows.length) return fallback;
    return rows.map((m) => `${m.role === "user" ? OWNER_LABEL : "Edva"}: ${m.content.slice(0, 500)}`).join("\n");
  } catch {
    return fallback;
  }
}

async function correctReplyInPlace(rowId, text, repliedTo = null) {
  try {
    const { checkFreshness } = await import("../../lib/claim-freshness.mjs");
    const conversation = await replyExchange(rowId, repliedTo);
    const fresh = await checkFreshness(
      { text, solicited: true, conversation },
      { deadlineMs: REPLY_GATE_DEADLINE_MS },
    );
    if (fresh.verdict !== "rewrite" || !fresh.corrected_text) return;
    // Keep the text being replaced BEFORE the overwrite — the chat row only
    // ever holds the corrected version (lib/superseded-replies.mjs; otherwise
    // the original draft exists in no log).
    recordSuperseded({
      row_id: rowId, original: text, replacement: fresh.corrected_text,
      reason: "freshness_rewrite", source: "phone-channel",
      details: { reasons: fresh.reasons || [], claims: fresh.claims || [] },
    });
    const { error } = await supabase
      .from("edva_messages")
      .update({ content: fresh.corrected_text, metadata: { freshness_rewritten: "1" } })
      .eq("id", rowId);
    if (error) throw new Error(error.message);
    console.error(`[phone-channel] freshness rewrite (in place, ${rowId}): ${fresh.reasons?.[0] || "stale premise attributed"}`);
  } catch (e) {
    console.error(`[phone-channel] freshness gate skipped: ${e?.message || e}`);
  }
}

const mcp = new Server(
  { name: "phone-channel", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
      logging: {},
    },
    instructions: `You are monitoring mobile messages from ${OWNER} via the Edva app.

CRITICAL: \`mcp__phone-channel__reply\` is the ONLY way to deliver text to ${OWNER}. Plain assistant text — anything you "say" without calling the reply tool — is silently dropped; ${OWNER} never sees it. Every Edva message you receive MUST end with at least one reply tool call. One exception: the supervisor's own "Session started" line, sent after every restart, is not from ${OWNER}. If a message of theirs is still unanswered because the restart cut you off, answer that message now; otherwise end the turn without calling reply. If you produce ANY substantive answer text, that text must be the \`message\` argument to a reply tool call, NOT a plain text content block in your turn.

THREADED REPLIES: ${OWNER_LABEL} often reads Edva in between other things, so several messages stack up before they answer. When they tap Reply on a specific bubble, the message you receive opens with a \`[Threaded reply]\` block quoting the message they answered. Treat that quoted message as the subject — NOT the most recent exchange in the "Recent conversation" tail, which is usually about something else by then. Say enough in your reply to make clear which thread you're answering.

If you have nothing to say (e.g. a tool failed), still call reply with a one-line acknowledgement rather than ending the turn silently. The chat-supervisor has a safety net that auto-posts orphaned text — but that's a recovery path for bugs, not the design; never rely on it.

RESTARTS: never tell ${OWNER} you're up, back or standing by. Restarts and recoveries belong to the system channel, and only the watchdog writes those.

Keep responses concise — ${OWNER} is on their phone.`,
  }
);

// --- Tools ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a response back to " + OWNER + " via the Edva mobile app. " +
        "For any reply longer than ~80 characters, or that contains structured/multi-section content " +
        "(digests, briefings, lists), you MUST provide a short `summary` — this becomes the push " +
        "notification body (e.g. 'Weekend events ready', 'P1 email: draft ready'). " +
        "The full `message` still lands in the chat.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The full message body to insert into the Edva chat. With `message_file`, an optional short lead-in placed above the file's text.",
          },
          message_file: {
            type: "string",
            description:
              "Path to a finished message a tool already wrote (a tool's `message_file` output). " +
              "Sent exactly as written, so you don't retype it — use it whenever a tool hands you one. " +
              "Must be a file under data/reply-files/.",
          },
          summary: {
            type: "string",
            description:
              "Short one-line notification body shown in the push (≤80 chars). " +
              "Describes what the message is about, not a copy of its content. " +
              "Required when message is long or structured.",
          },
          time_sensitive: {
            type: "boolean",
            description:
              "Default false. Set TRUE only when this is a direct answer " + OWNER + " is ACTIVELY WAITING FOR and likely can't look at the screen — above all when they voice-summoned Edva hands-free (\"Hey Siri, Summon Edva\") or is otherwise driving. True marks the push time-sensitive so it pierces Driving/DND Focus and gets read aloud over AirPods/CarPlay. NEVER set true for anything proactive or ambient (digests, hum pings, ideas, suggestions, FYIs, reminders they didn't just ask about) — those must not interrupt them while driving. Rare genuine urgency (a real P1 they need now) may also use true.",
          },
        },
        // One of message / message_file — checked in the handler.
        required: [],
      },
    },
    {
      name: "get_location",
      description:
        "Request " + OWNER + "'s current location from their phone",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "reply") {
    let message;
    try {
      message = composeReply(request.params.arguments || {});
    } catch (err) {
      return { content: [{ type: "text", text: `Reply not sent: ${err.message}` }], isError: true };
    }
    const summary = request.params.arguments.summary;
    // Time-sensitive = "interrupt even while driving" (pierces Driving/DND Focus
    // + read aloud). Reserved for direct answers the user is actively awaiting
    // (esp. voice-summoned / driving); never for proactive/ambient messages.
    const timeSensitive = request.params.arguments.time_sensitive === true;
    console.error(`[phone-channel] Sending reply${timeSensitive ? " (time-sensitive)" : ""}: ${message.slice(0, 200)}`);

    // Find the most recent pending message for profiling
    const profMsgId = [...pendingMessages.keys()].pop();
    if (profMsgId) profLog(profMsgId, "t3_replyCall");

    // The release gate (is this still TRUE?) runs AFTER the reply lands — see
    // correctReplyInPlace below. It used to run here, before the insert, and
    // was the single largest share of chat latency (p50 ~23s on the reply
    // tool), because a reply carries no provenance,
    // so every one is "undated" and pays a Sonnet extraction + memory re-check
    // + adjudication. A solicited reply can only ever be rewritten, never
    // withheld, so nothing is lost by sending first and correcting the same
    // row in place (send-then-correct, the user's choice).
    const deliveredMessage = message;

    // Stop the ack refresh interval. If we have an ack row, UPDATE it in place
    // with the real reply — that keeps a single stable message row in the
    // chat UI (ack → real reply) instead of a delete+insert flicker.
    const pendingEntry = profMsgId ? pendingMessages.get(profMsgId) : null;
    // Tells a still-in-flight ack (generated off the critical path, see
    // startAck) that the reply beat it, so it must not land after the answer.
    if (pendingEntry) pendingEntry.replied = true;
    if (pendingEntry?.ackInterval) {
      clearInterval(pendingEntry.ackInterval);
      pendingEntry.ackInterval = null;
    }

    let reuseAckId = pendingEntry?.ackMsgId;
    // Null out on the pending entry so the refresh-interval's in-flight tick
    // (which checks pending.ackMsgId) skips its own update and doesn't race.
    if (pendingEntry) pendingEntry.ackMsgId = null;

    // If this reply was streaming into a row, finish THAT row. Its last partial
    // write must land before the final one, so wait for it. An ack the stream
    // didn't claim (the stream had to insert its own row) is now redundant.
    const streamed = takeStreamRow(message);
    if (streamed) {
      await streamed.chain.catch(() => {});
      if (streamed.rowId) {
        if (reuseAckId && reuseAckId !== streamed.rowId) {
          supabase.from("edva_messages").delete().eq("id", reuseAckId)
            .then(({ error }) => { if (error) log(`superseded ack delete error: ${error.message}`); });
        }
        reuseAckId = streamed.rowId;
      }
    }

    try {
      let inserted;
      if (reuseAckId) {
        const { data, error } = await supabase
          .from("edva_messages")
          // Clear is_ack — this row is now a real reply and SHOULD be visible
          // to the next message's ack-history window.
          .update({ content: deliveredMessage, read: false, metadata: {} })
          .eq("id", reuseAckId)
          .select("id")
          .single();
        if (error || !data) {
          console.error(`[phone-channel] Ack in-place update failed (${error?.message || "no row"}); falling back to insert`);
        } else {
          inserted = data;
          console.error(`[phone-channel] Replaced ack ${reuseAckId} with real reply`);
        }
      }
      let error;
      if (!inserted) {
        ({ data: inserted, error } = await supabase.from("edva_messages").insert({
          role: "assistant",
          content: deliveredMessage,
          read: false,
        }).select("id").single());
      }

      if (profMsgId) {
        profLog(profMsgId, "t4_replyDone");
        profSummary(profMsgId);
      }

      if (error) {
        console.error(`[phone-channel] Supabase insert error: ${error.message}`);
        return {
          content: [{ type: "text", text: `Failed to send reply: ${error.message}` }],
          isError: true,
        };
      }

      // Delay push to allow foreground apps to mark as read via realtime
      const msgId = inserted?.id;
      // A message_file reply was composed by a tool (a recommendation CLI, …) from the source
      // of record seconds ago — it IS the live evidence, so the freshness gate has nothing to
      // re-check; and a rewrite would replace the whole row with prose (e.g. a poster list cut
      // to 1,200 chars, with "as of when I looked" hedges on live data).
      if (msgId && !request.params.arguments?.message_file) correctReplyInPlace(msgId, message, pendingEntry?.text || null);
      setTimeout(async () => {
        try {
          if (msgId) {
            const { data: row } = await supabase
              .from("edva_messages")
              .select("read")
              .eq("id", msgId)
              .single();
            if (row?.read) {
              console.error(`[phone-channel] Message already read, skipping push`);
              return;
            }
          }
          // The push goes out before the freshness gate finishes, so it previews
          // the reply as written; a later correction updates the chat row only.
          const body = summary
            || (deliveredMessage.length > 100 ? deliveredMessage.slice(0, 100) + "…" : deliveredMessage);
          // A reply is SOLICITED — the user asked and is waiting. The motion
          // gate (which parks non-urgent alerts while the user is walking or driving)
          // is for proactive traffic only; holding an answer the user is waiting on
          // would be the same failure Rule #2 forbids, one layer down. Note this
          // is separate from `urgent`: that still decides whether the reply
          // pierces Focus and gets read aloud, and stays narrow by design.
          await sendApnsPush(supabase, {
            body, messageId: msgId, urgent: timeSensitive, skipMotionGate: true,
          });
        } catch (err) {
          console.error(`[phone-channel] Push failed: ${err.message}`);
        }
      }, 1500);

      return {
        content: [{ type: "text", text: "Reply sent to Edva app" }],
      };
    } catch (err) {
      console.error(`[phone-channel] Error: ${err.message}`);
      return {
        content: [{ type: "text", text: `Error sending reply: ${err.message}` }],
        isError: true,
      };
    }
  }

  if (request.params.name === "get_location") {
    console.error("[phone-channel] Requesting location from device");

    try {
      // Insert a pending command
      const { data: inserted, error: insertError } = await supabase
        .from("edva_commands")
        .insert({ command: "get_location", status: "pending" })
        .select()
        .single();

      if (insertError) {
        return {
          content: [{ type: "text", text: `Failed to request location: ${insertError.message}` }],
          isError: true,
        };
      }

      const commandId = inserted.id;

      // Poll for completion (every 1s, max 15s)
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));

        const { data: row, error: pollError } = await supabase
          .from("edva_commands")
          .select()
          .eq("id", commandId)
          .single();

        if (pollError) {
          console.error(`[phone-channel] Poll error: ${pollError.message}`);
          continue;
        }

        if (row.status === "completed") {
          const response = typeof row.response === "string" ? JSON.parse(row.response) : row.response;
          console.error(`[phone-channel] Location received: ${JSON.stringify(response)}`);
          return {
            content: [{ type: "text", text: JSON.stringify(response) }],
          };
        }

        if (row.status === "failed") {
          const response = typeof row.response === "string" ? JSON.parse(row.response) : row.response;
          return {
            content: [{ type: "text", text: `Location failed: ${response?.error || "unknown error"}` }],
            isError: true,
          };
        }
      }

      return {
        content: [{ type: "text", text: "Location request timed out (15s). The phone may be unreachable." }],
        isError: true,
      };
    } catch (err) {
      console.error(`[phone-channel] Location error: ${err.message}`);
      return {
        content: [{ type: "text", text: `Error requesting location: ${err.message}` }],
        isError: true,
      };
    }
  }

  return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
});

// --- Profiling ---

const pendingMessages = new Map(); // msgId -> { text, t0_created, t1_realtime, t2_notified, t3_replyCall, t4_replyDone }

function profLog(msgId, stage, extra = "") {
  const entry = pendingMessages.get(msgId);
  if (!entry) return;
  const now = Date.now();
  entry[stage] = now;
  const sincePrev = Object.keys(entry).filter(k => k.startsWith("t") && typeof entry[k] === "number").sort();
  const prevStage = sincePrev[sincePrev.length - 2];
  const delta = prevStage ? now - entry[prevStage] : 0;
  const total = now - entry.t0_created;
  console.error(`[PROF] ${stage} +${delta}ms (total ${total}ms) ${extra}`);
}

function profSummary(msgId) {
  const e = pendingMessages.get(msgId);
  if (!e) return;
  const total = (e.t4_replyDone || Date.now()) - e.t0_created;
  const supaDelay = (e.t1_realtime || 0) - e.t0_created;
  const notifyTime = (e.t2_notified || 0) - (e.t1_realtime || 0);
  const llmTime = (e.t3_replyCall || 0) - (e.t2_notified || 0);
  const replyInsert = (e.t4_replyDone || 0) - (e.t3_replyCall || 0);
  console.error(`[PROF] === "${e.text.slice(0, 50)}" total=${total}ms ===`);
  console.error(`[PROF]   Supabase Realtime delay: ${supaDelay}ms`);
  console.error(`[PROF]   MCP notification send:   ${notifyTime}ms`);
  console.error(`[PROF]   LLM thinking + routing:  ${llmTime}ms`);
  console.error(`[PROF]   Reply insert to Supa:    ${replyInsert}ms`);
  pendingMessages.delete(msgId);
}

// --- Ack generation ---

// Short conversational messages that don't need an ack.
const SKIP_ACK = /^(ok|okay|thanks|thank you|thx|ty|yep|yup|yeah|yes|no|nah|nope|cool|nice|got it|k|lol|haha|sure|👍|❤️|🙏)\s*[.!?]*$/i;

// Stop refreshing the ack after this many updates per conversation. At the
// 5s cadence below this is ~1 minute — a stuck chat-agent can't flood the
// UI with updates for one message.
const ACK_REFRESH_MAX_COUNT = 12;
const ACK_REFRESH_INTERVAL_MS = 5_000;
// The "working" status line is CANNED ONLY (a user decision). A local 1B
// model writing a one-line status from the conversation produced false facts
// and junk lines that the sanitizer let through. A status line must never
// state a fact, and fixed copy cannot. State-only: each line says Edva is
// still working; none promises a reply is imminent.
const ACK_INITIAL_MESSAGE = "On it…";
const CANNED_REFRESH_MESSAGES = [
  "Still on it…",
  "Working…",
  "Thinking…",
  "Processing…",
  "Looking into it…",
];

/// Threaded replies. The user often reads Edva in between other
/// things, so several pings stack up before an answer. The app lets
/// the user tap Reply on a specific bubble, which sets `reply_to` on the message.
/// Without this block the agent reads the reply against the newest message in
/// the "Recent conversation" tail — exactly the misfire the feature exists to
/// prevent — and the parent is often outside that 10-message window anyway.
const REPLY_QUOTE_MAX_CHARS = 1200;

/**
 * Hum routing for the agent prompt: which hum item a threaded reply answers,
 * plus — when the message plausibly answers several — the roster of open items
 * and the rule that each part must be filed against the item it answers.
 *
 * Runs for EVERY inbound message, not just threaded ones: the catch-up reply
 * that answers three pings at once is frequently not threaded at all. The lib
 * decides when the roster is warranted so it stays off the ~95% of messages
 * that are fresh commands. Fail-soft — a routing hint is never worth losing
 * the message over.
 */
async function buildHumBlock(row, text) {
  try {
    const { humRoutingBlock, humStateBlock } = await import("../../lib/hum-reply-target.mjs");
    // [Hum state]: the pending question / last-ping windows / open
    // ideas ping / canary, precomputed so the agent's Hum Inbound steps don't
    // read three files and do clock math by hand on every message.
    return humRoutingBlock({ replyTo: row.reply_to, text }) + humStateBlock();
  } catch (err) {
    console.error(`[phone-channel] hum routing hint failed: ${err.message}`);
    return "";
  }
}

/**
 * Improvement-card context for the agent prompt. An improvement
 * card's "Chat" action anchors a thread on a message representing that card;
 * this resolves the LIVE row behind the anchor so the answer is grounded in the
 * card's current status and actual files, not in the one-line summary frozen
 * into the anchor's text. Empty string for every other reply. Fail-soft — a
 * missing hint is never worth losing the message over.
 */
async function buildImprovementBlock(row) {
  if (!row?.reply_to) return "";
  try {
    const { improvementRoutingBlock } = await import("../../lib/improvement-reply-target.mjs");
    return await improvementRoutingBlock({ replyTo: row.reply_to });
  } catch (err) {
    console.error(`[phone-channel] improvement routing hint failed: ${err.message}`);
    return "";
  }
}

/**
 * A typed reply to a decision card (hum `decisions` lane, bin/decision-ask)
 * — an exact tap never gets here, choice-reply.mjs files it in code. Tells the
 * agent which decision it answers and how to file it, so the user's words reach the
 * planner / cost review instead of only this conversation. Structured fields
 * only (our own metadata); what the user meant is the agent's reading.
 */
function decisionReplyHint(parent) {
  try {
    const raw = parent?.metadata?.choices;
    const p = typeof raw === "string" ? JSON.parse(raw) : raw;
    // An installation's own card kind (REPLY_HINTS, from _ext/reply-hints.mjs):
    // the user's typed answer is the agent's reading; the hint only names the
    // ref and how to file it. The kernel's decision card is never overridden.
    const extHint = p?.kind !== "decision" && p?.ref ? REPLY_HINTS[p.kind] : null;
    if (typeof extHint === "function") return extHint(p) || "";
    if (p?.kind !== "decision" || !p.ref) return "";
    const opts = (p.options || []).map((o, i) => `${i + 1}. ${o.label}`).join("; ");
    return `[Decision card ${p.ref}] That message was a decision Edva asked them (options: ${opts}). Once you know their answer — an option (by number or meaning) or their own words — file it with \`~/Dev/edva/bin/decision-answer --ref ${p.ref} --option "<that option's label, exactly>"\` or \`--text "<their answer>"\`, then confirm in one short line. If they are asking about it rather than answering, answer and leave it open.\n\n`;
  } catch {
    return "";
  }
}

async function buildReplyBlock(row, tz) {
  if (!row?.reply_to) return "";
  try {
    const { data: parent } = await supabase
      .from("edva_messages")
      .select("role, content, created_at, metadata")
      .eq("id", row.reply_to)
      .single();
    if (!parent) return "";
    const decisionHint = decisionReplyHint(parent);

    let when = "";
    try {
      if (tz && tz !== "unknown") {
        when = new Date(parent.created_at).toLocaleString("en-US", {
          timeZone: tz,
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
      }
    } catch {}

    const body = (parent.content || "").length > REPLY_QUOTE_MAX_CHARS
      ? parent.content.slice(0, REPLY_QUOTE_MAX_CHARS) + "…[truncated]"
      : (parent.content || "");
    const whose = parent.role === "user"
      ? "their own earlier message"
      : "an earlier message of yours";

    return `[Threaded reply] ${OWNER_LABEL} replied directly to ${whose}${when ? ` from ${when}` : ""}, not to the newest message in the conversation above:\n"""\n${body}\n"""\nRead their message below as an answer to THAT, and answer in that context.\n\n${decisionHint}`;
  } catch (err) {
    console.error(`[phone-channel] Reply-parent fetch failed: ${err.message}`);
    return "";
  }
}

// --- Realtime subscription ---

// Load persisted cursor (falls back to 30-min lookback if no cursor file).
let lastSeenAt = loadCursor();
let currentChannel = null;

// The cursor is the acknowledgement the sweep reads, so it only ever moves
// forward (share-bundle.mjs § laterTimestamp: moving it back re-dispatches an
// already-answered message).
function advanceCursor(ts) {
  const next = laterTimestamp(lastSeenAt, ts);
  if (next === lastSeenAt) return;
  lastSeenAt = next;
  saveCursor(lastSeenAt);
}

// A share-sheet send is several rows; they reach the agent as one message
// (share-bundle.mjs). Typed messages never wait in here.
const shareBundler = new ShareBundler({
  onFlush: (merged) => handleIncomingMessage(merged)
    .catch((err) => console.error(`[phone-channel] share bundle dispatch failed: ${err.message}`)),
});

async function handleIncomingMessage(row) {
  if (!row.shareBundleIds && shareBundler.add(row)) return;
  const msgId = row.id;
  const text = row.content;
  const metadata = row.metadata || {};
  const tz = metadata.timezone || "unknown";
  const utcOffset = metadata.utc_offset || "unknown";
  const createdAt = new Date(row.created_at).getTime();

  if (pendingMessages.has(msgId)) return; // already processing
  // Anything new the user sends goes after a share still being collected.
  if (!row.shareBundleIds) shareBundler.flush();
  pendingMessages.set(msgId, { text, t0_created: createdAt });
  ensureStreamPoll();

  // Persist the user's current timezone for trigger scripts (pulse sleep-window check).
  //
  // Only from a message the PHONE sent — one carrying a device location fix.
  // A synthetic user message (e.g. a latency benchmark) carrying a default
  // timezone and no location would otherwise flip the stored zone while the
  // user is abroad and shift every local time that follows by hours.
  const fromDevice = metadata.latitude != null && metadata.longitude != null;
  if (fromDevice && tz && tz !== "unknown" && tz !== _cachedUserTz) {
    _cachedUserTz = tz;
    try {
      const tzPath = installTools("data/user-timezone.json");
      const tmp = tzPath + ".tmp." + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ timezone: tz, utc_offset: utcOffset, updated_at: new Date().toISOString() }));
      fs.renameSync(tmp, tzPath);
    } catch {}
  }
  profLog(msgId, "t1_realtime", `msg="${text.slice(0, 80)}"`);
  log(`handleIncomingMessage: "${text.slice(0, 80)}"`);

  // Fire-and-forget the suggestion classifier. If the user's message is a
  // reaction to a recent advisory hum ping (e.g. free-text "too pricey
  // for me" or "this again?"), it writes a structured `reaction` event
  // to suggestion-history.jsonl so the next dining/music/art lane scout
  // sees the rejection. Tapback reactions take a separate path via
  // `recordHumReaction` / `edva hum feedback` and don't double-count
  // (the classifier dedups by appending only when its rule/Gemma judgment
  // adds new info, and the deriveState fold keeps the most-specific reason).
  // Tapped a multiple-choice answer? Resolve it here and stop.
  //
  // The tap is deliberately an ordinary user message (that is what makes the
  // choice UX generic), but that also put it on the full dispatch path: one tap
  // cost a Sonnet turn re-reading a ~146k prefix and ~45s of "Working…" to say
  // "Saved —". Everything needed is already in the prompt's metadata, so act on
  // it in code. Fails OPEN — anything unrecognised continues to ack+dispatch
  // exactly as before, so a typed answer is unaffected.
  try {
    const { handleChoiceReply } = await import("../../lib/choice-reply.mjs");
    const outcome = await handleChoiceReply(supabase, row, text);
    if (outcome.handled) {
      // A null reply is a silent tick (a checklist box): the app's checkmark is the confirmation.
      if (outcome.reply) await supabase.from("edva_messages").insert({
        role: "assistant", content: outcome.reply, read: true,
        channel: row.channel || "chat", reply_to: row.id,
      });
      // ADVANCE THE CURSOR. Every other success branch ends with
      // `advanceCursor(row.created_at)`, and the failure branch
      // documents why ("Do NOT advance lastSeenAt — sweep will retry this
      // message"): the cursor IS the acknowledgement. This early return
      // originally skipped it, so the sweep — which selects on `read=false AND
      // created_at > lastSeenAt` — re-selected the same tap every couple of
      // minutes and answered it again, forever (two taps produced hundreds of
      // duplicate "Saved — …" messages). A fast path that answers without acknowledging is not a
      // shortcut, it is a loop.
      advanceCursor(row.created_at);
      pendingMessages.delete(msgId);
      profLog(msgId, "t2_choice_fastpath", `${outcome.kind} — no agent turn`);
      log(`choice fast-path: ${outcome.reply ?? outcome.kind}`);
      return;
    }
  } catch (err) {
    console.error(`[phone-channel] choice fast-path error, dispatching normally: ${err.message}`);
  }

  classifySuggestionReply(msgId, text, row.reply_to);

  // Everything the agent turn needs starts NOW, in parallel.
  // Run strictly after the ack (then a local-model call, ~1.5s
  // warm, up to 8s on a cold load) and then one after another, a message would spend ~3–10s in this
  // process before the agent ever saw it. The ack is a UI placeholder; nothing
  // in the dispatch depends on it, so it now runs alongside (startAck below).
  const recallP = withCap(autoRecallBlock(text).catch(() => ""), AUTO_RECALL_CAP_MS, "");
  // "Recent conversation" is THIS channel's thread, the same scope the ack
  // history already uses (startAck). Unscoped, the 10-row window mixed in
  // `system` alerts and `improvements` cards the user never saw in Chat, and on a
  // busy evening (several Jev disagreement notes in two hours) they crowd the
  // actual conversation out of the agent's context.
  const historyP = supabase
    .from("edva_messages")
    .select("id, role, content")
    .eq("channel", row.channel || "chat")
    .order("created_at", { ascending: false })
    .limit(10);
  const replyBlockP = buildReplyBlock(row, tz);
  const humBlockP = buildHumBlock(row, text);
  const improvementBlockP = buildImprovementBlock(row);

  // Fire-and-forget; see the header on startAck for the race with the reply.
  startAck(msgId, row, text).catch((err) => log(`ack task error: ${err.message}`));

  try {
    // Auto-recall: relevant long-term memory + recent chat for
    // THIS message, prepended below so the agent has it in context without
    // deciding to call the recall tool. Bounded + fail-soft (→ "").
    const { data: history } = await historyP;

    // A share's other rows are in the new message itself; don't repeat them
    // above it as if the user had sent them earlier.
    const otherShareRows = new Set((row.shareBundleIds || []).filter((id) => id !== msgId));
    const convoLines = (history || []).filter((m) => !otherShareRows.has(m.id)).reverse().map((m) => {
      const who = m.role === "user" ? OWNER_LABEL : "You";
      return `${who}: ${m.content}`;
    });

    const convoBlock = convoLines.length > 1
      ? `Recent conversation:\n${convoLines.slice(0, -1).join("\n")}\n\n`
      : "";

    // Compute the user's local time from device timezone
    let localTimeStr = "unknown";
    let tzAbbr = "";
    try {
      if (tz !== "unknown") {
        localTimeStr = new Date().toLocaleString("en-US", {
          timeZone: tz,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        tzAbbr = new Date().toLocaleString("en-US", {
          timeZone: tz,
          timeZoneName: "short",
        }).split(" ").pop(); // e.g. "ET", "PT", "CT"
      }
    } catch {}

    let locationLine = "";
    if (metadata.latitude && metadata.longitude) {
      locationLine = `\n[Location: ${metadata.latitude}, ${metadata.longitude} (accuracy: ${metadata.location_accuracy || "unknown"}m)]`;
    }

    // Sent from the iOS/macOS share sheet (client/EdvaShare), not typed: a
    // photo arrives as its own bare edva-attachments URL row, the note and
    // shared text/links as the following row; shareBundler has already joined
    // them into this one message, photos first.
    const shareLine = metadata.source === "share" ? "\n[Shared into Edva from another app via the share sheet]" : "";

    const [recallBlock, replyBlock, humBlock, improvementBlock] =
      await Promise.all([recallP, replyBlockP, humBlockP, improvementBlockP]);
    profLog(msgId, "t1b_context", `recall=${recallBlock ? "yes" : "no"}`);
    const builtContent = `${recallBlock}${convoBlock}${replyBlock}${humBlock}${improvementBlock}New message from ${OWNER}:\n\n${text}\n\n[Current time: ${localTimeStr} ${tzAbbr}]${locationLine}${shareLine}`;
    const DISPATCH_URL = process.env.EDVA_DISPATCH_URL;

    if (DISPATCH_URL) {
      // Supervisor mode: POST to chat supervisor's HTTP dispatch endpoint.
      try {
        const resp = await fetch(DISPATCH_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: builtContent, source: "edva", priority: "high", msgId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        profLog(msgId, "t2_notified", "via HTTP dispatch");
        advanceCursor(row.created_at);
      } catch (httpErr) {
        console.error(`[phone-channel] HTTP dispatch failed (${httpErr.message}), falling back to MCP notification`);
        await mcp.notification({
          method: "notifications/claude/channel",
          params: { content: builtContent, meta: { source: "edva", ts: new Date().toISOString(), timezone: tz, _profMsgId: msgId } },
        });
        profLog(msgId, "t2_notified", "via MCP fallback");
        advanceCursor(row.created_at);
      }
    } else {
      // Legacy mode: MCP channel notification (interactive Claude only).
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: builtContent,
          meta: { source: "edva", ts: new Date().toISOString(), timezone: tz, utcOffset, localTime: localTimeStr, latitude: metadata.latitude, longitude: metadata.longitude, _profMsgId: msgId },
        },
      });
      profLog(msgId, "t2_notified");
      advanceCursor(row.created_at);
    }
  } catch (err) {
    // Do NOT advance lastSeenAt — sweep will retry this message.
    console.error(`[phone-channel] Failed to send notification: ${err.message}`);
  }
}

// Hard ceiling on how long auto-recall may hold a dispatch. autoRecallBlock
// bounds retrieval (1.2s) and its judge (Jev 2.5s → Sonnet 4s) itself; this is
// the backstop so no future change inside it can stall the chat again.
const AUTO_RECALL_CAP_MS = 6_000;

function withCap(p, ms, fallback) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

/**
 * The "On it…" placeholder + its 5s refresh, off the dispatch critical path.
 *
 * RACE WITH THE REPLY. The ack used to be inserted before dispatch, so it
 * always existed by the time the agent replied. Now the reply can in principle
 * win. The reply handler sets `pending.replied = true` and reads
 * `pending.ackMsgId` in one synchronous step; this function sets ackMsgId and
 * checks `replied` in one synchronous step right after its insert resolves.
 * JS runs each of those blocks atomically, so exactly one of two things
 * happens: the ack registered first (the reply reuses the row and clears the
 * interval), or the reply landed first (this deletes its now-orphaned row).
 */
async function startAck(msgId, row, text) {
  const pending = pendingMessages.get(msgId);
  if (!pending) return;
  // Canned ack only — see ACK_INITIAL_MESSAGE.
  let ackMsgId = null;
  if (!SKIP_ACK.test(text.trim())) {
    const ackMsg = ACK_INITIAL_MESSAGE;
    if (ackMsg) {
      log(`ack: "${ackMsg}"`);
      const { data: ackRow, error: ackErr } = await supabase
        .from("edva_messages")
        // is_ack marks this row as placeholder copy so the next message's ack
        // history skips it. Cleared when the real reply overwrites the row.
        .insert({ role: "assistant", content: ackMsg, read: false, metadata: { is_ack: "1" } })
        .select("id")
        .single();
      if (ackErr) {
        log(`ack insert error: ${ackErr.message || ackErr.code || JSON.stringify(ackErr)}`);
      } else {
        ackMsgId = ackRow?.id;
        log(`ack inserted id=${ackMsgId}`);
      }
    }
  }
  // Must stay synchronous from here through setInterval — see the header.
  // A reply already streaming into its own row also wins (see streamTick).
  if (pending.replied || pending.streaming) {
    if (ackMsgId) {
      log(`ack ${ackMsgId} lost the race to the reply; removing it`);
      supabase.from("edva_messages").delete().eq("id", ackMsgId)
        .then(({ error }) => { if (error) log(`orphan ack delete error: ${error.message}`); });
    }
    return;
  }
  // Store ackMsgId so the reply handler can replace it in place
  pending.ackMsgId = ackMsgId;

  // Refresh the ack with the next canned line while waiting for the real
  // reply. Capped per-conversation by ACK_REFRESH_MAX_COUNT.
  if (ackMsgId) {
    let refreshCount = 0;
    pending.ackInterval = setInterval(async () => {
      if (refreshCount >= ACK_REFRESH_MAX_COUNT) {
        clearInterval(pending.ackInterval);
        pending.ackInterval = null;
        console.error(`[phone-channel] Ack refresh cap reached (${ACK_REFRESH_MAX_COUNT}); stopping for msg ${msgId}`);
        return;
      }
      refreshCount++;

      // Rotate through the canned lines so the indicator keeps moving.
      const updated = CANNED_REFRESH_MESSAGES[(refreshCount - 1) % CANNED_REFRESH_MESSAGES.length];

      if (!pending.ackMsgId) return; // real reply already landed, skip update

      await supabase
        .from("edva_messages")
        .update({ content: updated })
        .eq("id", pending.ackMsgId);
      console.error(`[phone-channel] Ack refresh #${refreshCount}: "${updated}"`);
    }, ACK_REFRESH_INTERVAL_MS);
  }
}

// --- Reply streaming ---
//
// The reply text is a `reply` tool argument, and the supervisor sees it arrive
// chunk by chunk (claude -p --include-partial-messages; lib/reply-stream.mjs).
// While a message is outstanding we poll its GET /reply-draft and paint the
// text into the chat row, so a long answer starts appearing about a second
// after the agent begins writing it instead of when it finishes.
//
// This process owns every write to the row, so the orderings that matter are
// in-process, not races between two writers:
//   - the first stream write claims the "On it…" row: stops its refresh timer
//     and takes it off the pending entry, so the refresh can't overwrite text;
//     with no ack row yet, the stream inserts its own and startAck deletes its
//     late ack (pending.streaming);
//   - writes for one row go through one promise chain, and the reply handler
//     waits on it before the final write, so a partial never lands last;
//   - each reply tool call streams into its own row (keyed by tool_use id), and
//     the reply handler picks the row whose streamed text is a prefix of its
//     message.
// Streamed writes never push; the reply handler's push is the only one. The
// truth gate still runs on the final text only (send-then-correct).
const STREAM_ENABLED = process.env.CHAT_REPLY_STREAM !== "0";
const STREAM_POLL_MS = 400;
// Short replies finish in about a second; streaming them only adds a flicker.
const STREAM_MIN_CHARS = 60;
const streamRows = new Map();      // tool_use id → { rowId, shown, raw, chain }
const finishedDrafts = new Set();  // tool_use ids a reply call already delivered
const recentReplies = [];          // { text, at } — guards a draft seen after its own reply
let streamPollTimer = null;
let streamTickBusy = false;

function ensureStreamPoll() {
  if (!STREAM_ENABLED || !process.env.EDVA_DISPATCH_URL || streamPollTimer) return;
  streamPollTimer = setInterval(() => {
    streamTick().catch((err) => log(`stream tick error: ${err.message}`));
  }, STREAM_POLL_MS);
}

// Called by the reply handler. Returns the stream entry for this message (and
// retires it), or null when the reply wasn't streamed.
function takeStreamRow(message) {
  recentReplies.push({ text: message, at: Date.now() });
  while (recentReplies.length > 20) recentReplies.shift();
  for (const [id, entry] of streamRows) {
    if (message.startsWith(entry.raw)) {
      streamRows.delete(id);
      finishedDrafts.add(id);
      return entry;
    }
  }
  return null;
}

async function streamTick() {
  if (streamTickBusy) return;
  streamTickBusy = true;
  try {
    const base = process.env.EDVA_DISPATCH_URL.replace(/\/dispatch$/, "");
    let draft;
    try {
      draft = await fetch(`${base}/reply-draft`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
    } catch {
      return; // supervisor busy/restarting; next tick retries
    }
    const now = Date.now();
    while (recentReplies.length && now - recentReplies[0].at > 120_000) recentReplies.shift();

    for (const d of draft.drafts || []) {
      if (finishedDrafts.has(d.id) || typeof d.text !== "string") continue;
      const shown = displayableDraft(d.text);
      let entry = streamRows.get(d.id);
      if (!entry) {
        // Don't start a stream for a reply that's already complete or already
        // delivered — the final write is moments away.
        if (d.done || shown.length < STREAM_MIN_CHARS) continue;
        if (recentReplies.some((r) => r.text.startsWith(d.text))) { finishedDrafts.add(d.id); continue; }
        // Claim synchronously (no await between the checks above and here), so
        // the reply handler always finds this entry once it exists.
        entry = { rowId: null, shown, raw: d.text, chain: null };
        streamRows.set(d.id, entry);
        const pendingKey = [...pendingMessages.keys()].pop();
        const pending = pendingKey ? pendingMessages.get(pendingKey) : null;
        if (pending) {
          pending.streaming = true;
          if (pending.ackInterval) { clearInterval(pending.ackInterval); pending.ackInterval = null; }
        }
        const ackId = pending?.ackMsgId || null;
        if (pending) pending.ackMsgId = null;
        entry.chain = (ackId
          ? supabase.from("edva_messages").update({ content: shown }).eq("id", ackId).then(({ error }) => {
              if (error) throw error;
              entry.rowId = ackId;
            })
          : supabase.from("edva_messages")
              // is_ack keeps it out of the next ack's history until it's final.
              .insert({ role: "assistant", content: shown, read: false, metadata: { is_ack: "1" } })
              .select("id").single().then(({ data, error }) => {
                if (error) throw error;
                entry.rowId = data?.id || null;
              })
        ).catch((err) => log(`stream start error: ${err.message || err}`));
        log(`stream: reply ${d.id.slice(-8)} → ${ackId ? `ack ${ackId}` : "new row"}`);
        continue;
      }
      entry.raw = d.text;
      if (shown === entry.shown) continue;
      entry.shown = shown;
      entry.chain = entry.chain.then(() => {
        if (!entry.rowId) return;
        return supabase.from("edva_messages").update({ content: entry.shown }).eq("id", entry.rowId)
          .then(({ error }) => { if (error) log(`stream write error: ${error.message}`); });
      });
    }

    if (!draft.turnActive) {
      // A streamed reply whose tool call never completed: the text was written
      // for the user, so leave it standing as a real message.
      for (const [id, entry] of streamRows) {
        streamRows.delete(id);
        finishedDrafts.add(id);
        entry.chain.then(() => entry.rowId && supabase.from("edva_messages")
          .update({ content: entry.raw, metadata: {} }).eq("id", entry.rowId))
          .catch(() => {});
        log(`stream: reply ${id.slice(-8)} ended without a reply call; kept its text`);
      }
      if (pendingMessages.size === 0) {
        clearInterval(streamPollTimer);
        streamPollTimer = null;
      }
    }
    if (finishedDrafts.size > 200) {
      for (const id of [...finishedDrafts].slice(0, 100)) finishedDrafts.delete(id);
    }
  } finally {
    streamTickBusy = false;
  }
}

const REACTION_EMOJI = {
  heart: "❤️",
  thumbs_up: "👍",
  thumbs_down: "👎",
};

// Hum feedback log path — we resolve tapback reactions back to the ping_id by
// scanning this file for a matching `message_id` (captured at ping-send time
// via `edva-send-curl --capture-id`, see jobs/hum.md step 3).
const HUM_FEEDBACK_PATH = installTools("data/hum-feedback.jsonl");
const HUM_CLI = installTools("bin/edva");

/// Look up the hum ping_id for a reacted-to edva_messages.id. Returns null
/// if the message isn't a hum ping (or the ping pre-dates message_id capture).
function findHumPingIdForMessage(messageId) {
  if (!messageId) return null;
  let raw;
  try { raw = fs.readFileSync(HUM_FEEDBACK_PATH, "utf8"); }
  catch { return null; }
  // Scan newest-first — typical reaction arrives within minutes of the ping.
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.message_id === messageId && r.ping_id) return r.ping_id;
    } catch {}
  }
  return null;
}

/// Record a tapback reaction against a hum ping via the edva CLI. Runs in
/// the background (fire-and-forget) so the forward notification to chat-agent
/// isn't blocked on shelling out. reactionToken is the raw Supabase value
/// ("heart"/"thumbs_up"/"thumbs_down"); `edva hum feedback` accepts those
/// via its HUM_REACTION_ALIASES table.
function recordHumReaction(pingId, reactionToken) {
  import("node:child_process").then(({ spawn }) => {
    const child = spawn(HUM_CLI, ["hum", "feedback", pingId, reactionToken], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", (err) => {
      console.error(`[phone-channel] hum feedback exec failed: ${err.message}`);
    });
    child.unref();
  }).catch((err) => {
    console.error(`[phone-channel] hum feedback import failed: ${err.message}`);
  });
}

// suggestion-classify binary path. Spawned fire-and-forget on every inbound
// user message; it self-decides whether the message is a reaction to the
// most-recent advisory hum ping. Latency-bounded by its own internal
// timeouts (rules are sync, Gemma fallback is 4s) so it never blocks here.
const SUGGESTION_CLASSIFY = installTools("bin/suggestion-classify");

function classifySuggestionReply(messageId, text, replyTo) {
  import("node:child_process").then(({ spawn }) => {
    const argv = ["--message-id", String(messageId || ""), "--text", text];
    // Threaded reply: pin the ping instead of letting the classifier guess by
    // recency — that guess is the mis-attribution the Reply feature kills.
    if (replyTo) argv.push("--reply-to", String(replyTo));
    const child = spawn(SUGGESTION_CLASSIFY, argv, {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", (err) => {
      console.error(`[phone-channel] suggestion-classify exec failed: ${err.message}`);
    });
    child.unref();
  }).catch((err) => {
    console.error(`[phone-channel] suggestion-classify import failed: ${err.message}`);
  });
}

// Read on one device → clear its banner on the others (sendClearPush in
// lib/apns-push.mjs). edva_messages has default replica identity, so
// payload.old carries no `read`: any UPDATE of a read row queues, and
// `readCleared` keeps a message from clearing twice. The 3 s window batches a
// scroll that marks several rows and lets a push that is still going out get
// its recipients recorded before we look them up.
const readCleared = new Set();
const readClearPending = new Set();
let readClearTimer = null;

function queueReadClear(messageId) {
  if (!messageId || readCleared.has(messageId)) return;
  readCleared.add(messageId);
  if (readCleared.size > 2000) readCleared.delete(readCleared.values().next().value);
  readClearPending.add(messageId);
  if (readClearTimer) return;
  readClearTimer = setTimeout(async () => {
    readClearTimer = null;
    const ids = [...readClearPending];
    readClearPending.clear();
    try {
      const r = await sendClearPush(supabase, ids);
      if (r.sent) console.error(`[phone-channel] Cleared ${ids.length} read banner(s) on ${r.ok}/${r.sent} device(s)`);
    } catch (err) {
      console.error(`[phone-channel] Read-clear push failed: ${err.message}`);
    }
  }, 3000);
}

function subscribeToMessages() {
  if (currentChannel) {
    supabase.removeChannel(currentChannel);
    currentChannel = null;
  }

  const channel = supabase
    .channel("edva-user-messages")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "edva_messages",
      },
      async (payload) => {
        const oldRow = payload.old || {};
        const newRow = payload.new || {};
        if (newRow.role !== "assistant") return;
        if (newRow.read === true) queueReadClear(newRow.id);
        if (oldRow.reaction === newRow.reaction) return;

        const reaction = newRow.reaction;
        const emoji = reaction ? (REACTION_EMOJI[reaction] || reaction) : null;
        const snippet = (newRow.content || "").slice(0, 160);
        const content = reaction
          ? `${OWNER_LABEL} reacted ${emoji} to your previous message:\n\n"${snippet}${newRow.content?.length > 160 ? "…" : ""}"\n\nThis is a quality signal from ${OWNER} about that response. No reply is required — acknowledge internally and use it to calibrate future messages. Do not respond unless ${OWNER} has also sent a follow-up message.`
          : `${OWNER_LABEL} removed their reaction from your previous message:\n\n"${snippet}${newRow.content?.length > 160 ? "…" : ""}"\n\nNo reply required.`;

        // If the reacted-to row is a hum ping (has a matching message_id in
        // hum-feedback.jsonl), route the reaction through `edva hum
        // feedback` so hum-daily/hum-review can see it. Only record on a real
        // reaction value — don't propagate clears (hum-feedback has no
        // concept of "un-react" today).
        if (reaction) {
          const humPingId = findHumPingIdForMessage(newRow.id);
          if (humPingId) {
            recordHumReaction(humPingId, reaction);
            console.error(`[phone-channel] Routed tapback ${reaction} → hum feedback ${humPingId}`);
          }
        }

        try {
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content,
              meta: {
                source: "edva",
                kind: "reaction",
                messageId: newRow.id,
                reaction: reaction || null,
                ts: new Date().toISOString(),
              },
            },
          });
          console.error(`[phone-channel] Reaction ${reaction || "cleared"} on ${newRow.id}`);
        } catch (err) {
          console.error(`[phone-channel] Reaction notify failed: ${err.message}`);
        }
      }
    )
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "edva_messages",
        filter: "role=eq.user",
      },
      (payload) => handleIncomingMessage(payload.new)
    )
    .subscribe((status) => {
      console.error(`[phone-channel] Realtime subscription status: ${status}`);
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error(`[phone-channel] Subscription lost — reconnecting in 3s`);
        setTimeout(() => subscribeToMessages(), 3000);
      }
    });

  currentChannel = channel;
  return channel;
}

// One-shot sweep at startup catches messages that arrived while MCP was
// down. Steady-state delivery is realtime-only — a 1Hz fallback poll is a
// SELECT every second, all day, enough to exhaust a database plan's egress
// budget (and its 402 retries keep the meter spinning after lockout). Worst-case Realtime
// push delay is ~7s on this table; the proactive 2-min re-subscribe below
// covers silent websocket drops.
async function sweepMissedMessages() {
  // Clean up stale profiling entries older than 10 minutes.
  // Always clear the ack refresh interval first — otherwise the timer stays
  // alive in the event loop and keeps hitting the local LLM every 5s forever.
  const PENDING_TTL_MS = 10 * 60 * 1000;
  const now = Date.now();
  for (const [id, entry] of pendingMessages) {
    if (now - (entry.t0_created || 0) > PENDING_TTL_MS) {
      if (entry.ackInterval) {
        clearInterval(entry.ackInterval);
        entry.ackInterval = null;
      }
      pendingMessages.delete(id);
    }
  }

  try {
    const { data: missed } = await supabase
      .from("edva_messages")
      .select("*")
      .eq("role", "user")
      .eq("read", false)
      .gt("created_at", lastSeenAt)
      .order("created_at", { ascending: true })
      .limit(10);

    if (missed && missed.length > 0) {
      console.error(`[phone-channel] Sweep found ${missed.length} missed message(s)`);
      for (const row of missed) {
        await handleIncomingMessage(row);
      }
    }
  } catch (err) {
    console.error(`[phone-channel] Sweep error: ${err.message}`);
  }
}
// --- Start ---

// ─── Location edge (realtime) ─────────────────────────────────────────────
// Watch for visit arrivals/departures in location_history and fire a
// targeted check that dispatches an in-the-moment yes/no question.
let locationChannel = null;
function subscribeToLocationEdges() {
  if (locationChannel) {
    supabase.removeChannel(locationChannel);
    locationChannel = null;
  }
  locationChannel = supabase
    .channel("edva-location-edges")
    .on("postgres_changes", {
      event: "INSERT", schema: "public", table: "location_history",
      filter: "segment_type=eq.visit",
    }, (payload) => {
      const row = payload.new || {};
      if (row.departed_at) return; // already-closed visit, not an arrival
      dispatchLocationEdge("arrival", row);
    })
    .on("postgres_changes", {
      event: "UPDATE", schema: "public", table: "location_history",
      filter: "segment_type=eq.visit",
    }, (payload) => {
      const oldRow = payload.old || {};
      const newRow = payload.new || {};
      if (!newRow.departed_at || oldRow.departed_at) return; // only null→non-null transitions
      dispatchLocationEdge("departure", newRow);
    })
    .subscribe((status) => {
      console.error(`[phone-channel] Location edge subscription: ${status}`);
      if (status === "SUBSCRIBED") {
        console.error(`[phone-channel] Realtime ready for location_history edges. If events don't arrive, confirm location_history is in the supabase_realtime publication.`);
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setTimeout(() => subscribeToLocationEdges(), 5000);
      }
    });
}

// Location edge → the hum event bus. GPS is a signal, not a decision. The edge
// becomes an event; the gate (lib/hum-events.mjs) decides whether it
// earns an agent turn; Sonnet then decides — with full context: memory,
// calendar, conversation, habits, weather — whether to ask, what to ask, or
// stay silent. Phone-channel does NOT craft questions itself and does not
// dispatch the webhook itself either.
const LOCATION_EDGE_SEEN = installTools("data/location-edge-seen.json");
const HUM_PENDING = installTools("data/hum-pending-question.json");
// Telemetry only since the hum-sense engine took over dispatch: the
// authoritative "when did hum last fire" now lives in hum-sense-state.json.
// Kept because it is a cheap, human-readable marker of the last realtime edge
// this process saw, which is the first thing to check when the realtime
// subscription is suspected of having gone quiet.
const SITUATIONAL_TRIGGER_STATE = installTools("data/last-situational-trigger-at.json");

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

// The user's current timezone, from the phone-reported value this process itself
// persists to user-timezone.json (see handleIncomingMessage). Falls back to the
// instance zone (lib/instance.cjs) when the file is missing/unreadable. Keeps the sleep-window gate below keyed
// to the user's ACTUAL local wall-clock when traveling, matching its name.
function userTz() {
  try {
    const tzPath = installTools("data/user-timezone.json");
    const tz = JSON.parse(fs.readFileSync(tzPath, "utf8"))?.timezone;
    if (tz && Intl.DateTimeFormat("en-US", { timeZone: tz })) return tz;
  } catch {}
  return INSTANCE.tz;
}

function inLocalSleepWindow() {
  const hour = parseInt(new Date().toLocaleTimeString("en-US", {
    timeZone: userTz(), hour: "2-digit", hour12: false,
  }), 10);
  return hour >= 1 && hour < 9;
}

function edgeRecentlyDispatched(edgeKey) {
  const seen = readJsonSafe(LOCATION_EDGE_SEEN, {});
  const last = seen[edgeKey];
  if (!last) return false;
  return Date.now() - new Date(last).getTime() < 30 * 60 * 1000;
}

// Per-session lock: when the user is walking through several stops in quick
// succession (a wandering session), each visit row gets its own dedup_key,
// so the per-edge gate fires every single time. This collapses any new edge
// within 30 min of the LAST edge to noise — a session in progress
// (otherwise a wander can produce ~10 dispatches in a few minutes).
const SESSION_COOLDOWN_MS = 30 * 60 * 1000;
function sessionInProgress() {
  const seen = readJsonSafe(LOCATION_EDGE_SEEN, {});
  let mostRecent = 0;
  for (const v of Object.values(seen)) {
    const t = new Date(v).getTime();
    if (Number.isFinite(t) && t > mostRecent) mostRecent = t;
  }
  if (!mostRecent) return false;
  return Date.now() - mostRecent < SESSION_COOLDOWN_MS;
}

function markEdgeDispatched(edgeKey) {
  const seen = readJsonSafe(LOCATION_EDGE_SEEN, {});
  seen[edgeKey] = new Date().toISOString();
  // Prune >24h
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const k of Object.keys(seen)) {
    if (new Date(seen[k]).getTime() < cutoff) delete seen[k];
  }
  try { writeFileAtomic(LOCATION_EDGE_SEEN, JSON.stringify(seen, null, 2)); } catch {}
}

// Records that the realtime subscription saw a real situational edge just now.
// Nothing gates on this any more (the hum-sense engine owns that decision) —
// it survives as the cheapest possible answer to "is the location realtime
// subscription still alive?", which can silently die.
function markSituationalTrigger(type) {
  try {
    writeFileAtomic(SITUATIONAL_TRIGGER_STATE, JSON.stringify({ ts: new Date().toISOString(), type }, null, 2));
  } catch {}
}

function pendingQuestionActive() {
  const p = readJsonSafe(HUM_PENDING, null);
  if (!p || p === "null") return false;
  if (p.expires_at && new Date(p.expires_at).getTime() < Date.now()) return false;
  return true;
}

// Location edge → the hum event bus.
//
// POSTing the ops webhook directly would mean phone-channel making the
// "is this worth interrupting the user" decision itself, in parallel
// with the cron, with its own private copies of the quiet-window / dedup /
// pending-question rules. All four of those rules live in ONE place — the
// gate in lib/hum-events.mjs — so this function's job is only:
// notice the edge, describe it, hand it over.
//
// The local quiet/session gates below are kept as a cheap pre-filter (no point
// spooling an event at 04:00 that the gate will only drop), but they are no
// longer the authority; the gate re-checks all of them.
// A departure is announced only once the raw trace shows the user elsewhere
// (bin/ask-gate --mode departure). A row's departed_at alone is not
// proof: a quiet stretch of a stay the user never left can be written with an
// end time and read as "Left <place>". Held edges are
// not marked dispatched — the hum location sensor re-checks and emits once
// proof arrives. Fail-open: an error lets the departure through as before.
function departureProven(rowId) {
  return new Promise((resolve) => {
    const { execFile } = require("node:child_process");
    const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "bin", "ask-gate");
    execFile(bin, ["--visit", String(rowId), "--mode", "departure", "--json"], { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(true);
      try { resolve(JSON.parse(String(stdout).trim().split("\n").pop()).ask !== false); } catch { resolve(true); }
    });
  });
}

async function dispatchLocationEdge(event, row) {
  // Gate 1: quiet window
  if (inLocalSleepWindow()) return;
  // Gate 2: dedup per edge
  const edgeKey = `${event}:${row.id}`;
  if (edgeRecentlyDispatched(edgeKey)) return;
  // Gate 2b: session in progress — any other edge fired in the last 30 min
  // already covered the wandering-session attribution.
  if (sessionInProgress()) return;
  // Gate 3: don't interrupt an active hum question
  if (pendingQuestionActive()) return;
  // Gate 4: a departure needs proof the user left (see departureProven).
  if (event === "departure" && !(await departureProven(row.id))) {
    console.error(`[phone-channel] location departure held for row=${row.id}: no point away from it yet`);
    return;
  }

  const place = row.place_name || null;
  // The dedup_key MUST match the one hum-sensors/location.mjs derives from the
  // same row, so whichever path notices the edge first wins and the other is
  // swallowed by the gate's cooldown instead of producing a second ping.
  const spooled = spoolEvent({
    sensor: "location",
    type: `location.${event}`,
    subject: place || (event === "arrival" ? "a new place" : "somewhere"),
    summary: event === "arrival"
      ? `Arrived at ${place || "a new place"}`
      : `Left ${place || "somewhere"}`,
    salience: place ? 0.62 : 0.5,
    lanes: event === "arrival"
      ? LOCATION_LANES.arrival
      : LOCATION_LANES.departure,
    dedup_key: `location:visit:${row.id}:${event}`,
    ttl_min: 25,
    cooldown_min: 30,
    // This is the FAST path — realtime, seconds after the row changes — so it
    // is the one that most deserves to jump the dispatch queue. Keep in step
    // with hum-sensors/location.mjs, which emits the same events as a backstop.
    perishable: true,
    data: {
      row_id: row.id,
      place,
      lat: row.latitude,
      lon: row.longitude,
      arrived_at: row.arrived_at,
      departed_at: row.departed_at,
      source: "realtime",
    },
  }, "location");

  if (!spooled) {
    console.error(`[phone-channel] failed to spool location ${event} for row=${row.id}`);
    return;
  }
  markEdgeDispatched(edgeKey);
  markSituationalTrigger(`location-edge:${event}`);
  console.error(`[phone-channel] Emitted hum event location.${event} for row=${row.id}`);
}

// Only monitor incoming messages when running under a supervisor (EDVA_DISPATCH_URL is set).
// When loaded standalone (e.g. Claude Desktop), only the reply/get_location tools are available.
if (process.env.EDVA_DISPATCH_URL) {
  // Warm auto-recall judge: one resident tool-less `claude -p`
  // instead of a fork per message, so the judgment in front of every chat
  // message costs API latency, not CLI startup. Prewarmed here so the first
  // message after a restart is already warm. Kill switch: CHAT_WARM_JUDGE=0.
  if (process.env.CHAT_WARM_JUDGE !== "0") {
    const warm = new WarmClaude({ model: "claude-sonnet-5-5" });
    warm.prewarm();
    useWarmJudge(warm);
    process.on("exit", () => warm.close());
  }
  subscribeToMessages();
  subscribeToLocationEdges();
  // Immediate sweep on startup to catch messages that arrived while MCP was down.
  setTimeout(sweepMissedMessages, 2000);

  // Every 2 minutes: (a) always run sweepMissedMessages — the channel state
  // can report "joined" while the websocket is functionally dead (messages
  // can stop arriving for hours while heartbeats keep firing and state stays
  // "joined"), so we can't trust state alone to detect a
  // stalled subscription; the sweep is a cheap REST fallback that catches
  // any user message the realtime path silently dropped. (b) Re-subscribe
  // only when state isn't healthy. Sweep + handleIncomingMessage are deduped
  // via pendingMessages.has(msgId), so overlapping with realtime is safe.
  const RESUBSCRIBE_INTERVAL_MS = 2 * 60 * 1000;
  setInterval(() => {
    sweepMissedMessages().catch((err) =>
      console.error(`[phone-channel] Periodic sweep failed: ${err.message}`)
    );
    if (currentChannel?.state === "joined" || currentChannel?.state === "joining") return;
    console.error(`[phone-channel] Proactive re-subscribe (state=${currentChannel?.state})`);
    subscribeToMessages();
  }, RESUBSCRIBE_INTERVAL_MS);

  // Heartbeat: POST to supervisor every 60s so it can detect MCP crashes.
  // Fire immediately on startup too — setInterval defers the first tick by
  // the full interval, which combined with a stale `lastPhoneChannelHeartbeat`
  // in the supervisor causes spurious restarts right after respawn.
  const HEARTBEAT_INTERVAL_MS = 60_000;
  async function sendHeartbeat() {
    const base = process.env.EDVA_DISPATCH_URL?.replace(/\/dispatch$/, "");
    const url = base ? `${base}/heartbeat` : null;
    if (!url) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "phone-channel", pid: process.pid }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {}
  }
  // Immediate heartbeat on startup so the supervisor sees the new phone-channel
  // is alive within ~1s instead of waiting ≥60s.
  setTimeout(sendHeartbeat, 500);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  console.error("[phone-channel] Subscribed to edva_messages realtime");
} else {
  console.error("[phone-channel] Standalone mode — tools only, no message monitoring");
}

const transport = new StdioServerTransport();
await mcp.connect(transport);
