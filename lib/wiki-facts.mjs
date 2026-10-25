// wiki-facts.mjs — typed fact edges with validity, extracted from wiki pages.
//
// A `[[wikilink]]` says two pages are connected; it does not say HOW. "What does
// <person>'s husband like" needs the edge to say `spouse_of`; "where does <person>
// work now" needs the edge to know it replaced an older one. This is Graphiti's
// fact-edge schema (Zep, arXiv 2501.13956) brought onto the wiki's own SQLite,
// minus Graphiti's per-write extraction: facts are extracted in a nightly batch,
// per page, only when the page changed.
//
// `page_facts` — one row per fact:
//   src_id → rel → dst_id   subject page, a relation from REL_VOCAB, and the
//                           object page (NULL for a fact with no page object:
//                           "allergic to shellfish")
//   fact_text               the fact as one sentence — a searchable entry point
//                           into its subject page (it joins the KNN matrix the
//                           way a cue anchor does)
//   evidence                the verbatim quote from the page it came from. The
//                           extraction is rejected without one (model-ladder.mjs
//                           § grounding): a fact with nothing to quote was
//                           invented.
//   source_page/source_hash which page said it, and that page's body_hash then
//   valid_at / invalid_at   EVENT time, when the page states it ("since 2024",
//                           "until March"); NULL when it doesn't
//   created_at / expired_at SYSTEM time: when Edva learned it, and when it
//                           stopped asserting it — because the source page no
//                           longer says it, or because a newer fact for a
//                           one-valued relation (works_at, lives_in, spouse_of,
//                           partner_of) replaced it (`superseded_by`). Nothing is
//                           ever deleted: "where did they work in 2024" keeps its
//                           answer. Which rows are current: CURRENT_FACT_SQL.
//
// Readers: the association graph (a fact with an object page is a typed edge,
// `via: "fact:<rel>"`), the KNN matrix in wiki-embed.mjs (the fact sentence is
// an entry point into its subject), and wiki_read (the page's current facts).
//
// Extraction runs the Rule #0b ladder (local → Sonnet on validation failure),
// both rungs Edva's own models, so health and finance pages are in scope.

import { createRequire } from "node:module";
import { openMemoryDb } from "./memory-db.mjs";
import { CURRENT_FACT_SQL } from "./wiki-assoc.mjs";
import { packF32 } from "./hybrid-recall.mjs";
import { runLadder, quoteIn } from "./model-ladder.mjs";

// Relations a fact may use. Small on purpose: a relation nobody queries by is
// just a worse wikilink. `related_to` is the honest fallback.
export const REL_VOCAB = Object.freeze([
  // people
  "spouse_of", "partner_of", "parent_of", "child_of", "sibling_of", "relative_of",
  "friend_of", "works_with", "works_at", "lives_in",
  // tastes and constraints
  "likes", "dislikes", "prefers", "avoids",
  // things, places, responsibilities
  "owns", "member_of", "part_of", "located_in", "handles", "involves", "related_to",
]);
// One current object per subject: a new one supersedes the old.
export const FUNCTIONAL_RELS = new Set(["works_at", "lives_in", "spouse_of", "partner_of"]);
// Relations whose inverse is the same relation — stored once, read both ways by
// the graph anyway, listed so the extractor is told not to emit both.
const SYMMETRIC_RELS = new Set(["spouse_of", "partner_of", "sibling_of", "relative_of", "friend_of", "works_with"]);

export const DEFAULT_FACT_TYPES = ["user", "project", "feedback"];
const MAX_FACTS_PER_PAGE = 15;
const BODY_CHARS = 4500;
const MAX_LINKED_IN_PROMPT = 60;
// lang-regex-ok: validates a model-emitted ISO date field (structure)
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function ensureFactsSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS page_facts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      src_id        TEXT NOT NULL,
      rel           TEXT NOT NULL,
      dst_id        TEXT,
      fact_text     TEXT NOT NULL,
      evidence      TEXT NOT NULL,
      source_page   TEXT NOT NULL,
      source_hash   TEXT NOT NULL,
      valid_at      TEXT,
      invalid_at    TEXT,
      expired_at    TEXT,
      superseded_by INTEGER,
      model         TEXT,
      rung          TEXT,
      dim           INTEGER,
      embedding     BLOB,
      created_at    TEXT DEFAULT (datetime('now'))
    )
  `);
  d.exec("CREATE INDEX IF NOT EXISTS idx_page_facts_src ON page_facts(src_id)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_page_facts_dst ON page_facts(dst_id)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_page_facts_source ON page_facts(source_page)");
  // Which body each page was last extracted from — the freshness marker, kept
  // apart from page_facts so a page that yields no facts is still "done".
  d.exec(`
    CREATE TABLE IF NOT EXISTS page_fact_runs (
      page_id   TEXT PRIMARY KEY,
      body_hash TEXT NOT NULL,
      n_facts   INTEGER NOT NULL,
      rung      TEXT,
      ran_at    TEXT DEFAULT (datetime('now'))
    )
  `);
}

// The ids a fact on `row` may name: the page itself plus every active page it
// links to or is linked from — the model can only connect what the graph
// already knows exists, which is what keeps a fact edge from dangling.
// The wiki's owner is the other party to most relations a page states ("<name>,
// the owner's colleague") whether or not the page links the owner, so the owner's page is always
// a known id. Without it, facts on a page about someone close to the owner come
// back as "unknown object <owner page>" and are rejected.
// The owner page id comes from WIKI_OWNER_PAGE, else agent/local/config/wiki.json
// `owner_page`, else "user_owner".
const OWNER_PAGE = process.env.WIKI_OWNER_PAGE
  || createRequire(import.meta.url)("./instance.cjs").localConfig("wiki", { owner_page: "user_owner" }).owner_page;

function knownNeighbours(d, row) {
  const owner = row.id === OWNER_PAGE ? null : d.prepare("SELECT id, title FROM pages WHERE id = ? AND status = 'active'").get(OWNER_PAGE);
  const linked = d
    .prepare(
      `SELECT DISTINCT p.id, p.title FROM page_links l JOIN pages p ON p.id = l.dst_id
        WHERE l.src_id = ? AND p.status = 'active'
       UNION
       SELECT DISTINCT p.id, p.title FROM page_links l JOIN pages p ON p.id = l.src_id
        WHERE l.dst_id = ? AND p.status = 'active'`,
    )
    .all(row.id, row.id)
    .filter((r) => r.id !== OWNER_PAGE);
  return [...(owner ? [owner] : []), ...linked].slice(0, MAX_LINKED_IN_PROMPT);
}

export function factPrompt(row, neighbours) {
  const known = [`${row.id} — ${row.title || row.id} (THIS PAGE)`, ...neighbours.map((n) => `${n.id} — ${n.title || n.id}`)];
  return `You are extracting typed facts from one page of someone's personal memory, to build a knowledge graph.

Return the facts the page states about how its subject relates to other people, places, things and preferences.

Rules:
- "subject" and "object" must be ids from KNOWN PAGES below. Use "object": null when the fact has no page to point at (e.g. a food allergy).
- "rel" must be one of: ${REL_VOCAB.join(", ")}. Use related_to only when nothing else fits.
- For ${[...SYMMETRIC_RELS].join(", ")} emit ONE direction only.
- "fact": one plain sentence stating it, using names not ids.
- "evidence": copy the exact words from the page that state it (at least 3 words). Never paraphrase.
- "valid_at" / "invalid_at": YYYY-MM-DD only when the page says when it started / ended; otherwise null.
- Only facts the page actually states. Never infer, never guess, never add outside knowledge. An empty list is a fine answer.
- At most ${MAX_FACTS_PER_PAGE} facts.

Return ONLY this JSON:
{"facts": [{"subject": "...", "rel": "...", "object": "..." , "fact": "...", "evidence": "...", "valid_at": null, "invalid_at": null}]}

KNOWN PAGES:
${known.join("\n")}

PAGE ${row.id}
TITLE: ${row.title || row.id}
DESCRIPTION: ${row.description || "(none)"}
BODY:
${String(row.body_md || "").slice(0, BODY_CHARS)}`;
}

// Split a model reply into valid facts and rejection reasons. Exported for
// tests. `source` is what evidence must be quoted from.
export function checkFacts(parsed, { allowed, source }) {
  const good = [];
  const bad = [];
  if (!parsed || !Array.isArray(parsed.facts)) return { good, bad: ["facts is not an array"] };
  for (const f of parsed.facts.slice(0, MAX_FACTS_PER_PAGE * 2)) {
    const why = (() => {
      if (!f || typeof f !== "object") return "not an object";
      if (!allowed.has(f.subject)) return `unknown subject ${f.subject}`;
      if (!REL_VOCAB.includes(f.rel)) return `unknown rel ${f.rel}`;
      if (f.object != null && !allowed.has(f.object)) return `unknown object ${f.object}`;
      if (f.object != null && f.object === f.subject) return "object equals subject";
      if (typeof f.fact !== "string" || f.fact.trim().length < 8 || f.fact.length > 240) return "bad fact text";
      if (!quoteIn(f.evidence, source)) return `evidence not found in page: "${String(f.evidence || "").slice(0, 60)}"`;
      for (const k of ["valid_at", "invalid_at"]) {
        if (f[k] != null && !(typeof f[k] === "string" && ISO_DATE_RE.test(f[k]))) return `bad ${k}`;
      }
      return null;
    })();
    if (why) bad.push(why);
    else good.push({
      subject: f.subject, rel: f.rel, object: f.object ?? null, fact: f.fact.trim(),
      evidence: String(f.evidence).trim(), valid_at: f.valid_at ?? null, invalid_at: f.invalid_at ?? null,
    });
  }
  return { good: good.slice(0, MAX_FACTS_PER_PAGE), bad };
}

// A reply is usable when it is the right shape and at least as many of its facts
// pass as fail. An empty list is usable (most pages state no relations). More
// failures than passes means the rung was making things up, so the ladder climbs.
export function validateFactReply(parsed, ctx) {
  const { good, bad } = checkFacts(parsed, ctx);
  if (!parsed || !Array.isArray(parsed.facts)) return "facts is not an array";
  if (bad.length > good.length) return `${bad.length} of ${bad.length + good.length} facts failed: ${bad[0]}`;
  return null;
}

const factKey = (f) =>
  [f.src_id ?? f.subject, f.rel, f.dst_id ?? f.object ?? "", String(f.fact_text ?? f.fact).trim().toLowerCase()].join("\u0001");

// Write one page's extraction: keep facts it still asserts, add new ones,
// expire the ones it no longer asserts, and let a new one-valued fact
// supersede the old one from ANY page. One transaction.
export function writePageFacts(d, row, facts, { rung = null, model = null, now = new Date() } = {}) {
  ensureFactsSchema(d);
  const nowIso = now.toISOString();
  const current = d
    .prepare(`SELECT * FROM page_facts f WHERE f.source_page = ? AND f.expired_at IS NULL`)
    .all(row.id);
  const currentByKey = new Map(current.map((f) => [factKey(f), f]));
  const incomingKeys = new Set();
  const ins = d.prepare(
    `INSERT INTO page_facts(src_id, rel, dst_id, fact_text, evidence, source_page, source_hash,
                            valid_at, invalid_at, model, rung, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const expire = d.prepare("UPDATE page_facts SET expired_at = ? WHERE id = ?");
  const supersede = d.prepare("UPDATE page_facts SET expired_at = ?, superseded_by = ? WHERE id = ?");
  let added = 0, kept = 0, expired = 0, superseded = 0;
  d.exec("BEGIN IMMEDIATE");
  try {
    for (const f of facts) {
      const key = factKey(f);
      incomingKeys.add(key);
      if (currentByKey.has(key)) { kept++; continue; }
      const res = ins.run(f.subject, f.rel, f.object, f.fact, f.evidence, row.id, row.body_hash,
        f.valid_at, f.invalid_at, model, rung, nowIso);
      added++;
      const newId = Number(res.lastInsertRowid);
      if (FUNCTIONAL_RELS.has(f.rel) && f.object) {
        for (const old of d
          .prepare(`SELECT id, dst_id FROM page_facts f WHERE f.src_id = ? AND f.rel = ? AND f.id <> ? AND f.expired_at IS NULL`)
          .all(f.subject, f.rel, newId)) {
          if (old.dst_id === f.object) continue;
          supersede.run(nowIso, newId, old.id);
          superseded++;
        }
      }
    }
    for (const [key, f] of currentByKey) {
      if (incomingKeys.has(key)) continue;
      expire.run(nowIso, f.id);
      expired++;
    }
    d.prepare(
      "INSERT OR REPLACE INTO page_fact_runs(page_id, body_hash, n_facts, rung, ran_at) VALUES (?, ?, ?, ?, ?)",
    ).run(row.id, row.body_hash, facts.length, rung, nowIso);
    d.exec("COMMIT");
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch {}
    throw e;
  }
  return { added, kept, expired, superseded };
}

// Pages whose current body has not been extracted yet.
export function pendingFactPages(d, { types = DEFAULT_FACT_TYPES, limit = 40 } = {}) {
  ensureFactsSchema(d);
  const ph = types.map(() => "?").join(",");
  return d
    .prepare(
      `SELECT p.id, p.type, p.title, p.description, p.body_md, p.body_hash
         FROM pages p LEFT JOIN page_fact_runs r ON r.page_id = p.id
        WHERE p.status = 'active' AND p.type IN (${ph})
          AND (r.page_id IS NULL OR r.body_hash <> p.body_hash)
        ORDER BY p.updated_at DESC LIMIT ?`,
    )
    .all(...types, limit);
}

// Nightly pass: extract pending pages through the ladder, write, then embed any
// fact sentence still missing a vector. Returns a summary. A page whose ladder
// produced nothing usable is NOT marked done, so it is retried next night.
export async function extractPendingFacts({
  d = openMemoryDb(),
  rungs = [],
  embedFn = null,
  types = DEFAULT_FACT_TYPES,
  limit = 40,
  sonnetBudget = 30,
  dryRun = false,
} = {}) {
  if (!d) return { error: "no db" };
  ensureFactsSchema(d);
  const pages = pendingFactPages(d, { types, limit });
  const budget = { sonnet: sonnetBudget };
  const out = { pages: pages.length, extracted: 0, failed: 0, added: 0, kept: 0, expired: 0, superseded: 0, by_rung: {}, errors: [] };
  for (const row of pages) {
    const neighbours = knownNeighbours(d, row);
    const allowed = new Set([row.id, ...neighbours.map((n) => n.id)]);
    const source = [row.title, row.description, row.body_md].filter(Boolean).join("\n");
    const ctx = { allowed, source };
    const res = await runLadder(factPrompt(row, neighbours), {
      rungs,
      budget,
      validate: (parsed) => validateFactReply(parsed, ctx),
    });
    if (!res.value) {
      out.failed++;
      out.errors.push(`${row.id}: ${res.errors.slice(-1)[0] || "no rung answered"}`);
      continue;
    }
    const { good } = checkFacts(res.value, ctx);
    out.extracted++;
    out.by_rung[res.rung] = (out.by_rung[res.rung] || 0) + 1;
    if (dryRun) { out.added += good.length; continue; }
    const w = writePageFacts(d, row, good, { rung: res.rung });
    out.added += w.added; out.kept += w.kept; out.expired += w.expired; out.superseded += w.superseded;
  }
  if (!dryRun && typeof embedFn === "function") Object.assign(out, await embedPendingFacts({ d, embedFn }));
  return out;
}

// Give every current fact without a vector one. Separate from extraction so an
// Ollama outage during extraction loses nothing — the next pass embeds.
export async function embedPendingFacts({ d = openMemoryDb(), embedFn, limit = 500 } = {}) {
  if (!d || typeof embedFn !== "function") return { embedded_facts: 0 };
  ensureFactsSchema(d);
  const rows = d
    .prepare(`SELECT f.id, f.fact_text FROM page_facts f WHERE f.embedding IS NULL AND ${CURRENT_FACT_SQL} LIMIT ?`)
    .all(limit);
  const up = d.prepare("UPDATE page_facts SET embedding = ?, dim = ? WHERE id = ?");
  let n = 0, fails = 0;
  for (const r of rows) {
    try {
      const v = await embedFn(r.fact_text);
      if (Array.isArray(v) && v.length) { up.run(packF32(v), v.length, r.id); n++; fails = 0; }
    } catch {
      if (++fails >= 3) break; // embedder down — the next pass picks these up
    }
  }
  return { embedded_facts: n, facts_missing_vectors: Math.max(0, rows.length - n) };
}

// Current facts touching a page, either end. For wiki_read and the CLI.
export function factsForPage(id, { d = openMemoryDb(), includeExpired = false } = {}) {
  if (!d) return [];
  try {
    ensureFactsSchema(d);
    return d
      .prepare(
        `SELECT f.id, f.src_id, f.rel, f.dst_id, f.fact_text, f.evidence, f.source_page,
                f.valid_at, f.invalid_at, f.created_at, f.expired_at, f.superseded_by
           FROM page_facts f
          WHERE (f.src_id = ? OR f.dst_id = ?) ${includeExpired ? "" : `AND ${CURRENT_FACT_SQL}`}
          ORDER BY f.expired_at IS NOT NULL, f.rel, f.id`,
      )
      .all(id, id);
  } catch {
    return [];
  }
}

export function factStats({ d = openMemoryDb() } = {}) {
  if (!d) return { available: false };
  ensureFactsSchema(d);
  const one = (sql) => d.prepare(sql).get().n;
  return {
    available: true,
    facts: one("SELECT COUNT(*) AS n FROM page_facts"),
    current: one(`SELECT COUNT(*) AS n FROM page_facts f WHERE ${CURRENT_FACT_SQL}`),
    with_object: one(`SELECT COUNT(*) AS n FROM page_facts f WHERE f.dst_id IS NOT NULL AND ${CURRENT_FACT_SQL}`),
    superseded: one("SELECT COUNT(*) AS n FROM page_facts WHERE superseded_by IS NOT NULL"),
    pages_extracted: one("SELECT COUNT(*) AS n FROM page_fact_runs"),
    missing_vectors: one(`SELECT COUNT(*) AS n FROM page_facts f WHERE f.embedding IS NULL AND ${CURRENT_FACT_SQL}`),
    by_rel: Object.fromEntries(
      d.prepare(`SELECT f.rel, COUNT(*) AS n FROM page_facts f WHERE ${CURRENT_FACT_SQL} GROUP BY f.rel ORDER BY n DESC`)
        .all().map((r) => [r.rel, r.n]),
    ),
  };
}
