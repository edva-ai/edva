import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "http";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { triageLog } = require("../../lib/triage-log.js");

const LAST_HISTORY_FILE = join(process.env.HOME, "dev/merlin/data/last-history-id.json");
const PAUSE_FLAG_FILE = join(process.env.HOME, "dev/merlin/data/.triage-paused");
const MAX_BODY_SIZE = 64 * 1024; // 64KB — Pub/Sub messages are small

function isTriagePaused() {
  return existsSync(PAUSE_FLAG_FILE);
}

// Atomic file write: temp file + rename
function atomicWrite(filePath, data) {
  const tmp = filePath + ".tmp." + process.pid;
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

function saveLastHistory(historyId) {
  atomicWrite(LAST_HISTORY_FILE, JSON.stringify({ historyId, ts: new Date().toISOString() }));
}

function loadLastHistory() {
  try {
    if (existsSync(LAST_HISTORY_FILE)) return JSON.parse(readFileSync(LAST_HISTORY_FILE, "utf8"));
  } catch (err) {
    console.error(`[gmail-channel] Failed to read last-history-id.json: ${err.message}`);
  }
  return null;
}

const PORT = 9090;
const RETRY_INTERVAL_MS = 30_000; // 30s between retry pings
const RETRY_INITIAL_DELAY_MS = 15_000; // wait 15s before first retry (give agent time to act)

// Deduplication: track recently processed historyIds to handle Pub/Sub at-least-once delivery
const recentHistoryIds = new Set();
const MAX_RECENT = 100;

function isDuplicate(historyId) {
  if (recentHistoryIds.has(historyId)) return true;
  recentHistoryIds.add(historyId);
  if (recentHistoryIds.size > MAX_RECENT) {
    const first = recentHistoryIds.values().next().value;
    recentHistoryIds.delete(first);
  }
  return false;
}

// --- Pending queue: retry notifications until agent acknowledges ---
// Each entry: { historyId, emailAddress, ts }
const pendingQueue = [];
let retryTimer = null;

function addPending(emailAddress, historyId) {
  // Don't add duplicates to the queue
  if (pendingQueue.some((e) => e.historyId === historyId)) return;
  pendingQueue.push({ historyId, emailAddress, ts: Date.now() });
  scheduleRetry();
}

function ackPending(historyId) {
  // Remove a specific historyId, or if "all", clear the queue
  if (historyId === "all") {
    const count = pendingQueue.length;
    pendingQueue.length = 0;
    return count;
  }
  const idx = pendingQueue.findIndex((e) => e.historyId === historyId);
  if (idx !== -1) {
    pendingQueue.splice(idx, 1);
    return 1;
  }
  return 0;
}

function scheduleRetry() {
  if (retryTimer) return; // already scheduled
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    if (pendingQueue.length === 0) return;

    const oldest = pendingQueue[0];
    const count = pendingQueue.length;
    const ageSec = Math.round((Date.now() - oldest.ts) / 1000);

    console.error(
      `[gmail-channel] Retry ping: ${count} email(s) pending triage, oldest ${ageSec}s ago (historyId ${oldest.historyId})`
    );

    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `PENDING TRIAGE: ${count} email(s) waiting (oldest: ${ageSec}s ago, historyId ${oldest.historyId}). Fetch and triage these emails now. After triaging, call the gmail-channel "ack" tool with historyId "all" to clear the queue.`,
          meta: { source: "gmail", type: "retry", pendingCount: count },
        },
      });
    } catch (err) {
      console.error(`[gmail-channel] Retry notification failed: ${err.message}`);
    }

    // Schedule next retry if queue is still non-empty
    if (pendingQueue.length > 0) scheduleRetry();
  }, pendingQueue.length === 1 ? RETRY_INITIAL_DELAY_MS : RETRY_INTERVAL_MS);
}

const mcp = new Server(
  { name: "gmail-channel", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
      logging: {},
    },
    instructions: `You are monitoring Gmail in real-time. When a new email event arrives:
1. Fetch the full email using the Gmail connector (mcp__claude_ai_Gmail)
2. Apply the triage rules in CLAUDE.md
3. Take the appropriate action (label, draft, archive, escalate)
4. Call the "ack" tool with historyId "all" after finishing a triage batch to stop retry pings
5. Do not reply in the channel — just act silently unless escalation is needed

IMPORTANT: If you receive a "PENDING TRIAGE" retry notification, triage the pending emails immediately, then call ack with "all".`,
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message back through the Gmail channel",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    {
      name: "ack",
      description:
        'Acknowledge that emails have been triaged. Call with historyId of the triaged email, or "all" to clear the entire pending queue. This stops retry notifications for acknowledged emails.',
      inputSchema: {
        type: "object",
        properties: {
          historyId: {
            type: "string",
            description: 'The historyId to acknowledge, or "all" to clear the queue',
          },
        },
        required: ["historyId"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "reply") {
    console.error(`[gmail-channel] Reply: ${request.params.arguments.message}`);
    return { content: [{ type: "text", text: "Reply acknowledged" }] };
  }
  if (request.params.name === "ack") {
    const hid = request.params.arguments.historyId;
    const removed = ackPending(hid);
    console.error(`[gmail-channel] Ack: ${hid} — removed ${removed}, ${pendingQueue.length} still pending`);
    return {
      content: [
        {
          type: "text",
          text: `Acknowledged ${hid}. Removed ${removed} item(s). ${pendingQueue.length} email(s) still pending.`,
        },
      ],
    };
  }
  return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
});

// HTTP server receives Pub/Sub push notifications from Hookdeck
const httpServer = createServer(async (req, res) => {
  // Health check endpoint
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", recentEvents: recentHistoryIds.size, pendingTriage: pendingQueue.length }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  let body = "";
  let bodySize = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_SIZE) {
      aborted = true;
      res.writeHead(413);
      res.end("Payload too large");
      req.destroy();
      return;
    }
    body += chunk;
  });

  req.on("end", async () => {
    if (aborted) return;
    try {
      const pubsubMessage = JSON.parse(body);
      const data = pubsubMessage.message?.data
        ? JSON.parse(Buffer.from(pubsubMessage.message.data, "base64").toString())
        : pubsubMessage;

      const emailAddress = data.emailAddress || "unknown";
      const historyId = data.historyId || "unknown";

      // Deduplicate Pub/Sub at-least-once delivery
      if (historyId !== "unknown" && isDuplicate(historyId)) {
        console.error(`[gmail-channel] Duplicate historyId ${historyId}, skipping`);
        res.writeHead(200);
        res.end("OK (duplicate)");
        return;
      }

      console.error(
        `[gmail-channel] New email event: ${emailAddress} / historyId: ${historyId}`
      );
      triageLog("EMAIL-RECEIVED", { emailAddress, historyId });
      if (historyId !== "unknown") saveLastHistory(historyId);

      // Triage pause: log event, save historyId, but don't queue or notify ops-agent.
      // When resumed, agent catches up via saved historyId.
      if (isTriagePaused()) {
        console.error(`[gmail-channel] Triage PAUSED — skipping notification for historyId ${historyId}`);
        triageLog("PAUSED-SKIP", { emailAddress, historyId });
        res.writeHead(200);
        res.end("OK (paused)");
        return;
      }

      // Add to pending queue — retries until agent calls ack
      if (historyId !== "unknown") addPending(emailAddress, historyId);

      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `New email received. Email: ${emailAddress}, History ID: ${historyId}. Fetch and triage this email now using the Gmail connector. After triaging, call the gmail-channel "ack" tool with historyId "all" to acknowledge.`,
          meta: { source: "gmail", emailAddress, historyId },
        },
      });

      res.writeHead(200);
      res.end("OK");
    } catch (err) {
      console.error(`[gmail-channel] Error processing webhook: ${err.message}`);
      res.writeHead(500);
      res.end("Error");
    }
  });
});

httpServer.listen(PORT, () => {
  console.error(`[gmail-channel] HTTP server listening on port ${PORT}`);
});

const transport = new StdioServerTransport();
await mcp.connect(transport);

// Startup catch-up: use last historyId for precise delta
setTimeout(async () => {
  try {
    const last = loadLastHistory();
    if (!last) {
      console.error("[gmail-channel] Startup catch-up: no prior history, skipping catch-up");
      return;
    }

    console.error(`[gmail-channel] Startup catch-up: resuming from historyId ${last.historyId} (${last.ts})`);

    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `Startup catch-up: The agent just restarted. Last activity was at ${last.ts} (historyId ${last.historyId}). Use the Gmail history API with startHistoryId=${last.historyId} if possible, otherwise search for emails received after ${last.ts.slice(0, 10).replace(/-/g, "/")} via Gmail connector. For each result, check email-mem to see if it was already triaged — do NOT rely on Gmail read/unread status, labels, or any other Gmail state to determine this. Only email-mem records and triage logs are authoritative. Triage any emails not found in email-mem.`,
        meta: { source: "gmail", type: "catchup", lastHistoryId: last.historyId, lastTs: last.ts },
      },
    });
  } catch (err) {
    console.error(`[gmail-channel] Catch-up scan error: ${err.message}`);
  }
}, 5000);
