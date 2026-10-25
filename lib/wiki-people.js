"use strict";

// wiki-people — the graph side of "every person the user knows has a page".
//
// A person page is any active page whose frontmatter has `entity: person`;
// a hub is `entity: people-hub` (user_family, user_colleagues, …) —
// a directory of people that links out to their pages. This module only
// does geometry over the link graph and the concept map: which person
// links are one-way, which people have no page in the concept map, which
// aliases collide, and exact `[[from|Display]]` → `[[to|Display]]` link
// rewrites. Deciding who a mention refers to is the weekly
// wiki-link-weave job's model, never this code.

const fs = require("node:fs");
const ws = require("./wiki-store.js");
const linker = require("./wiki-linker.js");

const EPISODIC_TYPES = new Set(["day", "week", "month"]);

function entityOf(row) {
  try {
    return JSON.parse(row.frontmatter_json || "{}").entity || null;
  } catch {
    return null;
  }
}

function pagesByEntity() {
  const people = [];
  const hubs = [];
  for (const p of ws.listPages({ status: "active" })) {
    const row = ws.getPage(p.id);
    const entity = entityOf(row);
    if (entity === "person") people.push(row);
    else if (entity === "people-hub") hubs.push(row);
  }
  return { people, hubs };
}

function forwardTargets(id) {
  return new Set(ws.getForwardLinks(id).map((l) => ws.basenameToId(String(l.dst_id).split("#")[0])));
}

// Person→person links that only go one way. A hub page is not a person,
// so a hub listing someone never demands a link back from them.
function asymmetricLinks(people) {
  const ids = new Set(people.map((p) => p.id));
  const out = new Map(people.map((p) => [p.id, forwardTargets(p.id)]));
  const missing = [];
  for (const p of people) {
    for (const dst of out.get(p.id)) {
      if (dst === p.id || !ids.has(dst)) continue;
      if (!out.get(dst).has(p.id)) missing.push({ from: p.id, to: dst, need: `${dst} → ${p.id}` });
    }
  }
  return missing;
}

function conceptTargets(conceptsPath) {
  const map = new Map();
  for (const c of linker.loadConcepts({ conceptsPath, includeEmpty: true })) map.set(c.target, c);
  return map;
}

// Aliases two or more concepts claim. loadConcepts already demotes them to
// ambiguous so the nightly linker skips them; this lists them so the weave
// job can disambiguate the mentions by hand.
function aliasCollisions(conceptsPath) {
  const raw = JSON.parse(fs.readFileSync(conceptsPath, "utf8"));
  const claims = new Map();
  for (const c of raw.concepts || []) {
    for (const a of [...(c.aliases || []), ...(c.ambiguous_aliases || [])]) {
      if (!claims.has(a)) claims.set(a, new Set());
      claims.get(a).add(ws.basenameToId(String(c.target)));
    }
  }
  return [...claims.entries()]
    .filter(([, targets]) => targets.size > 1)
    .map(([alias, targets]) => ({ alias, targets: [...targets].sort() }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

// Non-episodic active pages nothing links to.
function orphans() {
  const out = [];
  for (const p of ws.listPages({ status: "active" })) {
    if (EPISODIC_TYPES.has(p.type) || p.id === "MEMORY") continue;
    if (!ws.getBacklinks(p.id).some((b) => b.src_id !== p.id)) out.push(p.id);
  }
  return out;
}

function audit({ conceptsPath = linker.DEFAULT_CONCEPTS_PATH } = {}) {
  const { people, hubs } = pagesByEntity();
  const concepts = conceptTargets(conceptsPath);
  const personIds = new Set(people.map((p) => p.id));
  return {
    people: people.map((p) => ({
      id: p.id,
      title: p.title,
      inbound: ws.getBacklinks(p.id).filter((b) => b.src_id !== p.id).length,
      aliases: concepts.get(p.id)?.aliases || [],
      ambiguous_aliases: concepts.get(p.id)?.ambiguous_aliases || [],
    })),
    hubs: hubs.map((h) => ({
      id: h.id,
      people_linked: [...forwardTargets(h.id)].filter((t) => personIds.has(t)).length,
    })),
    asymmetric: asymmetricLinks(people),
    not_in_concepts: people.filter((p) => !concepts.has(p.id)).map((p) => p.id),
    no_safe_alias: people
      .filter((p) => concepts.has(p.id) && !concepts.get(p.id).aliases.length)
      .map((p) => p.id),
    collisions: aliasCollisions(conceptsPath),
    orphans: orphans(),
  };
}

// Idempotent upsert of one concept-map entry. `aliases` are safe for the
// nightly linker (a full name, a unique nickname); `ambiguous` are names
// only a model may resolve.
function addConcept({ target, aliases = [], ambiguous = [], conceptsPath = linker.DEFAULT_CONCEPTS_PATH }) {
  if (!target) throw new Error("addConcept: target required");
  const id = ws.basenameToId(String(target));
  if (!ws.getPage(id)) throw new Error(`addConcept: no page ${id}`);
  const data = JSON.parse(fs.readFileSync(conceptsPath, "utf8"));
  data.concepts = Array.isArray(data.concepts) ? data.concepts : [];
  let entry = data.concepts.find((c) => ws.basenameToId(String(c.target)) === id);
  const before = JSON.stringify(entry || null);
  if (!entry) {
    entry = { target: id, aliases: [] };
    data.concepts.push(entry);
  }
  entry.aliases = [...new Set([...(entry.aliases || []), ...aliases])].filter((a) => !ambiguous.includes(a));
  const amb = [...new Set([...(entry.ambiguous_aliases || []), ...ambiguous])];
  if (amb.length) entry.ambiguous_aliases = amb;
  const changed = JSON.stringify(entry) !== before;
  if (changed) {
    const tmp = `${conceptsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmp, conceptsPath);
  }
  return { target: id, changed, entry };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Rewrite links to `from` whose display text is exactly `display` so they
// point at `to` — e.g. `[[user_family|<Name>]]` → `[[user_<first>_<last>|<Name>]]`
// once that person has their own page. Matches link syntax only, never prose.
function retarget({ from, to, display, dryRun = false, editedBy = "wiki-people:retarget" }) {
  if (!from || !to || !display) throw new Error("retarget: from, to and display required");
  if (!ws.getPage(to)) throw new Error(`retarget: no page ${to}`);
  const re = new RegExp(`\\[\\[${escapeRe(from)}(?:#[^\\]|]*)?\\|${escapeRe(display)}\\]\\]`, "g");
  const changed = [];
  for (const b of ws.getBacklinks(from)) {
    if (b.src_id === to || changed.some((c) => c.id === b.src_id)) continue;
    const row = ws.getPage(b.src_id);
    if (!row || row.status !== "active") continue;
    const next = row.raw_md.replace(re, `[[${to}|${display}]]`);
    if (next === row.raw_md) continue;
    const count = row.raw_md.match(re).length;
    if (!dryRun) ws.savePage(row.id, next, { editedBy });
    changed.push({ id: row.id, count });
  }
  return changed;
}

module.exports = {
  entityOf,
  pagesByEntity,
  asymmetricLinks,
  aliasCollisions,
  orphans,
  audit,
  addConcept,
  retarget,
};
