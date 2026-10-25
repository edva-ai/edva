// hum-daily-report — aggregation + HTML rendering for the nightly hum chronicle.
//
// Pure functions over already-parsed rows, so bin/hum-daily-run owns all
// I/O and tests/hum-daily-report.test.mjs can pin the arithmetic. Until
// 2026-10-04 this was a Sonnet agent turn doing the counting, joining and
// HTML by hand (jobs/hum-daily.md); every number here is arithmetic over the
// trace, so the turn bought nothing but variance.
//
// The one sentence that looks like judgement — the TL;DR "Notable" line — is
// a structural pick, not prose: the highest-urgency ping actually sent, else
// the highest-urgency discovery. It quotes the trace's own subject/signal.

import { createRequire } from "node:module";
// The installation's home time zone (agent/local/instance.json tz; the host zone when unset).
const instanceTz = () => createRequire(import.meta.url)("./instance.cjs").instance().tz;
// Short label for that zone in the report ("PT" for America/Los_Angeles, "CT"
// for Chicago); the short offset form ("GMT+3") where Intl has no short name.
function zoneLabel() {
  const tz = instanceTz();
  for (const style of ["shortGeneric", "short"]) {
    try {
      const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: style })
        .formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value || "";
      if (name && !name.includes(" ")) return name;
    } catch {}
  }
  return tz;
}

/** One line per identical (topic, err) pair, first-seen time kept, with a repeat count. */
function dedupeHarvestErrors(errors) {
  const seen = new Map();
  for (const e of errors) {
    const k = `${e.topic}\u0000${e.err}`;
    const hit = seen.get(k);
    if (hit) hit.count += 1; else seen.set(k, { ...e, count: 1 });
  }
  return [...seen.values()];
}

export const MIN_TICKS = 5;
const DISCOVERY_URGENCY = 0.5;
const HELD_BACK_SCORE = 0.45;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]); // lang-regex-ok: HTML escaping of machine output, not meaning
const etTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  return new Intl.DateTimeFormat("en-US", { timeZone: instanceTz(), hour: "numeric", minute: "2-digit" }).format(d);
};
const inWindow = (iso, startMs, endMs) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) && t >= startMs && t <= endMs;
};

export function aggregate({ runs, feedback, learnings, pending, audit, startMs, endMs }) {
  const ticks = runs.filter((r) => inWindow(r.ts, startMs, endMs) && r.mode !== "canary");
  const decisions = { silent: 0, info: 0, question: 0, error: 0, legacy: 0 };
  const harvesters = new Map();
  const hv = (t) => {
    if (!harvesters.has(t)) harvesters.set(t, { topic: t, attempts: 0, skipped: 0, errors: 0, candidates: 0, wins: 0 });
    return harvesters.get(t);
  };
  const harvestErrors = [];
  const discoveries = [];
  const pings = [];
  const questions = [];
  const heldBack = [];

  for (const r of ticks) {
    const s = r.sonnet || {};
    const h = r.harvest || {};
    const d = s.decision;
    if (d in decisions) decisions[d] += 1;
    else decisions.legacy += 1;
    for (const t of h.attempted || []) hv(t).attempts += 1;
    for (const t of h.skipped_cadence || []) hv(t).skipped += 1;
    for (const e of h.errors || []) { hv(e.topic).errors += 1; harvestErrors.push({ ts: r.ts, topic: e.topic, err: e.err }); }
    const winner = r.outcome && r.outcome.sent ? s.based_on_topic : null;
    if (winner) hv(winner).wins += 1;
    for (const c of h.candidates || []) {
      hv(c.topic).candidates += 1;
      if (typeof c.urgency === "number" && c.urgency >= DISCOVERY_URGENCY) {
        discoveries.push({ ts: r.ts, topic: c.topic, signal: String(c.signal || "").slice(0, 120), urgency: c.urgency, freshness_min: c.freshness_min, won: winner === c.topic, rationale: s.rationale || null });
      }
    }
    if (r.outcome && r.outcome.sent && (d === "info" || d === "question")) {
      const competed = (h.candidates || []).filter((c) => c.topic !== s.based_on_topic).slice(0, 3).map((c) => `${c.topic}: ${String(c.signal || "").slice(0, 60)}`);
      const base = { ts: r.ts, subject: s.subject, topic: s.based_on_topic, score: s.score, rationale: s.rationale, competed };
      if (d === "info") {
        const fb = feedback.find((f) => f.ping_id === r.outcome.ping_id);
        pings.push({ ...base, ping_id: r.outcome.ping_id, reaction: fb ? fb.reaction : null });
      } else {
        const ans = learnings.find((l) => l.id === r.outcome.question_id);
        questions.push({ ...base, memory_hook: s.memory_hook, question_id: r.outcome.question_id, answered: !!ans, answer: ans ? ans.answer : null });
      }
    }
    if (d === "silent") {
      const top = (s.near_miss_candidates || [])[0];
      if (top && typeof top.score === "number" && top.score >= HELD_BACK_SCORE) {
        heldBack.push({ ts: r.ts, topic: top.topic, signal: top.signal, score: top.score, cause: s.silent_root_cause || null, rationale: s.rationale || null });
      }
    }
  }

  const fbWindow = feedback.filter((f) => inWindow(f.reaction_at || f.sent_at, startMs, endMs));
  const reactions = { up: 0, down: 0, snooze: 0, reply: 0, other: 0, down_subjects: [] };
  for (const f of fbWindow) {
    // Stored values are the canonical vocabulary from `edva hum feedback`
    // (HUM_REACTION_ALIASES): helpful | more | skip | snooze, plus reply.
    const r = f.reaction;
    if (!r) continue;
    if (r === "helpful" || r === "more") reactions.up += 1;
    else if (r === "skip") { reactions.down += 1; reactions.down_subjects.push(f.lane || f.ping_id); }
    else if (r === "snooze") reactions.snooze += 1;
    else if (r === "reply") reactions.reply += 1;
    else reactions.other += 1;
  }

  const harvesterRows = [...harvesters.values()].sort((a, b) => b.candidates - a.candidates || a.topic.localeCompare(b.topic));
  const topTopic = harvesterRows.find((h) => h.candidates > 0) || null;
  const bestPing = [...pings, ...questions].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  const bestFind = [...discoveries].sort((a, b) => b.urgency - a.urgency)[0];
  const notable = bestPing
    ? `${bestPing.subject || bestPing.topic} (${bestPing.topic}) was the strongest thing sent`
    : bestFind ? `${bestFind.topic} noticed "${bestFind.signal}"` : "a quiet day";

  return {
    ticks: ticks.length, decisions, harvestErrors, discoveries, pings, questions, heldBack, reactions,
    harvesters: harvesterRows, silentHarvesters: harvesterRows.filter((h) => h.attempts > 0 && h.candidates === 0).map((h) => h.topic),
    topTopic, notable, pending: pending || null, audit: audit || null,
  };
}

const section = (title, body) => `<h3 style="margin:20px 0 6px;font-size:15px">${esc(title)}</h3>${body}`;
const list = (items) => items.length ? `<ul style="padding-left:18px;margin:4px 0">${items.map((i) => `<li style="margin:3px 0">${i}</li>`).join("")}</ul>` : `<p style="color:#777;margin:4px 0">none</p>`;

export function renderHtml(a, { dateLabel, startMs, endMs }) {
  const d = a.decisions;
  const tldr = list([
    `${a.ticks} ticks · ${d.silent} silent / ${d.info} info / ${d.question} question / ${d.error} error${d.legacy ? ` (+${d.legacy} legacy)` : ""}`,
    `Sent ${a.pings.length} pings, asked ${a.questions.length} questions, got ${a.reactions.up + a.reactions.down + a.reactions.snooze + a.reactions.reply} reactions`,
    a.topTopic ? `Top topic by candidates: ${esc(a.topTopic.topic)} (${a.topTopic.candidates})` : "No candidates emitted",
    `Notable: ${esc(a.notable)}`,
  ]);
  const byTopic = new Map();
  for (const x of a.discoveries) { if (!byTopic.has(x.topic)) byTopic.set(x.topic, []); byTopic.get(x.topic).push(x); }
  const finds = [...byTopic.entries()].map(([t, xs]) => `<p style="margin:8px 0 2px"><b>${esc(t)}</b></p>` + list(xs.map((x) =>
    `${etTime(x.ts)} · ${esc(x.signal)} · urgency ${x.urgency.toFixed(2)} · ${x.won ? "won" : `passed${x.rationale ? `, ranker: ${esc(x.rationale)}` : ""}`}`))).join("") || list([]);
  const pings = list(a.pings.map((p) => `${etTime(p.ts)} · <b>${esc(p.subject)}</b> · ${esc(p.topic)} · score ${p.score ?? "?"}<br>${esc(p.rationale || "")}${p.competed.length ? `<br><span style="color:#777">over: ${esc(p.competed.join("; "))}</span>` : ""}<br>reaction: ${esc(p.reaction || "none")}`));
  const qs = list(a.questions.map((q) => `${etTime(q.ts)} · <b>${esc(q.subject)}</b> · hook ${esc(q.memory_hook || "-")}<br>${esc(q.rationale || "")}<br>${q.answered ? `answered: ${esc(q.answer)}` : "unanswered"}`));
  const held = list(a.heldBack.map((h) => `${etTime(h.ts)} · ${esc(h.topic)} · ${esc(h.signal)} · ${h.score.toFixed(2)}${h.cause ? ` · ${esc(h.cause)}` : ""}`));
  const hrows = a.harvesters.map((h) => `<tr><td>${esc(h.topic)}</td><td>${h.attempts}</td><td>${h.skipped}</td><td>${h.errors}</td><td>${h.candidates}</td><td>${h.wins}</td></tr>`).join("");
  const htable = `<table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr style="text-align:left;color:#555"><th>topic</th><th>attempts</th><th>skipped</th><th>errors</th><th>candidates</th><th>wins</th></tr>${hrows}</table>` +
    (a.silentHarvesters.length ? `<p style="color:#777">Zero candidates all day: ${esc(a.silentHarvesters.join(", "))}</p>` : "") +
    (a.harvestErrors.length ? list(dedupeHarvestErrors(a.harvestErrors).slice(0, 20).map((e) => `${etTime(e.ts)} · ${esc(e.topic)}: ${esc(String(e.err).slice(0, 160))}${e.count > 1 ? ` (x${e.count})` : ""}`)) : "");
  const r = a.reactions;
  const react = `<p>👍 ${r.up} · 👎 ${r.down} · 💤 ${r.snooze} · replies ${r.reply}</p>${r.down_subjects.length ? list(r.down_subjects.map(esc)) : ""}`;
  const au = a.audit;
  const plumbing = !au ? `<p style="color:#777">audit unavailable</p>`
    : au.healthy ? `<p>${au.pings_sent_in_runs} sent, ${au.pings_logged_in_feedback} logged, healthy</p>`
      : list([...au.missing_feedback_for_sent.map((id) => `missing feedback: ${esc(id)}`), ...au.orphan_feedback_no_run.map((id) => `orphan feedback: ${esc(id)}`)]);
  const pend = a.pending ? `<p>${esc(a.pending.subject || a.pending.question || "?")} (asked ${etTime(a.pending.asked_at)})</p>` : `<p>none</p>`;
  return `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:#222;max-width:680px">
<h2 style="font-size:18px;margin:0 0 4px">Hum daily, ${esc(dateLabel)}</h2>
<p style="color:#777;margin:0 0 12px">covering ${etTime(new Date(startMs).toISOString())} to ${etTime(new Date(endMs).toISOString())} ${esc(zoneLabel())}</p>
${section("TL;DR", tldr)}
${section("What hum noticed", finds)}
${section("Proactive pulses sent", pings)}
${section("Questions asked", qs)}
${section("Held back (close calls)", held)}
${section("Harvester activity", htable)}
${section("Reactions", react)}
${section("Plumbing health", plumbing)}
${section("Pending", pend)}
</div>`;
}
