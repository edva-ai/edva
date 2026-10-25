// cron-pause-marker.test.mjs — the un-pause half of the `#MARKER#` convention.
//
// These tests exist because this code rewrites the user's live crontab
// (hundreds of lines, several `#HUMPAUSE#` jobs). A bug here does not
// fail loudly; it silently mangles a schedule. So the assertions are mostly
// about what must NOT change.
//
// Run: node --test tests/cron-pause-marker.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { findPaused, unpause, labelOf } = require(path.join(HERE, "../lib/cron-pause-marker.js"));

// A synthetic crontab in the shapes cron-run and the pause families write.
const CRON = [
  "*/20 * * * * /Users/operator/Dev/edva/bin/cron-run --label trigger-hum -- /Users/operator/Dev/edva/agent/scripts/trigger-hum.sh",
  "#HUMPAUSE# 0 23 * * * /Users/operator/Dev/edva/bin/cron-run --label trigger-hum-daily -- /Users/operator/Dev/edva/agent/scripts/trigger-hum-daily.sh",
  "# edva: hum-example-collect — daily example collector",
  "#HUMPAUSE# 29 6 * * * /Users/operator/Dev/edva/bin/cron-run --label trigger-hum-example-collect -- /Users/operator/Dev/edva/agent/scripts/trigger-hum-example-collect.sh",
  "#DIGESTPAUSE# 15 9 * * * /Users/operator/Dev/edva/bin/cron-run --label trigger-example-digest -- bash -c 'x'",
  "0 8 1 1 * /Users/operator/Dev/edva/bin/example-audit --days 3 # ONE-SHOT-AUDIT",
  "",
];

test("finds only the lines carrying the requested marker", () => {
  assert.equal(findPaused(CRON, "HUMPAUSE").length, 2);
  assert.equal(findPaused(CRON, "DIGESTPAUSE").length, 1);
  assert.equal(findPaused(CRON, "NOPE").length, 0);
});

test("restoring strips exactly the marker and nothing else", () => {
  const { lines, restored } = unpause(CRON, "HUMPAUSE");
  assert.equal(restored.length, 2);
  assert.equal(lines[1], "0 23 * * * /Users/operator/Dev/edva/bin/cron-run --label trigger-hum-daily -- /Users/operator/Dev/edva/agent/scripts/trigger-hum-daily.sh");
  assert.equal(lines[3], "29 6 * * * /Users/operator/Dev/edva/bin/cron-run --label trigger-hum-example-collect -- /Users/operator/Dev/edva/agent/scripts/trigger-hum-example-collect.sh");
});

test("the line count never changes and every other line is byte-identical", () => {
  const { lines } = unpause(CRON, "HUMPAUSE");
  assert.equal(lines.length, CRON.length);
  for (const i of [0, 2, 4, 5, 6]) assert.equal(lines[i], CRON[i], `line ${i} must be untouched`);
});

test("a different family's pause is left alone", () => {
  const { lines } = unpause(CRON, "HUMPAUSE");
  assert.equal(lines[4], CRON[4], "DIGESTPAUSE is not ours to lift");
});

test("nothing to restore is a no-op that returns the same array", () => {
  const { lines, restored } = unpause(CRON, "HUMPAUSE");
  const again = unpause(lines, "HUMPAUSE");
  assert.equal(again.restored.length, 0);
  assert.equal(again.lines, lines, "idempotent: no copy, no change");
  assert.ok(restored.length > 0);
});

test("a trailing marker-shaped comment is not a paused line", () => {
  // `# ONE-SHOT-AUDIT` at end-of-line is a tag, not a prefix — and a bare
  // comment line is not a job. Neither may be resurrected as a cron entry.
  const { restored } = unpause(CRON, "ONE-SHOT-AUDIT");
  assert.equal(restored.length, 0);
  assert.equal(unpause(CRON, "edva").restored.length, 0);
});

test("an ordinary commented-out job is not touched", () => {
  const lines = ["# 0 5 * * * /some/old/job.sh", "## disabled by hand"];
  assert.equal(unpause(lines, "HUMPAUSE").restored.length, 0);
});

test("labelOf reads the job name for logging", () => {
  assert.equal(labelOf(CRON[1]), "trigger-hum-daily");
  assert.equal(labelOf("# a comment"), null);
});
