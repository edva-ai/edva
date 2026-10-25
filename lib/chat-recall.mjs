// chat-recall.mjs — recall over the recent chat conversation (edva_messages).
//
// Short-term memory. The chat transcript already has a live semantic index:
// `bin/embed-messages` (cron */15) embeds every edva_messages row into
// a pgvector column, and the `edva_messages_semantic_search` RPC ranks by
// cosine similarity. That infra existed but was unwired — nothing but a bare
// CLI (`edva-messages-search`) used it, so hum and the agent never "saw"
// what the user had just typed. This module is the reusable surface over it, so
// the unified recall path (and hum) can fold recent chat into recall.
//
// Two primitives, both FAIL-SOFT (return [] on any error — recall degrades, it
// never throws into a caller):
//   searchChat(query, …)  — semantic recall via the pgvector RPC (paraphrase-
//                           tolerant "what did I say about X"). Embeds the query
//                           locally via Ollama (or takes a precomputed vector so
//                           the unified path embeds once).
//   recentChat(…)         — a plain recency fetch of the last N hours of user
//                           messages (no embedding). "What did I just type?" —
//                           complete, not similarity-filtered; used by hum so a
//                           thing the user mentioned this afternoon suppresses a
//                           re-ask on the next tick.

import { localLlmEmbed } from "./local-llm.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadEnv } = require("./load-env.js");
loadEnv();

const SUPABASE_URL =
  process.env.EDVA_SUPABASE_URL || require("./instance.cjs").supabaseUrl();

function key() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || null;
}

function authHeaders(k) {
  return { apikey: k, Authorization: `Bearer ${k}`, Accept: "application/json" };
}

// Semantic recall over edva_messages via the pgvector RPC. Returns
// [{ id, role, content, created_at, similarity }] best-first, or [] on any
// failure. `queryVec` lets the unified path pass a once-embedded query.
export async function searchChat(
  query,
  { k = 10, role = "user", sinceDays = null, since = null, queryVec = null, timeoutMs = 8000 } = {},
) {
  const kApi = key();
  if (!kApi || !query || !String(query).trim()) return [];
  let vec = queryVec;
  if (!vec) {
    try {
      vec = await localLlmEmbed(query);
    } catch {
      return []; // Ollama down → no semantic recall (caller may still recentChat)
    }
  }
  if (!Array.isArray(vec) || !vec.length) return [];
  // Explicit `since` (ISO) wins; else derive from sinceDays; else unbounded.
  const sinceIso =
    since || (sinceDays ? new Date(Date.now() - sinceDays * 86_400_000).toISOString() : null);
  const payload = {
    query_embedding: "[" + vec.join(",") + "]",
    match_count: k,
    role_filter: role,
    since: sinceIso,
  };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/edva_messages_semantic_search`,
      {
        method: "POST",
        headers: { ...authHeaders(kApi), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

// Plain recency fetch of the last `hours` of messages (default: The user's own
// user messages). No embedding — complete and instant. Returns
// [{ role, content, created_at }] newest-first, or [] on failure.
export async function recentChat({ hours = 36, role = "user", limit = 40, timeoutMs = 8000 } = {}) {
  const kApi = key();
  if (!kApi) return [];
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const qs = new URLSearchParams({
    select: "role,content,created_at",
    created_at: `gt.${since}`,
    order: "created_at.desc",
    limit: String(limit),
  });
  if (role) qs.set("role", `eq.${role}`);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/edva_messages?${qs}`, {
      headers: authHeaders(kApi),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => typeof r.content === "string" && r.content.trim())
      .map((r) => ({ role: r.role, content: r.content, created_at: r.created_at }));
  } catch {
    return [];
  }
}

export const CHAT_RECALL_SUPABASE_URL = SUPABASE_URL;
