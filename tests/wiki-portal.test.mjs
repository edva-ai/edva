// wiki-portal.test.mjs — the wiki website: the shared portal/renderers
// (lib/wiki-portal.js, wiki-render.js) and the host's server
// (lib/wiki-serve.js): curated topics, scope, the timeline strip, the
// model answer's escaping and citations, and memory search with a scoped
// viewer.
// Run: node --test tests/wiki-portal.test.mjs
//
// Isolated fixture DB; Ollama unreachable (search degrades to FTS + graph);
// `claude` is a stub on a throwaway HOME that records the prompt it was given,
// so the test can prove a scoped viewer's prompt holds only their pages.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-portal-test-"));
const home = path.join(dir, "home");
fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
const PROMPT_LOG = path.join(dir, "prompt.txt");
fs.writeFileSync(
  path.join(home, ".local/bin/claude"),
  `#!/bin/bash\ncat > "${PROMPT_LOG}"\necho '{"answer":"Lunch with Victor <script>x</script> [1], see also [9]."}'\n`,
  { mode: 0o755 },
);
process.env.HOME = home;
process.env.MEMORY_INDEX_DIR = path.join(dir, "memory");
process.env.MEMORY_INDEX_DB = path.join(dir, "memory-index.db");
process.env.MEMORY_DB_AUTHORITATIVE = "1";
process.env.OLLAMA_URL = "http://127.0.0.1:9";
process.env.WIKI_ACCESS_LOG = path.join(dir, "access.jsonl");
process.env.AUTO_RECALL_JUDGE_LOG = path.join(dir, "judge.jsonl");
process.env.WIKI_PORTAL_FILE = path.join(dir, "portal.json");

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ws = require(path.resolve("lib/wiki-store.js"));
const portal = require(path.resolve("lib/wiki-portal.js"));
const render = require(path.resolve("lib/wiki-render.js"));
const serveLib = require(path.resolve("lib/wiki-serve.js"));

const P = (id, type, name, desc, body) =>
  ws.savePage(id, `---\nname: ${name}\ndescription: ${desc}\ntype: ${type}\n---\n${body}\n`, { editedBy: "test" });

let server;
let base;
before(async () => {
  P("user_sam", "user", "Sam", "Sam plans trips", "Plans trips. Loves pastry.");
  P("user_victor_hale", "user", "Victor Hale", "Victor, Northfield club organiser", "Lunch in Northport at [[reference_bistro]].");
  P("reference_bistro", "reference", "Le Petit Bistro", "Bistro near the canal", "Good lunch in Northport.");
  P("travel_hotel_northport", "reference", "Hotel Northport", "Where we stayed in Northport", "Hotel in Northport, near the canal. Lunch nearby.");
  P("travel_hotel_harbor", "reference", "Hotel Harbor", "Where we stayed in Northport", "Harbor hotel.");
  P("project_northfield", "project", "Northfield project", "The Northfield allotment", "With [[user_victor_hale]].");
  P("day_2026-08-03", "day", "Monday in Northport", "Lunch with Victor", "Lunch with [[user_victor_hale|Victor]] in Northport at [[reference_bistro]].");
  P("day_2026-08-04", "day", "Tuesday in Northport", "Pastries", "Pastries in Northport.");
  P("month_2026-08", "month", "August 2026", "Northport", "A month in Northport.");
  fs.writeFileSync(process.env.WIKI_PORTAL_FILE, JSON.stringify({ topics: [
    { slug: "people", name: "People", blurb: "Who is who, including the Northfield plot rota.", ids: ["user_sam", "user_victor_hale"], featured: ["user_victor_hale"] },
    { slug: "travel", name: "Travel", blurb: "Hotels and places.", prefixes: ["travel_"], ids: ["reference_bistro"] },
  ] }));
  server = await serveLib.serve({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  try { server?.close(); } catch {}
  try { ws.closeDb(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (url) =>
  new Promise((resolve, reject) => {
    http.get(base + url, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b, type: res.headers["content-type"] }));
    }).on("error", reject);
  });

const rows = () => ws.db().prepare("SELECT id, type, title, description, status, pinned, updated_at FROM pages").all();

// ── Pure portal logic ───────────────────────────────────────────────────────

test("curated topics claim pages by id and prefix; the rest land in Everything else", () => {
  const config = JSON.parse(fs.readFileSync(process.env.WIKI_PORTAL_FILE, "utf8"));
  const p = portal.resolvePortal({ pages: rows(), config, fullView: true });
  assert.equal(p.curated, true);
  const bySlug = Object.fromEntries(p.topics.map((t) => [t.slug, t]));
  assert.deepEqual(bySlug.travel.pages.map((x) => x.id).sort(), ["reference_bistro", "travel_hotel_harbor", "travel_hotel_northport"]);
  assert.deepEqual(bySlug["everything-else"].pages.map((x) => x.id), ["project_northfield"]);
  assert.ok(!p.topics.some((t) => t.pages.some((x) => x.type === "day")), "episodic pages are the timeline, not a topic");
  assert.equal(bySlug.people.featured[0].id, "user_victor_hale", "curated featured first");
  assert.equal(p.ofPage("travel_hotel_harbor").slug, "travel");
});

test("a scoped view drops topics with nothing visible and never shows blurbs", () => {
  const config = JSON.parse(fs.readFileSync(process.env.WIKI_PORTAL_FILE, "utf8"));
  const visible = rows().filter((x) => x.id.startsWith("travel_"));
  const p = portal.resolvePortal({ pages: visible, config, fullView: false });
  assert.deepEqual(p.topics.map((t) => t.slug), ["travel"]);
  assert.equal(p.topics[0].blurb, "", "a blurb is written for the owner and may mention hidden pages");
  const html = portal.homeBody({ pages: visible, portal: p, fullView: false });
  assert.ok(!html.includes("Northfield"), "nothing from outside the scope reaches the page");
});

test("without a curated file, topics are the page types", () => {
  const p = portal.resolvePortal({ pages: rows(), config: null, fullView: true });
  assert.equal(p.curated, false);
  assert.deepEqual(p.topics.map((t) => t.slug).sort(), ["project", "reference", "user"]);
});

test("checkPortalConfig drops unknown ids and dead prefixes, and enforces coverage", () => {
  const shelf = ["alpha_x", "alpha_y", "b_1", "c_1"];
  const ok = portal.checkPortalConfig({ topics: [
    { slug: "aa", name: "Alpha", ids: ["c_1", "ghost"], prefixes: ["alpha_", "zz_"], featured: ["alpha_x", "b_1"] },
    { slug: "bb", name: "Beta", ids: ["b_1"] },
  ] }, shelf, { minTopics: 2 });
  // One made-up id of three listed is too many to trust the rest blindly.
  assert.deepEqual(ok.errors, ["1 of 3 listed ids do not exist"]);
  assert.deepEqual(ok.config.topics[0].ids, ["c_1"]);
  assert.deepEqual(ok.config.topics[0].prefixes, ["alpha_"]);
  assert.deepEqual(ok.config.topics[0].featured, ["alpha_x"], "featured must sit inside its topic");
  const thin = portal.checkPortalConfig({ topics: [{ slug: "aa", name: "Alpha", ids: ["c_1"] }] }, shelf, { minTopics: 1 });
  assert.ok(thin.errors.some((e) => e.includes("cover")));
  const bad = portal.checkPortalConfig({ topics: [{ slug: "Bad Slug!", name: "Alpha", ids: ["c_1"] }] }, shelf, { minTopics: 1 });
  assert.ok(bad.errors.some((e) => e.includes("slug")));
});

test("the days strip has one cell per calendar day and links the days that have pages", () => {
  const months = portal.timelineMonths(rows());
  assert.equal(months.length, 1);
  assert.equal(months[0].label, "Aug 2026");
  assert.equal(months[0].monthPage.id, "month_2026-08");
  const html = portal.timelineBody({ pages: rows() });
  assert.equal((html.match(/<a href="\/p\/day_/g) || []).length, 2);
  assert.ok(html.includes('href="/p/month_2026-08"'));
});

test("the model's answer is escaped, and only real [n] sources become links", () => {
  const html = portal.answerHtml({
    answer: 'Lunch with Victor <img src=x onerror=alert(1)> [1] and [7].',
    sources: [{ n: 1, id: "day_2026-08-03", title: "Monday in Northport" }],
  });
  assert.ok(!html.includes("<img"), "model text never becomes markup");
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('class="cite" href="/p/day_2026-08-03"'));
  assert.ok(!html.includes("[7]") && !html.includes(">7<"), "a citation naming no source is dropped");
});

test("a bare [[id]] renders as the page title when the title is known", () => {
  const out = render.renderInline("See [[project_northfield]] and [[x_y|Shown]].", { labelFor: (id) => (id === "project_northfield" ? "Northfield & co" : null) });
  assert.ok(out.includes(">Northfield &amp; co</a>"));
  assert.ok(out.includes(">Shown</a>"));
});

// ── The host's server ───────────────────────────────────────────────────────

test("every view renders, with the new shell and no internal stack on errors", async () => {
  for (const [url, status] of [["/", 200], ["/t/travel", 200], ["/timeline", 200], ["/p/user_victor_hale", 200], ["/?pinned=1", 200], ["/?type=reference", 200], ["/p/nope", 404], ["/t/nope", 404]]) {
    const r = await get(url);
    assert.equal(r.status, status, url);
    assert.ok(r.body.includes('class="bar"') && r.body.includes("Ask your memory"), `${url} uses the shell`);
  }
  const home = await get("/");
  assert.ok(home.body.includes("What would you like to remember?"));
  assert.ok(home.body.includes('href="/t/people"') && home.body.includes("Days remembered"));
  const pageView = await get("/p/user_victor_hale");
  assert.ok(pageView.body.includes(">Le Petit Bistro</a>"), "a bare wikilink shows its page title");
  assert.ok(pageView.body.includes('id="related"'), "the connected-in-memory panel is wired");
});

test("search goes through memory retrieval and loads the model's answer", async () => {
  const r = await get("/search?q=" + encodeURIComponent("where did we have lunch in northport"));
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('id="answer"') && r.body.includes("/api/ask"), "the answer panel is on the page");
  assert.ok(r.body.includes("Monday in Northport"), "the day page is found");
  const ask = await get("/api/ask?q=" + encodeURIComponent("where did we have lunch in northport"));
  assert.equal(ask.status, 200);
  const j = JSON.parse(ask.body);
  assert.ok(j.html.includes('class="cite"'));
  assert.ok(!j.html.includes("<script>"), "the answer is escaped");
  assert.ok(fs.readFileSync(PROMPT_LOG, "utf8").includes("SOURCES:"));
  const rel = await get("/api/related?id=user_victor_hale");
  assert.equal(rel.status, 200);
  assert.ok(JSON.parse(rel.body).html.includes("/p/"));
});

test("a scoped viewer's search and the model's prompt hold only pages they may read", async () => {
  const ctx = { canSee: (id) => id.startsWith("travel_"), key: "Sam", viewer: "Sam", fullView: false };
  const { results, connected } = await serveLib._memorySearch("lunch in northport", ctx);
  assert.ok(results.length && results.every((r) => r.id.startsWith("travel_")));
  assert.ok(connected.every((r) => r.id.startsWith("travel_")));
  fs.rmSync(PROMPT_LOG, { force: true });
  await serveLib._memoryAnswer("lunch in northport", ctx);
  const prompt = fs.readFileSync(PROMPT_LOG, "utf8");
  assert.ok(prompt.includes("Hotel Northport"));
  assert.ok(!prompt.includes("Victor") && !prompt.includes("Monday in Northport") && !prompt.includes("Bistro"),
    "no out-of-scope page reaches the model");
  assert.ok(prompt.includes("Sam is asking"));
});

test("the ask API refuses an empty question", async () => {
  const r = await get("/api/ask?q=");
  assert.equal(r.status, 400);
  assert.ok(r.type.includes("application/json"));
});
