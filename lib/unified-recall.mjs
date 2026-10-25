// unified-recall.mjs — one recall across short-term chat + long-term wiki (+events).
//
// The problem it closes: recall was fragmented. "What did I say about X" lived
// in three unconnected places — recent chat (edva_messages pgvector, via
// chat-recall), curated pages (wiki hybrid), and the activity log (events_fts).
// A consumer had to know which to ask, so things the user *just typed* were
// routinely missed (hum re-asking a settled question, the agent not seeing an
// answer from this morning). This fuses them into ONE ranked answer.
//
// Mechanism: embed the query ONCE locally (Ollama), fan it out to each source's
// own recall (each already tuned — chat = cosine RPC, wiki = BM25+KNN hybrid,
// events = BM25+KNN hybrid), then fuse the ranked lists with Reciprocal Rank
// Fusion (the same `hybrid-recall.mjs` primitive the wiki/event paths use).
// RRF is rank-based, so it fuses incomparable score scales (cosine vs BM25)
// correctly and needs no normalization. Every source is fail-soft: a source
// that errors contributes an empty list, so unified recall degrades to whatever
// is reachable rather than throwing.

import { localLlmEmbedCached } from "./local-llm.mjs";
import { rrfFuse } from "./hybrid-recall.mjs";
import { searchChat } from "./chat-recall.mjs";
import { searchPagesHybrid } from "./wiki-embed.mjs";
import { searchEventsHybrid } from "./event-fts.mjs";
import { searchUtterances } from "./utterance-store.mjs";
import { searchInboxHybrid } from "./inbox-mem.mjs";
import { wikiQuantity, inboxQuantity, preferQuantity } from "./money-quantity.mjs";

// recall(query, opts) → { query, sources, results: [{ source, id, title,
// snippet, score, rrf, ... }] }. `results` is the fused, best-first list.
//
// opts:
//   k             max fused results (default 10)
//   chat          include recent chat (default true)
//   wiki          include wiki pages (default true)
//   replies       include the user's dated replies to pings (default true)
//   events        include the activity log (default false — noisier, opt-in)
//   inbox         include indexed mail (default true — the inbox as a memory
//                 channel; kept on by default because a resolution that arrived
//                 by email is exactly what consumers keep missing)
//   chatSinceDays bound chat recall to the last N days (default 21; short-term)
//   chatRole      which chat role to recall (default "user" — what the user said)
//   wikiMatch     FTS term boolean for the wiki half ("auto" default —
//                 AND then topped up from OR | "and" | "or").
//                 Pass "or" when the query is a whole sentence — see
//                 wiki-store.searchPages.
//   sourceTimeoutMs  per-source deadline (default 600). See below.
//   embedTimeoutMs   deadline on the one query embed (default 1500).
//   quantity      a money quantity type (or array) the caller is asking for —
//                 see lib/money-quantity.mjs. Rows tagged with it rank
//                 first, untagged rows follow, rows tagged ONLY with a different
//                 quantity are dropped. Every wiki/inbox row carries its own
//                 `quantity` tag (or null) whether or not this is passed.

// Resolve `fallback` if `p` has not settled within `ms`. Every source is
// ALREADY fail-soft — an erroring source contributes [] and RRF just fuses the
// lists that arrived — so a source that is merely SLOW can be treated exactly
// like one that failed. Without this, `Promise.all` means the whole recall runs
// at the speed of its slowest member, and today exactly one member (chat) is a
// WAN round trip to Supabase while everything else is local SQLite.
//
// The loser keeps running; we simply stop waiting for it. Nothing downstream
// holds a reference to it, so it is collected once it settles.
function withDeadline(p, ms, fallback) {
  if (!(ms > 0)) return p;
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

export async function recall(
  query,
  { k = 10, chat = true, wiki = true, replies = true, events = false, inbox = true, chatSinceDays = 21, chatRole = "user", wikiMatch = "auto", sourceTimeoutMs = 600, embedTimeoutMs = 1500, quantity = null } = {},
) {
  const q = String(query || "").trim();
  if (!q) return { query: q, sources: [], results: [] };

  // Embed once; reuse for every source. If Ollama is down, qVec stays null and
  // each source degrades on its own terms (chat → [], wiki/events → pure FTS).
  // Cached, because the same query text recurs constantly (hum re-checks the
  // same subjects every tick). Deadlined too: this one is serial in front of
  // every source, so a stalled Ollama would otherwise stall all of recall —
  // and degrading to pure FTS is strictly better than degrading to nothing.
  let qVec = null;
  try {
    qVec = await withDeadline(localLlmEmbedCached(q), embedTimeoutMs, null);
  } catch {
    qVec = null;
  }
  const embedQuery = qVec ? () => qVec : null;
  const cand = Math.max(k, 10); // pull a wider candidate set per source before fusing

  const jobs = [];
  const sources = [];
  if (chat) {
    sources.push("chat");
    jobs.push(
      searchChat(q, { k: cand, role: chatRole, sinceDays: chatSinceDays, queryVec: qVec })
        .then((rows) =>
          rows.map((r) => ({
            source: "chat",
            id: r.id,
            key: `chat:${r.id}`,
            title: null,
            // lang-regex-ok: collapses whitespace for display; does not interpret meaning
            snippet: String(r.content || "").replace(/\s+/g, " ").slice(0, 240),
            created_at: r.created_at,
            score: r.similarity ?? null,
          })),
        )
        .catch(() => []),
    );
  }
  if (wiki) {
    sources.push("wiki");
    jobs.push(
      searchPagesHybrid(q, { limit: cand, embedQuery, match: wikiMatch })
        .then((rows) =>
          rows.map((r) => ({
            source: "wiki",
            id: r.id,
            key: `wiki:${r.id}`,
            title: r.title || r.id,
            snippet: String(r.snippet || r.description || "").replace(/\s+/g, " ").slice(0, 240),
            type: r.type,
            pinned: r.pinned,
            via: r.via,
            // Carry BOTH relevance signals through. They were dropped here,
            // which left every downstream consumer unable to tell a strong hit
            // from the tail of a top-k that always returns k rows — the reason
            // auto-recall injects loosely-related pages into every message and
            // could not be given a floor. Scales differ; see wiki-embed.mjs.
            score: r.score ?? null,
            cosine: r.cosine ?? null,
            matched: r.matched ?? null,
            // Which kind of money this page states, if any (explicit tag).
            quantity: wikiQuantity(r.id),
          })),
        )
        .catch(() => []),
    );
  }
  if (inbox) {
    // The mailbox, as memory (memory is updated from multiple channels,
    // the inbox included). Before this, recall
    // could not answer "what has the inbox told us about X?" at all, so
    // consumers that needed it — the release gate above all — went around
    // memory and point-queried Gmail with model-authored keywords. That is
    // how several emails saying "Your order is on its way" stay invisible
    // to a search for "shipped". Fused here, the semantic half answers the
    // question in the ASKER's words rather than the sender's.
    sources.push("inbox");
    jobs.push(
      searchInboxHybrid(q, { limit: cand, embedQuery })
        .then((rows) =>
          rows.map((r) => ({
            source: "inbox",
            id: r.msg_id,
            key: `inbox:${r.msg_id}`,
            title: r.subject || null,
            snippet: [r.sender, r.snippet].filter(Boolean).join(" — ").replace(/\s+/g, " ").slice(0, 240),
            created_at: r.ts,
            thread_id: r.thread_id,
            score: r.score ?? null,
            quantity: inboxQuantity({ sender: r.sender, subject: r.subject }),
          })),
        )
        .catch(() => []),
    );
  }
  if (replies) {
    // The user's own dated words in reply to a ping. Local + synchronous (small
    // corpus, lexical), so this source still answers when Ollama or Supabase
    // is down — deliberate: it is the last line of defense against re-asking
    // something the user already answered. Wrapped in Promise.resolve so it joins
    // the same fan-out.
    sources.push("replies");
    jobs.push(
      Promise.resolve()
        .then(() =>
          searchUtterances(q, { k: cand }).map((u) => ({
            source: "replies",
            id: u.id,
            key: `reply:${u.id}`,
            title: u.subject || null,
            // `rendered` carries the date + attribution inline so a fused
            // snippet can never be mistaken for Edva's own note.
            snippet: u.rendered,
            created_at: u.ts,
            disposition: u.disposition,
            score: u.score ?? null,
          })),
        )
        .catch(() => []),
    );
  }
  if (events) {
    sources.push("events");
    jobs.push(
      searchEventsHybrid(q, { limit: cand, embedQuery })
        .then((rows) =>
          rows.map((r) => ({
            source: "events",
            id: r.dispatch_id || r.ts,
            key: `event:${r.dispatch_id || r.ts}`,
            title: r.kind || null,
            snippet: String(r.snippet || "").replace(/\s+/g, " ").slice(0, 240),
            ts: r.ts,
            agent: r.agent,
          })),
        )
        .catch(() => []),
    );
  }

  // Deadline each source independently rather than the fan-out as a whole, so
  // one slow source drops out instead of truncating the others' results.
  let lists = await Promise.all(jobs.map((j) => withDeadline(j, sourceTimeoutMs, [])));
  // A caller asking for one money quantity: reorder/drop within each source
  // BEFORE fusion, so a mismatched row cannot take a fused slot.
  if (quantity) lists = lists.map((l) => preferQuantity(l, quantity));
  // Index every item by its namespaced key for display after fusion.
  const byKey = new Map();
  for (const list of lists) for (const item of list) byKey.set(item.key, item);
  // Sources have disjoint key spaces, so RRF here interleaves the per-source
  // rankings by position — the natural "most relevant across everything" merge.
  const fused = rrfFuse(lists, (r) => r.key, { limit: k });
  return {
    query: q,
    sources,
    results: fused.map((f) => ({ ...(byKey.get(f.key) || f.item || {}), rrf: f.rrf })),
  };
}
