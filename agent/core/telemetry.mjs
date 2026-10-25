// telemetry.mjs — WP13 (server-side): live telemetry primitives so a running
// task can narrate itself. `setStatusLine` (the now-line) and `setTodos` (a live
// checklist) are PERSISTED to memory-index.db so a producer (a supervisor turn,
// a job) and the consumer (the WP12 dashboard on :9098, a separate process) are
// decoupled — the dashboard reads + streams them. `mobilePush` routes through
// the existing APNs path (`edva-notify`) and enforces Conway's one-push-per-
// task discipline in code (dedupe within a window), so a long task yields ONE
// completion/blocker push, never incremental spam.
//
// The native half of WP13 (rendering the status line + checklist on the Swift
// client, and speak/haptic) is client work + a TestFlight build — this module is
// the server side it maps onto. Fail-soft like the rest of the substrate: a
// down DB degrades to no-op, never throws into a producer's hot path.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { installTools } from "../../lib/root.cjs";
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
      CREATE TABLE IF NOT EXISTS agent_telemetry (
        agent_id    TEXT PRIMARY KEY,
        status_line TEXT,
        todos_json  TEXT,
        updated_at  INTEGER NOT NULL
      )
    `);
    _db = d;
    return _db;
  } catch {
    _disabled = true;
    _db = null;
    return null;
  }
}

function upsert(agentId, patch, now) {
  const d = db();
  if (!d || !agentId) return false;
  try {
    const cur = d.prepare("SELECT status_line, todos_json FROM agent_telemetry WHERE agent_id = ?").get(agentId) || {};
    const statusLine = patch.statusLine !== undefined ? patch.statusLine : (cur.status_line ?? null);
    const todosJson = patch.todosJson !== undefined ? patch.todosJson : (cur.todos_json ?? null);
    d.prepare(
      "INSERT INTO agent_telemetry(agent_id, status_line, todos_json, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(agent_id) DO UPDATE SET status_line=excluded.status_line, todos_json=excluded.todos_json, updated_at=excluded.updated_at"
    ).run(agentId, statusLine, todosJson, now);
    return true;
  } catch {
    return false;
  }
}

// The now-line for `agentId`. Pass "" or null to clear just the status line.
export function setStatusLine(agentId, text, { now = Date.now() } = {}) {
  return upsert(agentId, { statusLine: text ? String(text) : null }, now);
}

// A live checklist: [{ content, status: "pending"|"in_progress"|"completed", activeForm? }].
// Conway's rule: the checklist clears when everything is complete.
export function setTodos(agentId, todos, { now = Date.now() } = {}) {
  const list = Array.isArray(todos) ? todos : [];
  const allDone = list.length > 0 && list.every((t) => t.status === "completed");
  const todosJson = allDone || list.length === 0 ? null : JSON.stringify(list);
  return upsert(agentId, { todosJson }, now);
}

// Clear a task's telemetry entirely (call when the task ends).
export function clearTelemetry(agentId) {
  const d = db();
  if (!d || !agentId) return false;
  try { d.prepare("DELETE FROM agent_telemetry WHERE agent_id = ?").run(agentId); return true; }
  catch { return false; }
}

export function getTelemetry(agentId) {
  const d = db();
  if (!d || !agentId) return null;
  try {
    const r = d.prepare("SELECT agent_id, status_line, todos_json, updated_at FROM agent_telemetry WHERE agent_id = ?").get(agentId);
    if (!r) return null;
    return { agentId: r.agent_id, statusLine: r.status_line || null, todos: parseTodos(r.todos_json), updatedAt: r.updated_at };
  } catch { return null; }
}

// All active telemetry rows (for the dashboard). Optionally drop rows older than maxAgeMs.
export function allTelemetry({ maxAgeMs = null, now = Date.now() } = {}) {
  const d = db();
  if (!d) return [];
  try {
    const rows = d.prepare("SELECT agent_id, status_line, todos_json, updated_at FROM agent_telemetry ORDER BY updated_at DESC").all();
    return rows
      .filter((r) => maxAgeMs == null || now - r.updated_at <= maxAgeMs)
      .map((r) => ({ agentId: r.agent_id, statusLine: r.status_line || null, todos: parseTodos(r.todos_json), updatedAt: r.updated_at }));
  } catch { return []; }
}

function parseTodos(json) {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

// ---- mobilePush: one push per task, via the existing APNs path -------------

const _lastPush = new Map();   // dedupeKey -> ts
const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60_000;

// Default pusher: `edva-notify --title <title> <body>` (existing APNs sender).
function defaultPusher(title, body) {
  const bin = installTools("bin/edva-notify");
  try {
    const child = spawn(bin, ["--title", title, body], { stdio: "ignore", detached: true });
    child.unref?.();
    return true;
  } catch { return false; }
}

// Send ONE push. `dedupeKey` (default title) suppresses a repeat within
// `dedupeWindowMs` — the enforced "one push per task at completion/blocker,
// never incremental" discipline. Returns { sent, reason }.
export function mobilePush(title, body, { dedupeKey = null, dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS, pusher = defaultPusher, now = () => Date.now() } = {}) {
  const key = dedupeKey || title || body || "push";
  const t = now();
  const last = _lastPush.get(key);
  if (last != null && t - last < dedupeWindowMs) {
    return { sent: false, reason: "deduped" };
  }
  const ok = pusher(title || "Edva", body || "");
  if (ok) _lastPush.set(key, t);
  return { sent: !!ok, reason: ok ? "sent" : "push-failed" };
}

export function _resetPushDedupeForTest() { _lastPush.clear(); }

export function _closeForTest() {
  try { _db?.close(); } catch {}
  _db = null;
  _disabled = false;
  _lastPush.clear();
}
