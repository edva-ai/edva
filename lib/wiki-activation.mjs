// wiki-activation.mjs — ACT-R base-level activation per wiki page.
//
// How likely a memory is to be needed next tracks how often and how recently it
// was needed before (Anderson & Schooler 1991). ACT-R writes that as
//
//   B_i = ln( Σ_k t_k^(−d) ),   d = 0.5
//
// over the ages t_k of every past use of page i. It is the principled form of
// "recency × frequency": many recent uses → high; one use long ago → low; and
// spacing matters (ten uses spread over a month outlast ten uses in an hour).
//
// What counts as a USE — and what does not — is the whole design:
//   counted     the auto-recall judge KEPT the page for a message (a model read
//               it and judged it relevant), and the agent deliberately READ it
//               (wiki_read / episode_get, caller=mcp).
//   not counted a page merely appearing in search results. Learning from hits
//               would make the most-retrieved pages retrieved more — a
//               rich-get-richer loop with nothing checking it.
// The eval harness calls the store directly and never writes these logs, so it
// cannot leak into the prior either.
//
// Used as a weak fourth RRF list in searchPagesHybrid (WIKI_PRIOR=1, weight
// 0.2) that may only REORDER pages the direct retrievers found — a tie-breaker
// between near-identical candidates, never a gate and never a source of new
// candidates.
//
// Petrov (2006) keeps the cost bounded: the k most recent uses are summed
// exactly and the rest by a closed-form tail, so a page used every day for a
// year costs the same as one used ten times.

import path from "node:path";
import os from "node:os";
import { openMemoryDb, readJsonl, AUTO_RECALL_JUDGE_LOG, keptWikiIds, setMeta } from "./memory-db.mjs";

import { installTools } from "./root.cjs";
export const DECAY_D = Number(process.env.WIKI_ACTIVATION_DECAY || 0.5);
const EXACT_K = 10;
// Ages are in days, floored at an hour so a use a second ago is not infinite.
const MIN_AGE_DAYS = 1 / 24;
// Uses older than this are ignored (the term is negligible and the logs large).
const HORIZON_DAYS = 365;
const READ_TOOLS = new Set(["wiki_read", "episode_get"]);

const ACCESS_LOG = () =>
  process.env.WIKI_ACCESS_LOG || installTools("data/wiki-access.jsonl");

export function ensureActivationSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS page_activation (
      page_id     TEXT PRIMARY KEY,
      base_level  REAL NOT NULL,
      n_refs      INTEGER NOT NULL,
      last_ref    TEXT,
      updated_at  TEXT DEFAULT (datetime('now'))
    )
  `);
}

// B from a list of ages in days (any order). Exact for the EXACT_K most recent,
// Petrov's approximation for the rest:
//   (n − k)·(t_n^(1−d) − t_k^(1−d)) / ((1 − d)·(t_n − t_k))
// with t_k the k-th most recent age and t_n the oldest.
export function baseLevel(agesDays, d = DECAY_D) {
  const ages = agesDays
    .map((a) => Math.max(MIN_AGE_DAYS, Number(a)))
    .filter((a) => Number.isFinite(a))
    .sort((x, y) => x - y);
  if (!ages.length) return null;
  const k = Math.min(EXACT_K, ages.length);
  let sum = 0;
  for (let i = 0; i < k; i++) sum += Math.pow(ages[i], -d);
  const n = ages.length;
  if (n > k) {
    const tk = ages[k - 1];
    const tn = ages[n - 1];
    if (tn > tk) sum += ((n - k) * (Math.pow(tn, 1 - d) - Math.pow(tk, 1 - d))) / ((1 - d) * (tn - tk));
    else sum += (n - k) * Math.pow(tk, -d);
  }
  return Math.log(sum);
}

// Collect every counted use per page: Map<id, ts[]>.
export function collectUses({ judgeLog = AUTO_RECALL_JUDGE_LOG(), accessLog = ACCESS_LOG(), now = Date.now() } = {}) {
  const since = now - HORIZON_DAYS * 86400000;
  const uses = new Map();
  const add = (id, ts) => {
    const t = Date.parse(ts);
    if (!id || !Number.isFinite(t) || t < since || t > now) return;
    if (!uses.has(id)) uses.set(id, []);
    uses.get(id).push(t);
  };
  for (const row of readJsonl(judgeLog)) for (const id of keptWikiIds(row)) add(id, row.ts);
  for (const row of readJsonl(accessLog)) {
    if (row.caller !== "mcp" || !READ_TOOLS.has(row.tool)) continue;
    for (const id of row.page_ids || []) add(id, row.ts);
  }
  return uses;
}

// Recompute page_activation from the logs (full rebuild — the logs are the
// source of truth and a rebuild is a few hundred ms). Returns { pages, uses }.
export function updateActivation({ d = openMemoryDb(), now = Date.now(), ...opts } = {}) {
  if (!d) return { error: "no db" };
  ensureActivationSchema(d);
  const uses = collectUses({ now, ...opts });
  const active = new Set(d.prepare("SELECT id FROM pages WHERE status = 'active'").all().map((r) => r.id));
  const ins = d.prepare(
    "INSERT OR REPLACE INTO page_activation(page_id, base_level, n_refs, last_ref, updated_at) VALUES (?, ?, ?, ?, datetime('now'))",
  );
  let pages = 0;
  let total = 0;
  d.exec("BEGIN IMMEDIATE");
  try {
    d.exec("DELETE FROM page_activation");
    for (const [id, ts] of uses) {
      if (!active.has(id)) continue;
      const b = baseLevel(ts.map((t) => (now - t) / 86400000));
      if (b == null) continue;
      ins.run(id, b, ts.length, new Date(Math.max(...ts)).toISOString());
      pages++;
      total += ts.length;
    }
    setMeta(d, "activation.updated_at", new Date(now).toISOString());
    d.exec("COMMIT");
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch {}
    return { error: e.message };
  }
  return { pages, uses: total };
}

export function topActivation({ d = openMemoryDb(), limit = 20 } = {}) {
  if (!d) return [];
  ensureActivationSchema(d);
  return d
    .prepare("SELECT page_id, base_level, n_refs, last_ref FROM page_activation ORDER BY base_level DESC LIMIT ?")
    .all(limit);
}
