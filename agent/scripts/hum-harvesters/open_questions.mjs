#!/usr/bin/env node
// open_questions — re-asks Edva questions the user has not answered yet.
//
// Questions floated via hum can arrive at a time the user can't answer and
// then be buried by later messages, so they are repeated until answered
// (a user rule), unless no longer relevant (a "where were you today" question
// is not relevant tomorrow).
//
// Every question hum-ask sends is recorded in data/open-questions.jsonl
// (lib/open-questions.mjs) and stays open until answered or retired. This lane
// hands the ranker the oldest one that is due again — the next day after the
// first ask, then 2 days, 4, then weekly — as a QUESTION candidate. The ranker
// re-asks it in fresh words, or, if it is no longer relevant, retires it
// (`retire_questions`) instead. The re-ask keeps the question's original id
// (hum.md Step 4 passes supporting_data.question_id to hum-ask), so an answer to
// any copy files against the same question, and resolve-first still gets to
// settle it from the user's records before anything is sent.
//
// Pacing is code (Rule #0b — geometry): at most REASK_MAX_PER_DAY re-asks in
// 24h and REASK_SPACING_H apart, counted from hum-runs.jsonl. Time-bound lanes
// (location) lapse at the end of their day and are never offered; hum_asks
// questions repeat on their own lane.
//
// Fail-closed: any error → "null" + stderr, never blocks a tick.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readStdinJson, emit, emitNull, stampRun, OWNER_NAME } from "./_common.mjs";
import { dueForReask } from "../../../lib/open-questions.mjs";
import { reportBacklog, scaledLanePacing } from "../../../lib/question-pacing.mjs";

import { installTools } from "../../../lib/root.cjs";
await readStdinJson();

const DATA = process.env.EDVA_DATA_DIR || installTools("data");
const RUNS = process.env.HUM_RUNS_FILE || path.join(DATA, "hum-runs.jsonl");

export const REASK_MAX_PER_DAY = 2;
export const REASK_SPACING_H = 3;

function readJsonl(p) {
  try {
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

const fmtAgo = (iso, now) => {
  const d = Math.round((now - Date.parse(iso)) / 86400e3);
  return d <= 0 ? "earlier today" : d === 1 ? "yesterday" : `${d} days ago`;
};

try {
  const now = Date.now();
  reportBacklog("open_questions", dueForReask(now).length);
  // A long question backlog multiplies the cap and divides the spacing.
  const { maxPerDay, spacingH } = scaledLanePacing({ maxPerDay: REASK_MAX_PER_DAY, spacingH: REASK_SPACING_H });
  const sent = readJsonl(RUNS)
    .filter((r) => r.outcome?.sent === true && r.sonnet?.based_on_topic === "open_questions")
    .map((r) => Date.parse(r.ts)).filter(Number.isFinite);
  const last = sent.length ? Math.max(...sent) : 0;
  if (last && now - last < spacingH * 3600e3) {
    stampRun("open_questions", false);
    emitNull(`re-asked ${Math.round((now - last) / 60000)}m ago (spacing ${spacingH}h)`);
    process.exit(0);
  }
  if (sent.filter((t) => now - t < 24 * 3600e3).length >= maxPerDay) {
    stampRun("open_questions", false);
    emitNull(`${maxPerDay} re-asks in the last 24h already`);
    process.exit(0);
  }

  const due = dueForReask(now);
  if (!due.length) {
    stampRun("open_questions", false);
    emitNull("no unanswered question due for a re-ask");
    process.exit(0);
  }
  const q = due[0];

  const signal = [
    `An unanswered Edva question. It was first asked ${fmtAgo(q.first_asked_at, now)} and has gone out ${q.asks} time${q.asks === 1 ? "" : "s"} with no answer; ${OWNER_NAME} asked that questions be repeated until answered, because they can arrive when the user can't reply and get buried.`,
    "Ask it again as ONE short, warm question in fresh words. Say lightly that you're coming back to it (never guilt, never \"you didn't answer\"). Keep its meaning and any open-endedness; freshen relative time words (\"today\" asked yesterday is now \"yesterday\").",
    "If it is NO LONGER RELEVANT — its moment passed, a later chat message or memory already answers it, or what it asks about is settled — do not ask: list it in retire_questions with why, and pick another candidate or stay silent.",
    `Last asked as: ${String(q.question || "").slice(0, 600)}`,
    q.original_question && q.original_question !== q.question ? `First asked as: ${String(q.original_question).slice(0, 400)}` : null,
    q.rationale ? `Why it was asked: ${String(q.rationale).slice(0, 300)}` : null,
  ].filter(Boolean).join("\n");

  stampRun("open_questions", true);
  emit({
    topic: "open_questions",
    signal,
    // Asks land ahead of fresh lanes of similar weight, the longer it waits the more.
    urgency: Math.min(0.75, 0.55 + 0.05 * q.asks),
    freshness_min: 0,
    dedup_key: `openq:${q.id}`,
    act_fit: { effort_to_act: "quick_win", steps_to_act: ["reply in a line or two"] },
    supporting_data: {
      kind: "open_question",
      question_id: q.id,
      memory_hook: q.memory_hook,
      subject: q.subject,
      original_lane: q.lane,
      asks: q.asks,
      first_asked_at: q.first_asked_at,
      // Rule #2: a stored question surfaces with the time it was first asked.
      evidence_as_of: q.first_asked_at,
      waiting: due.length,
    },
  });
} catch (err) {
  process.stderr.write(`open_questions: ${err?.message || err}\n`);
  stampRun("open_questions", false);
  emitNull("open_questions failed");
}
