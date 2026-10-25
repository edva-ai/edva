// claim-freshness-extractor-health.test.mjs — "couldn't check" must never read
// as "checked". A self-improvement review found 142 of 354 truth-gate
// decisions were the Stage-1 extractor failing, logged as a bare pass.
// Verifies: a forced extractor failure logs its KIND, the rolling counter
// moves, zero-claims is logged as a success, and the system channel is paged
// once on crossing the threshold (and once on recovery) — not per failure.
// Run: node --test tests/claim-freshness-extractor-health.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-health-"));
const CLAUDE = path.join(tmp, "claude");
const SEND = path.join(tmp, "send");
const SENT = path.join(tmp, "sent.txt");
const LOG = path.join(tmp, "log.jsonl");
const HEALTH = path.join(tmp, "health.json");
fs.writeFileSync(CLAUDE, `#!/bin/sh
cat >/dev/null
case "$STUB_MODE" in
  sleep) sleep 5 ;;
  garbage) echo "Sorry, I can't produce that." ;;
  shape) echo '{"verdict":"pass"}' ;;
  exit) exit 3 ;;
  empty) echo '{"claims":[]}' ;;
esac
`, { mode: 0o755 });
fs.writeFileSync(SEND, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${SENT}"\n`, { mode: 0o755 });

Object.assign(process.env, {
  CLAIM_FRESHNESS_CLAUDE_BIN: CLAUDE, CLAIM_FRESHNESS_LOG: LOG, CLAIM_FRESHNESS_HEALTH: HEALTH,
  // 2000, not 400: the stub is a shell script, and when the suite runs beside
  // other test files a cold spawn alone can pass 400ms, so the garbage/shape
  // replies were landing as "timeout" (both failed at ~410ms on 2026-10-15).
  // Only the `sleep` stub (5s) should ever reach the deadline.
  CLAIM_FRESHNESS_SEND_BIN: SEND, CLAIM_FRESHNESS_EXTRACT_TIMEOUT_MS: "2000",
});
delete process.env.CLAIM_FRESHNESS_NO_ALERT;

const { checkFreshness, extractorHealth, noteExtractorOutcome, HEALTH_WINDOW } = await import("../lib/claim-freshness.mjs");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => { for (const f of [LOG, HEALTH, SENT]) fs.rmSync(f, { force: true }); });

const NOW = Date.parse("2026-10-06T14:00:00Z");
const STALE = { text: "The customer still hasn't enrolled in autopay.", evidence_as_of: "2026-10-04T09:00:00Z" };
const rows = () => fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const waitSent = async () => {
  for (let i = 0; i < 40; i++) { if (fs.existsSync(SENT)) return fs.readFileSync(SENT, "utf8"); await new Promise((r) => setTimeout(r, 50)); }
  return "";
};

for (const [mode, kind] of [["sleep", "timeout"], ["garbage", "unparseable"], ["shape", "bad_shape"], ["exit", "exit_nonzero"]]) {
  test(`forced extractor failure (${mode}) → still pass, log names "${kind}", counter moves`, async () => {
    process.env.STUB_MODE = mode;
    const out = await checkFreshness(STALE, { nowMs: NOW });
    assert.equal(out.verdict, "pass", "fail-open is unchanged");
    assert.deepEqual(out.reasons, ["extractor_unavailable", `extractor_unavailable:${kind}`]);
    const r = rows().at(-1);
    assert.equal(r.extractor, "failed");
    assert.equal(r.extractor_error.kind, kind);
    assert.ok(r.extractor_error.message.length > 0);
    assert.deepEqual(r.extractor_health, { window: 1, failures: 1, rate: 1 });
    const h = extractorHealth();
    assert.equal(h.total_failures, 1);
    assert.equal(h.by_kind[kind], 1);
  });
}

test("a missing claude binary is a spawn_error, not a pass-with-no-reason", async () => {
  // The gate resolves its bin at module load, so exercise the shared runner directly.
  const { runToollessDetailed } = await import("../lib/jev-claude.mjs");
  const r = await runToollessDetailed({ bin: path.join(tmp, "nope"), model: "x", prompt: "p", timeoutMs: 400 });
  assert.equal(r.out, "");
  assert.equal(r.error.kind, "spawn_error");
});

test("zero claims extracted is a SUCCESS in the log, distinct from failure", async () => {
  process.env.STUB_MODE = "empty";
  const out = await checkFreshness(STALE, { nowMs: NOW });
  assert.deepEqual(out.reasons, ["no_mutable_claims"]);
  const r = rows().at(-1);
  assert.equal(r.extractor, "ok");
  assert.equal(r.claims_extracted, 0);
  assert.deepEqual(r.extractor_health, { window: 1, failures: 0, rate: 0 });
  assert.equal(extractorHealth().total_failures, 0);
});

test("crossing >20% of the window pages the system channel ONCE; recovery pings once", async () => {
  // 40 ok + 10 failed = exactly 20%: at the line, not over it → no page.
  fs.writeFileSync(HEALTH, JSON.stringify({ window: [...Array(40).fill(""), ...Array(10).fill("timeout")] }));
  noteExtractorOutcome("");
  assert.equal(await waitSent(), "", "at/below threshold → silent");
  // Two more failures push it over (11/50, then 12/50): exactly one page.
  noteExtractorOutcome("timeout");
  noteExtractorOutcome("timeout");
  const sent = await waitSent();
  await new Promise((r) => setTimeout(r, 200));
  const pages = fs.readFileSync(SENT, "utf8").trim().split("\n");
  assert.equal(pages.length, 1, "one page per episode, not per failure");
  assert.match(sent, /--channel system/);
  assert.match(sent, /claim-freshness-health/);
  assert.match(sent, /timeout/);
  assert.ok(extractorHealth().alerted_at);

  // Recovery: drain the window with successes until the rate is ≤10%.
  fs.rmSync(SENT, { force: true });
  for (let i = 0; i < HEALTH_WINDOW; i++) noteExtractorOutcome("");
  const rec = await waitSent();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fs.readFileSync(SENT, "utf8").trim().split("\n").length, 1, "one recovery ping");
  assert.match(rec, /✅/);
  assert.equal(extractorHealth().alerted_at, null);
});

test("below the minimum sample nothing pages, even at 100% failure", async () => {
  for (let i = 0; i < 5; i++) noteExtractorOutcome("timeout");
  assert.equal(await waitSent(), "");
  assert.equal(extractorHealth().failures, 5);
});
