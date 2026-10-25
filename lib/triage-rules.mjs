// triage-rules.mjs — section index over ops-agent/email-triage-rules.md.
//
// The ruleset is one file (~108 KB, ~27k tokens) and every `gmail:*` dispatch
// used to tell the agent to read all of it — per email, into the shared ops
// session, where every later dispatch paid for it again as cache-read. Most of it
// is per-category rules (shipping, tickets, health portals, app stores, 30-odd
// fast-paths) of which any one email needs one or two.
//
// The file stays the single source of truth — edits still go there. This module
// only SLICES it along its own `### ` headings:
//   core()       — the decision procedure every email needs (Steps 0-6, P1 ping
//                  policy, due-date timezone rule, draft/instruction/ack policies,
//                  tools reference)
//   index()      — one line per category section: `slug — title`
//   section(s)   — one category section's full text, by slug
// CLI: bin/triage-rules. (2026-10-04 determinism review.)
//
// What is sliced is the MERGED ruleset (loadMergedRules): the kernel file plus
// the instance's own companion, agent/local/email-triage-rules.md, merged
// by heading. The ops supervisor writes that merge to its state dir and points
// TRIAGE_RULES_FILE at it; a process without TRIAGE_RULES_FILE (cron, a CLI, a
// fork the supervisor did not start) merges on the fly, so every reader sees
// the same rules.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { mergeSectionedMarkdown, readOptional } from "../agent/supervisor/dispatch-preamble.mjs";

import { installTools } from "./root.cjs";
export function rulesFile() {
  return process.env.TRIAGE_RULES_FILE || installTools("agent/ops-agent/email-triage-rules.md");
}

/** The instance's own triage additions (may not exist). */
export function localRulesFile() {
  const dir = process.env.EDVA_LOCAL_DIR || installTools("agent/local");
  return path.join(dir, "email-triage-rules.md");
}

/**
 * The full ruleset text an agent or model should apply. TRIAGE_RULES_FILE, when
 * set, is already the merged file (or an operator override) and is read as is;
 * otherwise the kernel file is merged with the local companion here. Read at
 * call time, so an edit to either file is seen by the next caller. Throws when
 * the ruleset cannot be read (callers decide whether that is fatal).
 */
export function loadMergedRules({ kernelPath = rulesFile(), localPath = localRulesFile() } = {}) {
  if (process.env.TRIAGE_RULES_FILE) return fs.readFileSync(process.env.TRIAGE_RULES_FILE, "utf8");
  const kernel = fs.readFileSync(kernelPath, "utf8");
  return mergeSectionedMarkdown(kernel, readOptional(localPath));
}

// Headings (prefix match) that make up the always-needed decision core.
const CORE_PREFIXES = [
  "Phone-channel notification policy",
  "Step ",
  "Timezone Rule",
  "Draft reply policy",
  "Freeform instructions",
  "No acknowledgment emails",
  "Tools reference",
];

export function slugOf(title) {
  return String(title).toLowerCase()
    .replace(/\(.*?\)|`/g, "")          // lang-regex-ok: slugging our own markdown headings
    .replace(/[^a-z0-9]+/g, "-")         // lang-regex-ok: slugging our own markdown headings
    .replace(/^-+|-+$/g, "")             // lang-regex-ok: slugging our own markdown headings
    .slice(0, 60).replace(/-+$/, "");    // lang-regex-ok: slugging our own markdown headings
}

/** Parse the file into {preamble, sections:[{title, slug, core, text}]}. */
export function parse(md) {
  const lines = String(md || "").split("\n");
  const sections = [];
  const pre = [];
  let cur = null;
  for (const line of lines) {
    if (line.startsWith("### ")) {
      const title = line.slice(4).trim();
      cur = { title, slug: slugOf(title), core: CORE_PREFIXES.some((p) => title.startsWith(p)), lines: [line] };
      sections.push(cur);
    } else if (cur) cur.lines.push(line);
    else pre.push(line);
  }
  return {
    preamble: pre.join("\n"),
    sections: sections.map(({ lines: l, ...s }) => ({ ...s, text: l.join("\n").trimEnd() })),
  };
}

function load() {
  return parse(loadMergedRules());
}

export function core(doc = load()) {
  return doc.sections.filter((s) => s.core).map((s) => s.text).join("\n\n");
}

export function index(doc = load()) {
  return doc.sections.filter((s) => !s.core).map((s) => `- ${s.slug} — ${s.title}`).join("\n");
}

export function section(slug, doc = load()) {
  const s = doc.sections.find((x) => x.slug === slug);
  return s ? s.text : null;
}

export function sizes(doc = load()) {
  const coreText = core(doc);
  const all = doc.sections.map((s) => s.text).join("\n\n");
  return { total_chars: all.length, core_chars: coreText.length, categories: doc.sections.filter((s) => !s.core).length };
}
