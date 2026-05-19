"use strict";
// merlin-context — unified access layer for everything Merlin knows.
//
// One object per tick covers:
//   - profile      who the user is (digest of memory files)
//   - tastes       his preferences across domains
//   - knowledge    catalog of live-queryable sources + how to reach them
//   - recent       today's activity summary across those sources
//
// Every hum harvester + the Sonnet ranker reads this instead of hitting each
// source ad-hoc. Adding a new source = one entry in KNOWLEDGE below + a small
// lazy-read in `recent`. Harvesters don't change.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execSync } = require("node:child_process");
const wiki = require("./wiki-store.js");

const HOME = os.homedir();
const MEMORY_DIR = path.join(HOME, ".claude/projects/-Users-mraccah-Dev-merlin/memory");
const TOOLS = path.join(HOME, "dev/merlin/tools");
const DATA = path.join(TOOLS, "data");

// Taste domains — each maps to a primary file. Builder extracts a compact
// digest (YAML/markdown front-matter + first N lines of content). Add a new
// domain here; harvesters pick it up via `context.tastes[domain]`.
const TASTE_FILES = {
  art:         path.join(MEMORY_DIR, "user_art_taste.md"),
  food:        path.join(MEMORY_DIR, "user_food_taste.md"),
  tv:          path.join(MEMORY_DIR, "user_tv_profile.md"),
  music:       path.join(DATA, "music-profile.md"),
  restaurants: path.join(MEMORY_DIR, "reference_trusted_restaurants.md"),
  schedule:    path.join(MEMORY_DIR, "user_daily_schedule.md"),
};

// Profile files — compact identity digest. Not tastes; "who the user is."
// Map keys to memory pages with frontmatter type=user. Each value is an
// absolute path to a .md file under MEMORY_DIR. Ships empty in the public
// repo; populate as you author wiki pages for the recurring people, places,
// and patterns in your life.
//
// Example:
//   const PROFILE_FILES = {
//     owner:        path.join(MEMORY_DIR, "user_owner.md"),
//     partner:      path.join(MEMORY_DIR, "user_partner.md"),
//     residences:   path.join(MEMORY_DIR, "user_residences.md"),
//   };
const PROFILE_FILES = {};

// Active projects — pinned. The ranker gets higher-relevance weight for
// candidates that intersect these. Edit this list (or the underlying files)
// to change priority stack. Ships empty in the public repo.
//
// Example:
//   const PROJECT_FILES = {
//     project_x:    path.join(MEMORY_DIR, "project_x.md"),
//     side_gig:     path.join(MEMORY_DIR, "project_side_gig.md"),
//   };
const PROJECT_FILES = {};

// Knowledge catalog — what's queryable at runtime, and how. This is not data;
// it tells Sonnet "you can reach X via Y." Real data lives in `recent`.
const KNOWLEDGE = {
  calendar:      { via: "gog calendar list",                      mcp: "claude_ai_Google_Calendar", scope: "next 14d" },
  tasks:         { via: "gog tasks list @default",                mcp: "gtasks",                    scope: "open + completed 30d" },
  email:         { via: "email-mem search / list + email-memory.db", mcp: "claude_ai_Gmail",        scope: "classified inbox history" },
  photos:        { via: "photos CLI + Supabase photos table",     mcp: null,                        scope: "everything in Apple Photos" },
  notes:         { via: "context-search (indexed every 30m)",     mcp: null,                        scope: "all Apple Notes" },
  imessage:      { via: "imsg / context-search",                  mcp: null,                        scope: "chat.db — read-only" },
  slack:         { via: "mcp__claude_ai_Slack__*",                mcp: "claude_ai_Slack",           scope: "connected workspaces" },
  location:      { via: "findme locate --json",                   mcp: null,                        scope: "iCloud Find My + Supabase location_history" },
  watchlist:     { via: "watchlist CLI + Supabase watchlist",     mcp: null,                        scope: "shows/movies/documentaries" },
  wiki:          { via: "context-search --source wiki",          mcp: null,                        scope: "active wiki pages (compact recall cards)" },
  portfolio:     { via: "~/dev/broker-trader/ + positions.json",  mcp: null,                        scope: "<broker> holdings, market hours" },
  trip_history:  { via: "data/trip-history.json",           mcp: null,                        scope: "167 traveler=true past trips" },
  flights:       { via: "data/flights.json",                mcp: null,                        scope: "upcoming flights" },
  phone_context: { via: "lib/phone-context.js",             mcp: null,                        scope: "motion + Wi-Fi (10m freshness)" },
  weather:       { via: "apple-weather --findme",                 mcp: null,                        scope: "current + daily at any lat/lon" },
  supabase:      { via: "mcp__supabase-merlin__execute_sql",     mcp: "supabase-merlin",          scope: "merlin_messages, watchlist, daily_summaries, weekly_summaries, monthly_summaries, photos, location_history, phone_context, health_samples, health_workouts, health_aggregates, health_clinical_records, device_tokens, merlin_commands, phone_unlocks (Merlin project ${MERLIN_SUPABASE_PROJECT}, Silo org)" },
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
    todayCommits = (shSafe(`cd ${HOME}/dev/merlin && git log --oneline --since="today 00:00" --no-color`) || "")
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
    trip_history:     (readJsonSafe(path.join(DATA, "trip-history.json"))?.trips || []).length,
    watchlist_notify: parseWatchlistNotifyCount(),
  };

  return {
    today_commits: todayCommits,
    today_triage: triageCounts,
    recent_learnings: recentLearnings.slice(0, 15),
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

function parseWatchlistNotifyCount() {
  try {
    const out = shSafe(`"${TOOLS}/bin/watchlist" notify-list 2>/dev/null`);
    const m = out.match(/Tracking new seasons for (\d+) shows/);
    return m ? parseInt(m[1], 10) : 0;
  } catch { return 0; }
}

// ─────────────────────────────────────────────────────────────────────────

const CACHE_FILE = path.join(process.env.TMPDIR || "/tmp", "merlin-context.json");
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

  const ctx = {
    built_at: new Date().toISOString(),
    profile: buildProfile(),
    tastes: buildTastes(),
    projects: buildProjects(),
    knowledge: KNOWLEDGE,
    recent: buildRecent(),
  };

  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(ctx)); } catch {}
  return ctx;
}

module.exports = { build, KNOWLEDGE, TASTE_FILES, PROFILE_FILES, PROJECT_FILES };
