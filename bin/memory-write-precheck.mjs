#!/usr/bin/env node
// memory-write-precheck — conflict gate for memory writes.
//
// Before saving new factual content to a wiki page, this script searches
// existing memory for contradictions and asks Sonnet to adjudicate.
//
// Motivating case: an agent read a fact out of an email and saved it to memory,
// but an existing reference page already asserted the opposite. Both facts
// can't be true. The conflict should be resolved before the write lands.
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
//   echo '{"page_id":"reference_<page>","content":"<person> is now also flying to <city> on <date>","intent":"travel-update"}' \
//     | ~/Dev/edva/bin/memory-write-precheck.mjs
//   # → {"decision":"conflict","conflicts":[...],"resolution":"...","reason":"..."}

import { spawnSync } from "node:child_process";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const __dir = path.dirname(fileURLToPath(import.meta.url));
// Env overrides exist for tests/jev-memory-write-precheck.test.mjs only.
const WIKI_BIN   = process.env.MEMORY_PRECHECK_WIKI_BIN || path.resolve(__dir, "wiki");
const CLAUDE_BIN = process.env.MEMORY_PRECHECK_CLAUDE_BIN || path.join(os.homedir(), ".local/bin/claude");
const LOG_FILE   = process.env.MEMORY_PRECHECK_LOG || path.resolve(__dir, "..", "data", "memory-write-precheck-log.jsonl");
// Whose memory this is (agent/local/instance.json owner_name), and this
// installation's travel/presence search and contradiction example
// (agent/local/config/memory-write-precheck.json).
const { instance, localConfig } = createRequire(import.meta.url)("../lib/instance.cjs");
const OWNER = instance().owner_name;
const CFG = localConfig("memory-write-precheck", {
  presence_query: "solo traveling stay",
  contradiction_example: `memory says "${OWNER} traveling solo" and new content says "${OWNER} and a companion flying together"`,
  addition_example: `"they also enjoy hiking"`,
});

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

// Pass 2: always check current travel/presence status
const r2 = spawnSync(WIKI_BIN, ["search", CFG.presence_query, "--limit", "3"], {
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
const prompt = `You are reviewing a proposed memory write for ${OWNER}'s personal AI agent. Before the agent saves new facts to its long-term memory, you check whether the new content contradicts any existing memory.

Your job is to detect FACTUAL CONTRADICTIONS — not just related content. An addition (e.g., ${CFG.addition_example}) is not a conflict. A contradiction (e.g., ${CFG.contradiction_example}) IS a conflict that must be resolved before writing.

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
     "resolution":"<≤200 chars: what should be done — which source is more authoritative, which page to update, what to ask ${OWNER}>",
     "reason":"<≤120 chars: summary>"
   }

A conflict requires BOTH: (a) the existing memory asserts something factual, AND (b) the new content asserts the opposite or an incompatible fact. If in doubt, prefer "save" — false positives block legitimate writes.

Reply with ONE LINE of compact JSON, no prose, no markdown fence.`;

// ─── Decision: Jev primary, Sonnet shadow/fallback ───────────────────────────
// Jev runs as primary with the current mechanism as shadow for one week
// (docs/jev.md). Jev answers one boolean — does the new content
// contradict existing memory? — but it cannot WRITE the conflict detail the
// wiki caller prints (page_id / snippet / explanation / resolution). So:
//   - Jev "save" (confident)     → save, no Sonnet needed after the shadow week.
//   - Jev "conflict" (confident) → Sonnet is asked for the detail; the memoized
//     legacy call means the shadow run is reused, never a second Sonnet turn.
//     If Sonnet then says save, we save — the prompt's own rule is "if in doubt,
//     prefer save", and the disagreement is logged + paged for review.
//   - Jev unavailable / low confidence → Sonnet decides alone, exactly as before.
// Health/bank content never reaches Jev: the on-device screen (fail-closed)
// routes a flagged write straight to Sonnet. Fail-open is unchanged: any path
// that cannot reach a verdict saves.
const { decide } = await import("../lib/jev-shadow.mjs");
const { runToolless, parseModelJson } = await import("../lib/jev-claude.mjs");
const { answerConfidence, boolOf } = await import("../lib/jev.mjs");
const JEV_SITE = "memory-write-precheck";

// The pre-existing Sonnet check, unchanged in prompt and parsing. Resolves the
// full result object; THROWS (with the old fail-open reason) when Sonnet could
// not produce a verdict, so the shadow log records an error, not a fake "save".
// Async (execFile, not spawnSync) so the shadow Sonnet turn and the Jev call
// genuinely overlap — a spawnSync here would run Sonnet to completion before
// the Jev request was even sent.
// Tool-less, Max-only, off the edva tree's settings — lib/jev-claude.mjs.
async function sonnetCheck() {
  const sonnetOut = await runToolless({ bin: CLAUDE_BIN, model: "claude-sonnet-5-5", prompt, timeoutMs: 60000 });
  if (!sonnetOut) throw new Error("precheck_sonnet_unavailable");
  const parsed = parseModelJson(sonnetOut);
  if (!parsed) throw new Error("precheck_sonnet_no_json");
  if (parsed.decision === "conflict" && Array.isArray(parsed.conflicts) && parsed.conflicts.length > 0) {
    return {
      decision: "conflict",
      conflicts: parsed.conflicts,
      resolution: (parsed.resolution || "").toString().slice(0, 300),
      reason: (parsed.reason || "precheck_conflict").toString().slice(0, 200),
    };
  }
  return { decision: "save", reason: (parsed.reason || "precheck_send").toString().slice(0, 200) };
}
let legacyMemo = null;
const legacyFull = () => (legacyMemo ||= sonnetCheck());

const failOpen = (err) => emit({ decision: "save", reason: String(err?.message || err || "precheck_error").slice(0, 200) });

const jevState = {
  intent,
  page_id: pageId || "(new content)",
  new_content: newContent.slice(0, 1200),
  current_page: existingPageContent.trim() || "(none)",
  related_memory: wikiContext || "(none found)",
};

let r;
try {
  r = await decide({
    site: JEV_SITE,
    id: pageId || null,
    state: jevState,
    interpret: (answers) => {
      const a = answers.contradiction;
      const b = boolOf(a);
      if (b === null) throw new Error("jev: no contradiction answer");
      return { value: b ? "conflict" : "save", confidence: answerConfidence(a) };
    },
    legacy: () => legacyFull().then((x) => x.decision),
    same: (j, l) => j === l,
    logInput: { intent, page_id: pageId || null, new_content: newContent.slice(0, 300) },
    // On-device health/bank screen over exactly jevState (fail-closed); a flagged
    // write goes to Sonnet alone. Runs only when Jev would.
    privacyScreen: true,
  });
} catch (err) { failOpen(err); }

if (r.value === "save") {
  if (r.used === "jev") {
    // Shadow week: decide() already awaited the Sonnet shadow. If Sonnet found a
    // detailed conflict, it wins — a false "save" writes a contradiction into
    // memory, the costly direction (from a code review). The disagreement is
    // already logged and paged by decide().
    if (legacyMemo) {
      const sh = await legacyMemo.catch(() => null);
      if (sh && sh.decision === "conflict") emit({ ...sh, reason: `sonnet_shadow_conflict_over_jev_save: ${sh.reason || ""}`.slice(0, 200) });
    }
    const p = r.jev?.answers?.contradiction?.probability ?? r.jev?.answers?.contradiction?.noul;
    emit({ decision: "save", reason: `jev_consistent (p_conflict=${typeof p === "number" ? p.toFixed(3) : "?"})` });
  }
  try { emit(await legacyFull()); } catch (err) { failOpen(err); }
}

// Conflict: the caller needs Sonnet's detail. Reuses the shadow's result.
let full;
try { full = await legacyFull(); } catch (err) {
  emit({ decision: "save", reason: `jev_conflict_undetailed (${String(err?.message || err).slice(0, 80)})` });
}
if (full.decision === "conflict") emit(full);
emit({ decision: "save", reason: `jev_conflict_unconfirmed_by_sonnet: ${full.reason || ""}`.slice(0, 200) });
