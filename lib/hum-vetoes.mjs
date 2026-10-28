// hum-vetoes.mjs — hum's structural send-vetoes, shared by the pre-rank filter
// (hum-harvest-all) and the send-time backstop (bin/hum-ping).
//
// WHY THEY MOVED (2026-10-04 determinism review). These four gates used to live
// only inside hum-ping, which runs AFTER the ranker has picked a winner:
//
//   exit 7  subject previously rejected (suggestion-history)
//   exit 8  dedup_key already sent inside the 24h window
//   exit 9  semantic near-duplicate of a recent ping (embedding cosine)
//   exit 10 retrospective "were you at X?" ask over the daily cap
//   exit 11 the shared daily ping budget (6/day, 45 min apart — ping-budget.mjs)
//
// So the ranker spent a model call picking a winner that was already doomed,
// and — worse than the cost — a tick that had a perfectly good runner-up ended
// SILENT, because the refused winner was the only thing the turn sent. Every
// one of these is a property of the candidate and the ledgers, never of the
// final wording, so all of them can be decided before ranking. hum-ping keeps
// calling the same functions as the backstop for anything that reaches it some
// other way (a manual send, a turn that ignored the filter).
//
// Code owns all of it (Rule #0b): IDs, timestamps, counts and a cosine over a
// local embedding. Nothing here reads what the user meant. One judgment is a
// model's: whether a restaurant / place recommendation re-recommends a place
// already recommended (findSamePlacePitch, Jev site `hum-place-repeat`).
//
// Carve-outs match hum-ping exactly: a protected lane (PROTECTED_LANES) and a
// high-urgency candidate (>= 0.9) are never vetoed by the dedup, novelty or
// ping-budget gates. The subject-block and the ask cap have no carve-out, same
// as before — and neither does a STICKY key (below): urgency is no reason to
// tell the user the same landmark twice.
//
// FAIL-OPEN everywhere: an unreadable ledger, a down embedder or a blown time
// budget vetoes nothing.
//
// `resolved_first` (2026-10-15) is the pre-rank half of hum-ping exit 12: a
// candidate whose dedup_key the resolve-first gate settled from Edva's own
// records inside RESOLVED_WINDOW_D days (lib/hum-resolve-first-store.mjs)
// is not offered again. Same carve-outs as dedup: a protected lane or urgency
// >= 0.9 passes, because a key can stay the same while the situation changes
// (`travel:<flight>:<depart>`) and the send-time gate re-judges it against
// fresh records anyway. A key match only; the gate itself catches a reworded
// re-ask.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { canonicalKey } from "./suggestion-key.mjs";
import { shouldFilter } from "./suggestion-recall.mjs";
import * as novelty from "./hum-novelty.mjs";
import { checkPingBudget, isLocalHistoryRow } from "./ping-budget.mjs";
import { isQuestionCandidate, checkQuestionBudget, currentScale } from "./question-pacing.mjs";
import { resolvedKeys } from "./hum-resolve-first-store.mjs";
import { installTools } from "./root.cjs";
// Who the assistant serves (agent/local/instance.json owner_name).
const OWNER = createRequire(import.meta.url)("./instance.cjs").instance().owner_name;

const HOME = os.homedir();
export const RUNS_PATH = process.env.HUM_RUNS_PATH
  || installTools("data/hum-runs.jsonl");
export const FEEDBACK_PATH = process.env.HUM_FEEDBACK_PATH
  || installTools("data/hum-feedback.jsonl");

// Rule #1 lanes whose pings skip the dedup / novelty carve-outs and that only an
// explicit user revocation may suppress: the installation's own, from
// agent/local/config/hum-lanes.json `protected_lanes` (none by default).
export const PROTECTED_LANES = new Set(createRequire(import.meta.url)("./instance.cjs")
  .localConfig("hum-lanes", { protected_lanes: [] }).protected_lanes.map((l) => String(l).toLowerCase()));
export const HIGH_URGENCY = 0.9;
export const dedupWindowH = () => Number(process.env.HUM_DEDUP_WINDOW_H || 24);
export const settledWindowD = () => Number(process.env.HUM_WIKI_SETTLED_WINDOW_D || 7);
export const askCap = () => Number(process.env.HUM_LOCATION_ASK_CAP || 3);

// STICKY dedup keys (2026-10-06 self-improvement review, item 14). The 24h
// window is right for a lane whose subject is a moment ("<call> in 1h"),
// and wrong for one whose subject is a PLACE. One `nearby:<landmark>` key went
// out three days running (the second 24h20m after the first — just outside the
// window) under the identical key, and a street fact twice. A fact about the
// ground the user stands on is told once, so a nearby key is checked against the
// whole recent history — HUM_STICKY_DEDUP_WINDOW_D days (default 180, the same
// horizon the nearby harvester's own recall uses). This is dedup only: the
// lane's weight and score are untouched.
export const STICKY_KEY_PREFIXES = ["nearby:"];
export const stickyDedupWindowH = () => Number(process.env.HUM_STICKY_DEDUP_WINDOW_D || 180) * 24;
export function isStickyKey(dedupKey) {
  const k = String(dedupKey || "");
  return STICKY_KEY_PREFIXES.some((p) => k.startsWith(p));
}
/** The window a dedup_key is checked against: sticky keys get the long one. */
export function dedupWindowFor(dedupKey) {
  return isStickyKey(dedupKey) ? Math.max(stickyDedupWindowH(), dedupWindowH()) : dedupWindowH();
}
/** May the urgency / protected-lane carve-out skip the dedup check for this key? Never for a sticky key. */
export function dedupBypassable(dedupKey) {
  return !isStickyKey(dedupKey);
}
// A sticky lookup has to reach back further than the 600 newest rows; the whole
// ledger is under a thousand lines, so read up to this many.
const LEDGER_SCAN_ROWS = 20000;

/** hum-ping's `--intent hum:<lane>:<branch>` → is it a protected lane? */
export function isProtectedIntent(intent) {
  const parts = String(intent || "").split(":");
  return parts[0] === "hum" && PROTECTED_LANES.has(parts[1]);
}

/** Same rule from the candidate side (pre-rank has no intent yet, only a topic). */
export function isProtectedLane(lane) {
  return PROTECTED_LANES.has(String(lane || "").toLowerCase());
}

/** A "were you at X?" confirmation question — the class the daily cap bounds. */
export function isRetrospectiveAsk(finding) {
  if (!finding) return false;
  return String(finding.dedup_key || "").startsWith("location_ask:")
    || finding.supporting_data?.ask_kind === "retrospective_confirmation";
}

/**
 * The dedup_key hum-ping would stamp on a headline that arrived without one:
 * `<topic>:<sha8(basis)>`. Shared so the pre-rank filter and hum-ping derive
 * the SAME key for the same candidate.
 */
export function deriveDedupKey(finding, lane, fallbackText = "") {
  const basis = String(finding?.signal || finding?.subject_key || fallbackText || "").slice(0, 200);
  return `${finding?.topic || lane}:${createHash("sha256").update(basis).digest("hex").slice(0, 8)}`;
}

/** Exit-7 check: is this finding's canonical subject blocked by suggestion-history? */
export function subjectBlock(finding, lane) {
  const key = finding?.subject_key || canonicalKey(finding?.topic || lane, finding);
  if (!key) return { block: false, key: null, reason: null, state: null };
  const { block, reason, state } = shouldFilter(key);
  return { block, key, reason, state };
}

/** Feedback rows, newest first, bounded — sends inside any window sit near the tail. */
function tailRows(feedbackPath, maxLines) {
  let lines;
  try { lines = fs.readFileSync(feedbackPath, "utf8").split("\n"); } catch { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && lines.length - i <= maxLines; i--) {
    const ln = lines[i];
    if (!ln || !ln.trim()) continue;
    try { out.push(JSON.parse(ln)); } catch { /* skip */ }
  }
  return out;
}

/** Exit-8 check: the most recent send of `dedupKey` inside the window, or null. */
export function findRecentDedupSend(dedupKey, { feedbackPath = FEEDBACK_PATH, windowH = dedupWindowFor(dedupKey), nowMs = Date.now(), rows = null } = {}) {
  if (!dedupKey) return null;
  const sinceMs = nowMs - windowH * 3600_000;
  for (const row of rows || tailRows(feedbackPath, LEDGER_SCAN_ROWS)) {
    if (!row.sent_at) continue;
    if (new Date(row.sent_at).getTime() < sinceMs) break; // past the window
    const rf = Array.isArray(row.findings) ? row.findings : [];
    if (rf.some((f) => f && f.dedup_key === dedupKey)) return row;
  }
  return null;
}

/**
 * dedup_keys that outbound-precheck / the ranker already killed as settled
 * ("wiki_settled" ticks in hum-runs.jsonl) inside the window. Each such tick
 * names the settled candidate first in near_miss_candidates; without this veto
 * the same candidate wins the next tick too and the runner-ups never get a turn
 * (seen on two lanes, each winning two ticks two days apart).
 * Returns Map<dedup_key, ts>. Fail-open: an unreadable ledger returns an empty map.
 */
export function wikiSettledKeys({ runsPath = RUNS_PATH, nowMs = Date.now(), windowD = settledWindowD() } = {}) {
  const out = new Map();
  const sinceMs = nowMs - windowD * 86400_000;
  for (const row of tailRows(runsPath, 2000)) {
    const ts = new Date(row?.ts || 0).getTime();
    if (!ts) continue;
    if (ts < sinceMs) break; // newest first: past the window
    if (row?.sonnet?.silent_root_cause !== "wiki_settled") continue;
    const key = row.sonnet.near_miss_candidates?.[0]?.dedup_key;
    if (key && !out.has(key)) out.set(key, row.ts);
  }
  return out;
}

// ── A place re-recommended under a new key ─────────────────────────────────
// A place can go out under one idea id and again days later under a second: a
// new key, wording too different for the embedding, and the user notices it
// has been floated before. nearby closed this hole by keying on an identity code already owns
// (the matched encyclopedia title); an idea or a dining pick has none,
// the place lives only in model-written text. So code supplies the restaurant /
// place RECOMMENDATIONS already sent (dining lane, ideas in PLACE_IDEA_CATEGORIES;
// never reminders, logistics, warnings or closings) and a model judges whether
// the candidate re-recommends one (Rule #0b: Jev, Sonnet below its bar).
// A DEFERRED recommendation is left out ("snooze", or a reply classified
// snoozed / deferred, e.g. "good idea, another day"): that means remind
// me later. Fail-open. A real answer is cached per (candidate,
// earlier recommendations, question). A vetoed idea is retired through
// `hum-reservoir-prune --expire`, so it stops winning the ideas slot.
export const PLACE_IDEA_CATEGORIES = new Set(["dining", "taste-match"]);
const DEFERRED_DISPOSITIONS = new Set(["snoozed", "deferred"]);
const SNOOZE_REACTIONS = new Set(["snooze", "💤"]);
const MAX_PRIORS = 30;
export const PLACE_SITE = "hum-place-repeat";
export const placeRepeatWindowD = () => Number(process.env.HUM_PLACE_REPEAT_WINDOW_D || 21);
// One deadline for all of a tick's place checks, run in parallel: the harvest is a
// Bash call with a ~120 s budget, and in the shadow week each check also waits on
// Sonnet. Past it the check is skipped (veto nothing, cache nothing, log it), the
// same fail-open contract as the novelty gate's 4 s budget.
export const placeDeadlineMs = () => Number(process.env.HUM_PLACE_REPEAT_DEADLINE_MS || 20000);
const msLeft = (deadlineAt, cap) => Math.max(1000, Math.min(cap, (deadlineAt ?? Infinity) - Date.now()));
export const RESPONSES_PATH = process.env.HUM_RESPONSES_PATH
  || installTools("data/hum-responses.jsonl");
const PLACE_CACHE_PATH = process.env.HUM_PLACE_REPEAT_CACHE
  || installTools("data/.cache/hum-place-repeat.json");
const PLACE_CACHE_TTL_MS = 3 * 86400_000;
const PRUNE_BIN = installTools("bin/hum-reservoir-prune");

/** A restaurant / place recommendation: the dining lane, or an idea in a recommendation category. */
export function isPlaceRecommendation(f) {
  if (f?.topic === "dining") return true;
  return f?.topic === "ideas" && PLACE_IDEA_CATEGORIES.has(f?.supporting_data?.category);
}

/** Recommendations already sent inside the window, newest first, deferred ones left out. */
export function recentPlacePitches({ rows = null, feedbackPath = FEEDBACK_PATH, responsesPath = RESPONSES_PATH, nowMs = Date.now(), windowD = placeRepeatWindowD() } = {}) {
  const deferred = new Set();
  for (const r of tailRows(responsesPath, LEDGER_SCAN_ROWS)) {
    if (r?.ping_id && DEFERRED_DISPOSITIONS.has(r.disposition)) deferred.add(r.ping_id);
  }
  const sinceMs = nowMs - windowD * 86400_000;
  const out = [];
  for (const row of rows || tailRows(feedbackPath, LEDGER_SCAN_ROWS)) {
    const t = Date.parse(row?.sent_at || "");
    if (!Number.isFinite(t) || t > nowMs) continue;
    if (t < sinceMs || out.length >= MAX_PRIORS) break;
    const f = Array.isArray(row.findings) ? row.findings[0] : null;
    if (!f?.signal || !isPlaceRecommendation({ ...f, topic: f.topic || row.lane })) continue;
    if (!row.ping_id || deferred.has(row.ping_id) || SNOOZE_REACTIONS.has(row.reaction)) continue;
    out.push({ ping_id: row.ping_id, sent_at: row.sent_at, text: String(f.signal).slice(0, 240) });
  }
  return out;
}

async function placeQuestion() {
  const { jevSiteDef } = await import("./jev.mjs");
  return jevSiteDef(PLACE_SITE) || {};
}

/** Tool-less Sonnet read: id re-recommended, null for none, undefined for no answer. */
async function sonnetSamePlace(candidate, earlier, tpl, deadlineAt) {
  const { runToolless, parseModelJson } = await import("./jev-claude.mjs");
  const { MODELS } = createRequire(import.meta.url)("./models.cjs");
  const prompt = `Edva, ${OWNER}'s assistant, is about to send them this suggestion:\n${candidate}\n\nRecommendations it already sent them in the last few weeks:\n${earlier.map((e) => `${e.id} (${e.sent}): ${e.text}`).join("\n")}\n\n${tpl.instructions}\nReply with JSON only: {"same_as": "<id>"} or {"same_as": "none"}.`;
  const j = parseModelJson(await runToolless({ model: MODELS.sonnet, prompt, timeoutMs: msLeft(deadlineAt, 45000) }));
  if (!j || typeof j.same_as !== "string") return undefined;
  return earlier.some((e) => e.id === j.same_as) ? j.same_as : null;
}

/** Jev (choice over the earlier recommendations + none) → Sonnet. Index into priors, null for none, undefined for no answer. */
export async function judgeSamePlace(candidateText, priors, { id = null, def = null, deadlineAt = null } = {}) {
  const [{ decide }, { answerConfidence }] = await Promise.all([import("./jev-shadow.mjs"), import("./jev.mjs")]);
  const q = def || await placeQuestion();
  const tpl = q.same_place_template;
  if (!tpl?.instructions) return undefined; // no question on file: ask nothing
  const earlier = priors.map((p, i) => ({ id: `p${i}`, sent: String(p.sent_at).slice(0, 10), text: p.text }));
  const criteria = { ...tpl.fixed_criteria };
  for (const e of earlier) criteria[e.id] = e.text.slice(0, 200);
  let memo = null;
  const legacy = () => (memo ||= sonnetSamePlace(candidateText, earlier, tpl, deadlineAt));
  const { value } = await decide({
    site: PLACE_SITE, id, privacyScreen: true, jevTimeoutMs: msLeft(deadlineAt, 8000),
    state: { candidate: candidateText, earlier_recommendations: earlier },
    questions: { same_place: { type: "choice", instructions: tpl.instructions, criteria } },
    interpret: (answers) => {
      const pick = answers?.same_place?.choice;
      return { value: earlier.some((e) => e.id === pick) ? pick : null, confidence: answerConfidence(answers?.same_place) };
    },
    legacy,
    // Own shadow week: Sonnet runs alongside Jev until the question file's shadow_until.
    alwaysShadow: !!(q.shadow_until && Date.now() < Date.parse(q.shadow_until)),
    // A Sonnet that gave no answer is not a "none" verdict (same rule as hum-reply-segments).
    shadow: () => legacy().then((p) => { if (p === undefined) throw new Error("sonnet gave no answer"); return p; }),
  });
  if (value === undefined) return undefined;
  const i = earlier.findIndex((e) => e.id === value);
  return i >= 0 ? i : null;
}

function readPlaceCache(p) {
  try { const c = JSON.parse(fs.readFileSync(p, "utf8")); return c && typeof c === "object" ? c : {}; } catch { return {}; }
}
function writePlaceCache(p, cache, nowMs) {
  try {
    for (const [k, v] of Object.entries(cache)) if (!(nowMs - Date.parse(v?.ts || "") < PLACE_CACHE_TTL_MS)) delete cache[k];
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cache) + "\n");
    fs.renameSync(tmp, p);
  } catch { /* a cache, never a dependency */ }
}

/** The earlier recommendation {ping_id, sent_at, text} this candidate re-recommends, or null. deps: priors | recentPlacePitches opts, placeJudge, placeCachePath. */
export async function findSamePlacePitch(c, deps = {}) {
  try {
    const text = String(c?.signal || "").trim();
    if (!text || !isPlaceRecommendation(c)) return null;
    const priors = deps.priors || recentPlacePitches(deps);
    if (!priors.length) return null;
    const nowMs = deps.nowMs ?? Date.now();
    const def = deps.placeJudge ? {} : await placeQuestion();
    const cachePath = deps.placeCachePath || PLACE_CACHE_PATH;
    const cache = readPlaceCache(cachePath);
    const key = createHash("sha256").update(JSON.stringify([text, priors.map((p) => [p.ping_id, p.text]), def.same_place_template || null])).digest("hex").slice(0, 32);
    const hit = cache[key];
    if (hit && nowMs - Date.parse(hit.ts || "") < PLACE_CACHE_TTL_MS) {
      return hit.same ? priors.find((p) => p.ping_id === hit.same) || null : null;
    }
    const idx = await (deps.placeJudge || judgeSamePlace)(text, priors, { id: c.dedup_key || null, def, deadlineAt: deps.deadlineAt ?? null });
    if (idx === undefined) return null; // no answer: ask again next time
    if (deps.deadlineAt && Date.now() > deps.deadlineAt) return null; // too late: the caller has moved on, cache nothing
    const prior = Number.isInteger(idx) ? priors[idx] || null : null;
    cache[key] = { ts: new Date(nowMs).toISOString(), same: prior?.ping_id || null };
    writePlaceCache(cachePath, cache, nowMs);
    return prior;
  } catch { return null; }
}

/** Retire a re-pitched idea through the reservoir's own writer (hum.md § retire_ideas). Fail-open. */
export function retireRepitchedIdea(ideaId, why) {
  try {
    execFileSync(process.execPath, [PRUNE_BIN, "--expire", ideaId, "--reason", why], { timeout: 15000, stdio: "ignore" });
    return true;
  } catch { return false; }
}

/** Exit-10 input: retrospective asks already sent since local midnight. */
export function countRetrospectiveAsksToday({ feedbackPath = FEEDBACK_PATH, now = new Date(), rows = null } = {}) {
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  let n = 0;
  for (const row of rows || tailRows(feedbackPath, 400)) {
    if (!row.sent_at) continue;
    if (new Date(row.sent_at).getTime() < dayStart.getTime()) break;
    const rf = Array.isArray(row.findings) ? row.findings : [];
    if (rf.some((f) => isRetrospectiveAsk(f))) n++;
  }
  return n;
}

/**
 * Drop every candidate a send-time gate would refuse, BEFORE ranking.
 *
 * Mutates nothing it doesn't own except stamping a derived `dedup_key` onto a
 * candidate that lacked one (so the ranker, hum-ping and the trace all agree on
 * the key), and retiring an idea vetoed as a place re-recommendation. Returns
 * `{ eligible, vetoed }`; each veto names its gate with the same vocabulary as
 * hum.md's `silent_root_cause` enum.
 *
 * `deps`: `preview` (hum-harvest-all --preview: no model-judged check), and for
 * tests embed / recentVectors / nowMs / feedbackPath / statePath / tz /
 * checkPingBudget / placeJudge / placeCachePath / placeDeadlineMs / retireIdea /
 * responsesPath / log / resolvedKeys / resolvedStore.
 */
export async function preRankFilter(candidates, deps = {}) {
  const nowMs = deps.nowMs ?? Date.now();
  const feedbackPath = deps.feedbackPath || FEEDBACK_PATH;
  const embed = deps.embed || novelty.embed;
  const recentVectors = deps.recentVectors || novelty.recentVectors;
  // Per-lane since 2026-10-06 (novelty.THRESHOLD_BY_LANE): `nearby` keys on a
  // standing subject, so telling a NEW fact from a RESTATED one is this gate's
  // job rather than the exit-8 window's. An explicit deps override still wins,
  // for tests.
  const thresholdOverride = deps.noveltyThreshold;
  const budgetMs = deps.noveltyBudgetMs ?? 4000;
  const rows = tailRows(feedbackPath, LEDGER_SCAN_ROWS);

  const eligible = [];
  const vetoed = [];
  const veto = (c, gate, detail) => vetoed.push({ topic: c.topic ?? null, dedup_key: c.dedup_key ?? null, gate, detail });

  let settled = null;
  let resolved = null;
  let asksToday = null;
  let vectors = null;
  const budgets = {};
  const started = Date.now();

  for (const c of candidates || []) {
    if (!c || typeof c !== "object") continue;
    const lane = c.topic;
    if (!c.dedup_key && (c.signal || c.subject_key)) c.dedup_key = deriveDedupKey(c, lane);
    const bypass = isProtectedLane(lane) || (typeof c.urgency === "number" && c.urgency >= HIGH_URGENCY);

    try {
      const sb = subjectBlock(c, lane);
      if (sb.block) { veto(c, "history_blocked", `${sb.key} ${sb.reason}`); continue; }
    } catch { /* fail-open */ }

    if (c.dedup_key && !bypass) {
      try {
        if (resolved === null) resolved = deps.resolvedKeys || resolvedKeys({ nowMs, ...(deps.resolvedStore ? { file: deps.resolvedStore } : {}) });
        const hit = resolved.get(c.dedup_key);
        if (hit) { veto(c, "resolved_first", `answered from the records ${hit.ts} (${hit.decision_id})`); continue; }
      } catch { /* fail-open */ }
    }

    if (c.dedup_key && !bypass) {
      try {
        if (settled === null) settled = deps.wikiSettled || wikiSettledKeys({ runsPath: deps.runsPath || RUNS_PATH, nowMs });
        if (settled.has(c.dedup_key)) { veto(c, "wiki_settled", `held back as already settled ${settled.get(c.dedup_key)}`); continue; }
      } catch { /* fail-open */ }
    }

    if (c.dedup_key && (!bypass || !dedupBypassable(c.dedup_key))) {
      const dup = findRecentDedupSend(c.dedup_key, { rows, nowMs, windowH: dedupWindowFor(c.dedup_key) });
      if (dup) { veto(c, "cross_send_dedup", `sent ${dup.sent_at} (${dup.ping_id || "?"})`); continue; }
    }

    if (!bypass) {
      try {
        // Local explanations (nearby factoids) have their own pool since 2026-10-20,
        // and questions of every lane their own, scaled to the backlog.
        const pool = isQuestionCandidate(c) ? "question" : isLocalHistoryRow(c) ? "local_history" : "shared";
        if (!budgets[pool]) {
          budgets[pool] = pool === "question"
            ? (deps.checkQuestionBudget || checkQuestionBudget)({ now: new Date(nowMs), ...(deps.tz ? { tz: deps.tz } : {}) })
            : (deps.checkPingBudget || checkPingBudget)({ now: new Date(nowMs), rows, pool, ...(deps.statePath ? { statePath: deps.statePath } : {}), ...(deps.tz ? { tz: deps.tz } : {}) });
        }
        const b = budgets[pool];
        // Location asks skip the 45-min spacing (perishable; see hum-ping 0c-ter) but not the daily cap.
        const spacingOnly = b.gate === "min_interval" && isRetrospectiveAsk(c);
        if (!b.ok && !spacingOnly) { veto(c, "rate_limited", `${pool === "shared" ? "" : `${pool.replace("_", " ")} `}${b.gate}: ${b.detail}`); continue; }
      } catch { /* fail-open */ }
    }

    if (isRetrospectiveAsk(c) && askCap() > 0) {
      if (asksToday === null) asksToday = countRetrospectiveAsksToday({ rows, now: new Date(nowMs) });
      const cap = askCap() * (deps.questionScale ?? currentScale());
      if (asksToday >= cap) { veto(c, "retrospective_ask_cap", `${asksToday} sent today (cap ${cap})`); continue; }
    }

    if (!bypass && Date.now() - started < budgetMs) {
      try {
        const text = novelty.signalText(c, "");
        const vec = text ? await embed(text) : null;
        if (vec) {
          if (vectors === null) vectors = recentVectors(nowMs);
          const { maxSim, nearest } = novelty.nearestDuplicate(vec, vectors);
          const threshold = thresholdOverride ?? novelty.thresholdFor(lane);
          if (maxSim >= threshold) {
            veto(c, "novelty_duplicate", `cosine ${maxSim.toFixed(3)} vs ${nearest?.ping_id || "?"}`);
            continue;
          }
        }
      } catch { /* fail-open */ }
    }

    eligible.push(c);
  }

  // A restaurant / place re-recommended under a new key. After the loop so a
  // model call never eats the novelty budget; never in --preview (no model
  // call, no cache or reservoir write there). Same carve-outs as dedup. The
  // checks run in parallel under one deadline (placeDeadlineMs).
  if (deps.preview) return { eligible, vetoed };
  const toCheck = eligible.filter((c) => isPlaceRecommendation(c)
    && !(isProtectedLane(c.topic) || (typeof c.urgency === "number" && c.urgency >= HIGH_URGENCY)));
  const verdicts = new Map();
  if (toCheck.length) {
    const priors = recentPlacePitches({ rows, nowMs, ...(deps.responsesPath ? { responsesPath: deps.responsesPath } : {}) });
    const ms = deps.placeDeadlineMs ?? placeDeadlineMs();
    const deadlineAt = Date.now() + ms;
    const TIMEOUT = Symbol("deadline");
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), ms); });
    const results = await Promise.all(toCheck.map((c) => Promise.race([findSamePlacePitch(c, { ...deps, priors, nowMs, deadlineAt }), late])));
    clearTimeout(timer);
    toCheck.forEach((c, i) => {
      if (results[i] === TIMEOUT) (deps.log || console.error)(`hum-vetoes: place-repeat check skipped for ${c.dedup_key || c.topic} (no answer within ${ms}ms) — fail-open`);
      else if (results[i]) verdicts.set(c, results[i]);
    });
  }
  const kept = [];
  for (const c of eligible) {
    const prior = verdicts.get(c);
    if (!prior) { kept.push(c); continue; }
    const why = `same place as ${prior.ping_id} sent ${prior.sent_at}`;
    const isIdea = c.topic === "ideas" && String(c.dedup_key || "").startsWith("idea-");
    const retired = isIdea && (deps.retireIdea || retireRepitchedIdea)(c.dedup_key, `hum-place-repeat: re-recommends a place already recommended (${prior.ping_id})`);
    veto(c, "cross_send_dedup", retired ? `${why}; idea retired` : why);
  }
  return { eligible: kept, vetoed };
}
