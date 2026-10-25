// wiki-assoc-writers.test.mjs — the nightly writers that feed associative
// recall: Hebbian co-retrieval weights (wiki-hebbian.mjs), ACT-R base-level
// activation (wiki-activation.mjs) and typed fact edges (wiki-facts.mjs), plus
// the grounding check and ladder they share (model-ladder.mjs, quote-check.mjs).
// Run: node --test tests/wiki-assoc-writers.test.mjs
//
// Isolated fixture DB and log files; no Ollama, no `claude -p` — the model
// rungs are plain async functions here.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-assoc-writers-"));
fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
process.env.MEMORY_INDEX_DIR = path.join(dir, "memory");
process.env.MEMORY_INDEX_DB = path.join(dir, "memory-index.db");
process.env.MEMORY_DB_AUTHORITATIVE = "1";
const JUDGE = path.join(dir, "judge.jsonl");
const ACCESS = path.join(dir, "access.jsonl");
process.env.AUTO_RECALL_JUDGE_LOG = JUDGE;
process.env.WIKI_ACCESS_LOG = ACCESS;
// The owner's own page id (wiki-facts.mjs reads it at load).
process.env.WIKI_OWNER_PAGE = "user_owner";

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ws = require(path.resolve("lib/wiki-store.js"));
const H = await import(path.resolve("lib/wiki-hebbian.mjs"));
const ACT = await import(path.resolve("lib/wiki-activation.mjs"));
const F = await import(path.resolve("lib/wiki-facts.mjs"));
const L = await import(path.resolve("lib/model-ladder.mjs"));
const { quoteIn } = await import(path.resolve("lib/quote-check.mjs"));
const { openMemoryDb, closeMemoryDb, keptWikiIds } = await import(path.resolve("lib/memory-db.mjs"));
const A = await import(path.resolve("lib/wiki-assoc.mjs"));

const page = (id, type, desc, body) => `---\nname: ${id}\ndescription: ${desc}\ntype: ${type}\n---\n${body}\n`;

before(() => {
  ws.savePage("user_maya", page("user_maya", "user", "Maya Stone", "Alex's cousin. Married to [[user_ben]]. Works at [[project_acme]]. She avoids cilantro."), { editedBy: "test" });
  ws.savePage("user_ben", page("user_ben", "user", "Ben", "Maya's husband. Loves jazz."), { editedBy: "test" });
  ws.savePage("project_acme", page("project_acme", "project", "Acme", "A company."), { editedBy: "test" });
  ws.savePage("project_globex", page("project_globex", "project", "Globex", "Another company."), { editedBy: "test" });
  ws.savePage("user_food", page("user_food", "user", "Food", "Margherita pizza."), { editedBy: "test" });
  ws.savePage("user_travel", page("user_travel", "user", "Travel", "Window seats."), { editedBy: "test" });
  ws.savePage("project_initech", page("project_initech", "project", "Initech", "Never used."), { editedBy: "test" });
});

after(() => {
  closeMemoryDb();
  try { ws.closeDb(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

const judgeRow = (ts, keptIds, extra = []) => {
  const candidates = [...keptIds, ...extra].map((id, i) => ({ i, source: "wiki", id }));
  return JSON.stringify({ ts, kept: keptIds.map((_, i) => i), candidates });
};

// ── shared helpers ──────────────────────────────────────────────────────────

test("keptWikiIds takes only KEPT wiki candidates, never other sources or rejects", () => {
  const row = {
    kept: [0, 2],
    candidates: [
      { i: 0, source: "wiki", id: "user_food" },
      { i: 1, source: "wiki", id: "user_travel" },
      { i: 2, source: "chat", id: "msg_1" },
    ],
  };
  assert.deepEqual(keptWikiIds(row), ["user_food"]);
  assert.deepEqual(keptWikiIds({}), []);
});

test("quoteIn: verbatim modulo case and whitespace; short or absent quotes fail", () => {
  assert.equal(quoteIn("AVOIDS\n  cilantro", "She avoids cilantro."), true);
  assert.equal(quoteIn("avoids peanuts", "She avoids cilantro."), false);
  assert.equal(quoteIn("she", "She avoids cilantro."), false, "too short to mean anything");
  assert.equal(quoteIn(null, "x"), false);
});

test("runLadder climbs only on validation failure, and honours the Sonnet budget", async () => {
  const local = async () => '{"ok": false}';
  local.rungName = "local";
  let sonnetCalls = 0;
  const sonnet = async () => { sonnetCalls++; return 'sure: {"ok": true}'; };
  sonnet.rungName = "sonnet";
  const validate = (p) => (p.ok ? null : "not ok");
  const r = await L.runLadder("x", { rungs: [local, sonnet], validate });
  assert.equal(r.rung, "sonnet");
  assert.deepEqual(r.value, { ok: true });
  const budget = { sonnet: 1 };
  await L.runLadder("x", { rungs: [local, sonnet], validate, budget });
  const spent = await L.runLadder("x", { rungs: [local, sonnet], validate, budget });
  assert.equal(spent.value, null, "budget spent → no answer, no call");
  assert.equal(sonnetCalls, 2);
  const ok = async () => '{"ok": true}';
  ok.rungName = "local";
  const first = await L.runLadder("x", { rungs: [ok, sonnet], validate });
  assert.equal(first.rung, "local");
  assert.equal(sonnetCalls, 2, "a passing local rung never escalates");
});

// ── Hebbian ─────────────────────────────────────────────────────────────────

test("pages kept together are wired together, and the cursor makes it idempotent", () => {
  fs.writeFileSync(JUDGE, [
    judgeRow("2026-10-20T10:00:00.000Z", ["user_food", "user_travel"]),
    judgeRow("2026-10-21T10:00:00.000Z", ["user_food", "user_travel"]),
    judgeRow("2026-10-21T11:00:00.000Z", ["user_food"]), // one page: no pair
    "{torn line",
  ].join("\n") + "\n");
  const now = Date.parse("2026-10-21T12:00:00Z");
  const r1 = H.updateCoactivation({ now });
  assert.equal(r1.rows_used, 2);
  assert.equal(r1.pairs_updated, 2);
  const p = H.partnersOf("user_food", { now });
  assert.equal(p[0].id, "user_travel");
  assert.ok(p[0].weight > 0.19 && p[0].weight < 0.2, `two co-uses ≈ 2η with a day of decay (got ${p[0].weight})`);
  const r2 = H.updateCoactivation({ now });
  assert.equal(r2.rows_read, 0, "nothing re-read past the cursor");
  assert.equal(H.partnersOf("user_food", { now })[0].n, 2);
});

test("a broad message keeping many pages wires nothing (noise guard)", () => {
  fs.appendFileSync(JUDGE, judgeRow("2026-10-22T10:00:00.000Z",
    ["user_food", "user_travel", "user_maya", "user_ben", "project_acme", "project_globex", "x1"]) + "\n");
  const r = H.updateCoactivation({ now: Date.parse("2026-10-22T12:00:00Z") });
  assert.equal(r.rows_used, 0);
});

test("link candidates are strong co-used pairs with NO link, carrying both titles", () => {
  for (let i = 0; i < 3; i++) {
    fs.appendFileSync(JUDGE, judgeRow(`2026-10-23T1${i}:00:00.000Z`, ["user_food", "user_travel"]) + "\n");
    fs.appendFileSync(JUDGE, judgeRow(`2026-10-23T1${i}:30:00.000Z`, ["user_maya", "user_ben"]) + "\n");
  }
  const now = Date.parse("2026-10-23T23:00:00Z");
  H.updateCoactivation({ now });
  const c = H.linkCandidates({ min: 0.3, now });
  const ids = c.map((x) => [x.a, x.b].join("+"));
  assert.ok(ids.includes("user_food+user_travel"), "unlinked and strong → proposed");
  assert.ok(!ids.some((x) => x.includes("user_ben")), "already linked → not proposed");
  assert.ok(c[0].a_title && c[0].b_title);
});

test("the association graph reads the Hebbian weight as an edge", () => {
  const d = openMemoryDb();
  const g = A.buildAssocGraph(A.loadAssocGraphRows(d, { now: Date.parse("2026-10-23T23:00:00Z") }));
  const e = g.adj[g.idx.get("user_food")].find((x) => x.j === g.idx.get("user_travel"));
  assert.ok(e, "co-use with no link becomes a weak edge");
  assert.equal(e.kind, "hebbian");
});

// ── Base-level activation ───────────────────────────────────────────────────

test("baseLevel: more and more recent uses → higher; Petrov's tail tracks the exact sum", () => {
  const recent = ACT.baseLevel([0.5, 1, 2]);
  const old = ACT.baseLevel([30, 60, 90]);
  const many = ACT.baseLevel([0.5, 1, 2, 3, 4]);
  assert.ok(recent > old);
  assert.ok(many > recent);
  assert.equal(ACT.baseLevel([]), null);
  const ages = Array.from({ length: 200 }, (_, i) => 1 + i * 0.5);
  const exact = Math.log(ages.reduce((s, t) => s + Math.pow(t, -0.5), 0));
  assert.ok(Math.abs(ACT.baseLevel(ages) - exact) < 0.05, "approximation within 0.05 of the exact sum");
});

test("activation counts judge-kept recalls and deliberate reads — never search hits", () => {
  fs.writeFileSync(ACCESS, [
    JSON.stringify({ ts: "2026-10-23T09:00:00.000Z", tool: "wiki_read", page_ids: ["project_globex"], caller: "mcp" }),
    JSON.stringify({ ts: "2026-10-23T09:00:00.000Z", tool: "wiki_search", page_ids: ["project_initech"], caller: "mcp" }),
    JSON.stringify({ ts: "2026-10-23T09:00:00.000Z", tool: "wiki_read", page_ids: ["project_initech"], caller: "cli" }),
  ].join("\n") + "\n");
  const r = ACT.updateActivation({ now: Date.parse("2026-10-24T00:00:00Z") });
  assert.ok(r.pages >= 3);
  const top = ACT.topActivation({ limit: 50 }).map((x) => x.page_id);
  assert.ok(top.includes("user_food"), "judge-kept");
  assert.ok(top.includes("project_globex"), "mcp wiki_read");
  assert.ok(!top.includes("project_initech"), "a search hit and a CLI read are not uses");
});

// ── Facts ───────────────────────────────────────────────────────────────────

const rung = (name, reply) => {
  const fn = async () => (typeof reply === "function" ? reply() : reply);
  fn.rungName = name;
  return fn;
};
const factsJson = (facts) => JSON.stringify({ facts });

test("fact validation: known ids, known relations, and a quote from the page", () => {
  const allowed = new Set(["user_maya", "user_ben", "project_acme"]);
  const source = "Alex's cousin. Married to [[user_ben]]. Works at [[project_acme]]. She avoids cilantro.";
  const { good, bad } = F.checkFacts({ facts: [
    { subject: "user_maya", rel: "spouse_of", object: "user_ben", fact: "Maya is married to Ben.", evidence: "Married to [[user_ben]]" },
    { subject: "user_maya", rel: "avoids", object: null, fact: "Maya avoids cilantro.", evidence: "avoids cilantro" },
    { subject: "user_maya", rel: "works_at", object: "project_nope", fact: "Maya works at Nope.", evidence: "Works at" },
    { subject: "user_maya", rel: "admires", object: "user_ben", fact: "Maya admires Ben.", evidence: "Married to" },
    { subject: "user_maya", rel: "likes", object: null, fact: "Maya likes skiing a lot.", evidence: "she loves skiing" },
  ] }, { allowed, source });
  assert.equal(good.length, 2);
  assert.equal(bad.length, 3);
  assert.ok(bad.some((b) => b.includes("unknown object")));
  assert.ok(bad.some((b) => b.includes("unknown rel")));
  assert.ok(bad.some((b) => b.includes("evidence")));
  assert.ok(F.validateFactReply({ facts: [] }, { allowed, source }) == null, "no facts is a fine answer");
});

test("extraction climbs past an inventing local rung, writes facts, and the graph gets typed edges", async () => {
  const local = rung("local", factsJson([
    { subject: "user_maya", rel: "likes", object: null, fact: "Maya likes opera music.", evidence: "she adores opera" },
  ]));
  const sonnet = rung("sonnet", factsJson([
    { subject: "user_maya", rel: "spouse_of", object: "user_ben", fact: "Maya is married to Ben.", evidence: "Married to [[user_ben]]" },
    { subject: "user_maya", rel: "works_at", object: "project_acme", fact: "Maya works at Acme.", evidence: "Works at [[project_acme]]" },
    { subject: "user_maya", rel: "avoids", object: null, fact: "Maya avoids cilantro.", evidence: "avoids cilantro" },
  ]));
  const emb = async (t) => [t.length % 7, 1, 2];
  const r = await F.extractPendingFacts({ rungs: [local, sonnet], embedFn: emb, types: ["user"], limit: 10 });
  assert.ok(r.by_rung.sonnet >= 1);
  const facts = F.factsForPage("user_maya");
  assert.equal(facts.filter((f) => f.src_id === "user_maya").length, 3);
  assert.equal(F.factStats().missing_vectors, 0, "embedded in the same pass");
  const g = A.buildAssocGraph(A.loadAssocGraphRows(openMemoryDb()));
  const e = g.adj[g.idx.get("user_ben")].find((x) => x.j === g.idx.get("user_maya"));
  assert.equal(e.kind, "fact:spouse_of");
  // The canned replies only fit Maya's page; every other page's ladder failed
  // validation and must stay pending — but Maya, unchanged, must not.
  const pending = F.pendingFactPages(openMemoryDb(), { types: ["user"] }).map((p) => p.id);
  assert.ok(!pending.includes("user_maya"), "an unchanged, extracted page is not re-extracted");
  assert.ok(pending.includes("user_ben"), "a page no rung could ground stays pending");
});

test("a page that no longer says it expires the fact; a new one-valued fact supersedes the old", async () => {
  ws.savePage("user_maya", page("user_maya", "user", "Maya Stone",
    "Alex's cousin. Married to [[user_ben]]. Now works at [[project_globex]]."), { editedBy: "test" });
  const sonnet = rung("sonnet", factsJson([
    { subject: "user_maya", rel: "spouse_of", object: "user_ben", fact: "Maya is married to Ben.", evidence: "Married to [[user_ben]]" },
    { subject: "user_maya", rel: "works_at", object: "project_globex", fact: "Maya works at Globex.", evidence: "Now works at [[project_globex]]" },
  ]));
  const r = await F.extractPendingFacts({ rungs: [sonnet], types: ["user"], limit: 10 });
  assert.equal(r.extracted, 1);
  const current = F.factsForPage("user_maya").filter((f) => f.src_id === "user_maya");
  assert.deepEqual(current.map((f) => f.rel).sort(), ["spouse_of", "works_at"]);
  assert.equal(current.find((f) => f.rel === "works_at").dst_id, "project_globex");
  const all = F.factsForPage("user_maya", { includeExpired: true });
  const acme = all.find((f) => f.dst_id === "project_acme");
  assert.ok(acme.expired_at, "the old job is kept, not deleted, and is no longer current");
  assert.ok(acme.superseded_by, "and it records what replaced it");
  const allergy = all.find((f) => f.rel === "avoids");
  assert.ok(allergy.expired_at && !allergy.superseded_by, "dropped from the page → expired, not superseded");
  assert.equal(F.factsForPage("user_maya").filter((f) => f.rel === "spouse_of").length, 1, "kept fact not duplicated");
});

test("a page whose ladder produces nothing is not marked done, so it is retried", async () => {
  ws.savePage("project_acme", page("project_acme", "project", "Acme", "A company in town. Founded by [[user_ben]]."), { editedBy: "test" });
  const broken = rung("local", "no json here");
  const r = await F.extractPendingFacts({ rungs: [broken], types: ["project"], limit: 10 });
  assert.ok(r.failed >= 1);
  assert.ok(F.pendingFactPages(openMemoryDb(), { types: ["project"] }).some((p) => p.id === "project_acme"));
});

test("the owner's page is a known id even when the page does not link it", async () => {
  ws.savePage("user_owner", page("user_owner", "user", "Alex Rivers", "The owner of this memory."), { editedBy: "test" });
  ws.savePage("user_ruth", page("user_ruth", "user", "Ruth", "Alex's sister. Lives in Springfield."), { editedBy: "test" });
  let promptSeen = "";
  const sonnet = async (prompt) => {
    if (prompt.includes("PAGE user_ruth")) promptSeen = prompt;
    return factsJson([{ subject: "user_ruth", rel: "sibling_of", object: "user_owner", fact: "Ruth is Alex's sister.", evidence: "Alex's sister" }]);
  };
  sonnet.rungName = "sonnet";
  await F.extractPendingFacts({ rungs: [sonnet], types: ["user"], limit: 20 });
  const known = promptSeen.slice(promptSeen.indexOf("KNOWN PAGES:"), promptSeen.indexOf("PAGE user_ruth"));
  assert.ok(known.includes("\nuser_owner — "), "listed under KNOWN PAGES");
  const facts = F.factsForPage("user_ruth").filter((f) => f.src_id === "user_ruth");
  assert.deepEqual(facts.map((f) => [f.rel, f.dst_id]), [["sibling_of", "user_owner"]]);
});
