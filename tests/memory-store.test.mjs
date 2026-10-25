// memory-store.test.mjs — unit tests for lib/memory-store.js.
// Run: node --test tests/memory-store.test.mjs
//
// Tests run offline: we point the lib at a temp memory dir / temp DB via
// env vars, and swap the embed path for a deterministic toy embedder so
// no Ollama connection is required.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Fixture scaffolding — set BEFORE requiring memory-store ─────────────

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-test-"));
const fixtureMemoryDir = path.join(fixtureDir, "memory");
const fixtureDb = path.join(fixtureDir, "memory-index.db");
const fixtureLog = path.join(fixtureDir, "memory-retrieval.jsonl");
fs.mkdirSync(fixtureMemoryDir, { recursive: true });

process.env.MEMORY_INDEX_DIR = fixtureMemoryDir;
process.env.MEMORY_INDEX_DB = fixtureDb;
process.env.MEMORY_INDEX_LOG = fixtureLog;

// MEMORY.md must be skipped by the indexer.
fs.writeFileSync(path.join(fixtureMemoryDir, "MEMORY.md"), "# index (skip me)\n");

fs.writeFileSync(
  path.join(fixtureMemoryDir, "user_food_prefs.md"),
  `---
name: Food taste
type: user
---
Alex prefers Greek, Japanese, and Mexican food. Likes casual neighborhood spots over fancy ones.
`,
);

fs.writeFileSync(
  path.join(fixtureMemoryDir, "reference_trusted_restaurants.md"),
  `---
name: Trusted restaurants
type: reference
---
Preamble: known-good vetted picks Alex returns to; check here first before cold-searching. This preamble is intentionally long enough (well over eight hundred characters) to force the chunker into heading-aware mode rather than collapsing the whole file into a single chunk. It mentions dining in several neighborhoods and is meant to pad the body so the h2 split actually triggers. We want to ensure the reference_trusted_restaurants fixture has both a preamble chunk and per-city chunks once the heading split kicks in. That way the chunking-at-h2 assertion below is meaningful instead of being a tautology over a small file.

## METRO

Great ramen downtown. Greek on Main Street.

## Lakeview

Taqueria near Lake House. Bakery in the old town.
`,
);

fs.writeFileSync(
  path.join(fixtureMemoryDir, "user_sam.md"),
  `---
name: Sam
type: user
---
Alex's partner. Teaches piano and runs the neighborhood book club.
`,
);

fs.writeFileSync(
  path.join(fixtureMemoryDir, "feedback_email_from_address.md"),
  `---
name: Email from address
type: feedback
---
Default agent-originated email to Alex uses Edva <edva@example.com> via email-send. Exception: when Alex explicitly asks to email a third party, use alexr@example.com via gmail-action.
`,
);

// ── Require the lib (paths now point at fixtures) ───────────────────────

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ms = require(path.resolve("lib/memory-store.js"));

// ── Deterministic toy embedder ──────────────────────────────────────────
//
// Swap the live embedText() with a toy embedding so tests run offline.
// Two design goals:
//   1. Pure function of input text — reproducible across runs.
//   2. Reserve specific slots for a few "concepts" so paraphrase tests
//      (food → eat, email from → from address) produce non-zero cosine
//      between query and target even when they share no literal tokens.

const DIM = ms.EMBED_DIM;

function toyEmbed(text) {
  const t = text.toLowerCase();
  const vec = new Array(DIM).fill(0);
  for (let i = 0; i < t.length; i++) {
    vec[(t.charCodeAt(i) * 31 + i) % DIM] += 0.01;
  }
  const axes = [
    { k: "food", slot: 0 },
    { k: "eat", slot: 0 },
    { k: "cuisine", slot: 0 },
    { k: "restaurant", slot: 1 },
    { k: "dining", slot: 1 },
    { k: "sam", slot: 2 },
    { k: "wife", slot: 2 },
    { k: "spouse", slot: 2 },
    { k: "email", slot: 3 },
    { k: "mail", slot: 3 },
    { k: "send", slot: 3 },
    { k: "address", slot: 3 },
  ];
  for (const { k, slot } of axes) {
    if (t.includes(k)) vec[slot] += 1.5;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

ms.setEmbedFn(async (txt) => toyEmbed(txt));

// ── Tests ───────────────────────────────────────────────────────────────

before(async () => {
  const stats = await ms.reindex({ force: true });
  assert.ok(
    stats.chunks_written >= 4,
    `expected ≥4 chunks, got ${stats.chunks_written}`,
  );
});

after(() => {
  try {
    ms.closeDb();
  } catch {}
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("reindex populates chunks and skips MEMORY.md", () => {
  const s = ms.stats();
  assert.ok(s.chunks >= 4);
  assert.ok(s.files >= 4);
  const rows = ms.listEntries();
  const filenames = new Set(rows.map((r) => r.file));
  assert.ok(!filenames.has("MEMORY.md"), "MEMORY.md must not be indexed");
  assert.ok(filenames.has("user_food_prefs.md"));
  assert.ok(filenames.has("reference_trusted_restaurants.md"));
});

test("larger file is chunked at h2 headings", () => {
  const rows = ms.listEntries({ file: "reference_trusted_restaurants.md" });
  assert.ok(rows.length >= 2, `trusted_restaurants should split into ≥2 chunks, got ${rows.length}`);
  const headings = rows.map((r) => r.heading).filter(Boolean);
  assert.ok(
    headings.includes("METRO") || headings.includes("Lakeview"),
    `expected METRO/Lakeview in headings, got ${headings.join(", ")}`,
  );
});

test("FTS search returns exact-keyword hits", async () => {
  const results = await ms.search("Greek", { mode: "fts", log: false });
  assert.ok(results.length > 0);
  const files = results.map((r) => r.file);
  assert.ok(
    files.includes("user_food_prefs.md") ||
      files.includes("reference_trusted_restaurants.md"),
  );
});

test("semantic search tolerates paraphrase (food → eat)", async () => {
  const results = await ms.search("what does he eat", {
    mode: "semantic",
    log: false,
  });
  assert.ok(results.length > 0);
  const top3 = results.slice(0, 3).map((r) => r.file);
  assert.ok(
    top3.includes("user_food_prefs.md"),
    `expected user_food_prefs.md in top-3 for paraphrase, got ${top3.join(", ")}`,
  );
});

test("hybrid search merges FTS + semantic via RRF", async () => {
  const results = await ms.search("email from", {
    mode: "hybrid",
    log: false,
  });
  assert.ok(results.length > 0);
  assert.equal(results[0].file, "feedback_email_from_address.md");
  assert.ok(typeof results[0].rrf === "number" && results[0].rrf > 0);
});

test("retrieval log appends a JSONL row per logged search", async () => {
  if (fs.existsSync(fixtureLog)) fs.unlinkSync(fixtureLog);
  await ms.search("Sam", { mode: "hybrid", caller: "test" });
  assert.ok(fs.existsSync(fixtureLog));
  const lines = fs.readFileSync(fixtureLog, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.caller, "test");
  assert.equal(row.mode, "hybrid");
  assert.ok(Array.isArray(row.top) && row.top.length > 0);
});

test("reindex removes stale chunks when a file is deleted", async () => {
  fs.writeFileSync(
    path.join(fixtureMemoryDir, "ephemeral_note.md"),
    `---
name: Ephemeral note
type: reference
---
Temporary fact about XJYZ-42 only used in this test.
`,
  );
  await ms.reindex();
  let rows = ms.listEntries({ file: "ephemeral_note.md" });
  assert.equal(rows.length, 1);

  fs.unlinkSync(path.join(fixtureMemoryDir, "ephemeral_note.md"));
  const after = await ms.reindex();
  assert.ok(
    after.chunks_removed >= 1,
    `expected ≥1 stale chunk removed, got ${after.chunks_removed}`,
  );
  rows = ms.listEntries({ file: "ephemeral_note.md" });
  assert.equal(rows.length, 0);
});

test("reindex is idempotent when content hasn't changed", async () => {
  const first = await ms.reindex();
  const second = await ms.reindex();
  assert.equal(second.chunks_written, 0);
  assert.ok(second.chunks_skipped_unchanged >= 4);
  assert.equal(second.chunks_removed, 0);
  assert.equal(first.files_scanned, second.files_scanned);
});

test("sanitizeFtsQuery strips punctuation and builds an OR", () => {
  const q = ms.sanitizeFtsQuery("what's the 'food' taste??");
  assert.ok(q && q.includes(" OR "));
  assert.ok(!/['?]/.test(q));
});

test("cosine is 1 for identical vectors and 0 for orthogonal", () => {
  assert.ok(Math.abs(ms.cosine([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(ms.cosine([1, 0, 0], [0, 1, 0])) < 1e-9);
});
