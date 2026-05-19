#!/usr/bin/env node
// memory-write-precheck — conflict gate for memory writes.
//
// Before saving new factual content to a wiki page, this script searches
// existing memory for contradictions and asks Sonnet to adjudicate.
//
// Motivating case (generic): an upstream job (email-triage, calendar fuse,
// etc.) writes a new fact to memory that contradicts something the wiki
// already says — e.g. memory says "user is in city A solo this week",
// new write says "user and partner are in city B on day N." Both facts
// can't be true. The conflict should be surfaced before the write lands.
//
// Stdin: {page_id?: string, content: string, intent?: string}
//   page_id  — the wiki page being written/updated (optional, for context)
//   content  — the new content or key facts being saved
//   intent   — short tag describing what this write is for ("travel-update", etc.)
//
// Stdout: {
//   decision: "save" | "conflict",
//   conflicts?: [{page_id: string, snippet: string, explanation: string}],
//   resolution?: string,   // what to do to resolve (if decision=conflict)
//   reason: string
// }
//
// Fail-open: any error path emits {decision: "save"} so the write proceeds.
// Better an occasional stale write than a broken pipeline that can't save anything.
//
// Usage from an agent or playbook:
//   echo '{"page_id":"reference_trip_destination","content":"Partner is also flying to the destination on the trip date","intent":"travel-update"}' \
//     | ${MERLIN_HOME}/bin/memory-write-precheck.mjs
//   # → {"decision":"conflict","conflicts":[...],"resolution":"...","reason":"..."}

import { spawnSync } from "node:child_process";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MERLIN_HOME = process.env.MERLIN_HOME || path.join(process.env.HOME, "Dev/merlin");

const __dir = path.dirname(fileURLToPath(import.meta.url));
const WIKI_BIN   = path.resolve(__dir, "wiki");
const CLAUDE_BIN = "${MERLIN_HOME_USER}/.local/bin/claude";
const LOG_FILE   = path.resolve(__dir, "..", "data", "memory-write-precheck-log.jsonl");

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
  } catch {}
  process.exit(0);
}

// ─── Read stdin ───────────────────────────────────────────────────────────────
let raw = "";
try { raw = readFileSync(0, "utf8"); } catch {}
let input;
try { input = JSON.parse(raw); } catch { emit({ decision: "save", reason: "precheck_invalid_input" }); }
if (!input || typeof input !== "object") emit({ decision: "save", reason: "precheck_invalid_input" });

const pageId     = (input.page_id || "").toString().trim();
const newContent = (input.content  || "").toString().trim();
const intent     = (input.intent   || "unknown").toString().slice(0, 80);

if (!newContent) emit({ decision: "save", reason: "precheck_empty_content" });

// ─── Two-pass wiki search (same pattern as outbound-precheck) ─────────────────
const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","have","has","had",
  "does","did","will","would","could","should","may","might","just","very","it",
  "its","he","she","they","we","you","me","him","her","them","us","this","that",
  "these","those","what","which","who","when","where","why","how","with","about",
  "from","into","through","before","after","for","and","but","or","not","so","at",
  "by","on","in","of","to","up","any","all","each","every","also","then","than",
  "over","both","more","some","only","now","still","even","such","new","our",
  "your","their","here","there","make","take","want","need","like","know","think",
  "going","doing","mine","hers","ours","lets","page","wiki","memory","update",
  "save","write","added","noted","saved","record","information","content",
]);
const rawWords = (intent.replace(/[-_:]/g, " ") + " " + newContent.slice(0, 400))
  .toLowerCase()
  .match(/\b[a-z]{4,}\b/g) || [];
const keywords = [...new Set(rawWords)].filter(w => !STOPWORDS.has(w)).slice(0, 5);

const wikiParts = [];

// Pass 1: topic keywords from new content
if (keywords.length >= 2) {
  const r1 = spawnSync(WIKI_BIN, ["search", keywords.join(" "), "--limit", "4"], {
    encoding: "utf8", timeout: 8000,
  });
  if (r1.status === 0 && r1.stdout.trim() && !r1.stdout.trim().startsWith("(no matches)")) {
    wikiParts.push("=== Topic search results ===\n" + r1.stdout.trim());
  }
}

// Pass 2: always check current travel/presence status.
// Tune the keyword list to match the kinds of conflict-prone facts your
// wiki tracks (travel state, companion presence, project status, etc.).
const r2 = spawnSync(WIKI_BIN, ["search", "solo traveling stay together", "--limit", "3"], {
  encoding: "utf8", timeout: 8000,
});
if (r2.status === 0 && r2.stdout.trim() && !r2.stdout.trim().startsWith("(no matches)")) {
  wikiParts.push("=== Travel/presence status search ===\n" + r2.stdout.trim());
}

// Bonus: if page_id given, read the existing page content to include as context
let existingPageContent = "";
if (pageId) {
  const r3 = spawnSync(WIKI_BIN, ["render", pageId], { encoding: "utf8", timeout: 8000 });
  if (r3.status === 0 && r3.stdout.trim()) {
    existingPageContent = `\nCurrent content of page being updated (${pageId}):\n${r3.stdout.trim().slice(0, 1500)}\n`;
  }
}

const wikiContext = wikiParts.join("\n\n").slice(0, 3000);

// If no existing memory found at all, nothing can conflict — skip Sonnet and save
if (!wikiContext.trim() && !existingPageContent.trim()) {
  emit({ decision: "save", reason: "no_existing_memory_to_conflict_with" });
}

// ─── Sonnet conflict check ────────────────────────────────────────────────────
const prompt = `You are reviewing a proposed memory write for the user's personal AI agent. Before the agent saves new facts to its long-term memory, you check whether the new content contradicts any existing memory.

Your job is to detect FACTUAL CONTRADICTIONS — not just related content. An addition (e.g., "the user also likes Korean food") is not a conflict. A contradiction (e.g., memory says "the user is traveling solo this week" and new content says "the user's partner is flying with them on day N") IS a conflict that must be resolved before writing.

Intent of this write: ${intent}
Page being written/updated: ${pageId || "(new content)"}

New content being saved:
"""${newContent.slice(0, 1200)}"""
${existingPageContent}
Existing related memory pages (from wiki search):
${wikiContext || "(none found)"}

Decide:

1. "save" — the new content is consistent with existing memory, or the existing memory is silent on the topic. Return:
   {"decision":"save","reason":"<≤120 chars>"}

2. "conflict" — the new content directly contradicts one or more existing memory pages. Return:
   {
     "decision":"conflict",
     "conflicts":[{"page_id":"<id>","snippet":"<quoted contradicting text, ≤150 chars>","explanation":"<≤120 chars: what exactly contradicts>"}],
     "resolution":"<≤200 chars: what should be done — which source is more authoritative, which page to update, what to ask the user>",
     "reason":"<≤120 chars: summary>"
   }

A conflict requires BOTH: (a) the existing memory asserts something factual, AND (b) the new content asserts the opposite or an incompatible fact. If in doubt, prefer "save" — false positives block legitimate writes.

Reply with ONE LINE of compact JSON, no prose, no markdown fence.`;

let sonnetOut = "";
try {
  const res = spawnSync(CLAUDE_BIN, [
    "-p", "--model", "sonnet", "--effort", "low",
    "--allowedTools", "",
    "--output-format", "text",
    prompt,
  ], { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
  if (res.status === 0 && res.stdout) sonnetOut = res.stdout.trim();
} catch {}

if (!sonnetOut) emit({ decision: "save", reason: "precheck_sonnet_unavailable" });

const match = sonnetOut.match(/\{[\s\S]*\}/);
if (!match) emit({ decision: "save", reason: "precheck_sonnet_no_json" });

let parsed;
try { parsed = JSON.parse(match[0]); } catch { emit({ decision: "save", reason: "precheck_sonnet_bad_json" }); }

if (parsed.decision === "conflict" && Array.isArray(parsed.conflicts) && parsed.conflicts.length > 0) {
  emit({
    decision: "conflict",
    conflicts: parsed.conflicts,
    resolution: (parsed.resolution || "").toString().slice(0, 300),
    reason: (parsed.reason || "precheck_conflict").toString().slice(0, 200),
  });
}

emit({ decision: "save", reason: (parsed.reason || "precheck_send").toString().slice(0, 200) });
