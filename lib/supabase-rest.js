"use strict";
// supabase-rest — minimal GET helper for the Supabase REST endpoint.
// Used by tools that don't want the @supabase/supabase-js SDK weight or
// auth dance: just service-role-key + bearer header + JSON parse.

const https = require("node:https");
const { loadEnv } = require("./load-env.js");
loadEnv();

// This installation's project (lib/instance.cjs supabase_project).
const SUPABASE_URL = require("./instance.cjs").supabaseUrl();

function getKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || null;
}

/**
 * Collect a response stream's body and decode it as UTF-8 ONCE, at the end.
 *
 * Do not go back to `body += c` per chunk: each chunk is a Buffer, and
 * decoding them one at a time splits any multi-byte character that straddles
 * a TCP chunk boundary into two invalid halves, each becoming U+FFFD. That
 * mangled the leading emoji of system-channel rows (the Jev-disagreement
 * marker), so trigger-system-issue-review.sh's emoji filter missed them and
 * they inflated the nightly review batch. Guarded by
 * tests/supabase-rest-utf8-chunks.test.mjs.
 *
 * @param {import("node:events").EventEmitter} res  emits "data" (Buffer|string) then "end"
 * @param {(body: string) => void} onBody
 */
function collectBody(res, onBody) {
  const chunks = [];
  res.on("data", (c) => chunks.push(typeof c === "string" ? Buffer.from(c, "utf8") : c));
  res.on("end", () => onBody(Buffer.concat(chunks).toString("utf8")));
}

/**
 * GET a Supabase REST URL and parse the JSON body.
 * Returns parsed JSON on HTTP 200, null otherwise (network errors, non-200,
 * parse failures all collapse to null — caller should treat null as "no data").
 *
 * @param {string} pathAndQuery  e.g. "/rest/v1/photos?segment_id=eq.abc&select=*"
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 */
function fetchJson(pathAndQuery, { timeoutMs = 5000 } = {}) {
  const key = getKey();
  if (!key) return Promise.resolve(null);
  const url = pathAndQuery.startsWith("http") ? pathAndQuery : `${SUPABASE_URL}${pathAndQuery}`;
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      timeout: timeoutMs,
    }, (res) => {
      // Buffer.concat + one decode (see collectBody), not per-chunk string +=.
      collectBody(res, (body) => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * General Supabase REST request. Throws on non-2xx (unlike fetchJson which
 * collapses everything to null). Use this for writes (POST/PATCH/DELETE) or
 * when you need to distinguish "no data" from "fetch failed".
 *
 * @param {string} pathAndQuery  e.g. "/rest/v1/daily_summaries?date=eq.2026-04-17"
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {any}    [opts.body]           JSON-serialized automatically
 * @param {string} [opts.prefer]         PostgREST Prefer header (e.g. "return=representation")
 * @param {number} [opts.timeoutMs=10000]
 * @returns {Promise<any>}               parsed JSON or null for 204
 */
async function request(pathAndQuery, { method = "GET", body, prefer, timeoutMs = 10000 } = {}) {
  const key = getKey();
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
  const url = pathAndQuery.startsWith("http") ? pathAndQuery : `${SUPABASE_URL}${pathAndQuery}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Supabase ${method} ${pathAndQuery}: HTTP ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * GET every row of a query, page by page.
 *
 * PostgREST caps a single response at the server's max-rows (1000 here), and
 * it does so silently — `limit=5000` still returns 1000 rows with a 200. A
 * caller that wants "all of it" must page, or it quietly reads the newest
 * 1000 and reasons over them as if they were the whole history (one consumer
 * did exactly this: it read the newest tenth of its feed, so a detector built
 * on it saw a handful of the recurring items it should have found).
 *
 * The query must carry a stable `order=` so pages don't overlap or skip.
 *
 * @param {string} pathAndQuery  GET query WITHOUT limit/offset
 * @param {object} [opts]
 * @param {number} [opts.pageSize=1000]
 * @param {number} [opts.maxRows=100000]  safety stop
 * @returns {Promise<any[]>}
 */
async function requestAll(pathAndQuery, { pageSize = 1000, maxRows = 100000, timeoutMs = 20000 } = {}) {
  if (/[?&](limit|offset)=/.test(pathAndQuery)) throw new Error("requestAll: pass the query without limit/offset");
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const all = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const rows = (await request(`${pathAndQuery}${sep}limit=${pageSize}&offset=${offset}`, { timeoutMs })) || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

module.exports = { fetchJson, request, requestAll, SUPABASE_URL, collectBody };
