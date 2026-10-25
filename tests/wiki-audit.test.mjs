// wiki-audit.test.mjs — tests for the access log + nightly pin auditor.
// Run: node --test tests/wiki-audit.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-audit-"));
const fixtureMemoryDir = path.join(fixtureDir, "memory");
const fixtureDb = path.join(fixtureDir, "memory-index.db");
const fixtureLog = path.join(fixtureDir, "wiki-access.jsonl");
fs.mkdirSync(fixtureMemoryDir, { recursive: true });

process.env.MEMORY_INDEX_DIR = fixtureMemoryDir;
process.env.MEMORY_INDEX_DB = fixtureDb;
process.env.WIKI_ACCESS_LOG = fixtureLog;
process.env.MEMORY_DB_AUTHORITATIVE = "0";

const { createRequire } = await import("node:module");
const requireFromHere = createRequire(import.meta.url);
const ws = requireFromHere(path.resolve("lib/wiki-store.js"));

const FIXTURES = [
  ["user_alice.md", "---\nname: Alice\ntype: user\n---\nAlice notes\n"],
  ["user_bob.md", "---\nname: Bob\ntype: user\n---\nBob notes\n"],
  ["feedback_one.md", "---\nname: Rule one\ntype: feedback\n---\nFirst rule\n"],
  ["feedback_two.md", "---\nname: Rule two\ntype: feedback\n---\nSecond rule\n"],
  ["project_x.md", "---\nname: Project X\ntype: project\n---\nProject body\n"],
];

before(() => {
  for (const [name, body] of FIXTURES) {
    fs.writeFileSync(path.join(fixtureMemoryDir, name), body);
  }
  ws.backfill();
});

after(() => {
  ws.closeDb();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

// ── Schema additions ────────────────────────────────────────────────────

test("pinned_at + pin_locked columns exist on the pages table", () => {
  const cols = ws
    .db()
    .prepare("PRAGMA table_info(pages)")
    .all()
    .map((r) => r.name);
  assert.ok(cols.includes("pinned_at"), "pinned_at column missing");
  assert.ok(cols.includes("pin_locked"), "pin_locked column missing");
});

test("setPinned writes pinned_at on pin and clears it on unpin", () => {
  ws.setPinned("user_alice", true, { editedBy: "test" });
  let row = ws.db().prepare("SELECT pinned, pinned_at FROM pages WHERE id = ?").get("user_alice");
  assert.equal(row.pinned, 1);
  assert.ok(row.pinned_at, "pinned_at should be set");
  ws.setPinned("user_alice", false, { editedBy: "test" });
  row = ws.db().prepare("SELECT pinned, pinned_at FROM pages WHERE id = ?").get("user_alice");
  assert.equal(row.pinned, 0);
  assert.equal(row.pinned_at, null, "pinned_at should be NULL after unpin");
});

test("setPinLocked toggles the pin_locked column", () => {
  ws.setPinLocked("user_bob", true);
  let row = ws.db().prepare("SELECT pin_locked FROM pages WHERE id = ?").get("user_bob");
  assert.equal(row.pin_locked, 1);
  ws.setPinLocked("user_bob", false);
  row = ws.db().prepare("SELECT pin_locked FROM pages WHERE id = ?").get("user_bob");
  assert.equal(row.pin_locked, 0);
});

// ── Access log ──────────────────────────────────────────────────────────

test("logAccess appends a JSONL entry with the right shape", () => {
  // Wipe the log to start clean.
  try {
    fs.unlinkSync(fixtureLog);
  } catch {}
  ws.logAccess({
    tool: "wiki_search",
    query: "alice",
    page_ids: ["user_alice", "user_bob"],
    caller: "mcp",
  });
  const lines = fs.readFileSync(fixtureLog, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.tool, "wiki_search");
  assert.equal(row.query, "alice");
  assert.deepEqual(row.page_ids, ["user_alice", "user_bob"]);
  assert.equal(row.caller, "mcp");
  assert.ok(row.ts);
});

test("readAccessLog tallies hits per page and respects the caller filter", () => {
  // Reset + seed several entries.
  fs.writeFileSync(fixtureLog, "");
  for (let i = 0; i < 6; i++) {
    ws.logAccess({ tool: "wiki_read", page_ids: ["user_alice"], caller: "mcp" });
  }
  for (let i = 0; i < 3; i++) {
    ws.logAccess({ tool: "wiki_read", page_ids: ["user_bob"], caller: "mcp" });
  }
  ws.logAccess({ tool: "wiki_read", page_ids: ["user_bob"], caller: "cli" });
  const all = ws.readAccessLog({ sinceMs: 0 });
  assert.equal(all.counts.get("user_alice"), 6);
  assert.equal(all.counts.get("user_bob"), 4);
  assert.equal(all.total_entries, 10);
  const mcpOnly = ws.readAccessLog({ sinceMs: 0, onlyCallers: ["mcp"] });
  assert.equal(mcpOnly.counts.get("user_bob"), 3);
});

test("readAccessLog drops entries older than sinceMs", () => {
  fs.writeFileSync(fixtureLog, "");
  // Old entry — fabricate ts in the past.
  fs.appendFileSync(
    fixtureLog,
    JSON.stringify({
      ts: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      tool: "wiki_read",
      page_ids: ["user_alice"],
      caller: "mcp",
    }) + "\n",
  );
  ws.logAccess({ tool: "wiki_read", page_ids: ["user_alice"], caller: "mcp" });
  const recent = ws.readAccessLog({
    sinceMs: Date.now() - 7 * 24 * 3600 * 1000,
  });
  assert.equal(recent.counts.get("user_alice"), 1, "old entry should be ignored");
});

// ── Auditor end-to-end ──────────────────────────────────────────────────

function runAuditor(extraArgs = []) {
  return spawnSync(
    "node",
    [path.resolve("bin/wiki-audit"), "--no-email", "--json", ...extraArgs],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MEMORY_INDEX_DIR: fixtureMemoryDir,
        MEMORY_INDEX_DB: fixtureDb,
        WIKI_ACCESS_LOG: fixtureLog,
        MEMORY_DB_AUTHORITATIVE: "0",
      },
    },
  );
}

test("auditor pins an unpinned page with hits >= threshold", () => {
  // Reset state.
  fs.writeFileSync(fixtureLog, "");
  ws.setPinned("user_alice", false, { editedBy: "test" });
  for (let i = 0; i < 6; i++) {
    ws.logAccess({ tool: "wiki_read", page_ids: ["user_alice"], caller: "mcp" });
  }
  const r = runAuditor(["--pin-threshold", "5"]);
  assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
  const report = JSON.parse(r.stdout);
  assert.ok(report.pin_now.some((p) => p.id === "user_alice"));
  // And the change was applied.
  const row = ws.db().prepare("SELECT pinned FROM pages WHERE id = ?").get("user_alice");
  assert.equal(row.pinned, 1);
});

test("auditor unpins a pinned page with 0 hits past tenure", () => {
  // Pin user_bob, backdate pinned_at, log nothing.
  fs.writeFileSync(fixtureLog, "");
  ws.setPinned("user_bob", true, { editedBy: "test" });
  ws.db()
    .prepare("UPDATE pages SET pinned_at = datetime('now', '-30 days') WHERE id = ?")
    .run("user_bob");
  const r = runAuditor();
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.ok(report.unpin_now.some((p) => p.id === "user_bob"));
  const row = ws.db().prepare("SELECT pinned FROM pages WHERE id = ?").get("user_bob");
  assert.equal(row.pinned, 0);
});

test("auditor skips pin_locked pages from auto-unpin", () => {
  fs.writeFileSync(fixtureLog, "");
  ws.setPinned("feedback_one", true, { editedBy: "test" });
  ws.setPinLocked("feedback_one", true);
  ws.db()
    .prepare("UPDATE pages SET pinned_at = datetime('now', '-30 days') WHERE id = ?")
    .run("feedback_one");
  const r = runAuditor();
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.ok(!report.unpin_now.some((p) => p.id === "feedback_one"));
  assert.ok(report.skipped_locked.some((p) => p.id === "feedback_one"));
  const row = ws.db().prepare("SELECT pinned FROM pages WHERE id = ?").get("feedback_one");
  assert.equal(row.pinned, 1, "locked page must still be pinned");
});

test("auditor leaves recently-pinned (within tenure) pages alone", () => {
  fs.writeFileSync(fixtureLog, "");
  ws.setPinned("feedback_two", true, { editedBy: "test" });
  // pinned_at is now (set by setPinned) — within tenure.
  const r = runAuditor();
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.ok(!report.unpin_now.some((p) => p.id === "feedback_two"));
  assert.ok(report.too_fresh.some((p) => p.id === "feedback_two"));
});

test("auditor --dry-run does not change pinned state", () => {
  fs.writeFileSync(fixtureLog, "");
  ws.setPinned("project_x", false, { editedBy: "test" });
  for (let i = 0; i < 6; i++) {
    ws.logAccess({ tool: "wiki_read", page_ids: ["project_x"], caller: "mcp" });
  }
  const r = runAuditor(["--dry-run", "--pin-threshold", "5"]);
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.ok(report.pin_now.some((p) => p.id === "project_x"));
  const row = ws.db().prepare("SELECT pinned FROM pages WHERE id = ?").get("project_x");
  assert.equal(row.pinned, 0, "dry-run should not apply changes");
});
