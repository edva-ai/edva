// suggestion-classify-multi.test.mjs — the automatic capture path end-to-end.
//
// Drives the real CLI rather than importing pieces of it: this script runs
// fork-and-forget from phone-channel with no agent in the loop, so what matters
// is what the *binary* does with a message, including its arg parsing and its
// multi-vs-single branch. Fixture HOME, --dry-run, no writes.
//
// Run: node --test tests/suggestion-classify-multi.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "../bin/suggestion-classify");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "classify-multi-"));
after(() => fs.rmSync(fixture, { recursive: true, force: true }));
fs.mkdirSync(path.join(fixture, "Dev/edva/data"), { recursive: true });

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const MSG_MUSEUM = "f0000000-0000-0000-0000-00000000000a";
const MSG_FIRE = "f0000000-0000-0000-0000-00000000000b";

// Field shapes as live pings carry them: signal present on one,
// absent on the other (only the dedup-key slug describes it).
fs.writeFileSync(path.join(fixture, "Dev/edva/data/hum-feedback.jsonl"), [
  JSON.stringify({ ping_id: "p-museum", sent_at: hoursAgo(6), lane: "ideas", reaction: null,
    message_id: MSG_MUSEUM,
    findings: [{ dedup_key: "ideas:0a0b0c0d", subject_key: "ideas:0a0b0c0d",
      signal: "Museum tour needs booking now - summer slots sell out" }] }),
  JSON.stringify({ ping_id: "p-firecloud", sent_at: hoursAgo(1), lane: "news", reaction: null,
    message_id: MSG_FIRE,
    findings: [{ dedup_key: "news:https://news.example.com/2026/07/27/world/pyrocumulonimbus-fire-cloud-forest-wildfires.html" }] }),
].join("\n") + "\n");

// Which open item each segment answers is a MODEL pick (Rule #0b, 2026-10-04 —
// it used to be keyword overlap). This binary-level test pins everything around
// that pick, so the pick itself comes from a fixture table (HUM_ATTRIBUTION_FIXTURE,
// read by hum-reply-segments modelPick, tests only).
const ATTRIBUTION = path.join(fixture, "attribution.json");
fs.writeFileSync(ATTRIBUTION, JSON.stringify({
  "Booked Museum already, thanks.": "ping:p-museum",
  "Skip the fire cloud story, already saw it.": "ping:p-firecloud",
  "The museum was great.": "ping:p-museum",
  "The fire cloud piece was not for me.": "ping:p-firecloud",
  "The museum was too expensive.": "ping:p-museum",
}));

function classify(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: fixture, HUM_ATTRIBUTION_FIXTURE: ATTRIBUTION },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* non-JSON on the skip paths */ }
  return { status: res.status, json, stderr: res.stderr };
}

test("a catch-up reply splits, and each item gets its own segment + disposition", () => {
  const { status, json } = classify([
    "--message-id", "m1", "--dry-run",
    "--text", "Booked Museum already, thanks. Skip the fire cloud story, already saw it.",
  ]);
  assert.equal(status, 0);
  assert.equal(json._multi_answer, true);

  const byItem = Object.fromEntries(json.targets.map((t) => [t.item, t]));
  const museum = byItem["ping:p-museum"];
  const fire = byItem["ping:p-firecloud"];

  assert.match(museum.segments.join(" "), /Booked Museum/);
  assert.match(fire.segments.join(" "), /fire cloud/);

  // The multi-mode-scoped rules are the point of this case: "Booked …" used to
  // classify as nothing, because the global positive rules are anchored tight.
  assert.equal(museum.disposition, "positive");
  assert.equal(fire.disposition, "negative");

  // And the attribution is not crossed: the "skip" belongs to the fire-cloud
  // story, not to the museum.
  assert.doesNotMatch(museum.segments.join(" "), /Skip/i);
});

test("scoped rules catch enjoyed-it phrasing the global rules deliberately miss", () => {
  const { json } = classify([
    "--message-id", "m2", "--dry-run",
    "--text", "The museum was great. The fire cloud piece was not for me.",
  ]);
  const byItem = Object.fromEntries(json.targets.map((t) => [t.item, t]));
  assert.equal(byItem["ping:p-museum"].disposition, "positive");
  assert.equal(byItem["ping:p-firecloud"].disposition, "negative");
});

test("a reply the model ties to ONE item goes to that item, not to the newest ping", () => {
  const { json } = classify([
    "--message-id", "m3", "--dry-run", "--text", "The museum was too expensive.",
  ]);
  assert.ok(!json?._multi_answer, "one matched item is not a multi-answer reply");
  assert.equal(json.disposition, "negative");
  // p-firecloud is newer and would win on recency alone — the same
  // mis-attribution as the multi case, with one answer instead of several.
  assert.equal(json._ping.ping_id, "p-museum");
});

test("a reply naming NOTHING still falls back to recency, unchanged", () => {
  const { json } = classify([
    "--message-id", "m6", "--dry-run", "--text", "too expensive",
  ]);
  assert.equal(json._ping.ping_id, "p-firecloud", "nothing to go on → newest open ping");
});

test("a threaded reply to a non-hum message records nothing", () => {
  const { status, json } = classify([
    "--message-id", "m4", "--dry-run",
    "--reply-to", "00000000-0000-0000-0000-000000000000",
    "--text", "too expensive",
  ]);
  assert.equal(status, 1, "exit 1 = classified as non-reaction");
  assert.equal(json, null);
});

test("a threaded reply pins its ping even when a newer one is open", () => {
  const { json } = classify([
    "--message-id", "m5", "--dry-run",
    "--reply-to", MSG_MUSEUM, "--text", "too expensive",
  ]);
  assert.equal(json._ping.ping_id, "p-museum", "not p-firecloud, which is newer");
});
