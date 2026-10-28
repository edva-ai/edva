#!/usr/bin/env node
// hum-harvest-all — reads the registry, fans out to every enabled harvester
// in parallel passing the situation snapshot on stdin, collects non-null
// candidates. Single JSON array on stdout.
//
// Skips topics whose cadence_min hasn't elapsed since last_run_at and topics
// whose active_window filter excludes the current time.
//
// Two modes:
//
//   (default) COMMIT — the real harvest a hum turn acts on. Consumes the
//             dispatch context, lets harvesters stamp their state, and writes
//             the full result to data/hum-last-harvest.json, which
//             `hum-run-log append` reads to write machine-exact candidates
//             into the tick trace.
//
//   --preview PURE — "what would a harvest find right now?" with no side
//             effects: the dispatch context is left unconsumed, harvesters run
//             with HUM_HARVEST_PREVIEW=1 (every in-process write under
//             data is a no-op, see _common.mjs), and the model-forking
//             lanes (MODEL_LANES) are not run at all — they cost a Sonnet call
//             and spawn children the write-guard cannot reach. Lanes that WOULD
//             have run are reported in meta.preview_skipped_model_lanes so a
//             caller never mistakes "not looked at" for "nothing there".
//             Used by the hum-sense gate (lib/jev-hum-gate.mjs) to skip
//             idle ticks that have nothing eligible.
//
// Both modes run the pre-rank veto filter (lib/hum-vetoes.mjs): a
// candidate hum-ping would refuse at send time never reaches the ranker. Its
// model-judged place re-recommendation check runs in COMMIT mode only.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { computeEngagementWeights, DISCRETIONARY_LANES, normLane } from "../../lib/hum-engagement.mjs";
import { recallForCandidates } from "./hum-wiki-recall.mjs";
import { loadTimeline, checkClaims } from "../../lib/claim-facts.mjs";
import { buildIntent } from "../../lib/hum-intent.mjs";
import { preRankFilter } from "../../lib/hum-vetoes.mjs";
import { orderQuestionsFirst, questionBacklog, pacingScale, questionSlotBusy } from "../../lib/question-pacing.mjs";
import { createRequire } from "node:module";

import { installTools } from "../../lib/root.cjs";
// Per-instance values (lib/instance.cjs): the home timezone, and the
// instance's own lanes added to the locality classes below
// (agent/local/config/hum-lanes.json, `extend_place_bound` /
// `extend_operational`).
const { instance, localConfig } = createRequire(import.meta.url)("../../lib/instance.cjs");
const HOME_TZ = instance().tz;
const HUM_LANES = localConfig("hum-lanes", {
  place_bound: [
    "nearby", "location_context", "dining", "situation", "weather", "exercise",
  ],
  operational: [
    "watchdog", "secret_failures", "tasks", "calendar", "email_followups", "travel",
    "watchlist-approval",
  ],
});

const HOME = os.homedir();
const REGISTRY = installTools("data/hum-interests.json");
const STATE = installTools("data/hum-interests-state.json");
const HARVESTER_DIR = installTools("agent/scripts/hum-harvesters");
// An installation's own harvesters may sit in hum-harvesters/_ext/ (an overlay
// drop, same shape as the kernel's); a kernel harvester wins on a name.
const HARVESTER_EXT_DIR = path.join(HARVESTER_DIR, "_ext");

// A topic's harvester script (`script`, a file name in the harvester dir):
// the kernel dir's, else _ext/'s. Neither → the kernel path, so the spawn
// error says where it was looked for.
function resolveHarvesterPath(topic, { dir = HARVESTER_DIR, extDir = HARVESTER_EXT_DIR } = {}) {
  const kernel = path.join(dir, topic.script);
  if (fs.existsSync(kernel)) return kernel;
  const overlay = path.join(extDir, topic.script);
  if (fs.existsSync(overlay)) return overlay;
  return kernel;
}
const LAST_HARVEST = installTools("data/hum-last-harvest.json");

// Lanes that fork a `claude -p` (or several web searches) per run. Never run in
// --preview: a preview must be cheap and side-effect free.
const MODEL_LANES = new Set(["art", "music", "screen", "dining", "crossref", "nearby", "situation"]);

function readJson(p, def = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return def; }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// Lanes whose candidates ARE about where the user is standing — never deboosted for
// locality, because they are the locality.
const PLACE_BOUND_LANES = new Set(HUM_LANES.place_bound);
// Lanes that must never lose a slot to geography. Operational, financial,
// health and time-critical work is not less important because the user just arrived
// somewhere — the locality rule is about crowding out chatter, not signal.
const OPERATIONAL_LANES = new Set(HUM_LANES.operational);
// Enough to lose a head-to-head against a real local candidate, not enough to
// silence a genuinely urgent one on its own.
const LOCALITY_DEBOOST = 0.55;

function minutesSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Math.round((Date.now() - t) / 60000);
}

function inActiveWindow(spec) {
  // spec examples: "mon-fri 09:30-16:00 ET", null, "sat-sun", "daily" (kernel-guard-ok: US market-hours ET, not the home zone)
  if (!spec || spec === "daily") return true;
  // A spec ending in "ET" is US Eastern time by definition (e.g. US market
  // hours), whoever the user is — otherwise local time
  const useEt = /\bET\b/.test(spec);
  const now = useEt
    ? new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })) // kernel-guard-ok: US market hours are US Eastern for every user
    : new Date();
  const day = now.getDay(); // 0=Sun .. 6=Sat
  const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const dayToday = dayNames[day];

  // Day range
  const dayMatch = spec.match(/\b(sun|mon|tue|wed|thu|fri|sat)-(sun|mon|tue|wed|thu|fri|sat)\b/i);
  if (dayMatch) {
    const a = dayNames.indexOf(dayMatch[1].toLowerCase());
    const b = dayNames.indexOf(dayMatch[2].toLowerCase());
    const dn = day;
    const within = a <= b ? (dn >= a && dn <= b) : (dn >= a || dn <= b);
    if (!within) return false;
  }

  // Time range
  const timeMatch = spec.match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const [, sh, sm, eh, em] = timeMatch.map(Number);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (nowMin < startMin || nowMin >= endMin) return false;
  }
  void dayToday;
  return true;
}

// One id per harvest run when no tick passed one down (event-driven runs).
const HARVEST_RUN_ID = `h-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)}-${process.pid}`;

function runHarvester(topic, scriptPath, situationJson, timeoutMs, { preview = false } = {}) {
  return new Promise((resolve) => {
    // HUM_LANE + HUM_TICK_ID tag any paid call a harvester makes (the Places
    // call log reads them) with the lane and the run that asked, so a Places
    // bill never has to be attributed from burst timing.
    const env = { ...process.env, HUM_LANE: topic, HUM_TICK_ID: process.env.HUM_TICK_ID || HARVEST_RUN_ID };
    const child = spawn("node", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: preview ? { ...env, HUM_HARVEST_PREVIEW: "1" } : env,
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ topic, candidate: null, err: `timeout after ${timeoutMs}ms`, out });
    }, timeoutMs);

    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", () => {
      clearTimeout(timer);
      const line = (out.trim().split("\n").pop() || "").trim();
      if (!line || line === "null") return resolve({ topic, candidate: null, err });
      try { resolve({ topic, candidate: JSON.parse(line), err }); }
      catch { resolve({ topic, candidate: null, err: `bad JSON: ${line.slice(0, 80)}` }); }
    });
    child.stdin.write(situationJson);
    child.stdin.end();
  });
}

async function main() {
  const registry = readJson(REGISTRY, { topics: [] });
  const state = readJson(STATE, {});
  const args = new Set(process.argv.slice(2));
  const forceAll = args.has("--force");
  const preview = args.has("--preview");
  const onlyTopic = (() => {
    const idx = process.argv.indexOf("--topic");
    return idx >= 0 ? process.argv[idx + 1] : null;
  })();

  // Read situation from stdin (one JSON object); empty stdin → empty object
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const situationJson = Buffer.concat(chunks).toString("utf8").trim() || "{}";

  // Build the unified edva-context once per tick and pass it to every
  // harvester alongside the situation. Harvesters receive envelope shape:
  //   { situation, context }
  // on stdin. See lib/edva-context.js for fields.
  let contextJson = "{}";
  try {
    const ctxBuilder = await import(installTools("lib/edva-context.js"));
    const ctx = ctxBuilder.default.build ? ctxBuilder.default.build() : ctxBuilder.build();
    contextJson = JSON.stringify(ctx);
  } catch (e) {
    console.error(`hum-harvest-all: context build failed: ${e.message}`);
  }
  const situationObj = safeParse(situationJson);

  // ─── focus lanes (event-driven dispatches) ──────────────────────────────
  //
  // A situational trigger knows which lanes its event made relevant — an
  // arrival implicates location_context/dining, a metro change implicates
  // every place-bound lane. hum-sense passes them through as `lanes` in the
  // dispatch payload and the playbook forwards them here:
  //
  //   HUM_FOCUS_LANES  force these lanes to run even if their cadence hasn't
  //                    elapsed, and let every other lane run on its normal
  //                    cadence. This is the default for an event tick: react
  //                    immediately to what happened without going blind to
  //                    anything else that happens to be due.
  //   HUM_ONLY_LANES   run ONLY these. For a fast, deliberately narrow tick.
  //
  // An idle-fallback dispatch passes neither, which is exactly right: with no
  // situational hint there is nothing to focus on, so the full cadence-gated
  // fan-out is the correct behaviour.
  //
  // The env vars are the explicit override. The DEFAULT source is the
  // dispatch-context file hum-sense writes at dispatch time — because a
  // playbook that doesn't pass the env var would run a harvest that ignores
  // what triggered it (unrelated lanes run while every implicated lane sits in
  // `skipped_cadence`). Reading the
  // file makes the focus deterministic instead of contingent on an agent
  // following prose.
  const parseLanes = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
  const DISPATCH_CONTEXT = installTools("data/hum-dispatch-context.json");
  // Freshness-gated: a dispatch reaches the agent in ~1-2 min. Ten minutes is
  // generous for that hop while guaranteeing a stale file can never focus an
  // unrelated later tick (e.g. a manual run hours afterwards).
  const CONTEXT_MAX_AGE_MIN = 10;
  let contextLanes = [];
  let focusSource = "none";
  // Carried into the trace so a harvest can be tied back to the dispatch that
  // caused it — the correlation key `hum-sense log` joins on.
  let dispatchId = null;
  // The moment itself, handed to the harvesters: which events caused this turn,
  // their payloads (an arrival's lat/lon above all), and how stale they are by
  // the time anything can act on them.
  let moment = null;
  // NOTE the shape here: `HUM_FOCUS_LANES` overrides only WHICH LANES RUN. It
  // must NOT skip reading the dispatch context, because the context is also
  // where `moment` and the events' data live.
  //
  // Getting this wrong silently disables the entire `nearby` lane: the
  // playbook exports HUM_FOCUS_LANES as jobs/hum.md says, that takes the env
  // branch, `moment` stays null, and `nearby` declines every arrival with
  // "no location event behind this turn" — while the trace shows it dutifully
  // attempted. Wired, reached, and structurally incapable of ever firing.
  {
    const file = readJson(DISPATCH_CONTEXT, null);
    // schema 2 is a LIST of dispatches; a single record (schema 1, or a
    // rollback landing mid-flight) is still read as a one-element list rather
    // than ignored, so an older writer degrades instead of blinding the focus.
    const all = Array.isArray(file?.contexts) ? file.contexts : (file?.ts ? [file] : []);
    const mine = all.filter((c) => !c.consumed_at && minutesSince(c.ts) <= CONTEXT_MAX_AGE_MIN);
    if (mine.length) {
      // EVERY unconsumed moment, not just the newest. A perishable arrival can
      // be folded into a hum turn that was already waiting, so one turn
      // legitimately represents several dispatches — taking only the latest
      // would strand the arrival's lanes unconsumed until some later,
      // unrelated tick picked them up.
      const lanes = [...new Set(mine.flatMap((c) => (Array.isArray(c.lanes) ? c.lanes : [])))];
      dispatchId = mine[mine.length - 1].dispatch_id ?? null;
      if (process.env.HUM_FOCUS_LANES) {
        focusSource = "env";           // the env var still wins on lane SELECTION
      } else if (lanes.length) {
        contextLanes = lanes;
        focusSource = "dispatch-context";
      }
      const events = mine.flatMap((c) => c.events || []);
      const perishableAges = mine.filter((c) => c.perishable).map((c) => minutesSince(c.ts));
      moment = {
        dispatch_ids: mine.map((c) => c.dispatch_id).filter(Boolean),
        focus: mine.map((c) => c.focus).filter(Boolean).join(" · ") || null,
        age_min: Math.min(...mine.map((c) => minutesSince(c.ts))),
        perishable: perishableAges.length > 0,
        // How late a time-critical moment has become. A "there's a good bakery
        // on this corner" note is worth sending at two minutes and worth
        // nothing at twenty; the moment-bound lanes read this and decline
        // rather than ping the user about a corner they left.
        perishable_age_min: perishableAges.length ? Math.min(...perishableAges) : null,
        events,
      };
      // Mark consumed so the next turn doesn't re-react to the same moment.
      // Never in --preview: a preview must leave the moment for the real turn.
      if (!preview && Array.isArray(file?.contexts)) {
        const now = new Date().toISOString();
        const consumed = new Set(mine.map((c) => c.dispatch_id));
        for (const c of file.contexts) if (consumed.has(c.dispatch_id)) c.consumed_at = now;
        try {
          const tmp = `${DISPATCH_CONTEXT}.tmp.${process.pid}`;
          fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
          fs.renameSync(tmp, DISPATCH_CONTEXT);
        } catch (e) {
          console.error(`hum-harvest-all: could not mark dispatch context consumed: ${e.message}`);
        }
      }
    }
  }
  const focusLanes = new Set(process.env.HUM_FOCUS_LANES ? parseLanes(process.env.HUM_FOCUS_LANES) : contextLanes);
  const onlyLanes = new Set(parseLanes(process.env.HUM_ONLY_LANES));

  // What the user is trying to DO, alongside where they are. Assembled once per tick and
  // passed to every harvester; see lib/hum-intent.mjs for why it is raw
  // rather than interpreted. Fail-open: no intent block behaves as before.
  let intent = null;
  try {
    const localDate = situationObj?.time?.local_date
      || new Date().toLocaleDateString("en-CA", { timeZone: situationObj?.time?.tz || HOME_TZ });
    intent = buildIntent({ localDate });
  } catch (e) {
    console.error(`hum-harvest-all: intent build failed: ${e.message}`);
  }

  // Harvesters receive envelope shape { situation, context, moment, intent }.
  const envelope = JSON.stringify({
    situation: situationObj,
    context: safeParse(contextJson),
    moment,
    intent,
  });

  const runnable = registry.topics.filter((t) => {
    if (!t.enabled) return false;
    if (onlyTopic && t.name !== onlyTopic) return false;
    if (onlyLanes.size) return onlyLanes.has(t.name);
    if (forceAll) return true;
    // A focused lane bypasses cadence but NOT its active window — a stocks
    // lane forced at 22:00 has nothing to say either way.
    if (focusLanes.has(t.name)) return inActiveWindow(t.active_window);
    if (!inActiveWindow(t.active_window)) return false;
    const ageMin = minutesSince(state[t.name]?.last_run_at);
    if (ageMin < (t.cadence_min ?? 20)) return false;
    return true;
  });

  // --preview never runs a model-forking lane (cost + unguardable children);
  // it reports the ones that WOULD have run so "unseen" is never read as
  // "empty".
  const previewSkippedModelLanes = preview ? runnable.filter((t) => MODEL_LANES.has(t.name)).map((t) => t.name) : [];
  const toRun = preview ? runnable.filter((t) => !MODEL_LANES.has(t.name)) : runnable;

  // Run all in parallel. Web-search harvesters can take longer — give them 150s; rest 15s.
  const results = await Promise.all(toRun.map((t) => {
    // Web-search harvesters get 150s. `nearby` forks a model too but does no
    // web search — it judges data already fetched — so it gets 75s: long
    // enough for the call, short enough that a perishable moment can't be
    // held hostage by it.
    const timeout = ["art", "music", "screen", "dining", "crossref"].includes(t.name) ? 150000
      : t.name === "nearby" ? 75000
      : 15000;
    return runHarvester(t.name, resolveHarvesterPath(t), envelope, timeout, { preview });
  }));

  const candidates = results.filter((r) => r.candidate).map((r) => r.candidate);

  // Deterministic feedback-weighting: scale DISCRETIONARY-lane
  // candidates' urgency by the user's engagement (hum-engagement.mjs) before the
  // ranker sees them — engaged lanes boosted, ignored/👎'd lanes suppressed.
  // Operational/safety lanes are never in DISCRETIONARY_LANES, so they're
  // untouched. Records engagement_weight on the candidate for hum-review.
  const engWeights = computeEngagementWeights();
  for (const c of candidates) {
    if (!c || typeof c.urgency !== "number") continue;
    const lane = normLane(c.topic);
    if (!DISCRETIONARY_LANES.has(lane)) continue;
    const w = engWeights[lane] ?? 1.0;
    if (w === 1.0) continue;
    c.engagement_weight = w;
    c.urgency = +Math.max(0, Math.min(1, c.urgency * w)).toFixed(3);
  }

  // ─── locality weighting ─────────────────────────────────────────────────
  //
  // When a perishable location edge is what woke this turn, the ping should be
  // about the place or there should be no ping. Live evidence for why this
  // needs to be code and not an instruction: given an instruction alone, the
  // ranker picks a lunch-window dispatch's unrelated idea, a suggestion for a
  // city the user has left, or an admin question about somewhere far away.
  //
  // So: scale down candidates with no tie to where the user is standing. Two lanes
  // are exempt — the place-bound ones (that's the whole point) and the
  // operational/safety ones, which must never lose to geography: a watchdog
  // alert or an overdue task is not less important because the user just
  // walked into a café.
  const localityAdjusted = [];
  if (moment?.perishable) {
    for (const c of candidates) {
      if (!c || typeof c.urgency !== "number") continue;
      const lane = normLane(c.topic);
      if (PLACE_BOUND_LANES.has(lane) || OPERATIONAL_LANES.has(lane)) continue;
      const before = c.urgency;
      c.locality_weight = LOCALITY_DEBOOST;
      c.urgency = +Math.max(0, Math.min(1, c.urgency * LOCALITY_DEBOOST)).toFixed(3);
      localityAdjusted.push({ topic: c.topic, from: before, to: c.urgency });
    }
  }

  const skipped = registry.topics
    .filter((t) => t.enabled)
    .filter((t) => !runnable.find((r) => r.name === t.name))
    .map((t) => t.name);
  // Separate genuine failures from clean no-ops (a user request: "guess less").
  // emitNull(reason) in _common.mjs writes the
  // reason to stderr for BOTH "nothing to surface" (no flights, no edges, top
  // unchanged, below threshold, deduped) AND real failures (gog failed, subagent
  // exit=1, fetch failed). Counting the no-ops as errors makes hum-review
  // misread quiet harvesters as a "systemic failure" (most topics "failing"
  // when they are simply reporting nothing to say). Classify by the reason text so the telemetry the
  // review reads reflects reality and stops generating false root causes.
  const FAIL_RE = /(fail|error|exit=|timeout|enoent|eacces|auth missing|bad json|cannot|undefined|exception|refused|econn|throw|crash|not found)/i;
  const NOOP_RE = /(\bno \b|\bnone\b|nothing|unchanged|no due|no conflict|no flight|no edge|no item|no signal|below threshold|deduped|already|cooldown|quiet|skip|stale|suppress|empty|n\/a|not? due|0 )/i;
  const classifyNull = (txt) => {
    const t = String(txt || "");
    if (t.includes("[noop]")) return "noop"; // explicit benign marker wins (emitNoop)
    if (FAIL_RE.test(t)) return "error";   // real failure wins if both match
    if (NOOP_RE.test(t)) return "noop";    // clean "nothing to surface"
    return "error";                         // unknown → conservative: an error
  };
  const nulls = results.filter((r) => r.err && !r.candidate);
  const errors = nulls.filter((r) => classifyNull(r.err) === "error").map((r) => ({ topic: r.topic, err: r.err }));
  const noops = nulls.filter((r) => classifyNull(r.err) === "noop").map((r) => ({ topic: r.topic, reason: r.err }));
  // Distinguish "every harvester ran but produced no signal" (low-signal day,
  // expected) from "harvest pipeline broken" (REAL errors dominate, candidates
  // empty by failure not by signal). all_failed now keys off genuine errors
  // only — a quiet tick where everything no-op'd is no longer "all failed".
  const harvestEmpty = candidates.length === 0 && toRun.length > 0;
  const allFailed = harvestEmpty && errors.length > 0 && errors.length === toRun.length;

  // ─── Claim-check every candidate against the authorities ────────────────
  //
  // Deterministic stage only (no LLM, no tokens): attach what Edva's own
  // live data says about the places and dates each candidate names, and DROP
  // the ones whose asserted premise the timeline flatly refutes. The costly
  // adjudication stage runs once, later, on the single winner — at send time
  // in outbound-precheck.
  //
  // Without this gate a ping about a city the user has left can be ranked and
  // shipped while `travel where` says otherwise. Running here (rather
  // than only at send time) also means a stale candidate never gets to
  // out-compete a good one for the single winner slot.
  //
  // One timeline fetch is shared across all candidates. Fail-open throughout:
  // an unreachable authority yields no facts and drops nothing.
  const claim_check = { dropped: [], flagged: [] };
  try {
    const timeline = await loadTimeline();
    if (timeline) {
      const kept = [];
      for (const c of candidates) {
        const text = [c.signal, c.subject, c.supporting_data?.subject, c.supporting_data?.rationale, c.supporting_data?.why_now]
          .filter(Boolean).join(" ");
        const { facts, contradictions } = checkClaims({
          text,
          supporting_data: c.supporting_data || null,
          reference_iso: c.supporting_data?.time_sensitive_until || c.supporting_data?.created_at || null,
        }, timeline);
        const hard = contradictions.filter((x) => x.severity === "hard");
        if (hard.length) {
          claim_check.dropped.push({ topic: c.topic, dedup_key: c.dedup_key || null, why: hard[0].why });
          continue;
        }
        if (facts.length) {
          // Ride along so the ranker sees ground truth next to the candidate
          // instead of having to infer it, and so soft mismatches reach the
          // send-time adjudicator with the facts already resolved.
          c.claim_facts = facts;
          if (contradictions.length) {
            c.claim_soft_contradictions = contradictions;
            claim_check.flagged.push({ topic: c.topic, dedup_key: c.dedup_key || null, why: contradictions[0].why });
          }
        }
        kept.push(c);
      }
      candidates.length = 0;
      candidates.push(...kept);
    }
  } catch (e) {
    console.error(`hum-harvest-all: claim-check failed (fail-open): ${e.message}`);
  }

  // ─── Pre-rank vetoes ────────────────────────────────────────────────────
  //
  // Apply hum-ping's send-time refusals (rejected subject, 24h dedup_key,
  // semantic near-duplicate, retrospective-ask cap) to EVERY candidate now,
  // so the ranker only ever sees candidates that could actually ship.
  // Otherwise a vetoed winner silences a tick that had an eligible runner-up,
  // and the ranking call that picked it is wasted. hum-ping keeps the same checks
  // as the backstop. Fail-open: an error vetoes nothing.
  let preRankVetoes = [];
  try {
    const { eligible, vetoed } = await preRankFilter(candidates, { preview });
    preRankVetoes = vetoed;
    candidates.length = 0;
    candidates.push(...eligible);
  } catch (e) {
    console.error(`hum-harvest-all: pre-rank filter failed (fail-open): ${e.message}`);
  }

  // Questions first (lib/question-pacing.mjs): every eligible question goes to
  // the head of the ranker's list, marked `supporting_data.question_first`, and
  // jobs/hum.md makes one of them the winner. Code ordering, so the rule holds
  // whatever the scores say.
  let questionsFirst = 0;
  let backlog = { total: 0, lanes: {} };
  try {
    const q = orderQuestionsFirst(candidates, { slotBusy: questionSlotBusy() });
    questionsFirst = q.questions;
    candidates.length = 0;
    candidates.push(...q.candidates);
    backlog = questionBacklog();
  } catch (e) {
    console.error(`hum-harvest-all: question ordering failed (fail-open): ${e.message}`);
  }

  // On a PERISHABLE location tick the ping is about where the user is standing
  // or there is no ping (hum.md). If every surviving candidate is a
  // deboosted non-local, non-operational one, the ranker has nothing it is
  // allowed to prefer — say so structurally so the turn can go silent without
  // a ranking call.
  const perishableNoLocal = Boolean(moment?.perishable) && candidates.length > 0
    && candidates.every((c) => {
      const lane = normLane(c.topic);
      return !PLACE_BOUND_LANES.has(lane) && !OPERATIONAL_LANES.has(lane);
    });
  const noEligible = candidates.length === 0;

  // Consult the whole wiki for what the user has already said about each
  // candidate, plus today's not-yet-consolidated replies. The ranker uses this
  // to avoid re-asking/re-surfacing anything already settled (see hum.md Step 3
  // WIKI CONTEXT / TODAY'S REPLIES). Read-only; failure degrades to empty recall
  // so a wiki hiccup never blocks the tick.
  // Skipped in --preview (nothing will be ranked) and when nothing is eligible.
  let wiki_recall = { per_candidate: [], today_replies: [], today_chat: [] };
  if (!preview && !noEligible) {
    try {
      wiki_recall = await recallForCandidates(candidates);
    } catch (e) {
      console.error(`hum-harvest-all: wiki recall failed: ${e.message}`);
    }
  }

  const output = {
    candidates,
    wiki_recall,
    claim_check,
    meta: {
      attempted: toRun.map((t) => t.name),
      // Recorded so hum-review can tell an event-focused harvest from a full
      // idle fan-out — otherwise a narrow tick looks like 25 broken lanes.
      focus_lanes: [...focusLanes],
      focus_source: focusSource,
      dispatch_id: dispatchId,
      // The moment this turn was woken for, and how late it already is. Both
      // land in the run trace so `hum-sense log` can show not just what hum
      // decided but what it was reacting to when it decided.
      moment_age_min: moment?.age_min ?? null,
      perishable_age_min: moment?.perishable_age_min ?? null,
      intent_plan_stops: intent?.plan?.stops?.length ?? 0,
      locality_adjusted: localityAdjusted,
      only_lanes: [...onlyLanes],
      skipped_cadence: skipped,
      errors,
      noops,
      harvest_empty: harvestEmpty,
      all_failed: allFailed,
      // Pre-rank veto results. `no_eligible` = nothing could ship
      // this tick → the turn writes a silent trace with NO ranking call.
      pre_rank_vetoes: preRankVetoes,
      // How many eligible candidates are questions (they lead the list), and
      // the waiting-question backlog that sets their pace.
      questions_first: questionsFirst,
      question_backlog: backlog.total,
      question_backlog_lanes: backlog.lanes,
      question_scale: pacingScale(backlog.total),
      eligible_count: candidates.length,
      no_eligible: noEligible,
      perishable_no_local: perishableNoLocal,
      preview,
      preview_skipped_model_lanes: previewSkippedModelLanes,
      ts: new Date().toISOString(),
    },
  };

  // COMMIT mode leaves the exact harvest on disk: `hum-run-log append` copies
  // its candidates into the tick trace.
  if (!preview) {
    try {
      const tmp = `${LAST_HARVEST}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ ...output, situation: situationObj, moment }) + "\n");
      fs.renameSync(tmp, LAST_HARVEST);
    } catch (e) {
      console.error(`hum-harvest-all: could not persist last harvest: ${e.message}`);
    }
  }

  console.log(JSON.stringify(output));
}

main().catch((e) => {
  console.error(`hum-harvest-all fatal: ${e.message}`);
  console.log(JSON.stringify({ candidates: [], meta: { error: e.message } }));
});
