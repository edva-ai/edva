// fork-queue.mjs — the durable ledger that makes WP3 forks reachable from a
// tool call.
//
// WHY A QUEUE AT ALL. `core/fork.mjs` forks a live `Agent` object — it needs the
// parent in memory. But the thing that can *ask* for a fork is the model, and
// the model's tools are served by `tools-mcp`, a SEPARATE PROCESS from the
// supervisor that owns the chat Agent. There is no in-memory handle to pass.
//
// This is exactly the shape `check_later` already runs in production: the MCP
// tool writes a durable row, a supervisor ticker drains it and does the work in
// the process that actually holds the Agent. Same table style, same fail-soft
// contract, same reason — and the same payoff, a request that survives a
// supervisor bounce between being made and being served.
//
// WHAT A FORK BUYS OVER THE MODEL JUST DOING THE WORK. A research task inside a
// chat turn blocks the conversation and lands in the 200k window that the
// context guard is already fighting (it fires a /compact at ~150k).
// A fork inherits a slice of the conversation as read-only background, runs on
// the stateless executor in its own context, and reports back one summary. The
// conversation pays for the summary, not the research.
//
// STATUS MODEL: queued -> running -> done | failed. The ticker owns transitions;
// this module owns the ledger.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { installTools } from "../../lib/root.cjs";
const HOME = os.homedir();
const DB_PATH =
  process.env.MEMORY_INDEX_DB ||
  installTools("data/memory-index.db");

// A fork is one `claude -p` running an open-ended task. Cap how many can be in
// flight for one agent so a model that delegates in a loop cannot fan out an
// unbounded swarm on a RAM-constrained host.
export const MAX_INFLIGHT_FORKS = Number(process.env.MAX_INFLIGHT_FORKS) || 3;

// Task text ceiling — a delegated task is a brief, not a document.
export const MAX_TASK_CHARS = 2000;

let _db = null;
let _disabled = false;

function db() {
  if (_db) return _db;
  if (_disabled) return null;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const d = new DatabaseSync(DB_PATH);
    d.exec("PRAGMA journal_mode=WAL");
    d.exec("PRAGMA synchronous=NORMAL");
    d.exec("PRAGMA busy_timeout=3000");
    d.exec(`
      CREATE TABLE IF NOT EXISTS pending_forks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT NOT NULL,
        task         TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'queued',
        fork_id      TEXT,
        summary      TEXT,
        error        TEXT,
        created_at   INTEGER NOT NULL,
        started_at   INTEGER,
        finished_at  INTEGER
      )
    `);
    d.exec("CREATE INDEX IF NOT EXISTS idx_pending_forks_status ON pending_forks(status, created_at)");
    _db = d;
    return _db;
  } catch {
    _disabled = true;
    _db = null;
    return null;
  }
}

/**
 * Ask for a fork. Returns {id} or {error} — never throws, so a tool call can
 * report the refusal instead of failing the model's turn.
 */
export function requestFork(sessionId, task, { now = Date.now() } = {}) {
  const d = db();
  if (!d) return { error: "fork queue unavailable" };
  if (!sessionId) return { error: "no session id" };
  const text = String(task || "").trim();
  if (!text) return { error: "task is required" };
  if (text.length > MAX_TASK_CHARS) return { error: `task too long (${text.length} > ${MAX_TASK_CHARS} chars)` };

  const inflight = countActive(sessionId);
  if (inflight >= MAX_INFLIGHT_FORKS) {
    return { error: `already ${inflight} background task(s) running (max ${MAX_INFLIGHT_FORKS}) — wait for one to report back` };
  }
  try {
    const r = d.prepare(
      "INSERT INTO pending_forks(session_id, task, status, created_at) VALUES (?, ?, 'queued', ?)",
    ).run(sessionId, text, now);
    return { id: Number(r.lastInsertRowid) };
  } catch (err) {
    return { error: err.message };
  }
}

/** queued + running, for the in-flight cap. */
export function countActive(sessionId) {
  const d = db();
  if (!d) return 0;
  try {
    const r = d.prepare(
      "SELECT COUNT(*) AS n FROM pending_forks WHERE session_id = ? AND status IN ('queued','running')",
    ).get(sessionId);
    return Number(r?.n || 0);
  } catch { return 0; }
}

/** Queued requests for one agent, oldest first. The ticker consumes these. */
export function queuedForks(sessionId) {
  const d = db();
  if (!d) return [];
  try {
    return d.prepare(
      "SELECT id, session_id, task, created_at FROM pending_forks WHERE status = 'queued' AND session_id = ? ORDER BY created_at ASC",
    ).all(sessionId).map((r) => ({ id: r.id, sessionId: r.session_id, task: r.task, createdAt: r.created_at }));
  } catch { return []; }
}

export function markRunning(id, forkId, { now = Date.now() } = {}) {
  const d = db();
  if (!d) return;
  try {
    d.prepare("UPDATE pending_forks SET status='running', fork_id=?, started_at=? WHERE id=?").run(forkId || null, now, id);
  } catch {}
}

export function markDone(id, summary, { now = Date.now() } = {}) {
  const d = db();
  if (!d) return;
  try {
    d.prepare("UPDATE pending_forks SET status='done', summary=?, finished_at=? WHERE id=?").run(String(summary || ""), now, id);
  } catch {}
}

export function markFailed(id, error, { now = Date.now() } = {}) {
  const d = db();
  if (!d) return;
  try {
    d.prepare("UPDATE pending_forks SET status='failed', error=?, finished_at=? WHERE id=?").run(String(error || ""), now, id);
  } catch {}
}

/**
 * A fork left 'running' across a supervisor bounce is dead — its process died
 * with the supervisor. Reclaim it as failed so the in-flight cap does not leak
 * a slot forever, which would silently disable delegation.
 */
export function reclaimStale(sessionId, { olderThanMs = 30 * 60_000, now = Date.now() } = {}) {
  const d = db();
  if (!d) return 0;
  try {
    const r = d.prepare(
      "UPDATE pending_forks SET status='failed', error='abandoned (supervisor restart)', finished_at=? " +
      "WHERE session_id=? AND status='running' AND started_at IS NOT NULL AND started_at < ?",
    ).run(now, sessionId, now - olderThanMs);
    return Number(r.changes || 0);
  } catch { return 0; }
}

export function listForks(sessionId, { limit = 20 } = {}) {
  const d = db();
  if (!d) return [];
  try {
    return d.prepare(
      "SELECT id, task, status, summary, error, created_at, finished_at FROM pending_forks WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(sessionId, limit);
  } catch { return []; }
}

export function _closeForTest() {
  try { _db?.close(); } catch {}
  _db = null;
  _disabled = false;
}
