// gmail-source.mjs — Gmail Pub/Sub push handler.
// Port of gmail-channel's HTTP :9090 responsibilities: dedup historyIds,
// persist last-history-id, honor triage pause flag, emit dispatch actions.
//
// Batching: accumulates push notifications over a short window (BATCH_WINDOW_MS)
// and dispatches them as a single turn with pre-fetched metadata, amortizing
// the LLM thinking cost across multiple emails.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Intake-side spam-filter fast-path (added 2026-05-18). Before dispatching
// "New email received" to the ops-agent, run `spam-filter check --sender <addr>`.
// If the sender matches the spam-blocklist (exit code 2), mark the message
// read directly via gmail-action and skip the dispatch entirely. The CLAUDE.md
// Step 0b rule already covered this case, but the LLM-side check was not
// firing reliably (5 distinct blocked senders bypassed intake on 2026-05-18 alone).
// Hardwiring it here removes the dependency on agent recall.
const SPAM_FILTER_BIN = path.join(process.env.HOME, "dev/merlin/bin/spam-filter");
const GMAIL_ACTION_BIN = path.join(process.env.HOME, "dev/merlin/bin/gmail-action");
function extractEmailAddr(fromHeader) {
  if (!fromHeader) return "";
  const m = String(fromHeader).match(/<([^>]+)>/);
  return (m ? m[1] : String(fromHeader)).trim().toLowerCase();
}
function intakeSpamCheck(messageId, fromHeader) {
  const sender = extractEmailAddr(fromHeader);
  if (!sender) return { blocked: false };
  try {
    const r = spawnSync(SPAM_FILTER_BIN, ["check", "--sender", sender], { timeout: 5000, encoding: "utf8" });
    if (r.status === 2) {
      // Blocked. Mark read and skip dispatch. Best-effort; errors are non-fatal.
      try {
        spawnSync(GMAIL_ACTION_BIN, ["mark-read", messageId], { timeout: 8000 });
      } catch {}
      return { blocked: true, sender, reason: (r.stdout || "").trim().slice(0, 200) };
    }
  } catch {}
  return { blocked: false };
}

const MAX_BODY_SIZE = 64 * 1024;
const MAX_RECENT = 100;
const BATCH_WINDOW_MS = 8000; // accumulate pushes for 8s before dispatching

// Guest-host chat fast-path coalescing: see agent/ops-agent/CLAUDE.md
// "Fast-path classification". Messages from express@airbnb.com and
// sender@messages.homeaway.com whose subject contains one of these markers
// skip full triage and only need label + mark-read. Coalesce 2+ such messages
// in the same batch window into one dispatch (saves ~3 dispatches/day).
// Hospitable emails are NOT fast-path — they can trigger tasks/notifications.
const FAST_PATH_FROMS = ["express@airbnb.com", "sender@messages.homeaway.com"];
const FAST_PATH_SUBJECT_MARKERS = [
  "has replied to your message",
  "Reservation for",
  "Message from",
];
function isFastPathMeta(meta) {
  if (!meta || !meta.from || !meta.subject) return false;
  const fromLc = String(meta.from).toLowerCase();
  if (!FAST_PATH_FROMS.some((f) => fromLc.includes(f))) return false;
  return FAST_PATH_SUBJECT_MARKERS.some((m) => meta.subject.includes(m));
}
const SELF_INFLICTED_COOLDOWN_MS = 45000; // suppress empty-history dispatches for 45s after a real dispatch
// Window in which a gmail-action call is assumed to still be generating
// history changes in the Gmail API's view. Most phantom pushes land within
// ~60s of a label/star/mark-read write, but we've seen some arrive 2-3 min
// later when Gmail's history pipeline is backed up — so give it 5 min.
const SELF_ACTION_WINDOW_MS = 5 * 60 * 1000;
const SELF_ACTION_MARKER = path.join(process.env.HOME, "dev/merlin/data/.gmail-action-last-at");
const CATCHUP_INTERVAL_MS = 30 * 60 * 1000; // check for missed emails every 30 min
const STORM_THRESHOLD = 20; // max individual dispatches within storm window before consolidating
const STORM_WINDOW_MS = 60 * 1000; // 60-second window for storm detection
const TOKEN_FILE = path.join(process.env.HOME, "dev/merlin/credentials/gmail-push-token.json");
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

// True if `bin/gmail-action` wrote to the self-action marker within the
// given window. gmail-action touches this file on every mutating request
// (label, archive, star, mark-read, reply, send, etc.), so a recent touch
// means any Gmail push arriving now is almost certainly a phantom caused by
// our own write and should not wake the agent.
function recentSelfAction(maxAgeMs = SELF_ACTION_WINDOW_MS) {
  try {
    const raw = fs.readFileSync(SELF_ACTION_MARKER, "utf8").trim();
    const ts = parseInt(raw, 10);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < maxAgeMs;
  } catch {
    return false;
  }
}

export class GmailSource {
  constructor({ lastHistoryFile, pauseFlagFile, triageLog }) {
    this.lastHistoryFile = lastHistoryFile;
    this.pauseFlagFile = pauseFlagFile;
    this.triageLog = triageLog || (() => {});
    this.recent = new Set();
    this._batch = [];
    this._batchTimer = null;
    this._lastRealDispatchAt = 0; // tracks when we last dispatched real emails
    this._dispatchFn = null; // set by supervisor after wiring up
    this.lastPushAt = null; // timestamp of last Gmail push received
    this._catchupTimer = null;
    this._stormCounter = 0; // pushes received in current storm window
    this._stormWindowStart = 0;
    this._stormConsolidated = false; // true if we've already consolidated this storm
  }

  isPaused() {
    return fs.existsSync(this.pauseFlagFile);
  }

  _atomicWrite(file, data) {
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  saveLastHistory(historyId) {
    fs.mkdirSync(path.dirname(this.lastHistoryFile), { recursive: true });
    this._atomicWrite(this.lastHistoryFile, JSON.stringify({ historyId, ts: new Date().toISOString() }));
  }

  loadLastHistory() {
    try {
      if (fs.existsSync(this.lastHistoryFile)) return JSON.parse(fs.readFileSync(this.lastHistoryFile, "utf8"));
    } catch {}
    return null;
  }

  _isDuplicate(historyId) {
    if (this.recent.has(historyId)) return true;
    this.recent.add(historyId);
    if (this.recent.size > MAX_RECENT) {
      const first = this.recent.values().next().value;
      this.recent.delete(first);
    }
    return false;
  }

  // --- Gmail API helpers for pre-fetch ---

  async _getAccessToken() {
    try {
      const creds = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (creds.access_token && creds.expires_at && Date.now() < creds.expires_at - 300000) {
        return creds.access_token;
      }
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: creds.client_id,
          client_secret: creds.client_secret,
          refresh_token: creds.refresh_token,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (data.error) return null;
      creds.access_token = data.access_token;
      creds.expires_at = Date.now() + data.expires_in * 1000;
      const tmp = TOKEN_FILE + ".tmp." + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(creds, null, 2));
      fs.renameSync(tmp, TOKEN_FILE);
      return data.access_token;
    } catch { return null; }
  }

  async _fetchHistory(startHistoryId) {
    const token = await this._getAccessToken();
    if (!token) return { ok: false, reason: "no_token" };
    try {
      const url = `${GMAIL_API}/history?startHistoryId=${startHistoryId}&historyTypes=messageAdded&labelId=INBOX&maxResults=20`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
      // Gmail returns 404 when startHistoryId is older than ~7 days (records
      // have been garbage-collected). That's a known state, not a generic
      // failure — the caller should do a full catchup instead of dispatching
      // per-historyId with no content.
      if (res.status === 404) return { ok: false, reason: "history_expired" };
      if (!res.ok) return { ok: false, reason: `http_${res.status}` };
      const body = await res.json();
      return { ok: true, body };
    } catch (err) {
      return { ok: false, reason: `fetch_error: ${err.message}` };
    }
  }

  // Resolve a single historyId to its first INBOX messageId (if any).
  // Returns null on failure or if no INBOX message was added at that historyId.
  async _resolveHistoryToMessageId(historyId) {
    if (!historyId || historyId === "unknown") return null;
    try {
      const startId = String(BigInt(historyId) - 1n);
      const result = await this._fetchHistory(startId);
      if (!result.ok || !result.body?.history) return null;
      for (const h of result.body.history) {
        for (const added of (h.messagesAdded || [])) {
          if (added.message?.id) return added.message.id;
        }
      }
      return null;
    } catch { return null; }
  }

  // Check if a messageId has been marked phantom (phantom_skip=true in reclassify-tracking).
  // Synchronous; returns false on any read/parse error.
  _isPhantomMessageId(messageId) {
    try {
      const trackingFile = path.join(path.dirname(this.lastHistoryFile), "reclassify-tracking.json");
      if (!fs.existsSync(trackingFile)) return false;
      const tracking = JSON.parse(fs.readFileSync(trackingFile, "utf8"));
      return tracking[messageId]?.phantom_skip === true;
    } catch { return false; }
  }

  async _fetchMessageMeta(messageId) {
    const token = await this._getAccessToken();
    if (!token) return null;
    try {
      const url = `${GMAIL_API}/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const msg = await res.json();
      const headers = msg.payload?.headers || [];
      const from = headers.find(h => h.name === "From")?.value || "unknown";
      const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
      return { messageId, from, subject };
    } catch { return null; }
  }

  // Pre-fetch metadata for a batch of history IDs.
  // Returns:
  //   - Array — may be empty (empty = "nothing new in INBOX", filter as phantom).
  //   - { catchup: true } — history window was too old (Gmail GC'd records);
  //     caller should trigger a full catchup rather than dispatching per-id.
  //   - null — genuine failure (no token, network, non-404 HTTP error); caller
  //     falls back to per-item dispatch so nothing is silently dropped.
  async _prefetchBatch(historyIds) {
    if (!historyIds.length) return [];
    // Use the smallest historyId to fetch all changes since then.
    // Gmail history.list is exclusive (returns records with historyId > startHistoryId),
    // so subtract 1 to ensure the email added AT minId is included in results.
    const minId = historyIds.reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
    const startId = String(BigInt(minId) - 1n);
    const result = await this._fetchHistory(startId);
    if (!result.ok) {
      if (result.reason === "history_expired") {
        console.error(`[gmail-source] history too old (startId=${startId}); returning catchup sentinel`);
        return { catchup: true, reason: "history_expired" };
      }
      console.error(`[gmail-source] _fetchHistory failed: ${result.reason}`);
      return null;
    }
    const history = result.body;
    // 200 OK with no .history = no messageAdded-on-INBOX events in the
    // requested range. Filter as empty; never fall through to the per-item
    // fallback — that produces phantom content-less dispatches.
    if (!history.history) return [];

    const messageIds = new Set();
    for (const h of history.history) {
      for (const added of (h.messagesAdded || [])) {
        if (added.message?.id) messageIds.add(added.message.id);
      }
    }

    if (messageIds.size === 0) return [];
    const results = await Promise.all([...messageIds].map(id => this._fetchMessageMeta(id)));
    return results.filter(Boolean);
  }

  // --- Batching ---

  // Queue a push for batched dispatch. Calls dispatchFn after the batch window.
  _queueForBatch(historyId, emailAddress) {
    this._batch.push({ historyId, emailAddress, ts: Date.now() });

    if (!this._batchTimer && this._dispatchFn) {
      this._batchTimer = setTimeout(() => this._flushBatch(), BATCH_WINDOW_MS);
    }
  }

  async _flushBatch() {
    this._batchTimer = null;
    const items = this._batch.splice(0);
    if (!items.length || !this._dispatchFn) return;

    const historyIds = items.map(i => i.historyId).filter(h => h !== "unknown");

    // Dispatch one turn per message — never batch multiple emails into a single
    // LLM turn, because "triage ALL of these in sequence" instructions have been
    // observed to silently drop items (the agent processes the first few and
    // forgets the rest). One message per turn = one clear responsibility per turn.
    // The prefetch still runs ONCE across the whole batch to amortize API cost.
    try {
      const metas = await this._prefetchBatch(historyIds);

      // history-expired sentinel: our saved historyId is older than Gmail's
      // ~7-day retention window. Can't dispatch per-item (no content);
      // trigger a catchup that cross-references email-mem and triages only
      // what's actually unrecorded.
      if (metas && metas.catchup) {
        const last = this.loadLastHistory();
        const content = `CATCH UP: Gmail history window expired (reason=${metas.reason}); last known history id ${last?.historyId ?? "unknown"} at ${last?.ts ?? "unknown"}. Scan the last 7 days of INBOX messages, cross-reference email-mem, and triage any message not yet recorded. Do NOT rely on Gmail read/unread/label state — only email-mem records are authoritative.`;
        this._dispatchFn(content, "gmail:catchup-history-expired");
        return;
      }

      if (metas && metas.length > 0) {
        // Sort by messageId for deterministic ordering (Gmail IDs are hex-sortable
        // and roughly time-ordered since they embed a timestamp).
        const sorted = [...metas].sort((a, b) => a.messageId.localeCompare(b.messageId));

        // Split into guest-host fast-path group vs regular. Fast-path messages
        // only need label + mark-read (no full-body fetch), so coalescing 2+ of
        // them into a single dispatch is safe — the "multi-email turns silently
        // drop items" concern does not apply to this mechanical path.
        const fastPath = sorted.filter(isFastPathMeta);
        const regular = sorted.filter((m) => !isFastPathMeta(m));

        if (fastPath.length >= 2) {
          const lines = fastPath.map(
            (m) => `  - MessageId: ${m.messageId} | From: ${m.from} | Subject: ${m.subject}`,
          );
          const content =
            `Guest-host chat fast-path batch (${fastPath.length} messages).\n` +
            `All are express@airbnb.com / messages.homeaway.com replies that qualify for the fast-path in CLAUDE.md.\n` +
            `For EACH message below: label (airbnb-miami or pamper-homes based on property name in the subject), mark-read, record in email-mem. No body fetch, no task, no notification. Handle all of them in one batched tool pass.\n\n` +
            lines.join("\n");
          this._dispatchFn(content, `gmail:fastpath-batch(${fastPath.length})`);
        } else {
          // Single fast-path — fall through with the regular per-item path.
          regular.push(...fastPath);
        }

        for (const m of regular) {
          // Skip messageIds the ops-agent already marked as phantom (404 + no inbox match).
          // Prevents repeated dispatches when Gmail keeps pushing stale historyIds that
          // all resolve to the same deleted/missing message.
          try {
            const trackingFile = path.join(path.dirname(this.lastHistoryFile), "reclassify-tracking.json");
            if (fs.existsSync(trackingFile)) {
              const tracking = JSON.parse(fs.readFileSync(trackingFile, "utf8"));
              if (tracking[m.messageId]?.phantom_skip) {
                this.triageLog(`skip phantom messageId ${m.messageId} (phantom_skip=true in reclassify-tracking)`);
                continue;
              }
            }
          } catch {}
          // Intake spam-filter Step 0b check. If sender is on the spam-blocklist,
          // mark read directly and skip the dispatch (no LLM turn burned).
          const spam = intakeSpamCheck(m.messageId, m.from);
          if (spam.blocked) {
            this.triageLog(`spam-blocklist intake skip ${m.messageId} from ${spam.sender} (${spam.reason})`);
            continue;
          }
          const content = `New email received. MessageId: ${m.messageId}\nPre-fetched: From: ${m.from} | Subject: ${m.subject}\nFetch and triage this ONE email now using the Gmail connector, following the Email Triage Rules in CLAUDE.md.`;
          this._dispatchFn(content, `gmail:${m.messageId}`);
        }
        this._lastRealDispatchAt = Date.now();
        return;
      }

      // Prefetch returned no new messages — a successful history-fetch that
      // surfaced zero messageAdded records in INBOX. This is definitionally a
      // phantom: if there were a real new email, it'd be in the history. We
      // skip unconditionally. Edge case: the Gmail history API capped at
      // maxResults=20 could theoretically miss a 21st real email during a
      // storm, but the 30-min periodic catchup covers that.
      //
      // We still classify why we're skipping so the logs distinguish the two
      // phantom sources: self-action (gmail-action marker fresh) vs. the
      // in-session cooldown (we just dispatched real emails and the agent's
      // own writes are generating history changes).
      if (Array.isArray(metas) && metas.length === 0) {
        const sinceLastDispatch = Date.now() - this._lastRealDispatchAt;
        const selfAction = recentSelfAction();
        let reason;
        if (selfAction) {
          reason = "gmail-action marker fresh";
        } else if (sinceLastDispatch < SELF_INFLICTED_COOLDOWN_MS) {
          reason = `${Math.round(sinceLastDispatch / 1000)}s since last real dispatch`;
        } else {
          reason = "empty prefetch";
        }
        console.error(`[gmail-source] skipping empty batch — ${reason}`);
        return;
      }

      // Prefetch returned null (API failure) — we can't tell whether these
      // pushes carry real new mail. Fall back to per-item dispatch keyed by
      // historyId so nothing is silently dropped.
      // Before dispatching, try to resolve each historyId → messageId so we
      // can skip known phantoms. Fail open: if resolution fails, dispatch anyway.
      for (const item of items) {
        try {
          const resolvedMsgId = await this._resolveHistoryToMessageId(item.historyId);
          if (resolvedMsgId && this._isPhantomMessageId(resolvedMsgId)) {
            this.triageLog(`skip phantom ${resolvedMsgId} in null-prefetch fallback (historyId: ${item.historyId})`);
            continue;
          }
        } catch {}
        const content = `New email received. Email: ${item.emailAddress}, History ID: ${item.historyId}. Fetch and triage this ONE email now using the Gmail connector, following the Email Triage Rules in CLAUDE.md.`;
        this._dispatchFn(content, `gmail:${item.historyId}`);
      }
    } catch (err) {
      // CRITICAL: never silently drop emails. If prefetch fails, dispatch each
      // item individually without metadata. Phantom check still applies.
      console.error(`[gmail-source] _flushBatch error: ${err.message} — dispatching per-item without metadata`);
      for (const item of items) {
        try {
          const resolvedMsgId = await this._resolveHistoryToMessageId(item.historyId);
          if (resolvedMsgId && this._isPhantomMessageId(resolvedMsgId)) {
            this.triageLog(`skip phantom ${resolvedMsgId} in _flushBatch catch fallback (historyId: ${item.historyId})`);
            continue;
          }
        } catch {}
        const content = `New email received. Email: ${item.emailAddress}, History ID: ${item.historyId}. Fetch and triage this ONE email now using the Gmail connector, following the Email Triage Rules in CLAUDE.md.`;
        this._dispatchFn(content, `gmail:${item.historyId}`);
      }
    }
  }

  // Called by HTTP handler with raw request body.
  // Returns { accept: bool, reason?, historyId?, emailAddress?, content? }
  handlePush(rawBody) {
    let data;
    try {
      const pubsubMessage = JSON.parse(rawBody);
      data = pubsubMessage.message?.data
        ? JSON.parse(Buffer.from(pubsubMessage.message.data, "base64").toString())
        : pubsubMessage;
    } catch (err) {
      return { accept: false, reason: "parse_error", error: err.message };
    }

    const emailAddress = data.emailAddress || "unknown";
    const historyId = data.historyId || "unknown";

    if (historyId !== "unknown" && this._isDuplicate(historyId)) {
      return { accept: false, reason: "duplicate", historyId };
    }

    this.lastPushAt = Date.now();
    this.triageLog("EMAIL-RECEIVED", { emailAddress, historyId });
    if (historyId !== "unknown") this.saveLastHistory(historyId);

    if (this.isPaused()) {
      this.triageLog("PAUSED-SKIP", { emailAddress, historyId });
      return { accept: false, reason: "paused", historyId };
    }

    // Storm protection: if too many pushes in a short window, consolidate.
    if (this._isStorm()) {
      if (!this._stormConsolidated && this._dispatchFn) {
        // Dispatch one consolidated catchup for this storm, skip the rest.
        this._stormConsolidated = true;
        // Cancel any pending batch — the catchup will cover everything.
        if (this._batchTimer) { clearTimeout(this._batchTimer); this._batchTimer = null; }
        this._batch = [];
        const last = this.loadLastHistory();
        const content = `STORM CATCHUP: Gmail notification storm detected (${this._stormCounter}+ pushes in ${STORM_WINDOW_MS / 1000}s). Consolidating. Last history ID: ${last?.historyId || "unknown"}. Fetch all recent inbox emails since last triage and process them per CLAUDE.md. Do NOT rely on Gmail read/unread/label state — only email-mem records are authoritative.`;
        console.error(`[gmail-source] storm detected (${this._stormCounter} pushes) — consolidating to single catchup`);
        this._dispatchFn(content, `gmail-storm:${historyId}`);
      }
      return { accept: true, batched: true, historyId, emailAddress, storm: true };
    }

    // Queue for batched dispatch instead of returning content for immediate dispatch.
    if (this._dispatchFn) {
      this._queueForBatch(historyId, emailAddress);
      return { accept: true, batched: true, historyId, emailAddress };
    }

    // Fallback: if no dispatchFn wired yet, return content for legacy direct dispatch.
    const content = `New email received. Email: ${emailAddress}, History ID: ${historyId}. Fetch and triage this email now using the Gmail connector, following the Email Triage Rules in CLAUDE.md.`;
    return { accept: true, historyId, emailAddress, content };
  }

  // Produce a startup-catchup dispatch message (or null if no prior history).
  catchupMessage() {
    const last = this.loadLastHistory();
    if (!last) return null;
    return `STARTUP CATCHUP: Supervisor just (re)started. Last Gmail activity at ${last.ts} (historyId ${last.historyId}). Check for any emails since then that are not recorded in email-mem and triage them per CLAUDE.md. Do NOT rely on Gmail read/unread/label state — only email-mem records are authoritative.`;
  }

  // --- Periodic catchup timer ---
  // Starts a recurring timer that dispatches a catchup if no Gmail push
  // has arrived within CATCHUP_INTERVAL_MS. This guards against silent
  // Pub/Sub push delivery failures (watch expiry, Hookdeck issues, etc.).

  startCatchupTimer() {
    if (this._catchupTimer) return;
    this._catchupTimer = setInterval(() => this._checkForMissedEmails(), CATCHUP_INTERVAL_MS);
    // Don't prevent process exit
    if (this._catchupTimer.unref) this._catchupTimer.unref();
    console.error(`[gmail-source] catchup timer started (every ${CATCHUP_INTERVAL_MS / 60000}min)`);
  }

  stopCatchupTimer() {
    if (this._catchupTimer) {
      clearInterval(this._catchupTimer);
      this._catchupTimer = null;
    }
  }

  _checkForMissedEmails() {
    if (!this._dispatchFn) return;
    const now = Date.now();
    const gap = this.lastPushAt ? now - this.lastPushAt : Infinity;

    if (gap >= CATCHUP_INTERVAL_MS) {
      const last = this.loadLastHistory();
      if (!last) return;
      const content = `PERIODIC CATCHUP: No Gmail push received in ${Math.round(gap / 60000)} minutes (last push: ${this.lastPushAt ? new Date(this.lastPushAt).toISOString() : "never"}). Last history ID: ${last.historyId} at ${last.ts}. Check for any unprocessed emails since then and triage per CLAUDE.md. Do NOT rely on Gmail read/unread/label state — only email-mem records are authoritative.`;
      console.error(`[gmail-source] push gap detected (${Math.round(gap / 60000)}min) — dispatching periodic catchup`);
      this._dispatchFn(content, "periodic-catchup");
    }
  }

  // --- Storm protection ---
  // If more than STORM_THRESHOLD pushes arrive within STORM_WINDOW_MS,
  // stop dispatching individual items and consolidate into a single catchup.

  _isStorm() {
    const now = Date.now();
    if (now - this._stormWindowStart > STORM_WINDOW_MS) {
      // Reset window
      this._stormWindowStart = now;
      this._stormCounter = 0;
      this._stormConsolidated = false;
    }
    this._stormCounter++;
    return this._stormCounter > STORM_THRESHOLD;
  }

  MAX_BODY_SIZE() { return MAX_BODY_SIZE; }
}
