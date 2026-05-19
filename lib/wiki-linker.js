"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const ws = require("./wiki-store.js");

const DEFAULT_CONCEPTS_PATH = path.join(
  os.homedir(),
  "dev/merlin/data/wiki-link-concepts.json",
);

function loadConcepts({ conceptsPath = DEFAULT_CONCEPTS_PATH } = {}) {
  const raw = fs.readFileSync(conceptsPath, "utf8");
  const data = JSON.parse(raw);
  const concepts = Array.isArray(data.concepts) ? data.concepts : [];
  return concepts
    .filter((c) => c && c.target && Array.isArray(c.aliases))
    .map((c) => ({
      target: ws.basenameToId(String(c.target)),
      aliases: [...new Set(c.aliases.map((a) => String(a)).filter(Boolean))],
      exclude_phrases: Array.isArray(c.exclude_phrases)
        ? [...new Set(c.exclude_phrases.map((p) => String(p)).filter(Boolean))]
        : [],
    }))
    .filter((c) => c.aliases.length);
}

function maskExcludes(text, excludePhrases) {
  if (!excludePhrases || !excludePhrases.length) return text;
  let out = text;
  for (const phrase of excludePhrases) {
    const re = new RegExp(escapeRe(phrase), "g");
    out = out.replace(re, (m) => " ".repeat(m.length));
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasRegex(alias) {
  const wordy = /^[A-Za-z0-9]/.test(alias) && /[A-Za-z0-9]$/.test(alias);
  const left = wordy ? "(?<![A-Za-z0-9_])" : "";
  const right = wordy ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(`${left}${escapeRe(alias)}${right}`);
}

function splitProtected(s) {
  const re = /(```[\s\S]*?```|`[^`\n]*`|\[\[[\s\S]*?\]\]|\[[^\]\n]+\]\([^\)\n]+\))/g;
  const out = [];
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), protected: false });
    out.push({ text: m[0], protected: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), protected: false });
  return out;
}

function existingTargets(body) {
  const targets = new Set();
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
    targets.add(ws.basenameToId(m[1].trim()));
  }
  return targets;
}

function firstAliasHit(body, aliases, excludePhrases = []) {
  const sorted = [...aliases].sort((a, b) => b.length - a.length);
  for (const alias of sorted) {
    for (const segment of splitProtected(body)) {
      if (segment.protected) continue;
      const masked = maskExcludes(segment.text, excludePhrases);
      const match = masked.match(aliasRegex(alias));
      if (match) return alias;
    }
  }
  return null;
}

function suggestPage(row, concepts) {
  const { body } = ws.splitFrontmatter(row.raw_md);
  const linked = existingTargets(body);
  const suggestions = [];
  for (const concept of concepts) {
    if (concept.target === row.id) continue;
    if (linked.has(concept.target)) continue;
    const alias = firstAliasHit(body, concept.aliases, concept.exclude_phrases);
    if (!alias) continue;
    suggestions.push({
      page_id: row.id,
      basename: row.basename,
      target: concept.target,
      alias,
      replacement: `[[${concept.target}|${alias}]]`,
    });
  }
  return suggestions;
}

function suggestLinks({ id = null, conceptsPath = DEFAULT_CONCEPTS_PATH } = {}) {
  const concepts = loadConcepts({ conceptsPath });
  const rows = id ? [ws.getPage(id)].filter(Boolean) : ws.listPages({ status: "active" }).map((p) => ws.getPage(p.id));
  const suggestions = [];
  for (const row of rows) suggestions.push(...suggestPage(row, concepts));
  return suggestions;
}

function applySuggestions({ id = null, conceptsPath = DEFAULT_CONCEPTS_PATH, editedBy = "wiki-link-audit" } = {}) {
  const concepts = loadConcepts({ conceptsPath });
  const rows = id ? [ws.getPage(id)].filter(Boolean) : ws.listPages({ status: "active" }).map((p) => ws.getPage(p.id));
  const changed = [];
  for (const row of rows) {
    const { frontmatterText, body } = ws.splitFrontmatter(row.raw_md);
    const linked = existingTargets(body);
    let nextBody = body;
    const added = [];
    for (const concept of concepts) {
      if (concept.target === row.id) continue;
      if (linked.has(concept.target)) continue;
      const sorted = [...concept.aliases].sort((a, b) => b.length - a.length);
      let didLink = false;
      for (const alias of sorted) {
        const segments = splitProtected(nextBody);
        for (const segment of segments) {
          if (segment.protected) continue;
          const masked = maskExcludes(segment.text, concept.exclude_phrases);
          const m = masked.match(aliasRegex(alias));
          if (!m) continue;
          const start = masked.indexOf(m[0]);
          const end = start + m[0].length;
          const next =
            segment.text.slice(0, start) +
            `[[${concept.target}|${alias}]]` +
            segment.text.slice(end);
          segment.text = next;
          nextBody = segments.map((s) => s.text).join("");
          linked.add(concept.target);
          added.push({ target: concept.target, alias });
          didLink = true;
          break;
        }
        if (didLink) break;
      }
    }
    if (!added.length) continue;
    const raw = frontmatterText == null ? nextBody : `---\n${frontmatterText}\n---\n${nextBody}`;
    const out = ws.savePage(row.id, raw, { editedBy });
    changed.push({ id: row.id, basename: row.basename, rev: out.rev, added });
  }
  return changed;
}

function summarize(suggestions) {
  const byPage = new Map();
  const byTarget = new Map();
  for (const s of suggestions) {
    byPage.set(s.page_id, (byPage.get(s.page_id) || 0) + 1);
    byTarget.set(s.target, (byTarget.get(s.target) || 0) + 1);
  }
  return {
    total: suggestions.length,
    pages: byPage.size,
    targets: byTarget.size,
    byPage: Object.fromEntries([...byPage.entries()].sort()),
    byTarget: Object.fromEntries([...byTarget.entries()].sort()),
  };
}

module.exports = {
  DEFAULT_CONCEPTS_PATH,
  loadConcepts,
  suggestLinks,
  applySuggestions,
  summarize,
  splitProtected,
  existingTargets,
};
