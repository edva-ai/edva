// check-later.mjs — WP14: deferred self-wake as a loop primitive.
//
// Conway's checkLater(seconds, note) (max 300): the agent ends its turn; a
// reminder wakes it later with the note as a point-in-time payload. It's a
// one-shot in-flight deferral — "poll this PR in 60s", "re-check the fill in
// 5 min" — distinct from cron/launchd recurring jobs, and the sanctioned
// alternative to a foreground sleep (which would block the loop).
//
// EDVA SURPASSES CONWAY HERE: Conway's checkLater lives in a managed runtime
// and dies on container cycle. Edva PERSISTS the wake to memory-index.db, so
// a scheduled wake survives a full supervisor bounce or reboot — the always-on
// box + persistence makes this strictly better than Conway's in-memory timer
// (WP7 surpass-lens).
//
// This module owns the durable ledger + the due/fire accessors. The ticker that
// actually re-enqueues a session at wake_at is an integration concern (a
// supervisor timer polls dueWakes → re-dispatches → markFired); it is NOT here,
// so the module stays pure/testable. Same DB + fail-soft contract as the rest.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { installTools } from "../../lib/root.cjs";
// Conway caps this at 300s (its wake is an in-memory timer that dies on
// container cycle). Edva PERSISTS the wake to memory-index.db and survives a
// bounce, so the cap can be a useful in-conversation ceiling (1h) without
// competing with cron/calendar for genuine long-term reminders. Overridable via
// CHECK_LATER_MAX_SECONDS.
export const MAX_CHECK_LATER_SECONDS = Number(process.env.CHECK_LATER_MAX_SECONDS) || 3600;

const HOME = os.homedir();
const DB_PATH =
  process.env.MEMORY_INDEX_DB ||
  installTools("data/memory-index.db");

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
      CREATE TABLE IF NOT EXISTS pending_wakes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        wake_at    INTEGER NOT NULL,     -- epoch ms
        note       TEXT,
        created_at INTEGER NOT NULL,
        fired      INTEGER NOT NULL DEFAULT 0
      )
    `);
    d.exec("CREATE INDEX IF NOT EXISTS idx_pending_wakes_due ON pending_wakes(fired, wake_at)");
    _db = d;
    return _db;
  } catch {
    _disabled = true;
    _db = null;
    return null;
  }
}

// Schedule a one-shot wake. `seconds` is clamped to [1, 300]. `now` is injectable
// for tests. Returns the wake id (persisted → survives a supervisor bounce).
export function checkLater(sessionId, seconds, note = "", { now = Date.now() } = {}) {
  const d = db();
  if (!d || !sessionId) return null;
  const secs = Math.max(1, Math.min(MAX_CHECK_LATER_SECONDS, Math.floor(Number(seconds) || 0)));
  const wakeAt = now + secs * 1000;
  try {
    const r = d.prepare(
      "INSERT INTO pending_wakes(session_id, wake_at, note, created_at, fired) VALUES (?, ?, ?, ?, 0)",
    ).run(sessionId, wakeAt, note || "", now);
    return { id: Number(r.lastInsertRowid), wakeAt, seconds: secs };
  } catch {
    return null;
  }
}

// Wakes that are due (wake_at <= now) and not yet fired, oldest-first. The ticker
// consumes these and re-enqueues each session with its note.
export function dueWakes({ now = Date.now() } = {}) {
  const d = db();
  if (!d) return [];
  try {
    return d.prepare(
      "SELECT id, session_id, wake_at, note, created_at FROM pending_wakes WHERE fired = 0 AND wake_at <= ? ORDER BY wake_at ASC",
    ).all(now).map((r) => ({ id: r.id, sessionId: r.session_id, wakeAt: r.wake_at, note: r.note, createdAt: r.created_at }));
  } catch {
    return [];
  }
}

export function markFired(id) {
  const d = db();
  if (!d) return;
  try { d.prepare("UPDATE pending_wakes SET fired = 1 WHERE id = ?").run(id); } catch {}
}

export function pendingWakes(sessionId = null) {
  const d = db();
  if (!d) return [];
  try {
    const where = sessionId ? "WHERE fired = 0 AND session_id = ?" : "WHERE fired = 0";
    const args = sessionId ? [sessionId] : [];
    return d.prepare(`SELECT id, session_id, wake_at, note FROM pending_wakes ${where} ORDER BY wake_at ASC`).all(...args)
      .map((r) => ({ id: r.id, sessionId: r.session_id, wakeAt: r.wake_at, note: r.note }));
  } catch {
    return [];
  }
}

export function clearWake(id) {
  const d = db();
  if (!d) return;
  try { d.prepare("DELETE FROM pending_wakes WHERE id = ?").run(id); } catch {}
}

export function _closeForTest() {
  try { _db?.close(); } catch {}
  _db = null;
  _disabled = false;
}
