"use strict";
// edva-context — unified access layer for everything Edva knows.
//
// One object per tick covers:
//   - profile      who the user is (digest of memory files)
//   - tastes       the user's preferences across domains
//   - knowledge    catalog of live-queryable sources + how to reach them
//   - recent       today's activity summary across those sources
//
// Every hum harvester + the Sonnet ranker reads this instead of hitting each
// source ad-hoc. Adding a new source = one entry in KNOWLEDGE below + a small
// lazy-read in `recent`. Harvesters don't change.
//
// Overlay: an installation adds its own sources, profile pages and projects
// without editing this file through lib/_ext/edva-context.cjs, which
// exports a function ({ MEMORY_DIR, DATA, TOOLS, defaults, shSafe, readJsonSafe })
// returning any of { knowledge, tasteFiles, profileFiles, projectFiles, counts }.
// A returned table REPLACES the kernel's (spread `defaults.<table>` to keep the
// kernel entries; keys keep the order given). `counts` is a function called by
// buildRecent whose object is appended to `recent.counts`.

const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const path = require("node:path");
const os = require("node:os");
const { execSync } = require("node:child_process");
const wiki = require("./wiki-store.js");

const { instanceValue, claudeMemoryDir } = require("./instance.cjs");
const { installTools, installRoot } = require("./root.cjs");

const HOME = os.homedir();
const MEMORY_DIR = claudeMemoryDir();
const TOOLS = installTools();
const DATA = path.join(TOOLS, "data");

// Taste domains — each maps to a primary file. Builder extracts a compact
// digest (YAML/markdown front-matter + first N lines of content); harvesters
// pick a domain up via `context.tastes[domain]`. Keys name the installation's
// own preference pages (under MEMORY_DIR) or data files, so the installation's
// overlay lists them (e.g. food: user_<food-preferences>.md).
const TASTE_FILES = {};

// Profile files — compact identity digest. Not tastes; "who the user is."
// Keys name memory pages (frontmatter type=user) under MEMORY_DIR; the
// installation's overlay lists them (e.g. owner: user_owner.md, residences).
const PROFILE_FILES = {};

// Active projects — pinned. Sonnet gets higher-relevance weight for candidates
// that intersect these. Edit this list (or the underlying files) to change
// priority stack. The installation's overlay lists them.
const PROJECT_FILES = {};

// Knowledge catalog — what's queryable at runtime, and how. This is not data;
// it tells Sonnet "you can reach X via Y." Real data lives in `recent`.
// Kernel sources only; the overlay adds the installation's own.
const KNOWLEDGE = {
  calendar:      { via: "gog calendar list",                      mcp: "claude_ai_Google_Calendar", scope: "next 14d" },
  tasks:         { via: "gog tasks list @default",                mcp: "gtasks",                    scope: "open + completed 30d" },
  email:         { via: "email-mem search / list + email-memory.db", mcp: "claude_ai_Gmail",        scope: "classified inbox history" },
  notes:         { via: "context-search (indexed every 30m)",     mcp: null,                        scope: "all Apple Notes" },
  imessage:      { via: "imsg / context-search",                  mcp: null,                        scope: "chat.db — read-only" },
  slack:         { via: "mcp__claude_ai_Slack__*",                mcp: "claude_ai_Slack",           scope: "connected workspaces" },
  wiki:          { via: "context-search --source wiki",          mcp: null,                        scope: "active wiki pages (compact recall cards)" },
  supabase:      { via: "mcp__supabase-edva__execute_sql",     mcp: "supabase-edva",          scope: "edva_messages, device_tokens, edva_commands and any tables the overlay adds" },
  memory_files:  { via: "filesystem read",                        mcp: null,                        scope: MEMORY_DIR },
  hum_learnings: { via: "data/hum-learnings.jsonl",         mcp: null,                        scope: "all answered hum questions" },
};

// ─────────────────────────────────────────────────────────────────────────

// Read the head of a memory page. Files under MEMORY_DIR are read from the
// wiki DB (post-step-5d, the .md files are no longer authoritative). Files
// outside MEMORY_DIR (e.g. data/music-profile.md) are read from disk.
function readFirstLines(file, maxLines = 20, maxChars = 800) {
  try {
    let raw;
    if (file.startsWith(MEMORY_DIR + path.sep)) {
      const pageId = path.basename(file, ".md");
      const page = wiki.getPage(pageId);
      if (!page) return null;
      raw = page.raw_md;
    } else {
      raw = fs.readFileSync(file, "utf8");
    }
    const lines = raw.split("\n").slice(0, maxLines).join("\n");
    return lines.slice(0, maxChars);
  } catch {
    return null;
  }
}

function shSafe(cmd, timeoutMs = 4000) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function countLines(file) {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
}

// ─────────────────────────────────────────────────────────────────────────

function buildProfile() {
  const out = {};
  for (const [name, file] of Object.entries(PROFILE_FILES)) {
    const d = readFirstLines(file);
    if (d) out[name] = d;
  }
  return out;
}

function buildTastes() {
  const out = {};
  for (const [name, file] of Object.entries(TASTE_FILES)) {
    const d = readFirstLines(file);
    if (d) out[name] = d;
  }
  return out;
}

function buildProjects() {
  const out = {};
  for (const [name, file] of Object.entries(PROJECT_FILES)) {
    const d = readFirstLines(file);
    if (d) out[name] = d;
  }
  return out;
}

function buildRecent() {
  const today = new Date().toISOString().slice(0, 10);

  // Today's git commits
  let todayCommits = [];
  try {
    todayCommits = (shSafe(`cd ${installRoot()} && git log --oneline --since="today 00:00" --no-color`) || "")
      .trim().split("\n").filter(Boolean).slice(0, 15);
  } catch {}

  // Recent hum learnings (last 30d) — subjects + hooks for dedup reasoning
  let recentLearnings = [];
  try {
    const raw = fs.readFileSync(path.join(DATA, "hum-learnings.jsonl"), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    recentLearnings = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && new Date(r.answered_at || 0).getTime() >= cutoff)
      .map((r) => ({ subject: r.subject, memory_hook: r.memory_hook, answer_excerpt: String(r.answer || "").slice(0, 100) }));
  } catch {}

  // Today's replies to hum pings, not yet folded into the wiki by the overnight
  // `hum-consolidate` job. Lets harvesters pre-suppress/down-rank a candidate
  // the user already settled earlier today, before consolidation runs. Read the
  // JSONL directly (sync; hum-responses.mjs is ESM and can't be require()'d).
  let todayResponses = [];
  try {
    const raw = fs.readFileSync(path.join(DATA, "hum-responses.jsonl"), "utf8");
    const tz = instanceValue("tz");
    const fmt = (d) => new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
    const todayLocal = fmt(new Date());
    todayResponses = raw.split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.ts && fmt(new Date(r.ts)) === todayLocal)
      .map((r) => ({
        lane: r.lane, subject: r.subject, subject_key: r.subject_key,
        reply: String(r.reply_text || "").slice(0, 120), disposition: r.disposition,
      }));
  } catch {}

  // Triage events today (count by priority)
  let triageCounts = {};
  try {
    const raw = fs.readFileSync(path.join(TOOLS, "logs/triage.log"), "utf8");
    const todayLines = raw.split("\n").filter((l) => l.includes(today));
    triageCounts = {
      p1: todayLines.filter((l) => l.includes('"priority":"p1"')).length,
      p2: todayLines.filter((l) => l.includes('"priority":"p2"')).length,
      p3: todayLines.filter((l) => l.includes('"priority":"p3"')).length,
    };
  } catch {}

  // Counts for the knowledge catalog so Sonnet knows magnitudes
  const counts = {
    email_memories:   countLines(path.join(DATA, "email-memory.db")) ? "present" : "missing",
    hum_runs_7d:      recentJsonlCount(path.join(DATA, "hum-runs.jsonl"), 7),
    hum_feedback_14d: recentJsonlCount(path.join(DATA, "hum-feedback.jsonl"), 14),
    hum_learnings_30d: recentLearnings.length,
  };
  if (overlayCounts) {
    try { Object.assign(counts, overlayCounts()); } catch {}
  }

  return {
    today_commits: todayCommits,
    today_triage: triageCounts,
    recent_learnings: recentLearnings.slice(0, 15),
    today_responses: todayResponses.slice(0, 20),
    counts,
  };
}

function recentJsonlCount(file, days) {
  try {
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const raw = fs.readFileSync(file, "utf8");
    return raw.split("\n").filter(Boolean).filter((l) => {
      try {
        const r = JSON.parse(l);
        const ts = r.ts || r.sent_at || r.answered_at;
        return ts && new Date(ts).getTime() >= cutoff;
      } catch { return false; }
    }).length;
  } catch { return 0; }
}

// ─────────────────────────────────────────────────────────────────────────

const CACHE_FILE = path.join(process.env.TMPDIR || "/tmp", "edva-context.json");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5-min cache; cheaper than rebuilding on every harvester

function build({ skipCache = false } = {}) {
  if (!skipCache) {
    try {
      const stat = fs.statSync(CACHE_FILE);
      if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
        return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      }
    } catch {}
  }

  const _now = new Date();
  const _dow = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][_now.getDay()];
  const ctx = {
    built_at: _now.toISOString(),
    today_date: _now.toISOString().slice(0, 10),   // YYYY-MM-DD — explicit anchor for date validation
    today_dow: _dow,                                // e.g. "Saturday" — prevents DOW hallucination
    profile: buildProfile(),
    tastes: buildTastes(),
    projects: buildProjects(),
    knowledge: KNOWLEDGE,
    recent: buildRecent(),
  };

  try { writeFileAtomic(CACHE_FILE, JSON.stringify(ctx)); } catch {}
  return ctx;
}

// Overlay tables (see the header). Applied once at load so the exported tables
// carry them; a missing file is the plain-kernel case, and a broken one must
// not take harvesters down with it.
let overlayCounts = null;
function replaceTable(target, next) {
  if (!next || typeof next !== "object") return;
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, next);
}
function applyOverlay() {
  const file = process.env.EDVA_CONTEXT_OVERLAY || path.join(__dirname, "_ext", "edva-context.cjs");
  if (!fs.existsSync(file)) return;
  try {
    let ext = require(file);
    if (typeof ext === "function") {
      const defaults = {
        knowledge: { ...KNOWLEDGE }, tasteFiles: { ...TASTE_FILES },
        profileFiles: { ...PROFILE_FILES }, projectFiles: { ...PROJECT_FILES },
      };
      ext = ext({ MEMORY_DIR, DATA, TOOLS, defaults, shSafe, readJsonSafe });
    }
    if (!ext || typeof ext !== "object") return;
    replaceTable(KNOWLEDGE, ext.knowledge);
    replaceTable(TASTE_FILES, ext.tasteFiles);
    replaceTable(PROFILE_FILES, ext.profileFiles);
    replaceTable(PROJECT_FILES, ext.projectFiles);
    if (typeof ext.counts === "function") overlayCounts = ext.counts;
  } catch (e) {
    try { console.error(`edva-context: ${path.basename(file)} failed: ${e.message}`); } catch {}
  }
}
applyOverlay();

module.exports = { build, KNOWLEDGE, TASTE_FILES, PROFILE_FILES, PROJECT_FILES };
