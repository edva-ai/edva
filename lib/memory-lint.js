// memory-lint.js — structural + scope linter for the auto-memory corpus.
//
// Runs after the index is populated (reads file_meta, memory_links,
// supersession, entities, chunk_entities) and surfaces anti-patterns that
// the earlier prose-based system couldn't catch:
//
//   - dangling wikilinks      : [[foo]] where foo.md doesn't exist
//   - dangling related        : frontmatter `related: [x]` with x missing
//   - dangling supersedes     : frontmatter `supersedes: [x]` with x missing
//   - unknown entity id       : `scope: [bogus]` where bogus isn't in registry
//   - scope conflict          : file mentions entity E whose scope excludes
//                               the file's declared scope (the pulse-Bug of
//                               2026-04-20 that motivated v2)
//   - supersession stale      : file A supersedes B but B still status=active
//   - orphan project/feedback : project/feedback file with zero links, no
//                               scope, no entity mentions — likely dead
//
// Lint is read-only. A later `--fix-safe` pass could auto-normalize
// frontmatter arrays, but most findings need human judgement.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ms = require("./memory-store.js");

const SEVERITIES = ["error", "warning", "info"];

function mkIssue(severity, file, check, message, extra = {}) {
  return { severity, file, check, message, ...extra };
}

function listFiles() {
  return ms
    .listMemoryFiles()
    .map((abs) => path.basename(abs))
    .sort();
}

function loadFileMetaMap(d) {
  const rows = d.prepare("SELECT * FROM file_meta").all();
  const m = new Map();
  for (const r of rows) m.set(r.basename, r);
  return m;
}

function danglingLinks(d, files) {
  const fileSet = new Set(files);
  const rows = d.prepare("SELECT src, dst, link_type FROM memory_links").all();
  const issues = [];
  for (const r of rows) {
    if (fileSet.has(r.dst)) continue;
    const sev = r.link_type === "fm-supersedes" ? "error" : "warning";
    const label =
      r.link_type === "body"
        ? "wikilink"
        : r.link_type === "fm-related"
          ? "related:"
          : "supersedes:";
    issues.push(
      mkIssue(
        sev,
        r.src,
        "dangling-link",
        `${label} → \`${r.dst}\` does not exist`,
        { link_type: r.link_type, target: r.dst },
      ),
    );
  }
  return issues;
}

function unknownEntities(fileMetaMap, registry) {
  const known = new Set(Object.keys(registry.entities || {}));
  const issues = [];
  for (const [basename, meta] of fileMetaMap) {
    const scope = JSON.parse(meta.scope_json || "[]");
    for (const s of scope) {
      if (!known.has(s)) {
        issues.push(
          mkIssue(
            "error",
            basename,
            "unknown-entity",
            `scope references unknown entity id \`${s}\``,
            { entity_id: s },
          ),
        );
      }
    }
  }
  return issues;
}

// Scope conflict: a file declares `scope: [X]` but its body chunks mention
// entity E, and E.scope (per registry) has no overlap with X. This is the
// check that would have caught the 2026-04-20 pulse bug, because
// project_pamperhomes_active.md would have declared scope = [pamperhomes_active]
// while its Cleveland chunk mentioned josh_black (scope = [cleveland_118]) — so
// the file should either widen scope or split.
function scopeConflicts(d, fileMetaMap, registry) {
  const issues = [];
  for (const [basename, meta] of fileMetaMap) {
    const declared = JSON.parse(meta.scope_json || "[]");
    if (!declared.length) continue;
    const declaredSet = new Set(declared);
    // Expand declared scope: for each declared entity, add its scope chain too.
    const universe = ms.expandScopeUniverse(declared, registry);

    // For each chunk in this file, check mentioned entities against universe.
    const chunks = d
      .prepare(
        "SELECT m.id, m.heading FROM memory_chunks m WHERE m.file = ? ORDER BY m.chunk_ix",
      )
      .all(basename);
    for (const chunk of chunks) {
      const ents = d
        .prepare("SELECT entity_id FROM chunk_entities WHERE chunk_id = ?")
        .all(chunk.id)
        .map((r) => r.entity_id);
      for (const e of ents) {
        const ent = registry.entities[e];
        if (!ent) continue;
        const eScope = Array.isArray(ent.scope) ? ent.scope : [];
        if (!eScope.length) continue;
        // Entity E is scoped to specific properties. If none of those
        // properties are in the file's declared universe, it's a conflict.
        const overlaps = eScope.some((s) => universe.has(s) || declaredSet.has(s));
        if (!overlaps) {
          issues.push(
            mkIssue(
              "warning",
              basename,
              "scope-conflict",
              `chunk "${chunk.heading || "(no heading)"}" mentions \`${e}\` (scope: ${eScope.join(",")}) but file scope is [${declared.join(",")}]`,
              { chunk_heading: chunk.heading, entity: e },
            ),
          );
        }
      }
    }
  }
  return issues;
}

// Supersession stale: A.supersedes = [B], both exist, B.status is not
// 'superseded' or 'historical'. Usually benign (the drop-in-set rule still
// works), but worth surfacing as a tidy-up.
function staleSupersession(d, fileMetaMap) {
  const issues = [];
  const rows = d.prepare("SELECT new_basename, old_basename FROM supersession").all();
  for (const r of rows) {
    const oldMeta = fileMetaMap.get(r.old_basename);
    if (!oldMeta) continue; // dangling handled elsewhere
    if (oldMeta.status === "superseded" || oldMeta.status === "historical") continue;
    issues.push(
      mkIssue(
        "info",
        r.old_basename,
        "supersession-stale",
        `superseded by \`${r.new_basename}\` but status is still \`${oldMeta.status}\``,
        { superseded_by: r.new_basename },
      ),
    );
  }
  return issues;
}

// Orphan detection: project/feedback files with no incoming or outgoing links
// and no scope or entity mentions. Usually means the memory has drifted from
// the current network — either consolidate or link.
function orphanFiles(d, fileMetaMap) {
  const issues = [];
  const linkCounts = new Map();
  const inRows = d.prepare("SELECT dst, COUNT(*) as n FROM memory_links GROUP BY dst").all();
  const outRows = d.prepare("SELECT src, COUNT(*) as n FROM memory_links GROUP BY src").all();
  for (const r of inRows) linkCounts.set(r.dst, (linkCounts.get(r.dst) || 0) + r.n);
  for (const r of outRows) linkCounts.set(r.src, (linkCounts.get(r.src) || 0) + r.n);
  for (const [basename, meta] of fileMetaMap) {
    if (meta.type !== "project" && meta.type !== "feedback") continue;
    const links = linkCounts.get(basename) || 0;
    if (links > 0) continue;
    const scope = JSON.parse(meta.scope_json || "[]");
    const entities = JSON.parse(meta.entities_json || "[]");
    if (scope.length || entities.length) continue;
    issues.push(
      mkIssue(
        "info",
        basename,
        "orphan",
        `${meta.type} file has no links, no scope, no entity mentions — stranded in the graph`,
      ),
    );
  }
  return issues;
}

// Run all checks and return a flat issue array.
function lint() {
  const d = ms.db();
  const files = listFiles();
  const fileMetaMap = loadFileMetaMap(d);
  const registry = ms.loadEntityRegistry({ force: true });

  const issues = [];
  issues.push(...danglingLinks(d, files));
  issues.push(...unknownEntities(fileMetaMap, registry));
  issues.push(...scopeConflicts(d, fileMetaMap, registry));
  issues.push(...staleSupersession(d, fileMetaMap));
  issues.push(...orphanFiles(d, fileMetaMap));

  // Stable sort: severity (error first), file, check.
  const sevRank = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => {
    if (sevRank[a.severity] !== sevRank[b.severity])
      return sevRank[a.severity] - sevRank[b.severity];
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.check.localeCompare(b.check);
  });

  return issues;
}

function summarize(issues) {
  const byCheck = {};
  const bySeverity = { error: 0, warning: 0, info: 0 };
  for (const i of issues) {
    bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
    byCheck[i.check] = (byCheck[i.check] || 0) + 1;
  }
  return { total: issues.length, bySeverity, byCheck };
}

module.exports = { lint, summarize, SEVERITIES };
