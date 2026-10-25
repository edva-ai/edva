// Regression guard for the unstar Gmail retry.
//
// The defect this defends against: lib/google-auth.js's fetchWithRetry
// retried network-level throws only 3 times with linear 250ms/500ms sleeps, a
// total window of ~750ms. The observed failure — "ENOTFOUND
// gmail.googleapis.com" during unstar-scan, 29 times over two weeks — is the
// host's own DNS resolver blipping for seconds, so the entire retry envelope
// expired before the resolver came back, and all ~100 sequential calls in a
// 20-message batch failed together.
//
// These tests pin the three properties that matter, none of which can be
// asserted by reading the constants alone:
//   1. the backoff is exponential and the total window outlives a multi-second
//      resolver blip,
//   2. a throwing fetch is genuinely retried to the attempt limit,
//   3. a RESOLVED response (4xx/5xx, e.g. a real invalid_grant) is never
//      retried — widening the network envelope must not start papering over
//      credential failures.
//
// Backoff is injected as 1ms where the count is what's under test, so this file
// stays fast.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fetchWithRetry, retryDelayMs } = require("../lib/google-auth.js");

test("backoff is exponential, not linear", () => {
  assert.equal(retryDelayMs(1, 500), 500);
  assert.equal(retryDelayMs(2, 500), 1000);
  assert.equal(retryDelayMs(3, 500), 2000);
  assert.equal(retryDelayMs(4, 500), 4000);
});

test("total retry window outlives a multi-second resolver blip", () => {
  // 4 sleeps across 5 attempts. The pre-fix envelope was ~750ms, which is the
  // whole reason the cluster survived four fixes; anything under 5s here means
  // the regression is back.
  let total = 0;
  for (let attempt = 1; attempt <= 4; attempt++) total += retryDelayMs(attempt, 500);
  assert.equal(total, 7500);
  assert.ok(total >= 5000, `retry window collapsed to ${total}ms`);
});

test("a throwing fetch is retried to the attempt limit, then rethrows", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const err = new Error("getaddrinfo ENOTFOUND gmail.googleapis.com");
    err.code = "ENOTFOUND";
    throw err;
  };
  try {
    await assert.rejects(
      () => fetchWithRetry("https://gmail.googleapis.com/x", {}, 5, 1),
      /ENOTFOUND/,
    );
    assert.equal(calls, 5, "expected 5 attempts before giving up");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a transient throw that clears mid-envelope succeeds", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 4) throw new Error("getaddrinfo ENOTFOUND gmail.googleapis.com");
    return { ok: true, status: 200 };
  };
  try {
    const res = await fetchWithRetry("https://gmail.googleapis.com/x", {}, 5, 1);
    assert.equal(res.status, 200);
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a resolved non-2xx response is NOT retried", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 401 };
  };
  try {
    const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {}, 5, 1);
    assert.equal(res.status, 401);
    assert.equal(calls, 1, "an HTTP error must surface immediately, not be retried");
  } finally {
    globalThis.fetch = realFetch;
  }
});
