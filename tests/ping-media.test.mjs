// ping-media.test.mjs — the harvester→hum-ping media hand-off
// (lib/ping-media.mjs) plus the `--media` append contract in
// bin/edva-send-curl.
//
// What these pin down, and why each one is worth a test:
//
//   - The stash is keyed by `dedup_key` and expires. It exists because the
//     findings array reaching `hum-ping` is composed by an agent turn, so a
//     nested `supporting_data.media` is not something we can rely on arriving.
//   - `mediaUrls` orders image-then-map and rejects anything not http(s). The
//     client renders a bare URL line as an image; a malformed entry would land
//     in the user's chat as literal text.
//   - `edva-send-curl` appends media AFTER the gates and keeps them out of
//     the push preview. That ordering is the whole design — a precheck
//     `modify` replaces the message wholesale, so anything appended earlier is
//     silently lost.
//
// Run: node --test tests/ping-media.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ping-media-"));
process.env.EDVA_PING_MEDIA_FILE = path.join(fixtureDir, "ping-media.json");

let M;
before(async () => { M = await import("../lib/ping-media.mjs"); });
after(() => { fs.rmSync(fixtureDir, { recursive: true, force: true }); });

const IMG = "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e0/x.jpg/960px-x.jpg";
const MAP = "https://example-project.supabase.co/storage/v1/object/public/daily-photos/place-maps/abc.png";

test("stash round-trips under the dedup key", () => {
  M.stashMedia("nearby:old-passage", { image_url: IMG, map_url: MAP });
  const got = M.recallMedia("nearby:old-passage");
  assert.equal(got.image_url, IMG);
  assert.equal(got.map_url, MAP);
});

test("an unknown or empty key recalls nothing rather than throwing", () => {
  assert.equal(M.recallMedia("nearby:never-stashed"), null);
  assert.equal(M.recallMedia(""), null);
  assert.equal(M.recallMedia(null), null);
});

test("a candidate with no media is not stashed at all", () => {
  M.stashMedia("nearby:no-pictures", { image_url: null, map_url: null });
  assert.equal(M.recallMedia("nearby:no-pictures"), null);
});

test("entries past the TTL are not served", () => {
  const file = process.env.EDVA_PING_MEDIA_FILE;
  const all = JSON.parse(fs.readFileSync(file, "utf8"));
  all["nearby:stale"] = {
    ts: new Date(Date.now() - 13 * 3600000).toISOString(),
    media: { image_url: IMG, map_url: null },
  };
  fs.writeFileSync(file, JSON.stringify(all));
  assert.equal(M.recallMedia("nearby:stale"), null);
});

test("mediaUrls orders image before map", () => {
  assert.deepEqual(M.mediaUrls({ image_url: IMG, map_url: MAP }), [IMG, MAP]);
  assert.deepEqual(M.mediaUrls({ map_url: MAP }), [MAP]);
  assert.deepEqual(M.mediaUrls({ image_url: IMG }), [IMG]);
});

test("mediaUrls rejects anything that is not an http(s) URL", () => {
  // A relative path or a local file would render as literal text in the bubble.
  assert.deepEqual(M.mediaUrls({ image_url: "/tmp/map.png", map_url: MAP }), [MAP]);
  assert.deepEqual(M.mediaUrls({ image_url: "file:///tmp/x.png" }), []);
  assert.deepEqual(M.mediaUrls({ image_url: 42 }), []);
  assert.deepEqual(M.mediaUrls(null), []);
});

// ── edva-send-curl's --media contract ─────────────────────────────────
//
// Read as source rather than executed: running it would insert a real row into
// edva_messages and push to the user's phone. What matters is structural and
// checkable statically — that the append happens after the gates, and that the
// push reads the pre-media text.

const SEND = fs.readFileSync(path.join(here, "../bin/edva-send-curl"), "utf8");

test("media is appended after the precheck, not before it", () => {
  const precheckAt = SEND.indexOf('MESSAGE="$MODIFIED"');
  const mediaAt = SEND.indexOf('MESSAGE="${MESSAGE}"');
  assert.ok(precheckAt > 0, "precheck modify branch still assigns MESSAGE");
  assert.ok(mediaAt > 0, "media append still assigns MESSAGE");
  assert.ok(mediaAt > precheckAt,
    "media must be appended AFTER the precheck rewrite, or a `modify` verdict drops it");
});

test("media is appended before the row is serialized", () => {
  const mediaAt = SEND.indexOf('MESSAGE="${MESSAGE}"');
  const escapeAt = SEND.indexOf("JSON_MESSAGE=$(printf");
  assert.ok(escapeAt > mediaAt, "the appended URLs must reach the inserted row");
});

test("the push preview is built from the pre-media text", () => {
  assert.ok(SEND.includes('PUSH_TEXT="$MESSAGE"'), "PUSH_TEXT snapshot still taken");
  assert.ok(SEND.includes(`TRUNCATED=$(printf '%s' "$PUSH_TEXT"`),
    "the lock-screen preview must not be a truncated image URL");
});

test("--media is a declared flag, so the unknown-flag guard cannot eat it", () => {
  assert.ok(SEND.includes("--media)          MEDIA+="), "flag is parsed");
  assert.ok(SEND.includes("--push-body, --media,"), "flag is listed in the error help");
});
