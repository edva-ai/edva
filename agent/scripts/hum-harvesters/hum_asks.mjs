#!/usr/bin/env node
// hum_asks — floats a question about hum ITSELF through hum, in the chat.
//
// A user rule: questions about hum are floated via hum, in the chat, where the
// user answers them. hum's own improvement ideas that need the user's yes
// (scope manual_<owner_id>: a taste or behaviour change, not a safe tune-up)
// otherwise wait in the ledger with no way out. This lane is
// their way out: it hands the ranker the oldest/easiest one as an ordinary
// QUESTION candidate, so it rides the same ASK-FIRST, ping-budget, motion-gate
// and answer-capture machinery as every other hum question.
//
// The answer closes the loop: the chat agent files it with `hum-answer`, reads
// what the user meant, and runs `hum-idea-decide --question <q-id> approve|decline`.
// A yes makes the idea `approved`; the daily hum-action-executor then designs
// and lands it (automatically, or as one Improvements card if it is high-risk).
//
// The user welcomes such questions, a couple a day, and they need not be
// yes/no. So the question is free to be open ("how would you want this to work?", "which of these?"),
// and the pacing is up to ASK_MAX_PER_DAY a day, ASK_COOLDOWN_H apart.
//
// At most ONE candidate per tick, paced by lib/hum-ideas.mjs — the least urgent
// thing hum says must never crowd out the rest.
// Fail-closed: any error → "null" + stderr, never blocks a tick.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readStdinJson, emit, emitNull, stampRun, OWNER_NAME } from "./_common.mjs";
import { loadLatest, pickAsk } from "../../../lib/hum-ideas.mjs";
import { reportBacklog, currentScale, recentlyOffered } from "../../../lib/question-pacing.mjs";

import { installTools } from "../../../lib/root.cjs";
await readStdinJson();

const RUNS_FILE = process.env.HUM_RUNS_FILE || installTools("data/hum-runs.jsonl");

let pick;
try {
  let runs = "";
  try { runs = fs.readFileSync(RUNS_FILE, "utf8"); } catch { /* no runs yet */ }
  // One offered in the last few hours and held steps aside for the rest.
  const offered = recentlyOffered("hum_asks");
  const ideas = loadLatest();
  const fresh = ideas.filter((i) => !offered.has(`hum_asks:${i.id}`));
  const all = pickAsk(ideas, runs, Date.now(), { scale: currentScale() });
  pick = pickAsk(fresh, runs, Date.now(), { scale: currentScale() });
  if (!pick.idea) pick = all;
  reportBacklog("hum_asks", all.waiting || 0);
} catch (err) {
  process.stderr.write(`hum_asks: ${err?.message || err}\n`);
  stampRun("hum_asks", false);
  emitNull("ledger unreadable");
  process.exit(0);
}

if (!pick.idea) {
  stampRun("hum_asks", false);
  emitNull(pick.none);
  process.exit(0);
}

const i = pick.idea;
const ageDays = Math.max(0, Math.round((Date.now() - Date.parse(i.proposed_at || "")) / 86400000)) || null;
const proposedOn = String(i.proposed_at || "").slice(0, 10) || null;
const predicted = i.predicted_effect && typeof i.predicted_effect === "object"
  ? Object.entries(i.predicted_effect).map(([k, v]) => `${k}: ${v}`).join("; ")
  : String(i.predicted_effect || "");

const signal = [
  `A change to how hum itself behaves is waiting on ${OWNER_NAME}. Ask ONE plain-language question about it. They welcome questions that make hum better, so the question does not have to be yes/no: ask openly (what they would want it to do, which of two ways they prefer, what they would expect to see) whenever that will teach you more than a yes would, and use a plain yes/no only when the choice truly is binary.`,
  // The reasoning is what hum saw on the day the idea was filed, not a reading of
  // today. Under a label like "What is wrong today" a months-old snapshot
  // ("a week of zero reactions") gets restated as current ("lately very little
  // of it seems to land with you") when recent pings are drawing reactions.
  `Why it came up, as written ${proposedOn ? `on ${proposedOn}` : "when it was filed"}${ageDays ? ` (${ageDays} days ago)` : ""}: ${String(i.hypothesis || i.title).slice(0, 420)}`,
  "That is how things looked THEN. Never present it or its numbers as current (\"lately\", \"these days\"): say when it was seen, or ask without it.",
  `The change: ${String(i.proposed_change || i.title).slice(0, 360)}`,
  predicted ? `What it should do: ${predicted.slice(0, 220)}` : null,
  `Once they have answered, Edva builds it the way they described${i.risk === "high" ? " and files it as one Improvements card to sign (it is high-risk)" : " and applies it on its own"}.`,
].filter(Boolean).join("\n");

stampRun("hum_asks", true);
emit({
  topic: "hum_asks",
  signal,
  urgency: 0.5,
  freshness_min: 0,
  dedup_key: `hum_asks:${i.id}`,
  act_fit: { effort_to_act: "quick_win", steps_to_act: ["reply in a line or two"] },
  supporting_data: {
    kind: "hum_improvement_ask",
    idea_id: i.id,
    // Set the question's memory_hook to this, verbatim.
    memory_hook: `hum_improvement:${i.id}`,
    title: i.title,
    risk: i.risk,
    idea_age_days: ageDays,
    // Rule #2: a stored idea surfaces with its real date. hum-ping reads this as
    // the ping's --evidence-as-of, so the release gate re-checks the premise
    // against what has happened since instead of treating it as undated.
    ...(i.proposed_at ? { evidence_as_of: i.proposed_at } : {}),
    waiting: pick.waiting,
  },
});
