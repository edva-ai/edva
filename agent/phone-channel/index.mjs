import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";
import { sendApnsPush } from "../../lib/apns-push.mjs";
import { localLlmChat } from "../../lib/local-llm.mjs";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { loadEnv } = require("../../lib/load-env.js");

const SUPABASE_URL = "https://${MERLIN_SUPABASE_PROJECT}.supabase.co";

// Load .env first — service_role key must come from env, not source code.
loadEnv();

const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) {
  console.error("[phone-channel] FATAL: SUPABASE_SERVICE_ROLE_KEY not set in .env — phone-channel cannot connect");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Persistent cursor for sweep ---
const CURSOR_PATH = path.join(process.env.HOME, "dev/merlin/data/phone-channel-cursor.json");
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
const ACK_LOG = process.env.HOME + "/dev/merlin/agent/logs/ack-trace.log";
const log = (msg) => {
  const line = `${new Date().toISOString()} [${INSTANCE_ID}] ${msg}\n`;
  console.error(line.trim());
  fs.appendFileSync(ACK_LOG, line);
};

const mcp = new Server(
  { name: "phone-channel", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
      logging: {},
    },
    instructions: `You are monitoring mobile messages from the user via the Merlin app.

CRITICAL: \`mcp__phone-channel__reply\` is the ONLY way to deliver text to the user. Plain assistant text — anything you "say" without calling the reply tool — is silently dropped; the user never sees it. Every Merlin message you receive MUST end with at least one reply tool call. If you produce ANY substantive answer text, that text must be the \`message\` argument to a reply tool call, NOT a plain text content block in your turn.

If you have nothing to say (e.g. a tool failed, you're standing by), still call reply with a one-line acknowledgement rather than ending the turn silently. The chat-supervisor has a safety net that auto-posts orphaned text — but that's a recovery path for bugs, not the design; never rely on it.

Keep responses concise — the user is on their phone.`,
  }
);

// --- Tools ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a response back to the user via the Merlin mobile app. " +
        "For any reply longer than ~80 characters, or that contains structured/multi-section content " +
        "(digests, briefings, lists), you MUST provide a short `summary` — this becomes the push " +
        "notification body (e.g. 'Weekend events ready', 'P1 email: draft ready'). " +
        "The full `message` still lands in the chat.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The full message body to insert into the Merlin chat.",
          },
          summary: {
            type: "string",
            description:
              "Short one-line notification body shown in the push (≤80 chars). " +
              "Describes what the message is about, not a copy of its content. " +
              "Required when message is long or structured.",
          },
        },
        required: ["message"],
      },
    },
    {
      name: "get_location",
      description:
        "Request the user's current location from their phone",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "reply") {
    const message = request.params.arguments.message;
    const summary = request.params.arguments.summary;
    console.error(`[phone-channel] Sending reply: ${message.slice(0, 200)}`);

    // Find the most recent pending message for profiling
    const profMsgId = [...pendingMessages.keys()].pop();
    if (profMsgId) profLog(profMsgId, "t3_replyCall");

    // Stop the ack refresh interval. If we have an ack row, UPDATE it in place
    // with the real reply — that keeps a single stable message row in the
    // chat UI (ack → real reply) instead of a delete+insert flicker.
    const pendingEntry = profMsgId ? pendingMessages.get(profMsgId) : null;
    if (pendingEntry?.ackInterval) {
      clearInterval(pendingEntry.ackInterval);
      pendingEntry.ackInterval = null;
    }

    const reuseAckId = pendingEntry?.ackMsgId;
    // Null out on the pending entry so the refresh-interval's in-flight tick
    // (which checks pending.ackMsgId) skips its own update and doesn't race.
    if (pendingEntry) pendingEntry.ackMsgId = null;

    try {
      let inserted;
      if (reuseAckId) {
        const { data, error } = await supabase
          .from("merlin_messages")
          .update({ content: message, read: false })
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
        ({ data: inserted, error } = await supabase.from("merlin_messages").insert({
          role: "assistant",
          content: message,
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
      setTimeout(async () => {
        try {
          if (msgId) {
            const { data: row } = await supabase
              .from("merlin_messages")
              .select("read")
              .eq("id", msgId)
              .single();
            if (row?.read) {
              console.error(`[phone-channel] Message already read, skipping push`);
              return;
            }
          }
          const body = summary
            || (message.length > 100 ? message.slice(0, 100) + "…" : message);
          await sendApnsPush(supabase, { body, messageId: msgId });
        } catch (err) {
          console.error(`[phone-channel] Push failed: ${err.message}`);
        }
      }, 1500);

      return {
        content: [{ type: "text", text: "Reply sent to Merlin app" }],
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
        .from("merlin_commands")
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
          .from("merlin_commands")
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

// Long enough to absorb a Gemma cold-load (~7s on this Mac mini). A 2s
// timeout would AbortController.abort() the fetch mid-load, which Ollama
// treats as "client disconnect → cancel model load" — and the next call's
// 2s timeout would do the same thing, deathlocking the runner. With 8s
// the cold-load completes, the model becomes resident, and every ack
// after that hits a warm model in ~1.5s. Steady-state UX is unchanged.
const ACK_TIMEOUT_MS = 8000;
// Stop refreshing the ack after this many updates per conversation. At the
// 5s cadence below this is ~1 minute — a stuck chat-agent can't flood the
// UI with updates for one message.
const ACK_REFRESH_MAX_COUNT = 12;
const ACK_REFRESH_INTERVAL_MS = 5_000;
// How many prior messages to feed Gemma for ack generation. Both the initial
// ack and the 5s refresh ack get the same window so a status like "Looking
// up Jon Barr…" stays accurate when the user says "actually try gmail" two
// turns later. 20 is well within Gemma's 8K num_ctx (each chat line is
// typically 50-200 tokens).
const ACK_HISTORY_LIMIT = 20;
// Rotating fallback copy used when the local LLM can't produce an ack
// (Ollama down, timeout, empty completion). Keeps the visual "still working"
// signal moving so the user doesn't see a frozen "On it…" while ops does heavy
// work. State-only: each line describes what's happening *right now*; none
// promise a response is imminent, since we don't know when (or whether) the
// real reply will land while the ack layer is degraded.
const CANNED_REFRESH_MESSAGES = [
  "Still on it…",
  "Working…",
  "Thinking…",
  "Processing…",
  "Looking into it…",
];

const ACK_MAX_WORDS = 10;
const ACK_MAX_CHARS = 90;

const ACK_SYSTEM_PROMPT = `You are generating a ONE-LINE process status for Merlin (a personal AI assistant for the user). This status appears in the chat UI while the real Claude agent prepares the actual reply.

This is NOT the reply. Do not answer the user's request. Do not include dates, times, names, places, decisions, recommendations, or facts unless they are explicitly in the latest user message. When context is thin, stay generic.

Output exactly one short phrase (under 10 words) ending with "…" that describes the process Merlin is using before replying.

Examples:
- "tell me about Jon Barr" → "Searching messages before replying…"
- "any good sushi near me?" → "Checking location and food context…"
- "turn off the living room lights" → "Routing the home action…"
- "what's on my calendar tomorrow" → "Checking calendar before replying…"
- "review this memory page" → "Reading the wiki context…"
- "for tomorrow at noon" → "Using prior context before replying…"

STRICT RULES — violating any of these is wrong:
- Output ONLY the status phrase — no other text
- NEVER ask a question
- NEVER express confusion or ask for clarification
- NEVER respond as if you are the assistant answering the request
- NEVER provide the answer, even if it seems obvious
- NEVER invent dates, times, names, places, or outcomes
- Always end with "…"
- Prefer process words: checking, searching, reading, routing, comparing, drafting`;

function sanitizeAckOutput(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw
    .split(/\r?\n/)[0]
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  if (s.includes("?")) return null;
  if (s.length > ACK_MAX_CHARS) return null;
  const words = s.replace(/…$/, "").trim().split(/\s+/).filter(Boolean);
  if (words.length > ACK_MAX_WORDS) return null;

  // Reject answer-shaped text. The ack is only allowed to describe process.
  if (/\b(yes|no|sure|okay|ok|done|fixed|found|it is|it's|you should|i think|i recommend|the answer|that means)\b/i.test(s)) {
    return null;
  }
  if (!/…$/.test(s)) s = s.replace(/[.!]*$/, "") + "…";
  return s;
}

async function generateAck(text, recentHistory = []) {
  const messages = [];
  for (const m of recentHistory) {
    messages.push({ role: m.role === "user" ? "user" : "assistant", content: m.content });
  }
  messages.push({ role: "user", content: text });

  const llm = localLlmChat({
    system: ACK_SYSTEM_PROMPT,
    messages,
    maxTokens: 40,
    timeoutMs: ACK_TIMEOUT_MS,
    // Acks are one short status phrase. Reasoning adds latency for no gain.
    think: false,
  }).catch(err => {
    console.error(`[phone-channel] Gemma ack error: ${err.message}`);
    return null;
  });

  const timeout = new Promise(resolve =>
    setTimeout(() => resolve(null), ACK_TIMEOUT_MS)
  );

  const result = await Promise.race([llm, timeout]);
  const ack = sanitizeAckOutput(result);
  if (ack) {
    console.error(`[phone-channel] Gemma ack: "${ack}"`);
    return ack;
  }

  if (result) {
    console.error(`[phone-channel] Gemma ack rejected: "${result}"`);
  } else {
    console.error(`[phone-channel] Gemma timed out, using fallback`);
  }
  return "On it…";
}

// --- Realtime subscription ---

// Load persisted cursor (falls back to 30-min lookback if no cursor file).
let lastSeenAt = loadCursor();
let currentChannel = null;

async function handleIncomingMessage(row) {
  const msgId = row.id;
  const text = row.content;
  const metadata = row.metadata || {};
  const tz = metadata.timezone || "unknown";
  const utcOffset = metadata.utc_offset || "unknown";
  const createdAt = new Date(row.created_at).getTime();

  if (pendingMessages.has(msgId)) return; // already processing
  pendingMessages.set(msgId, { text, t0_created: createdAt });

  // Persist the user's current timezone for trigger scripts (pulse sleep-window check).
  if (tz && tz !== "unknown" && tz !== _cachedUserTz) {
    _cachedUserTz = tz;
    try {
      const tzPath = path.join(process.env.HOME, "dev/merlin/data/user-timezone.json");
      const tmp = tzPath + ".tmp." + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ timezone: tz, utc_offset: utcOffset, updated_at: new Date().toISOString() }));
      fs.renameSync(tmp, tzPath);
    } catch {}
  }
  profLog(msgId, "t1_realtime", `msg="${text.slice(0, 80)}"`);
  log(`handleIncomingMessage: "${text.slice(0, 80)}"`);

  // Fire-and-forget the suggestion classifier. If the user's message is a
  // reaction to a recent advisory hum ping (e.g. free-text "ridiculously
  // overpriced" or "why again?"), it writes a structured `reaction` event
  // to suggestion-history.jsonl so the next dining/music/art lane scout
  // sees the rejection. Tapback reactions take a separate path via
  // `recordHumReaction` / `merlin hum feedback` and don't double-count
  // (the classifier dedups by appending only when its rule/Gemma judgment
  // adds new info, and the deriveState fold keeps the most-specific reason).
  classifySuggestionReply(msgId, text);

  // Quick ack via local Gemma (Ollama); falls back to canned patterns.
  let ackMsgId = null;
  let ackHistoryOrdered = [];
  if (!SKIP_ACK.test(text.trim())) {
    const { data: ackHistory } = await supabase
      .from("merlin_messages")
      .select("role, content")
      .lt("created_at", row.created_at)
      .order("created_at", { ascending: false })
      .limit(ACK_HISTORY_LIMIT);
    ackHistoryOrdered = (ackHistory || []).reverse();
    const ackMsg = await generateAck(text, ackHistoryOrdered);
    if (ackMsg) {
      log(`ack: "${ackMsg}"`);
      const { data: ackRow, error: ackErr } = await supabase
        .from("merlin_messages")
        .insert({ role: "assistant", content: ackMsg, read: false })
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
  // Store ackMsgId so the reply handler can delete it
  const pending = pendingMessages.get(msgId);
  pending.ackMsgId = ackMsgId;

  // Refresh the ack with a new Gemma status message while waiting for the
  // real reply. Capped per-conversation by ACK_REFRESH_MAX_COUNT.
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

      let updated = null;
      let usedLlm = false;
      try {
        // Fetch active tools from supervisor to give Gemma context on what's happening.
        let toolContext = "";
        const base = process.env.MERLIN_DISPATCH_URL?.replace(/\/dispatch$/, "");
        if (base) {
          try {
            const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
            const tools = health.activeTools || [];
            if (tools.length > 0) {
              const friendly = tools.map(t => t.replace(/^mcp__\w+__/, "").replace(/_/g, " "));
              toolContext = `\nCurrently using tools: ${friendly.join(", ")}`;
            }
          } catch {}
        }

        const refreshMessages = ackHistoryOrdered.map((m) => ({
          role: m.role === "user" ? "user" : "assistant",
          content: m.content,
        }));
        refreshMessages.push({ role: "user", content: text });

        updated = await localLlmChat({
          system: `You are generating a brief process status update (under 10 words). The user sent a message and is waiting for the real Claude agent to reply. This is update #${refreshCount}.${toolContext}

This is NOT the reply. Do not answer the user's request. Do not include dates, times, names, places, decisions, recommendations, or facts unless they are explicitly in the latest user message or listed as an active tool. When context is thin, stay generic and describe the process.

Rules:
- Output ONLY the status message, nothing else
- Always end with "…" (ellipsis)
- NEVER ask a question
- NEVER provide the answer, even if it seems obvious
- If tools are listed, mention what they're doing (e.g. "Reading messages…", "Searching emails…")
- Prefer process words: checking, searching, reading, routing, comparing, drafting
- Each update should describe process, not final content`,
          messages: refreshMessages,
          maxTokens: 40,
          timeoutMs: ACK_TIMEOUT_MS,
          think: false, // acks are short status lines; reasoning adds latency
        });
        updated = sanitizeAckOutput(updated);
        usedLlm = true;
      } catch (err) {
        console.error(`[phone-channel] Ack refresh error: ${err.message}`);
        updated = null;
      }

      // Gemma unavailable or failed → rotate through a programmatic status line
      // so the user still sees the indicator moving.
      if (!updated) {
        updated = CANNED_REFRESH_MESSAGES[(refreshCount - 1) % CANNED_REFRESH_MESSAGES.length];
      }

      if (!pending.ackMsgId) return; // real reply already landed, skip update

      await supabase
        .from("merlin_messages")
        .update({ content: updated })
        .eq("id", pending.ackMsgId);
      console.error(`[phone-channel] Ack refresh #${refreshCount}${usedLlm ? "" : " (canned)"}: "${updated}"`);
    }, ACK_REFRESH_INTERVAL_MS);
  }

  try {
    // Fetch recent conversation history for context (last 10, lighter payload)
    const { data: history } = await supabase
      .from("merlin_messages")
      .select("role, content")
      .order("created_at", { ascending: false })
      .limit(10);

    const convoLines = (history || []).reverse().map((m) => {
      const who = m.role === "user" ? "User" : "You";
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

    const builtContent = `${convoBlock}New message from the user:\n\n${text}\n\n[Current time: ${localTimeStr} ${tzAbbr}]${locationLine}`;
    const DISPATCH_URL = process.env.MERLIN_DISPATCH_URL;

    if (DISPATCH_URL) {
      // Supervisor mode: POST to chat supervisor's HTTP dispatch endpoint.
      try {
        const resp = await fetch(DISPATCH_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: builtContent, source: "merlin", priority: "high", msgId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        profLog(msgId, "t2_notified", "via HTTP dispatch");
        lastSeenAt = row.created_at;
        saveCursor(lastSeenAt);
      } catch (httpErr) {
        console.error(`[phone-channel] HTTP dispatch failed (${httpErr.message}), falling back to MCP notification`);
        await mcp.notification({
          method: "notifications/claude/channel",
          params: { content: builtContent, meta: { source: "merlin", ts: new Date().toISOString(), timezone: tz, _profMsgId: msgId } },
        });
        profLog(msgId, "t2_notified", "via MCP fallback");
        lastSeenAt = row.created_at;
        saveCursor(lastSeenAt);
      }
    } else {
      // Legacy mode: MCP channel notification (interactive Claude only).
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: builtContent,
          meta: { source: "merlin", ts: new Date().toISOString(), timezone: tz, utcOffset, localTime: localTimeStr, latitude: metadata.latitude, longitude: metadata.longitude, _profMsgId: msgId },
        },
      });
      profLog(msgId, "t2_notified");
      lastSeenAt = row.created_at;
      saveCursor(lastSeenAt);
    }
  } catch (err) {
    // Do NOT advance lastSeenAt — sweep will retry this message.
    console.error(`[phone-channel] Failed to send notification: ${err.message}`);
  }
}

const REACTION_EMOJI = {
  heart: "❤️",
  thumbs_up: "👍",
  thumbs_down: "👎",
};

// Hum feedback log path — we resolve tapback reactions back to the ping_id by
// scanning this file for a matching `message_id` (captured at ping-send time
// via `merlin-send-curl --capture-id`, see jobs/hum.md step 3).
const HUM_FEEDBACK_PATH = path.join(process.env.HOME, "dev/merlin/data/hum-feedback.jsonl");
const HUM_CLI = path.join(process.env.HOME, "dev/merlin/bin/merlin");

/// Look up the hum ping_id for a reacted-to merlin_messages.id. Returns null
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

/// Record a tapback reaction against a hum ping via the merlin CLI. Runs in
/// the background (fire-and-forget) so the forward notification to chat-agent
/// isn't blocked on shelling out. reactionToken is the raw Supabase value
/// ("heart"/"thumbs_up"/"thumbs_down"); `merlin hum feedback` accepts those
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
const SUGGESTION_CLASSIFY = path.join(process.env.HOME, "dev/merlin/bin/suggestion-classify");

function classifySuggestionReply(messageId, text) {
  import("node:child_process").then(({ spawn }) => {
    const child = spawn(SUGGESTION_CLASSIFY, ["--message-id", String(messageId || ""), "--text", text], {
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

function subscribeToMessages() {
  if (currentChannel) {
    supabase.removeChannel(currentChannel);
    currentChannel = null;
  }

  const channel = supabase
    .channel("merlin-user-messages")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "merlin_messages",
      },
      async (payload) => {
        const oldRow = payload.old || {};
        const newRow = payload.new || {};
        if (newRow.role !== "assistant") return;
        if (oldRow.reaction === newRow.reaction) return;

        const reaction = newRow.reaction;
        const emoji = reaction ? (REACTION_EMOJI[reaction] || reaction) : null;
        const snippet = (newRow.content || "").slice(0, 160);
        const content = reaction
          ? `The user reacted ${emoji} to your previous message:\n\n"${snippet}${newRow.content?.length > 160 ? "…" : ""}"\n\nThis is a quality signal from the user about that response. No reply is required — acknowledge internally and use it to calibrate future messages. Do not respond unless the user has also sent a follow-up message.`
          : `The user removed their reaction from your previous message:\n\n"${snippet}${newRow.content?.length > 160 ? "…" : ""}"\n\nNo reply required.`;

        // If the reacted-to row is a hum ping (has a matching message_id in
        // hum-feedback.jsonl), route the reaction through `merlin hum
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
                source: "merlin",
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
        table: "merlin_messages",
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
// down. Steady-state delivery is realtime-only — the 1Hz fallback poll
// burned the Supabase free-tier egress budget (~86k SELECTs/day plus 402
// retries kept the meter spinning even after lockout). Worst-case Realtime
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
      .from("merlin_messages")
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
    .channel("merlin-location-edges")
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

// Location edge → pulse engine. GPS is a signal, not a decision. The edge
// event triggers a focused hum tick; Sonnet decides (with full context —
// memory, calendar, conversation, habits, weather) whether to ask, what to
// ask, or stay silent. Phone-channel does NOT craft questions itself.
const OPS_WEBHOOK_URL = "http://localhost:9092";
const OPS_WEBHOOK_TOKEN_PATH = process.env.HOME + "/dev/merlin/secrets/webhook-token";
const LOCATION_EDGE_SEEN = process.env.HOME + "/dev/merlin/data/location-edge-seen.json";
const HUM_PENDING = process.env.HOME + "/dev/merlin/data/hum-pending-question.json";

let _opsWebhookToken = null;
function opsWebhookToken() {
  if (_opsWebhookToken !== null) return _opsWebhookToken;
  try { _opsWebhookToken = fs.readFileSync(OPS_WEBHOOK_TOKEN_PATH, "utf8").trim(); }
  catch { _opsWebhookToken = ""; }
  return _opsWebhookToken;
}

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

function inLocalSleepWindow() {
  const hour = parseInt(new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hour: "2-digit", hour12: false,
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
// within 30 min of the LAST edge to noise — a session in progress.
// Documented in the 2026-04-29 review (10 dispatches in 13 min).
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
  try { fs.writeFileSync(LOCATION_EDGE_SEEN, JSON.stringify(seen, null, 2)); } catch {}
}

function pendingQuestionActive() {
  const p = readJsonSafe(HUM_PENDING, null);
  if (!p || p === "null") return false;
  if (p.expires_at && new Date(p.expires_at).getTime() < Date.now()) return false;
  return true;
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

  // Payload hints to the ops-agent that this tick was location-triggered.
  // jobs/hum.md reads `trigger` for telemetry and can weight the
  // location_context candidate higher when trigger === "location-edge".
  const payload = {
    job: "hum",
    trigger: "location-edge",
    source: "location-edge",
    edge: {
      event,
      row_id: row.id,
      place_name: row.place_name || null,
      lat: row.latitude,
      lon: row.longitude,
      arrived_at: row.arrived_at,
      departed_at: row.departed_at,
    },
  };
  const headers = { "content-type": "application/json" };
  const token = opsWebhookToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    const resp = await fetch(OPS_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      console.error(`[phone-channel] ops webhook ${event} ${row.id}: HTTP ${resp.status}`);
      return;
    }
    markEdgeDispatched(edgeKey);
    console.error(`[phone-channel] Dispatched hum/${event} for row=${row.id}`);
  } catch (err) {
    console.error(`[phone-channel] ops webhook dispatch failed (${err.message})`);
  }
}

// Only monitor incoming messages when running under a supervisor (MERLIN_DISPATCH_URL is set).
// When loaded standalone (e.g. Claude Desktop), only the reply/get_location tools are available.
if (process.env.MERLIN_DISPATCH_URL) {
  // Warmup runs BEFORE realtime subscription so the first incoming ack hits
  // a hot Gemma. Without this, a real message arriving in the first ~7s of
  // process life would race the cold-load, AbortController would fire at
  // ACK_TIMEOUT_MS, Ollama would cancel the load, and every subsequent ack
  // would re-trigger the same cancel-load deathlock until the runner was
  // manually warmed by an unaborted call. Tick interval is 60s (down from
  // 4min) so we recover faster if Ollama restarts mid-day.
  const WARMUP_INTERVAL_MS = 60 * 1000;
  async function warmupLocalLlm() {
    try {
      await localLlmChat({
        user: "hi",
        maxTokens: 1,
        timeoutMs: 15_000,
        think: false,
      });
    } catch (err) {
      console.error(`[phone-channel] Gemma warmup error: ${err.message}`);
    }
  }
  await warmupLocalLlm();
  setInterval(warmupLocalLlm, WARMUP_INTERVAL_MS);

  subscribeToMessages();
  subscribeToLocationEdges();
  // Immediate sweep on startup to catch messages that arrived while MCP was down.
  setTimeout(sweepMissedMessages, 2000);

  // Every 2 minutes: (a) always run sweepMissedMessages — the channel state
  // can report "joined" while the websocket is functionally dead (observed
  // 2026-04-30: messages stopped arriving for 2h while heartbeats kept firing
  // and state stayed "joined"), so we can't trust state alone to detect a
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
    const base = process.env.MERLIN_DISPATCH_URL?.replace(/\/dispatch$/, "");
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

  console.error("[phone-channel] Subscribed to merlin_messages realtime");
} else {
  console.error("[phone-channel] Standalone mode — tools only, no message monitoring");
}

const transport = new StdioServerTransport();
await mcp.connect(transport);
