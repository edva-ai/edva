// triage-decisions.js — structured per-message triage outcomes, written by CODE.
//
// Why (2026-10-04 determinism review): the sender-history consensus that lets
// intake auto-file routine mail used to be RECONSTRUCTED from free-text
// `email-mem` rows the agent wrote — a 600-char FTS window, regex-extracted
// "P3 personal" pairs, and an FTS ranking that weighs subject words as heavily
// as the sender, so a new sender inherited strangers' decisions. Six separate
// Jev-disagreement patches went into making that extraction less wrong.
//
// This table records the outcome itself, as a fact, at the one chokepoint every
// Gmail mutation already passes through: `bin/gmail-action` (label /
// unlabel / star / unstar / mark-read). The supervisor registers each inbound
// message's sender here at intake (`register`), so the row is keyed by
// messageId and carries the sender address before any label lands. Priority is
// derived from the final Gmail state, exactly as email-triage-rules.md Step 5
// defines it: `p1` label → P1; starred → P2; otherwise P3.
//
// Consensus is then a GROUP BY on the sender address (`senderConsensus`). Only
// rows whose last writer was NOT an intake auto-handler count — a consensus must
// mean "the agent (or the user) repeatedly made this call", never "intake agreed
// with itself", or auto-filing would become self-reinforcing.
//
// Storage: the `triage_decisions` table in data/email-memory.db (same file
// as email-mem, node:sqlite, zero deps). Override with TRIAGE_DECISIONS_DB for
// tests. Every function is fail-soft: a broken store must never break a Gmail
// mutation or an intake decision.

const path = require("path");

const { LABELS } = require("./triage-labels.cjs");
const MIN_ROWS = 3;            // fewer than this → "insufficient", caller falls back
const WINDOW_DAYS = 180;

function dbPath() {
  return process.env.TRIAGE_DECISIONS_DB || path.join(__dirname, "..", "data", "email-memory.db");
}

let _db = null;
let _dbFile = null;
function db() {
  const file = dbPath();
  if (_db && _dbFile === file) return _db;
  const { DatabaseSync } = require("node:sqlite");
  _db = new DatabaseSync(file);
  _dbFile = file;
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA busy_timeout=3000");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS triage_decisions (
      message_id  TEXT PRIMARY KEY,
      sender_addr TEXT,
      domain      TEXT,
      label       TEXT,
      p1          INTEGER DEFAULT 0,
      starred     INTEGER DEFAULT 0,
      read        INTEGER DEFAULT 0,
      decided_by  TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    )
  `);
  _db.exec("CREATE INDEX IF NOT EXISTS triage_decisions_sender ON triage_decisions(sender_addr)");
  return _db;
}

// Structural: the address inside <...> of a From header, lowercased.
function senderAddr(from) {
  const s = String(from || "");
  const lt = s.lastIndexOf("<");
  const gt = s.lastIndexOf(">");
  const addr = lt !== -1 && gt > lt ? s.slice(lt + 1, gt) : s;
  return addr.trim().toLowerCase();
}

function priorityOf(row) {
  if (!row) return null;
  if (row.p1) return "P1";
  if (row.starred) return "P2";
  return "P3";
}

function actor() {
  return process.env.EDVA_TRIAGE_ACTOR || "agent";
}

/** Intake: remember who sent this message. Never overwrites a known sender. */
function register(messageId, from) {
  try {
    const addr = senderAddr(from);
    if (!messageId || !addr || !addr.includes("@")) return false;
    db().prepare(`
      INSERT INTO triage_decisions (message_id, sender_addr, domain) VALUES (?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        sender_addr = COALESCE(triage_decisions.sender_addr, excluded.sender_addr),
        domain      = COALESCE(triage_decisions.domain, excluded.domain)
    `).run(messageId, addr, addr.split("@")[1] || null);
    return true;
  } catch { return false; }
}

/**
 * Record one Gmail mutation. `kind` is the gmail-action verb:
 *   label <name> | unlabel <name> | star | unstar | mark-read
 * Labels outside the triage set (other than p1) are ignored.
 */
function recordAction(messageId, kind, labelName = null) {
  try {
    if (!messageId) return false;
    const lab = labelName ? String(labelName).toLowerCase() : null;
    let set = null;
    if (kind === "label" && lab === "p1") set = "p1 = 1";
    else if (kind === "unlabel" && lab === "p1") set = "p1 = 0";
    else if (kind === "label" && LABELS.includes(lab)) set = "label = :label";
    else if (kind === "star") set = "starred = 1";
    else if (kind === "unstar") set = "starred = 0";
    else if (kind === "mark-read") set = "read = 1";
    if (!set) return false;
    const d = db();
    d.prepare("INSERT OR IGNORE INTO triage_decisions (message_id) VALUES (?)").run(messageId);
    const params = { id: messageId, by: actor() };
    if (set.includes(":label")) params.label = lab;
    d.prepare(`UPDATE triage_decisions SET ${set}, decided_by = :by, updated_at = datetime('now') WHERE message_id = :id`).run(params);
    return true;
  } catch { return false; }
}

function get(messageId) {
  try {
    const row = db().prepare("SELECT * FROM triage_decisions WHERE message_id = ?").get(messageId);
    return row ? { ...row, priority: row.label ? priorityOf(row) : null } : null;
  } catch { return null; }
}

/**
 * Sender-history consensus as a GROUP BY. Returns
 *   { enough:false, n }                                    — fewer than MIN_ROWS decided rows
 *   { enough:true, n, consensus:{label,priority:"P3"}, reason:"consensus" }
 *   { enough:true, n, consensus:null, reason:"mixed-or-urgent" }
 * Mirrors memConsensus's rule: any P1/P2 → no consensus; one label must hold at
 * least twice the votes of the runner-up.
 */
function senderConsensus(from, { minRows = MIN_ROWS, windowDays = WINDOW_DAYS } = {}) {
  try {
    const addr = senderAddr(from);
    if (!addr || !addr.includes("@")) return { enough: false, n: 0 };
    const rows = db().prepare(`
      SELECT label, p1, starred, COUNT(*) AS n FROM triage_decisions
      WHERE sender_addr = ? AND label IS NOT NULL
        AND (decided_by IS NULL OR decided_by NOT LIKE 'intake:%')
        AND updated_at >= datetime('now', ?)
      GROUP BY label, p1, starred
    `).all(addr, `-${windowDays} days`);
    const n = rows.reduce((a, r) => a + Number(r.n), 0);
    if (n < minRows) return { enough: false, n };
    if (rows.some((r) => r.p1 || r.starred)) return { enough: true, n, consensus: null, reason: "mixed-or-urgent" };
    const byLabel = {};
    for (const r of rows) byLabel[r.label] = (byLabel[r.label] || 0) + Number(r.n);
    const sorted = Object.entries(byLabel).sort((a, b) => b[1] - a[1]);
    const [topL, topN] = sorted[0];
    const second = sorted[1] ? sorted[1][1] : 0;
    if (topN >= 2 * second) return { enough: true, n, consensus: { label: topL, priority: "P3" }, reason: "consensus" };
    return { enough: true, n, consensus: null, reason: "mixed-or-urgent" };
  } catch { return { enough: false, n: 0 }; }
}

function _resetForTests() { try { _db?.close(); } catch {} _db = null; _dbFile = null; }

module.exports = { register, recordAction, get, senderConsensus, priorityOf, senderAddr, LABELS, MIN_ROWS, _resetForTests };
