"use strict";
// google-auth.js — shared Google OAuth token management
// Reads/refreshes the token from ~/Dev/edva/credentials/gmail-push-token.json
// Used by gmail-action, context-sync (Drive), and any future Google API callers.

const fs = require("node:fs");
const path = require("node:path");

const { installTools } = require("./root.cjs");
const TOKEN_FILE = installTools("credentials/gmail-push-token.json");

let _cachedToken = null;

// ---------------------------------------------------------------------------
// Retry envelope.
//
// 5 attempts with exponential backoff (0.5s, 1s, 2s, 4s ≈ 7.5s total), replacing
// the original 3 attempts with linear 250ms/500ms sleeps (≈ 750ms total).
//
// Why: the unstar-scan sweep failed all-at-once with "ENOTFOUND
// gmail.googleapis.com" over and over for two weeks, surviving
// several fix attempts — a retry-layer fix, an audit-log honesty fix, and a
// 300ms inter-message pacing experiment that the user approved by Face-ID. Every one of those treated the failure as Google-side:
// rate-limiting, throttling, or a bad response. It is not. ENOTFOUND is the
// host's own resolver failing before a request is ever sent, and a sub-second
// retry window cannot ride out a resolver blip that lasts seconds. Because a
// 20-message batch issues ~100 sequential calls that all hit the same blip, the
// whole sweep dies together — which is exactly the all-or-nothing signature that
// made this look like a Gmail outage for two weeks.
//
// Cost of being wrong: when the network is genuinely down, each call now spends
// ~7.5s before giving up instead of ~0.75s, so a fully-failing 20-message sweep
// takes minutes rather than seconds to report failure. That is the intended
// trade — unstar-scan is a background sweep with nobody waiting on it, and a
// slow correct answer beats a fast wrong one.
//
// Retries fire ONLY on network-level throws (DNS failure, TLS reset, timeout,
// connection refused). A resolved HTTP response — 4xx/5xx, including a real
// invalid_grant — is returned immediately on the first attempt and never
// retried, so genuine credential failures still surface right away.
// ---------------------------------------------------------------------------
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 500;

// Exponential, not linear: the point is to still be trying several seconds in,
// which is the timescale a resolver blip actually occupies.
function retryDelayMs(attempt, backoffMs = RETRY_BASE_MS) {
  return backoffMs * Math.pow(2, attempt - 1);
}

// Serialize an error's full cause chain into one line. Node's fetch() throws a
// generic "TypeError: fetch failed" whose real reason (ENOTFOUND, ECONNREFUSED,
// a TLS/certificate failure, a timeout) lives in err.cause, not err.message —
// verified 2026-08-07: `fetch()` against an unresolvable host throws exactly
// { message: "fetch failed", cause: { message: "getaddrinfo ENOTFOUND ...",
// code: "ENOTFOUND" } }. Every layer of this pipeline (gmail-action's
// top-level catch, p1-downgrade's inline fetch scripts, p1-scan-gate's
// execFileSync catch) historically logged err.message alone, collapsing every
// possible failure mode into the single indistinguishable string "fetch
// failed". That is why four consecutive fix attempts on the chronic
// unstar-scan failure (2026-07-21 through 2026-08-04) each tuned a *guessed* mechanism (retry count, backoff
// duration, inter-message pacing) against an unconfirmed theory ("ENOTFOUND",
// explicitly flagged as unconfirmed in this file's own history) instead of a
// captured one — nothing in the pipeline had ever recorded what actually
// failed. See agent/ops-agent/jobs/p1-resolve.md § Reliability notes,
// 2026-08-07 entry.
function describeError(err, depth = 0) {
  if (!err || depth > 5) return String(err);
  const code = err.code ? ` [${err.code}]` : "";
  const status = err.status ? ` (status ${err.status})` : "";
  const here = `${err.name || "Error"}: ${err.message}${code}${status}`;
  return err.cause ? `${here} <- caused by: ${describeError(err.cause, depth + 1)}` : here;
}

async function fetchWithRetry(url, opts, retries = RETRY_ATTEMPTS, backoffMs = RETRY_BASE_MS) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, retryDelayMs(attempt, backoffMs)));
      }
    }
  }
  throw lastErr;
}

async function getAccessToken() {
  if (_cachedToken) return _cachedToken;

  const creds = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));

  // Check if token is still valid (with 5 min buffer)
  if (creds.access_token && creds.expires_at && Date.now() < creds.expires_at - 300000) {
    _cachedToken = creds.access_token;
    return _cachedToken;
  }

  // Refresh the token
  const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error} — ${data.error_description}`);
  }

  // Atomic write: write to temp file then rename
  creds.access_token = data.access_token;
  creds.expires_at = Date.now() + data.expires_in * 1000;
  const tmpFile = TOKEN_FILE + ".tmp." + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(creds, null, 2));
  fs.renameSync(tmpFile, TOKEN_FILE);

  _cachedToken = data.access_token;
  return _cachedToken;
}

function clearCache() {
  _cachedToken = null;
}

module.exports = { getAccessToken, clearCache, fetchWithRetry, retryDelayMs, describeError };
