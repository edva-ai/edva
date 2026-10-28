#!/usr/bin/env node
// dream_asks — floats the dream's questions through hum, starting the day after.
//
// A user rule: a question the dream could not settle is floated through hum
// the next day. The dream (jobs/dream.md) writes the questions it could not settle from
// a day's evidence into hum-ideas.jsonl as `source: "dream"`, `confidence:
// "low"` ideas with a `verify_question`. Left to the `ideas` lane they would
// compete for its single slot per tick against every other idea at their low
// urgency and mostly never go out. This lane owns them instead (the ideas
// harvester skips them): from the morning after they were written, it hands the
// ranker one of them per tick as a QUESTION candidate, newest dream first, so
// it rides the same ASK-FIRST, resolve-first, ping-budget, motion-gate and
// answer-capture machinery as every other hum question.
//
// Pacing is code (Rule #0b — geometry): at most DREAM_ASK_MAX_PER_DAY sent in
// any 24h and DREAM_ASK_SPACING_H apart, counted from hum-runs.jsonl. A backlog
// (e.g. a two-week backfill) drains over the following days instead of flooding
// one. A question stays eligible until hum sends it (hum-tick / hum.md Step 4
// mark it consumed) or `hum-reservoir-prune` expires it.
//
// Fail-closed: any error → "null" + stderr, never blocks a tick.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readStdinJson, emit, emitNull, stampRun, OWNER_NAME, HOME_TZ } from "./_common.mjs";

import { installTools } from "../../../lib/root.cjs";
import { reportBacklog, scaledLanePacing, recentlyOffered, rotateOffered } from "../../../lib/question-pacing.mjs";
await readStdinJson();

const DATA = process.env.EDVA_DATA_DIR || installTools("data");
const IDEAS = path.join(DATA, "hum-ideas.jsonl");
const RUNS = process.env.HUM_RUNS_FILE || path.join(DATA, "hum-runs.jsonl");
const LOCAL_DAY = path.join(path.dirname(new URL(import.meta.url).pathname), "../../../bin/local-day");

export const DREAM_ASK_MAX_PER_DAY = 3;
export const DREAM_ASK_SPACING_H = 2;

function readJsonl(p) {
  try {
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function localToday() {
  // Test seam: DREAM_ASKS_TODAY + DREAM_ASKS_TZ stand in for local-day.
  if (process.env.DREAM_ASKS_TODAY) return { today: process.env.DREAM_ASKS_TODAY, tz: process.env.DREAM_ASKS_TZ || HOME_TZ };
  const r = spawnSync(LOCAL_DAY, ["--json"], { encoding: "utf8", timeout: 10000,
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ""}` } });
  try { const j = JSON.parse(r.stdout); return { today: j.today, tz: j.tz }; } catch { return null; }
}

function localDateOf(iso, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

try {
  const now = Date.now();
  const day = localToday();
  if (!day) throw new Error("local-day unavailable");

  const byId = new Map();
  for (const r of readJsonl(IDEAS)) if (r.id) byId.set(r.id, { ...(byId.get(r.id) || {}), ...r });
  const waiting = [...byId.values()].filter((i) =>
    i.source === "dream" && i.confidence === "low" && typeof i.verify_question === "string" && i.verify_question.trim()
    && !i.consumed && !i.expired
    && !(i.time_sensitive_until && Date.parse(i.time_sensitive_until) < now)
    // "the next day": written on an earlier local day than today.
    && i.created_at && localDateOf(i.created_at, day.tz) < day.today);

  reportBacklog("dream_asks", waiting.length);
  // A long question backlog multiplies the cap and divides the spacing.
  const { maxPerDay, spacingH } = scaledLanePacing({ maxPerDay: DREAM_ASK_MAX_PER_DAY, spacingH: DREAM_ASK_SPACING_H });

  // Pacing, from what hum actually SENT on this lane.
  const sent = readJsonl(RUNS)
    .filter((r) => r.outcome?.sent === true && r.sonnet?.based_on_topic === "dream_asks")
    .map((r) => Date.parse(r.ts)).filter(Number.isFinite);
  const last = sent.length ? Math.max(...sent) : 0;
  if (last && now - last < spacingH * 3600e3) {
    stampRun("dream_asks", false);
    emitNull(`asked ${Math.round((now - last) / 60000)}m ago (spacing ${spacingH}h)`);
    process.exit(0);
  }
  const today = sent.filter((t) => now - t < 24 * 3600e3).length;
  if (today >= maxPerDay) {
    stampRun("dream_asks", false);
    emitNull(`${today} dream questions in the last 24h (max ${maxPerDay})`);
    process.exit(0);
  }

  if (!waiting.length) {
    stampRun("dream_asks", false);
    emitNull("no dream question waiting from an earlier day");
    process.exit(0);
  }

  // Newest dream first (fresher in the user's mind), then the order they were written.
  const dreamDate = (i) => i.supporting_data?.dream_date || String(i.created_at).slice(0, 10);
  waiting.sort((a, b) => dreamDate(b).localeCompare(dreamDate(a)) || String(a.created_at).localeCompare(String(b.created_at)));
  // One offered in the last few hours and held steps behind the rest.
  const i = rotateOffered(waiting, (x) => x.id, recentlyOffered("dream_asks", { now }))[0];

  const signal = [
    `The dream (Edva's nightly whole-day review) had a question it could not settle from the evidence, and ${OWNER_NAME} asked for these to be floated the day after. Ask it as ONE warm, specific question — the wording below is a draft; keep its meaning and any open-endedness, freshen relative time words to today, and never assert its premise as fact.`,
    `Question: ${i.verify_question.trim().slice(0, 600)}`,
    `Why it came up (from the dream of ${dreamDate(i)}): ${String(i.rationale || i.subject).slice(0, 500)}`,
  ].join("\n");

  stampRun("dream_asks", true);
  emit({
    topic: "dream_asks",
    signal,
    urgency: 0.6,
    freshness_min: 0,
    dedup_key: i.id,
    act_fit: { effort_to_act: "quick_win", steps_to_act: ["reply in a line or two"] },
    supporting_data: {
      kind: "dream_question",
      idea_id: i.id,
      dream_date: dreamDate(i),
      verify_question: i.verify_question,
      category: i.category,
      confidence: "low",
      // Set the question's memory_hook to this, verbatim.
      memory_hook: `dream:${i.id}`,
      // Rule #2: a stored question surfaces with the time its evidence was seen.
      evidence_as_of: i.supporting_data?.evidence_as_of || i.created_at,
      waiting: waiting.length,
    },
  });
} catch (err) {
  process.stderr.write(`dream_asks: ${err?.message || err}\n`);
  stampRun("dream_asks", false);
  emitNull("dream_asks failed");
}
