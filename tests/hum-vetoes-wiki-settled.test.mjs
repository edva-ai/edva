import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wikiSettledKeys, preRankFilter } from "../lib/hum-vetoes.mjs";

const NOW = Date.parse("2026-10-12T14:00:00Z");
const row = (ts, cause, key) => JSON.stringify({ ts, sonnet: { silent_root_cause: cause, near_miss_candidates: key ? [{ dedup_key: key }, { dedup_key: "other:x" }] : [] } });

function ledger(lines) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hv-")), "runs.jsonl");
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

test("collects the top near-miss of wiki_settled ticks inside the window only", () => {
  const p = ledger([
    row("2026-10-01T10:00:00Z", "wiki_settled", "old:key"),
    row("2026-10-08T10:00:00Z", "wiki_settled", "plan-audit:1"),
    row("2026-10-10T10:00:00Z", "no_candidates", "unrelated:1"),
  ]);
  const m = wikiSettledKeys({ runsPath: p, nowMs: NOW });
  assert.deepEqual([...m.keys()], ["plan-audit:1"]);
});

test("missing ledger fails open", () => {
  assert.equal(wikiSettledKeys({ runsPath: "/nonexistent/runs.jsonl", nowMs: NOW }).size, 0);
});

test("preRankFilter vetoes a settled key, leaves the runner-up, spares high urgency", async () => {
  const deps = {
    nowMs: NOW, feedbackPath: "/nonexistent/fb.jsonl", runsPath: ledger([row("2026-10-10T10:00:00Z", "wiki_settled", "plan-audit:1")]),
    embed: async () => null, checkPingBudget: () => ({ ok: true }),
  };
  const { eligible, vetoed } = await preRankFilter([
    { topic: "plan_audit", dedup_key: "plan-audit:1", urgency: 0.55, signal: "a" },
    { topic: "ideas", dedup_key: "idea-1", urgency: 0.5, signal: "b" },
    { topic: "weather", dedup_key: "plan-audit:1", urgency: 0.95, signal: "c" },
  ], deps);
  assert.deepEqual(eligible.map((c) => c.topic), ["ideas", "weather"]);
  assert.equal(vetoed[0].gate, "wiki_settled");
});
