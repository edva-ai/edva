// models-central.test.mjs — model ids are pinned in ONE place
// (agent/config/models.env), and every Opus call site reads it.
//
// A review found the Opus id hard-coded in several sites. This pins that no listed site carries a literal again, and
// that shell (bash + zsh) and node read the same values.
//
// Run: node --test tests/models-central.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
import { REPO_ROOT as ROOT, TOOLS_DIR } from "../lib/root.cjs";
const ENV = path.join(ROOT, "agent/config/models.env");
const { MODELS, parseModelsEnv } = require("../lib/models.cjs");

test("shell (bash and zsh) and node read the same ids from models.env", () => {
  for (const sh of ["/bin/bash", "/bin/zsh"]) {
    if (!fs.existsSync(sh)) continue;
    const out = execFileSync(sh, ["-c", `source ${JSON.stringify(ENV)}; printf '%s %s' "$EDVA_MODEL_OPUS" "$EDVA_MODEL_SONNET"`], { encoding: "utf8" });
    assert.equal(out, `${MODELS.opus} ${MODELS.sonnet}`, `${sh} disagrees with models.cjs`);
  }
});

test("the Opus forks are on Opus 5.5 and the Sonnet tier is on Sonnet 5.5", () => {
  assert.equal(MODELS.opus, "claude-opus-5-5");
  assert.equal(MODELS.sonnet, "claude-sonnet-5-5");
  // The supervisors pin their own Sonnet in agents.json (not read from
  // models.env); the two must agree.
  const agents = fs.readFileSync(path.join(ROOT, "agent/config/agents.json"), "utf8");
  assert.ok(agents.includes(`"${MODELS.sonnet}"`), "models.env SONNET drifted from the supervisors' pin in agents.json");
});

// 2026-10-06: the Sonnet tier moved claude-sonnet-5 -> claude-sonnet-5-5 at ~45
// literal call sites. A quoted old id or `--model <old id>` left in CODE is a
// fork still running the previous Sonnet. Cost-rate tables legitimately keep
// the old id (old transcript rows still need pricing), so they are exempt.
test("no code still runs the previous Sonnet id", () => {
  const RATE_TABLES = new Set([
    "bin/edva-allowance-coverage",
    "bin/cost-review-prefetch.mjs",
    "agent/ext/cost-review-prefetch/tools/bin/cost-review-prefetch.mjs",
  ]);
  const OLD = /(['"`]claude-sonnet-5['"`])|(--model[ =]claude-sonnet-5(?![-\w]))/;
  const hits = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; } // unreadable (e.g. credentials on the host)
    for (const e of entries) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "tests", "test", "data", ".claude", "credentials", "secrets"].includes(e.name)) continue;
        walk(rel);
      } else if (!/\.(md|json|jsonl|ndjson|log|txt)$/.test(e.name) || e.name === "agents.json") {
        if (RATE_TABLES.has(rel)) continue;
        let src;
        try { src = fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { continue; }
        src.split("\n").forEach((l, i) => {
          const t = l.trimStart();
          if (t.startsWith("#") || t.startsWith("//") || t.startsWith("*")) return;
          if (OLD.test(l)) hits.push(`${rel}:${i + 1}`);
        });
      }
    }
  };
  walk(path.relative(ROOT, TOOLS_DIR) || ".");
  assert.deepEqual(hits, [], `still on claude-sonnet-5: ${hits.join(", ")}`);
});

test("models.env stays plain KEY=value — sourceable by zsh and bash without expansion", () => {
  const text = fs.readFileSync(ENV, "utf8");
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    assert.ok(/^[A-Z_]+=[a-z0-9.-]+$/.test(l), `not a plain KEY=value line: ${l}`);
  }
  assert.deepEqual(Object.keys(parseModelsEnv(text)).sort(), ["EDVA_MODEL_OPUS", "EDVA_MODEL_SONNET"]);
});

// Every site that used to carry its own Opus id. Comment lines are ignored —
// history in prose is fine; a literal in CODE is the drift this prevents.
// This install's own call sites are checked in models-central-local.test.mjs.
const SITES = [
  "agent/scripts/lib/run-ephemeral-opus.sh",
  "agent/supervisor/web-read.mjs",
];
test("no Opus call site hard-codes a model id any more", () => {
  for (const rel of SITES) {
    const code = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n")
      .filter((l) => !l.trimStart().startsWith("#") && !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    assert.ok(!code.includes("claude-opus-"), `${rel} hard-codes an Opus id — read EDVA_MODEL_OPUS / MODELS.opus instead`);
    assert.ok(code.includes("models.env") || code.includes("models.cjs"), `${rel} does not read the central model file`);
  }
});

test("every cost tool can price the pinned Opus id", () => {
  // edva-allowance-coverage and cost-review-prefetch SKIP a transcript
  // message whose model has no rate, so a missing row silently drops the spend.
  for (const rel of [
    "bin/edva-allowance-coverage",
    "bin/edva-cost-report",
  ]) { // (this installation's cost-review-prefetch: models-central-local.test.mjs)
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(src.includes(`'${MODELS.opus}'`), `${rel} has no rate for ${MODELS.opus}`);
  }
});
