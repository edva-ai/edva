"use strict";
// supabase-rest — minimal GET helper for the Supabase REST endpoint.
// Used by tools that don't want the @supabase/supabase-js SDK weight or
// auth dance: just service-role-key + bearer header + JSON parse.

const https = require("node:https");
const { loadEnv } = require("./load-env.js");
loadEnv();

const SUPABASE_URL = "https://${MERLIN_SUPABASE_PROJECT}.supabase.co";

function getKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || null;
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
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
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

module.exports = { fetchJson, request, SUPABASE_URL };
