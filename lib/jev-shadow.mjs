// jev-shadow.mjs — run a decision with Jev as PRIMARY and the pre-existing
// mechanism as SHADOW, log both, and flag every disagreement.
//
// The brief: run Jev as primary, with the current mechanism as shadow for one
// week; log all results; on disagreement between the two, investigate more
// deeply and suggest fixes to the Jev implementation through the
// Improvements channel.
//
// Contract, per decision site:
//   1. Jev is asked first. If it answers and its confidence clears the site's
//      threshold, ITS answer is the one acted on (used: "jev").
//   2. If Jev is unavailable, errors, or is below threshold, the legacy
//      mechanism's answer is acted on (used: "legacy") — never a silent drop.
//   3. While inside the shadow window (jev-config.json `shadow_until`), the
//      legacy mechanism ALSO runs on every decision, in parallel, in its
//      side-effect-free form (`shadow`, defaulting to `legacy`), and the two
//      answers are compared with the site's `same` function.
//   4. Every decision is appended to data/jev-shadow/YYYY-MM-DD.jsonl.
//      A disagreement is additionally appended to disagreements.jsonl, and
//      nowhere else (no channel post since 2026-10-11, see recordDisagreement).
//      The jev-disagreement-review job investigates them and files fixes to
//      the Improvements channel.
//   5. After the window, legacy runs only as the fallback in (2).
//
// Kill switches: `touch data/.jev-off` (everything back to legacy),
// or `"enabled": false` on a site in data/jev-config.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { jevEvaluate, jevAvailable, loadJevConfig, jevQuestions, jevSiteDef } from "./jev.mjs";
import { isPrivateForJev } from "./jev-private-screen.mjs";
import { createRequire } from "node:module";
import { installRoot } from "./root.cjs";
// The installation's home time zone (agent/local/instance.json tz; the host zone when unset).
const instanceTz = () => createRequire(import.meta.url)("./instance.cjs").instance().tz;

const ROOT = installRoot();
export const SHADOW_DIR = process.env.JEV_SHADOW_DIR || path.join(ROOT, "data/jev-shadow");
// Runtime stamp of the one-week window. Lives in the gitignored shadow dir, NOT
// in the tracked jev-config.json: a runtime write to a tracked file dirties the
// host's tree and blocks the next deploy's ff-merge (code review 2026-09-23).
// jev-config.json `shadow_until` stays as a manual override.
export const WINDOW_FILE = path.join(SHADOW_DIR, "window.json");
const SEND_BIN = path.join(ROOT, "bin/edva-send-curl");

// Health of the Jev gateway itself, tracked across every site in one file. A
// 403/429/timeout makes decide() fall back to legacy and log "jev-error", which
// is correct and completely invisible — so a TOTAL outage looks like a quiet
// week. It is worse than quiet: no Jev answer means no comparison, so no
// disagreement, so no jev-disagreement-review run. The one signal
// that would reveal the outage is suppressed BY the outage.
// Measured 2026-09-30: the gateway returned 403 "Free tier users do not have
// access to this model" on every call from 2026-09-27T06:50Z — 458 consecutive
// failures over 3.8 days, zero successes — and nothing anywhere said so.
const HEALTH_STATE = path.join(SHADOW_DIR, "health-state.json");
// Both arms are sized against this shadow week's own logs. Across 3.2 days of
// healthy traffic the longest run of consecutive errors was 4 calls spanning 4
// minutes, and the longest-SPANNING run was 2 calls over 51 minutes. Requiring
// 4 consecutive AND an hour of them fires zero times over that healthy stretch
// and fires 87 minutes into the real outage. The duration arm is what carries
// it: a burst of capacity 429s is short, a billing wall is not.
const OUTAGE_STREAK = 4;
const OUTAGE_MIN_MS = 60 * 60e3;
// Both arms above exist to filter NOISE, and a refusal is not noise. When the
// gateway answers 401/402/403 it has told us on its own terms that this request
// cannot succeed, so the first one is already proof (jev.mjs marks these
// `permanent`; nothing here reads the message text — Rule #0b). Those page
// immediately and open a breaker instead of waiting out an hour of calls that
// are all going to be refused.
// The breaker is a WINDOW, not a latch: it expires, so the first call after it
// is a live probe and an entitlement that gets fixed is picked up within the
// hour. A latch would recreate the exact bug this file was written to end —
// Jev silently off and nothing saying so.
const BREAKER_MS = 60 * 60e3;
// A wall nobody clears would otherwise page once and then be as invisible as it
// was before this monitor existed (the 569-call, 5-day silence above). While it
// stands, re-page weekly — the same shape as system-alert-dedup's third-day
// escalation, bounded so it can never become a daily nag.
const REPAGE_MS = 7 * 24 * 60 * 60e3;

function localDate(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: instanceTz() });
}

function append(file, row) {
  try {
    fs.mkdirSync(SHADOW_DIR, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
  } catch {}
}

export function siteConfig(site) {
  const cfg = loadJevConfig();
  // Per-site settings: the site's question file, overridden by jev-config.json sites.<site>.
  const s = { ...(jevSiteDef(site) || {}), ...((cfg.sites || {})[site] || {}) };
  return {
    enabled: s.enabled !== false,
    threshold: typeof s.threshold === "number" ? s.threshold : (cfg.default_threshold ?? 0.85),
    // No until yet + shadow_days set = the window has not started (no successful
    // Jev call so far): shadow is ON, and the first success stamps window.json.
    inShadow: shadowUntil(cfg) ? Date.now() < Date.parse(shadowUntil(cfg)) : !!cfg.shadow_days,
    shadowUntil: shadowUntil(cfg),
  };
}

function shadowUntil(cfg) {
  if (cfg.shadow_until) return cfg.shadow_until;
  try { return JSON.parse(fs.readFileSync(WINDOW_FILE, "utf8")).shadow_until || null; } catch { return null; }
}

// Privacy exclusions (health/financial sender lists, lanes, place types, the
// on-device content screen). The user chose to pass everything to Jev
// → jev-config.json `privacy_exclusions: false` turns them all off. Every site
// consults this, so flipping it back to true restores the whole guard.
export function privacyOn() {
  return loadJevConfig().privacy_exclusions !== false;
}

// True when a decide() call for this site would actually reach Jev. Callers use
// it to skip any Jev-only preparation (a privacy screen, extra state) while Jev
// is inert, so the pre-key behavior is exactly the old path's.
export function jevWouldRun(site) {
  return siteConfig(site).enabled && jevAvailable();
}

function short(v, n = 300) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s == null ? s : (s.length > n ? s.slice(0, n) + "…" : s);
}

/**
 * @param {object} o
 * @param {string} o.site            decision-site id (key in jev-config.json / jev-questions.json)
 * @param {string} [o.id]            caller's id for the item (messageId, draft hash, ...)
 * @param {*}      o.state           Jev state (string | object | array)
 * @param {object} [o.questions]     explicit questions; default jevQuestions(site, o.vars)
 * @param {object} [o.vars]          placeholder values for jev-questions.json
 * @param {(answers)=>{value:*, confidence:number}} o.interpret  Jev answers → decision
 * @param {()=>Promise<*>} o.legacy  the pre-existing mechanism (may act)
 * @param {()=>Promise<*>} [o.shadow] side-effect-free legacy for shadow runs (default: legacy)
 * @param {(jevValue, legacyValue)=>boolean} [o.same]  agreement test (default deep-equal JSON)
 * @param {*}      [o.logInput]      what to record as the input (default: truncated state)
 * @param {boolean}[o.awaitShadow=true] false in long-lived processes: compare in background
 * @param {boolean}[o.alwaysShadow]  run legacy regardless of window (never set by default)
 * @param {string} [o.skipJev]       reason to keep this call off Jev entirely (legacy only, input withheld)
 * @param {boolean}[o.privacyScreen] screen o.state on-device for health/bank content first (fail-closed)
 * @returns {Promise<{value:*, used:"jev"|"legacy", jev?:object, reason?:string}>}
 */
export async function decide(o) {
  const { site } = o;
  const sc = siteConfig(site);
  const same = o.same || ((a, b) => JSON.stringify(a) === JSON.stringify(b));
  const row = { ts: new Date().toISOString(), site, id: o.id ?? null, input: short(o.logInput ?? o.state, 600) };

  // o.skipJev = "<reason>" keeps THIS call off Jev (e.g. "health-excluded": no
  // external model on health rows). The input is withheld from the log too.
  if (o.skipJev || !sc.enabled || !jevAvailable()) {
    const value = await o.legacy();
    row.used = "legacy"; row.reason = o.skipJev || (!sc.enabled ? "site-disabled" : "jev-unavailable"); row.legacy = { value: short(value) };
    // An excluded call's legacy verdict can carry the same content (a venue, a
    // reason) — withhold it too; only the fact of the exclusion is logged.
    if (o.skipJev) { row.input = "[withheld]"; row.legacy = "[withheld]"; }
    append(path.join(SHADOW_DIR, `${localDate()}.jsonl`), row);
    return { value, used: "legacy", reason: row.reason };
  }

  const runShadow = sc.inShadow || o.alwaysShadow;
  const t0 = Date.now();
  // Start the shadow first so both run concurrently; swallow its error here —
  // a failing shadow is logged, never fatal to the decision.
  const shadowP = runShadow
    ? Promise.resolve().then(() => (o.shadow || o.legacy)()).then(
        (value) => ({ ok: true, value, ms: Date.now() - t0 }),
        (err) => ({ ok: false, error: String(err?.message || err).slice(0, 300), ms: Date.now() - t0 }))
    : null;

  // o.privacyScreen: run the on-device health/bank screen over EXACTLY the state
  // Jev would receive; private → this call stays on legacy (input withheld).
  if (o.privacyScreen && privacyOn()) {
    let scr;
    try { scr = await isPrivateForJev(o.state); } catch { scr = { private: true, reason: "screen-threw" }; }
    if (scr.private) {
      row.used = "legacy"; row.reason = `sensitive-excluded (${scr.reason})`; row.input = "[withheld]";
      let value, err = null;
      if (shadowP && !o.shadow) {
        const s = await shadowP;
        if (s.ok) value = s.value; else err = s.error;
      } else {
        try { value = await o.legacy(); } catch (e) { err = String(e?.message || e).slice(0, 300); }
      }
      row.legacy = err ? { error: err } : "[withheld]";
      append(path.join(SHADOW_DIR, `${localDate()}.jsonl`), row); // logged even when legacy fails
      if (err) throw new Error(`legacy failed (sensitive-excluded): ${err}`);
      return { value, used: "legacy", reason: "sensitive-excluded" };
    }
  }

  let jev = null;
  // Breaker open = the gateway has already refused this exact request and the
  // window has not elapsed. Report the cached refusal and skip the round-trip;
  // the outcome (legacy) is identical either way, so the only thing a call
  // would buy is latency at every decision site. Measured: 569 refusals over
  // 5 days, every one of them knowable from the first.
  const cachedRefusal = jevBreakerOpen();
  if (cachedRefusal) {
    jev = { error: cachedRefusal, breaker: true };
  } else {
    try {
      const questions = o.questions || jevQuestions(site, o.vars || {});
      const r = await jevEvaluate({ state: o.state, questions, ...(o.jevTimeoutMs ? { timeoutMs: o.jevTimeoutMs } : {}) });
      const it = o.interpret(r.answers);
      jev = { value: it.value, confidence: it.confidence, answers: r.answers, cost: r.cost, ms: r.latencyMs };
      if (!sc.shadowUntil) startShadowWindow();
      noteJevHealth(null);
    } catch (err) {
      jev = { error: String(err?.message || err).slice(0, 300) };
      noteJevHealth(jev.error, !!err?.permanent);
    }
  }

  const jevUsable = jev && !jev.error && typeof jev.confidence === "number" && jev.confidence >= sc.threshold;
  let value, used, reason;
  if (jevUsable) {
    value = jev.value; used = "jev";
  } else {
    used = "legacy";
    reason = jev.error ? "jev-error" : "jev-low-confidence";
    if (shadowP && !o.shadow) {
      // The shadow IS the legacy mechanism — reuse its result instead of running it twice.
      const s = await shadowP;
      if (!s.ok) throw new Error(`legacy failed after jev ${reason}: ${s.error}`);
      value = s.value;
    } else {
      value = await o.legacy();
    }
  }
  row.used = used; if (reason) row.reason = reason;
  row.threshold = sc.threshold;
  row.jev = jev.error ? { error: jev.error, ...(jev.breaker ? { breaker: true } : {}) } : { value: jev.value, confidence: round(jev.confidence), cost: jev.cost, ms: jev.ms, answers: jev.answers };

  const finish = (s) => {
    if (s) {
      row.shadow = s.ok ? { value: short(s.value, 600), ms: s.ms } : { error: s.error, ms: s.ms };
      if (s.ok && !jev.error) {
        // same() may return null = "not comparable here; a late comparison will
        // follow" (email-triage: legacy escalated, so the real legacy verdict is
        // the Sonnet shadow or the ops agent's, recorded via recordLateComparison).
        const eq = same(jev.value, s.value);
        if (eq === null) row.deferred = true;
        else { row.agree = !!eq; if (!row.agree) recordDisagreement(row); }
      }
    }
    append(path.join(SHADOW_DIR, `${localDate()}.jsonl`), row);
  };

  if (!shadowP) finish(null);
  else if (o.awaitShadow === false) shadowP.then(finish);
  else finish(await shadowP);

  return { value, used, jev, reason };
}

// The one-week shadow window starts at the first successful Jev call, not at
// deploy time — the key may land days after the code does.
function startShadowWindow() {
  try {
    const cfg = loadJevConfig();
    if (shadowUntil(cfg) || !cfg.shadow_days) return;
    fs.mkdirSync(SHADOW_DIR, { recursive: true });
    fs.writeFileSync(WINDOW_FILE, JSON.stringify({
      shadow_started: new Date().toISOString(),
      shadow_until: new Date(Date.now() + cfg.shadow_days * 864e5).toISOString(),
    }, null, 2) + "\n", { flag: "wx" }); // wx: first writer wins, never re-stamp
  } catch {}
}

function round(x) { return typeof x === "number" ? Math.round(x * 1000) / 1000 : x; }

/**
 * Compare a Jev decision against a legacy verdict that arrives LATER and out of
 * band (email triage: the ops agent's dispatch records its verdict minutes after
 * Jev decided). Called by the reconciler; logs + flags exactly like decide().
 *
 * `calibration: true` records the row as an OBSERVED OUTCOME instead of a
 * comparison: no boolean `agree` (so jev-shadow-report leaves it out of cmp and
 * agree%), no disagreements.jsonl row. Use it when the later value answers a
 * DIFFERENT question from the one Jev was asked, so a mismatch is not evidence
 * that either mechanism was wrong -- see jev-hum-gate.mjs reconcileHumOutcomes.
 * `extra` is merged into the row so the outcome stays queryable for the
 * end-of-week report. It defaults to false, so every existing caller (email
 * triage, p1-resolution, jev-gate-shadow) behaves exactly as before.
 */
export function recordLateComparison({ site, id, jevRow, legacyValue, agree, calibration = false, extra }) {
  const row = { ...jevRow, ts: new Date().toISOString(), site, id, late: true, shadow: { value: short(legacyValue, 600) }, ...(extra || {}) };
  if (calibration) row.calibration = true; else row.agree = agree;
  append(path.join(SHADOW_DIR, `${localDate()}.jsonl`), row);
  if (!calibration && !agree) recordDisagreement(row);
}

export function disagreementId(row) {
  return createHash("sha1").update(`${row.site}|${row.id}|${row.ts}`).digest("hex").slice(0, 12);
}

function recordDisagreement(row) {
  const d = { did: disagreementId(row), ...row };
  delete d.agree;
  // Logged, never posted. Every disagreement used to page the system channel
  // as "🔀 Jev disagreement [...]" (as first asked). The user withdrew that:
  // the system channel is only for things the user can or should act on.
  // Nothing in a single disagreement is the user's to act on: the
  // jev-disagreement-review job reads this file, and what IS the user's to act on (a
  // proposed fix) reaches them as an Improvements card. jev-shadow-report counts
  // them from the daily logs on demand.
  append(path.join(SHADOW_DIR, "disagreements.jsonl"), d);
}

// Count consecutive gateway failures across every site and page ONCE per
// episode, with a matching recovery ping when a call finally succeeds (the
// alert/recovery parity rule in agent/CLAUDE.md § System Channel).
// Never throws: a decision must not fail because its health bookkeeping did.
function noteJevHealth(error, permanent = false) {
  try {
    let st = {};
    try { st = JSON.parse(fs.readFileSync(HEALTH_STATE, "utf8")); } catch {}
    const now = Date.now();
    // Atomic (temp file + rename): with ok_at stamped on every success this
    // file is now written on most calls, and jevBreakerOpen() or a concurrent
    // process must never read it half-written.
    const write = (next) => {
      fs.mkdirSync(SHADOW_DIR, { recursive: true });
      const tmp = `${HEALTH_STATE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next));
      fs.renameSync(tmp, HEALTH_STATE);
    };
    if (!error) {
      if (st.alerted_at) alertJevRecovered(st);
      // Stamp ok_at on EVERY success, not only on the way out of a failing
      // episode. It used to be written only on recovery, so it froze during
      // healthy running: the 2026-10-13 12:51Z refusal page said "last good
      // call 2026-10-11T13:30Z" when the last good call was 16 minutes earlier.
      write({ streak: 0, ok_at: new Date(now).toISOString() });
      return;
    }
    st.streak = (st.streak || 0) + 1;
    if (!st.since) st.since = new Date(now).toISOString();
    st.last_error = String(error).slice(0, 200);
    st.permanent = !!permanent;
    const spanMs = now - Date.parse(st.since);
    // A refusal needs no corroboration — page at once, pause the calls, and
    // re-page weekly for as long as it stands. A wobble still has to clear both
    // arms (4 consecutive AND an hour) before it is worth waking anyone.
    if (permanent) {
      st.breaker_until = new Date(now + BREAKER_MS).toISOString();
      const pagedAt = st.alerted_at ? Date.parse(st.alerted_at) : 0;
      const due = !pagedAt || now - pagedAt >= REPAGE_MS;
      if (due) st.alerted_at = new Date(now).toISOString();
      write(st);
      if (due) alertJevOutage(st, spanMs, true);
      return;
    }
    const due = st.streak >= OUTAGE_STREAK && spanMs >= OUTAGE_MIN_MS && !st.alerted_at;
    if (due) st.alerted_at = new Date(now).toISOString();
    write(st);
    if (due) alertJevOutage(st, spanMs, false);
  } catch {}
}

// The cached refusal while the breaker window stands, or null to attempt the
// call. Fails OPEN on every read problem: a missing or unparseable health file
// must never be what stops Jev from being tried.
function jevBreakerOpen() {
  try {
    const st = JSON.parse(fs.readFileSync(HEALTH_STATE, "utf8"));
    if (!st.breaker_until) return null;
    const until = Date.parse(st.breaker_until);
    if (!Number.isFinite(until) || until <= Date.now()) return null;
    return st.last_error || "jev: gateway refused this request (breaker open)";
  } catch { return null; }
}

function humanDur(ms) {
  const h = ms / 3600e3;
  return h >= 24 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
}

// Jev is the PRIMARY mechanism at every site, so its absence is a
// capability-down condition (🔴) even though nothing visibly breaks: every
// decision silently reverts to the mechanism Jev was brought in to replace.
// Deliberately worded to stay clear of edva-send-curl's fabricated-outage
// gate — this is one named dependency, not a claim about the machine. No
// EDVA_ALERT_NO_DEDUP: a repeat here IS the same condition and should
// collapse.
function alertJevOutage(st, spanMs, permanent) {
  if (process.env.JEV_NO_ALERT) return;
  // A refusal and an intermittent failure need different words, because they
  // need different things from the user: one is a decision only the user can make, the
  // other is something to watch. Never claim a last-good time we did not see -
  // the first version of this alert reported "no successful call since" the
  // moment its own state file was created, which read as 1.9 hours when the
  // real outage was five days old.
  const lastGood = st.ok_at ? `last good call ${st.ok_at}` : "no successful call on record";
  if (permanent) {
    sendSystem("jev-health", `🔴 Jev is being refused rather than failing intermittently, so retrying cannot clear it: ${st.last_error} Every decision site has reverted to the mechanism Jev replaced - no decision is dropped, but Jev is deciding nothing until the plan or the model changes. Calls are paused an hour at a time and pick up again on their own the moment the refusal lifts (${lastGood}).`);
    return;
  }
  sendSystem("jev-health", `🔴 Jev unavailable — ${st.streak} consecutive gateway errors over ${humanDur(spanMs)}, ${lastGood}. Every decision site has fallen back to its legacy mechanism, so no decision was dropped, but Jev is deciding nothing. Last error: ${st.last_error}`);
}

function alertJevRecovered(st) {
  if (process.env.JEV_NO_ALERT) return;
  const since = st.since ? ` (failing since ${st.since})` : "";
  sendSystem("jev-health", `✅ Jev answering again${since} — decisions are back on Jev wherever confidence clears the site threshold.`);
}

function sendSystem(intent, msg) {
  const child = spawn(SEND_BIN, ["--channel", "system", "--skip-precheck", "--intent", intent, msg], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
