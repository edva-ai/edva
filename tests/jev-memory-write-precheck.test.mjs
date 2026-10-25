// jev-memory-write-precheck.test.mjs — Jev primary / Sonnet shadow for the
// wiki-write contradiction gate. Run: node --test tests/jev-memory-write-precheck.test.mjs
//
// The CLI runs as a real subprocess. A preloaded module (NODE_OPTIONS --import)
// replaces fetch inside the child, playing both the Jev gateway and Ollama (the
// private screen) — no listening socket, so it runs under the sandbox too.
// Stub shell scripts play `wiki` and `claude`.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const BIN = path.resolve("bin/memory-write-precheck.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-mwp-"));
const qdir = path.join(tmp, "questions");
fs.mkdirSync(qdir);
fs.copyFileSync(new URL("../agent/config/jev-questions/memory-write-precheck.json", import.meta.url), path.join(qdir, "memory-write-precheck.json"));
const CFG = path.join(tmp, "jev-config.json");
const SHADOW = path.join(tmp, "shadow");
const CLAUDE_COUNT = path.join(tmp, "claude-count");

const wikiStub = path.join(tmp, "wiki");
fs.writeFileSync(wikiStub, `#!/bin/sh
if [ "$1" = "search" ]; then echo "reference_plans: the user is away next month; everyone else is home"; fi
if [ "$1" = "render" ]; then echo "Trip page body"; fi
exit 0
`, { mode: 0o755 });
const claudeStub = path.join(tmp, "claude");
fs.writeFileSync(claudeStub, `#!/bin/sh
echo x >> "${CLAUDE_COUNT}"
if [ "$STUB_SONNET" = "conflict" ]; then
  echo '{"decision":"conflict","conflicts":[{"page_id":"reference_plans","snippet":"the user is away next month","explanation":"away vs home"}],"resolution":"ask the user","reason":"away/home contradiction"}'
else
  echo '{"decision":"save","reason":"consistent"}'
fi
`, { mode: 0o755 });

const JEV_CALLS = path.join(tmp, "jev-calls");
const fetchStub = path.join(tmp, "fetch-stub.mjs");
fs.writeFileSync(fetchStub, `
import fs from "node:fs";
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://jev.test")) {
    const body = JSON.parse(init.body);
    if (body.providerOptions !== undefined) throw new Error("gateway pinning must be gone (TypeSafe direct)");
    if (!body.questions?.contradiction) throw new Error("no contradiction question");
    fs.appendFileSync(${JSON.stringify(JEV_CALLS)}, "x\\n");
    const p = Number(process.env.STUB_JEV_P);
    return new Response(JSON.stringify({ answers: { contradiction: { type: "boolean", probability: p } }, providerMetadata: { gateway: { cost: "0.00001" } } }), { status: 200 });
  }
  if (u.includes("/api/chat")) return new Response(JSON.stringify({ message: { content: process.env.STUB_SCREEN || "NO" } }), { status: 200 });
  throw new Error("unexpected fetch " + u);
};
`);

let jevP = 0.03;
let screen = "NO";
const jevCallCount = () => (fs.existsSync(JEV_CALLS) ? fs.readFileSync(JEV_CALLS, "utf8").trim().split("\n").length : 0);

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => {
  jevP = 0.03; screen = "NO";
  fs.rmSync(JEV_CALLS, { force: true });
  fs.rmSync(SHADOW, { recursive: true, force: true });
  fs.rmSync(CLAUDE_COUNT, { force: true });
  fs.writeFileSync(CFG, JSON.stringify({ shadow_days: 7, shadow_until: null, default_threshold: 0.85, sites: {} }));
});

function run(extraEnv = {}) {
  const input = JSON.stringify({ page_id: "plans_next_month", content: "The user is home all next month.", intent: "travel-update" });
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [BIN], {
      env: {
        ...process.env,
        MEMORY_PRECHECK_WIKI_BIN: wikiStub,
        MEMORY_PRECHECK_CLAUDE_BIN: claudeStub,
        MEMORY_PRECHECK_LOG: path.join(tmp, "precheck-log.jsonl"),
        JEV_CONFIG_FILE: CFG, JEV_QUESTIONS_DIR: qdir, JEV_SHADOW_DIR: SHADOW,
        JEV_ENDPOINT: "https://jev.test/v1/evaluate",
        NODE_OPTIONS: `--import ${fetchStub}`,
        STUB_JEV_P: String(jevP), STUB_SCREEN: screen,
        JEV_NO_ALERT: "1", TYPESAFE_API_KEY: "test-key",
        JEV_PRIVATE_SCREEN: "",
        ...extraEnv,
      },
      timeout: 20000,
    }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
    child.stdin.end(input);
  });
}
const claudeRuns = () => (fs.existsSync(CLAUDE_COUNT) ? fs.readFileSync(CLAUDE_COUNT, "utf8").trim().split("\n").length : 0);
const shadowRows = () => fs.readdirSync(SHADOW).filter((f) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f))
  .flatMap((f) => fs.readFileSync(path.join(SHADOW, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));

test("confident Jev save → save; Sonnet runs once as shadow and agrees", async () => {
  const out = await run();
  assert.equal(out.decision, "save");
  assert.match(out.reason, /^jev_consistent/);
  assert.equal(jevCallCount(), 1);
  assert.equal(claudeRuns(), 1, "shadow ran once");
  const [row] = shadowRows();
  assert.equal(row.used, "jev");
  assert.equal(row.agree, true);
});

test("confident Jev conflict → Sonnet detail emitted, Sonnet called only once (memoized)", async () => {
  jevP = 0.97;
  const out = await run({ STUB_SONNET: "conflict" });
  assert.equal(out.decision, "conflict");
  assert.equal(out.conflicts[0].page_id, "reference_plans");
  assert.equal(claudeRuns(), 1);
  assert.equal(shadowRows()[0].agree, true);
});

test("Jev conflict that Sonnet does not confirm → save, disagreement recorded", async () => {
  jevP = 0.97;
  const out = await run();
  assert.equal(out.decision, "save");
  assert.match(out.reason, /^jev_conflict_unconfirmed/);
  const d = fs.readFileSync(path.join(SHADOW, "disagreements.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(d.length, 1);
  assert.equal(d[0].site, "memory-write-precheck");
});

test("shadow week: confident Jev save but Sonnet shadow finds a conflict → conflict wins", async () => {
  jevP = 0.03;
  const out = await run({ STUB_SONNET: "conflict" });
  assert.equal(out.decision, "conflict");
  assert.match(out.reason, /^sonnet_shadow_conflict_over_jev_save/);
  assert.equal(out.conflicts[0].page_id, "reference_plans");
  assert.equal(claudeRuns(), 1);
  const d = fs.readFileSync(path.join(SHADOW, "disagreements.jsonl"), "utf8").trim().split("\n");
  assert.equal(d.length, 1);
});

test("low-confidence Jev → Sonnet decides alone (legacy)", async () => {
  jevP = 0.6;
  const out = await run({ STUB_SONNET: "conflict" });
  assert.equal(out.decision, "conflict");
  assert.equal(claudeRuns(), 1);
  assert.equal(shadowRows()[0].used, "legacy");
});

test("private content (screen YES) never reaches Jev", async () => {
  screen = "YES";
  const out = await run();
  assert.equal(out.decision, "save");
  assert.equal(jevCallCount(), 0);
  assert.ok(shadowRows().some((r) => String(r.reason).startsWith("sensitive-excluded")));
});

test("after the shadow window a confident Jev save costs zero Sonnet calls", async () => {
  fs.writeFileSync(CFG, JSON.stringify({ shadow_days: 7, shadow_until: "2000-01-01T00:00:00Z", default_threshold: 0.85, sites: {} }));
  const out = await run();
  assert.equal(out.decision, "save");
  assert.equal(claudeRuns(), 0);
});

test("no gateway key → exactly the old Sonnet behavior", async () => {
  const out = await run({ TYPESAFE_API_KEY: "", STUB_SONNET: "conflict", HOME: tmp });
  assert.equal(out.decision, "conflict");
  assert.equal(jevCallCount(), 0);
});
