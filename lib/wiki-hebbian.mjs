// wiki-hebbian.mjs — "pages that fire together wire together".
//
// Every chat message that reaches auto-recall gets a Sonnet judge that reads the
// recalled candidates and keeps the ones relevant to what the user said
// (lib/auto-recall.mjs, logged to data/auto-recall-judge.jsonl). Two
// wiki pages KEPT for the same message were useful together — the cleanest
// co-activation signal Edva has, and it was already being written.
//
// This turns it into a weight per page pair (`page_coactivation`):
//   w ← w·λ^Δdays + η      each time the pair is kept together
// with λ = HEBB_DAILY_DECAY (0.985/day, a ~46-day half-life) and η = 0.1, so a
// pair kept together ten times in a month sits near 1 and one kept once fades
// out over a couple of months. (HeLa-Mem, ACL 2026, uses the same shape:
// Δw = η·x_i·x_j with adaptive forgetting.)
//
// The weight is used in two places:
//   - wiki-assoc.mjs reads it into the association graph: it multiplies an
//     existing edge by (1 + h) and adds a weak `hebbian` edge where pages with
//     no link keep being used together.
//   - `linkCandidates` lists the strong pairs with NO link, for the weekly
//     wiki-link-weave job to read and decide on. The counts propose; the job's
//     model reads both pages and disposes. A co-occurrence is not a relation.
//
// Learns ONLY from judge-kept pages — see memory-db.keptWikiIds for why raw
// retrieval hits would be a feedback loop.

import { decayedHebbian } from "./wiki-assoc.mjs";
import { openMemoryDb, getMeta, setMeta, readJsonl, AUTO_RECALL_JUDGE_LOG, keptWikiIds } from "./memory-db.mjs";

export const HEBB_ETA = Number(process.env.WIKI_HEBB_ETA || 0.1);
// A judge row keeping more pages than this is a broad message ("tell me about
// the trip"), and pairing every one with every other would wire up noise.
const MAX_KEPT_PER_ROW = 6;
// Stored weights stop growing here; the graph clamps to 1 anyway, and an
// uncapped weight would take months to decay back after a burst.
const W_CAP = 2;
// Pairs that have decayed below this are deleted.
const PRUNE_BELOW = 0.01;

export function ensureHebbianSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS page_coactivation (
      a        TEXT NOT NULL,
      b        TEXT NOT NULL,
      w        REAL NOT NULL,
      n        INTEGER NOT NULL DEFAULT 0,
      last_ts  TEXT NOT NULL,
      PRIMARY KEY (a, b)
    )
  `);
}

const pairKey = (x, y) => (x < y ? [x, y] : [y, x]);

// Fold judge rows newer than the stored cursor into page_coactivation. Returns
// { rows_read, rows_used, pairs_updated, pruned, cursor }. Idempotent: the
// cursor (assoc_meta 'hebbian.cursor') is the last ts folded in.
export function updateCoactivation({ d = openMemoryDb(), file = AUTO_RECALL_JUDGE_LOG(), now = Date.now(), dryRun = false } = {}) {
  if (!d) return { error: "no db" };
  ensureHebbianSchema(d);
  const cursor = getMeta(d, "hebbian.cursor", "");
  const active = new Set(d.prepare("SELECT id FROM pages WHERE status = 'active'").all().map((r) => r.id));
  const rows = readJsonl(file)
    .filter((r) => typeof r.ts === "string" && r.ts > cursor)
    .sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));

  const get = d.prepare("SELECT w, n, last_ts FROM page_coactivation WHERE a = ? AND b = ?");
  const put = d.prepare("INSERT OR REPLACE INTO page_coactivation(a, b, w, n, last_ts) VALUES (?, ?, ?, ?, ?)");
  let used = 0;
  let pairs = 0;
  let last = cursor;
  if (!dryRun) d.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      last = row.ts;
      // Breadth is judged on everything the judge kept, before dropping pages
      // that have since been deleted — a broad message stays broad.
      const kept = keptWikiIds(row);
      if (kept.length > MAX_KEPT_PER_ROW) continue;
      const ids = kept.filter((id) => active.has(id));
      if (ids.length < 2) continue;
      used++;
      const t = Date.parse(row.ts);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const [a, b] = pairKey(ids[i], ids[j]);
          const cur = get.get(a, b);
          const w = Math.min(W_CAP, (cur ? decayedHebbian(cur.w, cur.last_ts, t) : 0) + HEBB_ETA);
          if (!dryRun) put.run(a, b, w, (cur?.n || 0) + 1, row.ts);
          pairs++;
        }
      }
    }
    let pruned = 0;
    if (!dryRun) {
      // Decay is applied lazily (reader-side, from last_ts), so pruning is the
      // only place "now" matters to storage.
      for (const r of d.prepare("SELECT a, b, w, last_ts FROM page_coactivation").all()) {
        if (decayedHebbian(r.w, r.last_ts, now) < PRUNE_BELOW || !active.has(r.a) || !active.has(r.b)) {
          d.prepare("DELETE FROM page_coactivation WHERE a = ? AND b = ?").run(r.a, r.b);
          pruned++;
        }
      }
      if (last) setMeta(d, "hebbian.cursor", last);
      d.exec("COMMIT");
    }
    return { rows_read: rows.length, rows_used: used, pairs_updated: pairs, pruned, cursor: last };
  } catch (e) {
    if (!dryRun) try { d.exec("ROLLBACK"); } catch {}
    return { error: e.message };
  }
}

// Strong co-activation pairs with no page_links edge in either direction —
// what wiki-link-weave reads. Each carries both titles so the job can judge
// without a lookup, and how often/recently they were used together.
export function linkCandidates({ d = openMemoryDb(), min = 0.3, limit = 40, now = Date.now() } = {}) {
  if (!d) return [];
  ensureHebbianSchema(d);
  const linked = d.prepare(
    "SELECT 1 FROM page_links WHERE (src_id = ? AND dst_id = ?) OR (src_id = ? AND dst_id = ?) LIMIT 1",
  );
  const title = d.prepare("SELECT title, type FROM pages WHERE id = ? AND status = 'active'");
  const out = [];
  for (const r of d.prepare("SELECT a, b, w, n, last_ts FROM page_coactivation").all()) {
    const w = decayedHebbian(r.w, r.last_ts, now);
    if (w < min || linked.get(r.a, r.b, r.b, r.a)) continue;
    const ta = title.get(r.a);
    const tb = title.get(r.b);
    if (!ta || !tb) continue;
    out.push({ a: r.a, a_title: ta.title, a_type: ta.type, b: r.b, b_title: tb.title, b_type: tb.type,
      weight: Number(w.toFixed(3)), times_used_together: r.n, last_used_together: r.last_ts });
  }
  out.sort((x, y) => y.weight - x.weight);
  return out.slice(0, limit);
}

// The pages most often used together with `id`, decayed to now.
export function partnersOf(id, { d = openMemoryDb(), limit = 15, now = Date.now() } = {}) {
  if (!d) return [];
  ensureHebbianSchema(d);
  return d
    .prepare("SELECT a, b, w, n, last_ts FROM page_coactivation WHERE a = ? OR b = ?")
    .all(id, id)
    .map((r) => ({ id: r.a === id ? r.b : r.a, weight: decayedHebbian(r.w, r.last_ts, now), n: r.n, last_ts: r.last_ts }))
    .sort((x, y) => y.weight - x.weight)
    .slice(0, limit);
}

export function hebbianStats({ d = openMemoryDb(), now = Date.now() } = {}) {
  if (!d) return { available: false };
  ensureHebbianSchema(d);
  const rows = d.prepare("SELECT w, last_ts FROM page_coactivation").all();
  const ws = rows.map((r) => decayedHebbian(r.w, r.last_ts, now));
  return {
    available: true,
    pairs: rows.length,
    strong_pairs: ws.filter((w) => w >= 0.3).length,
    max_weight: ws.length ? Number(Math.max(...ws).toFixed(3)) : 0,
    cursor: getMeta(d, "hebbian.cursor", null),
  };
}
