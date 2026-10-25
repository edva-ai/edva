// supabase-rest-utf8-chunks.test.mjs — fetchJson must decode the response
// body once, not chunk by chunk.
//
// Defends against a system-channel cluster of corrupted rows.
// lib/supabase-rest.js
// used to do `body += c` on every "data" chunk. Each chunk is a Buffer, so a
// multi-byte UTF-8 character straddling a TCP chunk boundary was decoded as
// two invalid halves, each turned into U+FFFD. A system-channel row opening
// with the Jev-disagreement emoji (U+1F500) reached
// trigger-system-issue-review.sh with that emoji destroyed, slipped past its
// emoji filter, and inflated the nightly review gate's fresh-alert count.
//
// No network: the collectBody helper is fed a plain EventEmitter, and the
// end-to-end fetchJson cases swap `https.request` for an in-process fake (the
// URL also points at a .invalid host as a second line of defence).
//
// Run: node --test tests/supabase-rest-utf8-chunks.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

// Set a dummy key BEFORE requiring the module: loadEnv never overrides an
// existing value, so the real service-role key is never read into this test.
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-dummy-key";

const require = createRequire(import.meta.url);
const MOD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib/supabase-rest.js");
const https = require("node:https");
const { fetchJson, collectBody } = require(MOD);

const REPLACEMENT = "�";
const EMOJI = "\u{1F500}"; // F0 9F 94 80, the Jev-disagreement marker
const ROW_TEXT = `${EMOJI} Jev disagreement: café réservation`;
const PAYLOAD = JSON.stringify([{ id: 1, text: ROW_TEXT }]);
const PAYLOAD_BYTES = Buffer.from(PAYLOAD, "utf8");

/** Split a buffer at the given byte offsets. */
function splitAt(buf, offsets) {
  const out = [];
  let prev = 0;
  for (const o of offsets) { out.push(buf.subarray(prev, o)); prev = o; }
  out.push(buf.subarray(prev));
  return out;
}

/** Offsets that cut the 4-byte emoji and the 2-byte "é" in their middles. */
function hostileOffsets() {
  const emojiAt = PAYLOAD_BYTES.indexOf(Buffer.from(EMOJI, "utf8"));
  const eAt = PAYLOAD_BYTES.indexOf(Buffer.from("é", "utf8"));
  assert.ok(emojiAt > 0 && eAt > emojiAt, "fixture must contain both characters");
  return [emojiAt + 2, eAt + 1];
}

/** The pre-fix accumulation, kept only to document the failure mode. */
function oldPerChunkDecode(chunks) {
  let body = "";
  for (const c of chunks) body += c;
  return body;
}

/** Drive collectBody with an EventEmitter and return the decoded string. */
function viaCollectBody(chunks) {
  const res = new EventEmitter();
  let got;
  collectBody(res, (b) => { got = b; });
  for (const c of chunks) res.emit("data", c);
  res.emit("end");
  return got;
}

test("old per-chunk decoding corrupts a split emoji and a split é (documents the bug)", () => {
  const chunks = splitAt(PAYLOAD_BYTES, hostileOffsets());
  const broken = oldPerChunkDecode(chunks);
  assert.ok(broken.includes(REPLACEMENT), "per-chunk += should have produced U+FFFD");
  assert.notEqual(broken, PAYLOAD);
  assert.ok(!broken.includes(EMOJI), "the emoji is destroyed by per-chunk decoding");
});

test("collectBody decodes split multi-byte characters intact", () => {
  const got = viaCollectBody(splitAt(PAYLOAD_BYTES, hostileOffsets()));
  assert.equal(got, PAYLOAD);
  assert.ok(!got.includes(REPLACEMENT));
  assert.ok(JSON.parse(got)[0].text.startsWith(EMOJI), "row still opens with the emoji");
});

test("collectBody is correct at every possible single split point", () => {
  for (let i = 1; i < PAYLOAD_BYTES.length; i++) {
    assert.equal(viaCollectBody(splitAt(PAYLOAD_BYTES, [i])), PAYLOAD, `split at byte ${i}`);
  }
});

test("collectBody handles one-byte chunks, a single chunk, no chunks, and string chunks", () => {
  const bytewise = [...PAYLOAD_BYTES].map((b) => Buffer.from([b]));
  assert.equal(viaCollectBody(bytewise), PAYLOAD);
  // Behaviour-preserving for the common case: identical to the old path when nothing straddles.
  assert.equal(viaCollectBody([PAYLOAD_BYTES]), oldPerChunkDecode([PAYLOAD_BYTES]));
  assert.equal(viaCollectBody([]), "");
  assert.equal(viaCollectBody(["[1,", Buffer.from("2]")]), "[1,2]");
});

// ── end-to-end through fetchJson, with https.request faked in-process ──────

const realRequest = https.request;
after(() => { https.request = realRequest; });

/**
 * Install a fake https.request. `respond(res, req)` runs when the caller ends
 * the request; it may emit on res (status/body) or on req (error/timeout).
 */
function fakeRequest(respond) {
  https.request = (_url, _opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      respond(res, req, cb);
    });
    return req;
  };
}

function sendBody(res, cb, status, chunks) {
  res.statusCode = status;
  cb(res);
  for (const c of chunks) res.emit("data", c);
  res.emit("end");
}

const TEST_URL = "https://supabase-rest-test.invalid/rest/v1/edva_messages?select=*";

test("fetchJson returns the uncorrupted row when the emoji straddles a chunk boundary", async () => {
  fakeRequest((res, _req, cb) => sendBody(res, cb, 200, splitAt(PAYLOAD_BYTES, hostileOffsets())));
  const rows = await fetchJson(TEST_URL);
  assert.deepEqual(rows, [{ id: 1, text: ROW_TEXT }]);
  assert.ok(rows[0].text.startsWith(EMOJI));
});

test("fetchJson contract unchanged: non-200 → null", async () => {
  fakeRequest((res, _req, cb) => sendBody(res, cb, 404, [Buffer.from('{"message":"nope"}')]));
  assert.equal(await fetchJson(TEST_URL), null);
});

test("fetchJson contract unchanged: unparseable body → null", async () => {
  fakeRequest((res, _req, cb) => sendBody(res, cb, 200, [Buffer.from("not json")]));
  assert.equal(await fetchJson(TEST_URL), null);
});

test("fetchJson contract unchanged: network error → null", async () => {
  fakeRequest((_res, req) => req.emit("error", new Error("ECONNRESET")));
  assert.equal(await fetchJson(TEST_URL), null);
});

test("fetchJson contract unchanged: timeout → null", async () => {
  fakeRequest((_res, req) => req.emit("timeout"));
  assert.equal(await fetchJson(TEST_URL), null);
});

test("fetchJson still routes its body through collectBody (no per-chunk += regression)", () => {
  const src = fs.readFileSync(MOD, "utf8");
  assert.ok(src.includes("collectBody(res,"), "fetchJson must use collectBody");
  assert.ok(!src.includes("(body += c)"), "per-chunk string concatenation is the bug this test guards");
});
