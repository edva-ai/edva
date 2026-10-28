HUM — proactive check-in. Evaluates the user's current situation, harvests every standing interest in parallel, and decides whether to surface the best finding, ask a context-building question, or stay silent.

> **This instance's additions** to this playbook (its own people, places and decisions) are in `agent/local/jobs/hum.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (an ephemeral or by-hand run), `Read` that file before you start.

**Hum is EVENT-DRIVEN (2026-08-02).** It fires because something actually happened — they arrived somewhere, a meeting ended, rain is starting, the city changed — not because a clock ticked. The `hum-sense` daemon detects those edges and a deterministic gate decides whether the moment earns an agent turn; only then does this playbook run. The flat cadence survives only as (a) the low-salience `idle` sensor and (b) a cron watchdog for when the engine is down. See "How hum is dispatched" below and `system/hum-events.md`.

This file holds the rules only. Rationale, history, incidents and lane mechanics moved to `docs/hum-detail.md` (2026-10-06), one section per section here. If the two disagree, this file wins.

## Purpose

1. **Notice the moment.** On a situational trigger (or the `idle` tick after 75 min of nothing), snapshot the situation, check every standing interest for deltas, rank by urgency × relevance × freshness; the best wins, the rest go to the run log.
2. **Be curious.** After an event worth learning from (show, meal out, new place, notable person), ask **one** focused question whose answer sharpens future recommendations.

Most dispatches end silently. That's the design.

## Pipeline

```
dispatch (an event bundle from hum-sense, or the idle/watchdog fallback)
├─ Step 0: gates (already applied by the hum-sense gate pre-dispatch)
├─ Step 1: SITUATION snapshot        edva hum situation --json
├─ Step 2: TOPIC HARVEST              hum-harvest-all.mjs (parallel fan-out + pre-rank vetoes)
│    └─ meta.no_eligible / perishable_no_local → silent trace, NO Step 3 (no model call)
├─ Step 3: RANK + decide              in this turn (the hum model)
└─ Step 4: execute + state update
```

## Step 0 — Gates (already applied pre-dispatch)

**Jev gate (2026-09-23).** `hum-sense` also asks Jev (`lib/jev-hum-gate.mjs`); a confident "nothing worth pinging" skips the dispatch, anything else reaches this playbook unchanged. Health, exercise, finance, stocks, workout events and idle-only bundles never go to Jev. See `docs/jev.md`.

By the time a dispatch reaches this playbook, the `hum-sense` gate (`lib/hum-events.mjs`) has already verified — for an event dispatch — that:
- Not in the quiet window (00:00-09:00 local), activity is not `sleeping` / `winding_down`, hum is not paused
- They are not in a meeting, not mid-conversation with the chat agent, and have no outstanding hum question
- Nothing was dispatched inside the 10-min refractory window, and this moment's salience cleared the (rising) threshold
- No event in the bundle repeats a `dedup_key` inside its cooldown

The `watchdog-fallback` path (`trigger-hum.sh`, engine down) applies its own subset: sleep window, activity state, calendar-busy, pause. That check is cron-only — it never runs inside this playbook.

**Do NOT re-derive the quiet/sleep window from the `<live-state>` banner's clock** — it is always the installation's home time zone (`instance.cjs tz`); `hum-sense` gates on `data/user-timezone.json` (their current location). If a dispatch reached this playbook, every gate above is satisfied — go straight to Step 1. The only clock you reason about is what Step 1 reports. (Incident: hum-detail.md § Step 0.)

Increment `state.today.runs` in `data/hum-state.json`.

## Step 1 — Situation snapshot

> **RUN STEPS 1 AND 2 WITH THE BASH SANDBOX DISABLED (`dangerouslyDisableSandbox: true`).** Required, not optional: under the sandbox `gog` / `apple-weather` / the exercise tracker / ASC calls fail (TLS, `x509 OSStatus -26276`) and hum goes blind to tasks, calendar, weather, exercise and TestFlight crashes. Keep the harvest in this Max-authenticated turn. Do NOT disable the sandbox for any other step. (Why: hum-detail.md § Step 1.)

Single cached composite (2-min TTL), input to every harvester and the ranker:

```bash
~/Dev/edva/bin/edva hum situation --json
```

Shape:
```json
{
  "where": {"lat","lon","place","companions","activity"},
  "environment": {"weather","motion_class","phone_context_age_min"},
  "time": {"local_hour","tz","activity_state","inbound_min_ago","outbound_min_ago"},
  "now_activity": {"at_desk_min"},
  "next": {"upcoming_events":[{"in_min","duration_min","summary","location"}],"tasks_due_today":[...],"overdue_count"},
  "working_on": {"today_commits":[],"week_commit_topics":[]}
}
```

`next.upcoming_events` is first-class: a meeting in 30 min trumps most candidates. `now_activity.at_desk_min`: 0–2 = actively typing, >15 = away. `working_on.week_commit_topics` = shorthand for current focus.

If the snapshot fails (empty/invalid JSON), log `run:error:no_situation` to `hum-runs.jsonl` and exit.

## Step 2 — Topic harvest (parallel, one shell call)

**Run with the Bash sandbox disabled** (`dangerouslyDisableSandbox: true`) — see Step 1.

**Set `HUM_FOCUS_LANES` from the dispatch payload's `lanes`.** Not optional — it is the whole point of an event dispatch. Without it the lanes the triggering event implicated are skipped by their own cadence and hum harvests something unrelated. (Incident: hum-detail.md § Step 2.)

```bash
SIT=$(~/Dev/edva/bin/edva hum situation --json 2>/dev/null)
# LANES = the payload's `lanes`, comma-joined. Empty for an idle/watchdog
# dispatch — then simply omit the env var and take the full cadence-gated fan-out.
echo "$SIT" | HUM_FOCUS_LANES="location_context,weather,calendar,situation" \
  node ~/Dev/edva/agent/scripts/hum-harvest-all.mjs
```

Substitute the real lanes from *this* dispatch — the value above is illustrative. When `lanes` is absent or empty, drop the `HUM_FOCUS_LANES=` prefix entirely and run the bare command.

**Verify it took:** every lane in `meta.focus_lanes` must appear in `meta.attempted`, never `meta.skipped_cadence` — if not, the env var didn't reach the process; fix that before reading candidates. Copy `meta.focus_lanes` into the tick trace.

The wrapper reads `data/hum-interests.json`, runs every enabled harvester with the Step 2b context, then claim-check (2d) and wiki recall (2c), and returns:

```json
{
  "candidates": [
    {"topic","signal","urgency","freshness_min","dedup_key","supporting_data"},
    ...
  ],
  "wiki_recall": {
    "per_candidate": [
      {"topic","subject","dedup_key","wiki_hits":[{"page_id","title","snippet"}]}
    ],
    "today_replies": [
      {"ts","lane","subject","subject_key","reply_text","disposition"}
    ],
    "today_chat": [
      {"role","content","created_at","day_tag"}
    ]
  },
  "meta": {"attempted": [...], "skipped_cadence": [...], "errors": [...]}
}
```

Feed `wiki_recall` into Step 3 (WIKI CONTEXT / TODAY'S REPLIES / RECENT CHAT). Do not drop it.

The output also carries `claim_check` — `{dropped: [...], flagged: [...]}` (Step 2d). Copy both arrays into the tick trace.

### Pre-rank vetoes and the no-model short-circuit (2026-10-04)

`hum-harvest-all` applies `hum-ping`'s refusals before ranking (`lib/hum-vetoes.mjs`): `history_blocked`, `cross_send_dedup` (24h; 180 days for a sticky `nearby:*` key; and, commit harvests only, a dining pick or dining / taste-match idea that re-recommends a place already recommended in the last 21 days under any key, unless they deferred it: a model judgment, Jev site `hum-place-repeat`, checks in parallel under a 20 s deadline that fails open, and a vetoed idea is retired via `hum-reservoir-prune --expire`), `novelty_duplicate`, `retrospective_ask_cap` (3/day), and — once the shared daily ping budget is spent (6 today, or the last one < 45 min ago) — every remaining candidate (`rate_limited`; a `nearby` local explanation is checked against its own pool instead, 10/day, 15 min apart). Also `resolved_first` (2026-10-15): a candidate whose `dedup_key` the resolve-first gate (Step 4) already answered from Edva's records in the last 7 days, with no carve-out. Same carve-outs as `hum-ping`: exercise/health lanes and harvester `urgency` ≥ 0.9 bypass dedup, novelty and budget — but nothing bypasses a sticky `nearby:*` key. Refused candidates move to `meta.pre_rank_vetoes` — copy it into the trace's `harvest.pre_rank_vetoes`. Exits 7/8/9/10/11 at send time should therefore be rare; if they are not, something is bypassing the filter. (Exit 12 is different: the gate judges the final wording, so it can fire on a candidate no veto knew about.)

**Read two flags before Step 3, and skip Step 3 entirely when either is set:**

- **`meta.no_eligible: true`** — nothing survived. Write the silent trace with `silent_root_cause: "pre_rank_vetoed"` when `meta.pre_rank_vetoes` is non-empty, else `"no_candidates"`, and populate `near_miss_candidates` from the vetoes. No ranking — there is nothing to rank.
- **`meta.perishable_no_local: true`** — a perishable location tick where every surviving candidate is neither place-bound nor operational. Silent, `silent_root_cause: "perishable_no_local"`, near-misses from `candidates`.

Art/music/dining/crossref harvesters may fork a `claude -p` Sonnet subagent with WebSearch or hit `context-search` (150s budget); fast harvesters <15s; all run in parallel, wall time ≈ slowest.

## Step 2b — Context bundle (unified knowledge access)

Harvesters get `{situation, context}` on stdin; `context` is `lib/edva-context.js` (`edva context --json`):

```json
{
  "profile":   { "<one key per profile page the installation lists, e.g. owner, residences>" },
  "tastes":    { "art", "food", "tv", "music", "restaurants", "schedule" },
  "projects":  { "<one key per active project the installation lists>" },
  "knowledge": { "calendar", "tasks", "email", "notes", "imessage", "slack", "wiki",
                 "supabase", "memory_files", "hum_learnings", "<the installation's own sources>" },
  "recent":    { "today_commits", "today_triage", "recent_learnings", "counts" }
}
```

Adding a data source = one entry in `lib/edva-context.js` (+ optional lazy fetch in `recent`); harvesters don't change. Field-by-field use: hum-detail.md § Step 2b.

## Step 2c — Wiki recall (consult the entire wiki per candidate)

`agent/scripts/hum-wiki-recall.mjs`, per candidate: BM25 OR-search of the whole wiki (`bm25 <= -12`), plus today's un-consolidated replies (`hum-responses.jsonl`) and ~36h of their chat (`today_chat`, code-computed `day_tag`) → the `wiki_recall` block → Step 3's WIKI CONTEXT / TODAY'S REPLIES / RECENT CHAT. Read-only; failure degrades to empty recall, never blocks. (hum-detail.md § Step 2c.)

## Step 2d — Claim-check (authorities, deterministic)

Runs inside `hum-harvest-all.mjs` right after harvest, before wiki recall. For every candidate it extracts the **entities** (places, dates) and asks each entity's authority what is true (`lib/claim-facts.mjs`; travel presence from the installation's travel timeline, through its presence provider).

- A **hard** contradiction — the candidate *asserts* the user is somewhere the timeline refutes, structurally (`supporting_data.location_claim`) or with an explicit presence construction — **drops the candidate before ranking**.
- A **soft** mismatch — a known place merely *mentioned* while the user is elsewhere — does **not** drop. The resolved facts ride on the candidate as `claim_facts` for the ranker, and `outbound-precheck` settles it at send time.

Fail-open: an unreachable timeline yields no facts and drops nothing. One timeline fetch is shared across all candidates. (Why a gate, not a ranker instruction: hum-detail.md § Step 2d.)

## Step 2d-bis — Freshness (is the premise STILL true?)

`lib/claim-freshness.mjs` (`claim-check` Stage 1.5): when a candidate's evidence date (`supporting_data.evidence_as_of`, nested `source_email.date`, else `created_at`) is >90 min old, a model picks out its **stateful** claims and the mailbox is re-read for each, `after:` that date.

- **Resolved since** → the candidate is dropped.
- **Moved** → rewritten with the new facts.
- **Mailbox silent** → rewritten to carry its vintage ("as of Wednesday's email, the contractor hadn't confirmed yet"). Silence is not confirmation.

A rewrite does **not** short-circuit — the corrected text still faces the memory/relevance stage.

**Harvesters: stamp your ideas.** Any harvester writing an idea out of an email sets `supporting_data.evidence_as_of` (or `source_email.date`) to when that email landed. Undated = treated as stale (safe, but pays for a check and uses a conservative mailbox window). (Incident: hum-detail.md § Step 2d-bis.)

## Step 3 — Ranking + decision

**Rank in this turn, yourself** (the hum turn's own model, Sonnet), applying the decision logic below to the brief, and settle on one JSON decision object. Every candidate has already cleared the pre-rank vetoes (Step 2). This is the current model ranker and it stays (the user's decision, 2026-10-22): the turn has ranked in-line since 2026-10-06 instead of handing off to a Haiku subagent, and the code-only ranker that shadowed it was retired. Do not spawn a ranking subagent. (Model history: hum-detail.md § Step 3.)

### Decision logic

```
You are ranking candidate findings for the user's hum tick. One shot — no follow-up calls.

SITUATION (where/environment/time/now/next/working_on):
<inject situation JSON>

CONTEXT (compact — tastes + active projects + recent learnings; do NOT inject the full edva-context bundle):
<inject { tastes: context.tastes, projects: context.projects, recent_learnings: context.recent.recent_learnings } only>

CANDIDATES (harvesters already ran; candidates whose premise the authorities refuted were already dropped in Step 2d):
<inject candidates array. Some carry `claim_facts` — resolved ground truth about the places/dates they name, e.g. {place:"Springfield", on:"2026-07-31", actual_label:"Shelbyville", in:false}. Treat `claim_facts` as TRUE and the candidate's wording as suspect wherever they disagree: never surface a sentence that contradicts a claim_fact, and never build a recommendation on a city the user will not be in.>

RECENT RUNS (last 24 from hum-runs.jsonl, for dedup):
<inject recent runs>

FEEDBACK (last 14d reactions — bias signal):
<inject hum-feedback.jsonl tail>

LEARNINGS (last 30d answered questions — do NOT re-ask these):
<inject hum-learnings.jsonl tail>

WIKI CONTEXT (what the user may already have told us — BM25 keyword search over the WHOLE wiki, per candidate):
<inject wiki_recall.per_candidate — for each candidate, its subject + the wiki_hits (page_id, snippet, `bm25`).

Most candidates will have NO hits, and that is correct — roughly 8 of 14 real candidates match anything at all. An empty list means nothing on file matched the candidate's distinctive words; it is not a failure and it is not evidence either way.

READ THE SNIPPET. A hit means the page shares rare, specific vocabulary with the candidate — a strong signal it is about the same thing, but still only a LEAD. It settles the subject only when the snippet genuinely answers what you were going to ask or surface. A more-negative `bm25` is a stronger match (-25 is much stronger than -13).

Do NOT reason "there is a wiki hit, therefore this is handled.">

TODAY'S REPLIES (captured today, not yet consolidated into the wiki):
<inject wiki_recall.today_replies — replies the user gave to pings earlier today. A reply here that settles a subject (answered / negative / visited / deferred) means they already dealt with it; do NOT resurface it today.>

RECENT CHAT (what the user typed in ordinary conversation over the last ~36h, each message tagged with the day it was actually sent — NOT yet in the wiki):
<inject wiki_recall.today_chat — their own recent chat messages, each carrying a `day_tag` ("today" / "yesterday" / "N days ago") computed in code from its `created_at`. If one of these already states a preference, a plan, or an answer to what you'd otherwise raise, treat it as ground truth just like a reply: do NOT ask about something they just told the chat agent. THIS BLOCK SPANS ~36 HOURS, NOT ONE DAY — use ONLY a message's own `day_tag` for any relative-day language you write about it ("last night", "this morning", "yesterday"); never infer same-day/same-night from the fact that a message sits in this block, from its position, or from adjacency to another fact. A message tagged "yesterday" happened yesterday even if it's the newest thing in this block.>

DAYS SINCE LAST QUESTION:
<inject the integer number of days between now and state.last_question_at from hum-state.json. If the field is null/absent, inject 999. When this is ≥ 3 the question mechanism is overdue — apply the QUESTION BACKSTOP in the decision rules below.>

TASK: choose exactly one action.

Use CONTEXT to make relevance specific — when a candidate mentions art, weigh it against `context.tastes.art`; when a candidate is about a restaurant, check `context.tastes.restaurants` + `context.tastes.food`. `context.projects` lists active priorities that deserve lower-bar surfacing. If a candidate would benefit from data you don't have (profile details, knowledge-base entries, etc.), lower its confidence rather than guess — rank cannot make tool calls.

Scoring: for each candidate, compute
  score = urgency * 0.4 + relevance * 0.2 + freshness_bias * 0.1 + temporal_fit * 0.3 + act_deboost
where
  relevance is your natural-language judgment of how well the candidate fits SITUATION right now
  freshness_bias = 1 if freshness_min <= 30, 0.5 if <= 180, else 0.2
  temporal_fit = how well the candidate's `temporal_fit` block aligns with
    SITUATION right now. If the candidate has no temporal_fit field, score as
    0.5 (neutral). If it does:
      - relative_to == "calendar_event" with anchor matching SITUATION.next.upcoming_events:
        score 1.0 if within boost_during window, 0.4 otherwise
      - relative_to == "transition" + situation shows a transition (idle≥10min after
        active work, or just-finished calendar event): 0.9 if true, 0.3 if false
      - relative_to == "commitment": 0.95 if a free-window in next 4h aligns AND
        the commitment isn't in LEARNINGS as already-done
      - relative_to == "free_window" with anchor inside SITUATION.next free time: 0.85
      - relative_to == "time_of_day" with anchor matching SITUATION.time.local_hour: 0.7
      - relative_to == "always" (or omitted): 0.5
      - If `expires_after_iso` has passed: 0.0 (drop)

  act_deboost = small effort-based adjustment. Heavy-lift candidates
    (act_fit.effort_to_act == "heavy_lift") get -0.05 UNLESS the situation
    supplies the conditions to act now: SITUATION.next has a free_window ≥30 min
    in the next 4h, OR SITUATION.now_activity.at_desk_min >= 15 (they're
    away/transitioning). moderate = 0.0 (neutral). quick_win = +0.02 (the user's
    gold-standard reaction lane). Absent act_fit field = treat as moderate (0.0).

  The `situation` lane (topic="situation") aggressively carries temporal_fit and
  by design will score high when it fires; that is intentional — its WHOLE PURPOSE
  is timely-now suggestions. Do not down-rank it just because it doesn't come from
  a domain feed; the per-candidate dedup + the harvester's own anti-noise gates
  already bound its volume to ~1 per tick when relevant.

Pick the winner candidate. Then run **ASK-FIRST** before settling on info/silent — a question is a first-class outcome, not a fallback for when nothing else fits.

**QUESTION-FIRST (the user's rule, 2026-10-27: questions of every type are prioritized over everything else).** Code puts every eligible question at the head of the candidate list and marks it `supporting_data.question_first: true` (`lib/question-pacing.mjs`; decision cards, dream / hum-improvement / re-asked questions, location asks, low-confidence ideas). **If any candidate carries `question_first`, the winner is a question:** the first one, in code order, unless it fails a check that would make any question wrong to send (its subject is settled in WIKI CONTEXT / TODAY'S REPLIES / RECENT CHAT, it asks about Edva's own state (rule 5), or an `open_questions` re-ask is no longer relevant and goes to `retire_questions`); then the next marked one. The 0.45 score threshold and tie rules do not apply to a marked question. **Only two things go ahead of it:** an info candidate with urgency ≥ 0.9 (safety, a missed flight) and a protected Rule #1 lane, the same carve-outs the budget already has. Info candidates are decided only when no marked question survives. This supersedes, wherever they conflict, the older wording below that a question lane "never outranks an operational, health-urgent or time-critical candidate" and rule 3a's tie-loss and own-score threshold.

**Questions have their own budget and speed up as they pile up.** They no longer draw on the shared 6-a-day info budget: the question pool allows 6 a day, at least 5 minutes apart, and each question lane reports how many it has waiting. At 4 or more waiting across lanes every question cap doubles and every lane spacing halves (12 a day); at 10 or more they triple (18 a day). The pool's own spacing stays 5 minutes at every backlog. The lanes' own caps (dream asks, hum asks, re-asks, decision cards per day, location asks) scale the same way. All code (pre-rank veto and `hum-ping` / `hum-ask` / `decision-ask`); `meta.question_backlog` and `meta.question_scale` show where it stands. Do not self-throttle on top of it. Each question lane puts a question it offered in the last 6 hours that did not go out behind the others (`rotateOffered`), so one held question never blocks the queue. A tick woken by the `questions` sensor (`questions.waiting`, its lanes focused) exists to send a waiting question: unless every one fails a check above, send one. While a question already holds the pending slot, the questions that would need it are not marked this tick (decision cards and location asks still are).

**ASK-FIRST (the user's rule: guess less, ask more; hum may send more messages to do it).** Asking is the default move whenever surfacing would otherwise require a guess.

0. **CONFIDENCE→ASK (programmatic — fires before LLM judgment).** If the winning candidate is from the `ideas` topic AND `supporting_data.confidence === "low"`, it MUST become a `question` — not an `info`. Do not assert as fact something the ideation agent flagged as uncertain. Use `supporting_data.verify_question` as the question text verbatim if it exists; otherwise craft a short verification question that surfaces the signal and lets the user confirm or correct the premise ("Got a task here — [subject]. Does that timing still hold?"). This rule is deterministic and cannot be overridden by urgency score or the EXERCISE PRIORITY rule. The one exception: if the `ideas` candidate's `confidence` is `null` or missing (old ideas), fall through to normal GUESS→ASK judgment (point 1).

0a. **RELATIVE-DATE RE-RESOLUTION (programmatic — fires before LLM judgment).** Relative time words frozen into a candidate's prose (`today`, `tonight`, `tomorrow`, `this <weekday>`, `in N days`, "her day is Tuesday") are **stale by ping time — never echo them verbatim.** Before surfacing ANY candidate, re-resolve every temporal claim against the ACTUAL date/time of this tick, using the absolute date in `supporting_data` (`*_birthday`, explicit `YYYY-MM-DD` fields) as truth — NOT the prose — and rephrase fresh ("is today" / "was 3 days ago" / "is in 5 days"). A frozen claim that no longer holds is **stripped or corrected**; with no reconcilable absolute date, drop the temporal hook or convert to a `question` ("…is that timing still right?"). Decision-driving dates (birthdays, anniversaries, event/flight dates, deadlines) are **double-checked against calendar/contact + today's date at surface time**, never asserted from authoring-time wording. Deterministic; overrides urgency score.

1. **GUESS→ASK.** If shipping the winner as `info` would require GUESSING something you don't actually know — the user's preference on a new restaurant / show / artist / venue, their intent for an ambiguous event or plan, whether something still holds — do NOT dress the guess up as a confident info ping. Convert it to a `question` that resolves the unknown. A confident ping built on a guess is exactly the noise the user is rejecting; the honest move is to ask.
2. **PREFERENCE-CAPTURE.** If the winner touches a domain where the user's taste/intent is NOT yet in CONTEXT or LEARNINGS (a cuisine, genre, venue, or person not on file), prefer a question that captures it. Questions grow memory.
3. **A FORWARD-LOOKING question does NOT have to out-score the info candidates.** If the best info candidate is a guess-flavored surface and a genuine clarifying / preference-capture question exists this tick, the QUESTION wins — even at a lower raw score — provided it isn't in LEARNINGS / RECENT RUNS and no pending question is active. Asking beats guessing.

   **This rule applies ONLY to questions whose answer changes what Edva can do NEXT** — a taste they haven't expressed, an ambiguous plan, a preference, "does that timing still hold". Those buy them something.

3a. **RETROSPECTIVE-ASK — the opposite rule for confirmation questions.** A candidate whose `supporting_data.ask_kind` is `retrospective_confirmation`, or whose `dedup_key` starts with `location_ask:` — "were you at X?", "did you actually stop?", "was that lunch?" — is **excluded from rule 3 entirely**. It does not get the ASK-FIRST bypass, it does not get the rule-4 backstop, and it does not win ties. The user was physically there — the information gap is Edva's, not theirs, and the interrupt buys *us* data rather than buying *them* anything. Specifically:

   - *Superseded 2026-10-27 by QUESTION-FIRST: a location ask is a question like any other and leads the list (perishable ones first). The two bullets below are kept for history and no longer apply.*
   - It must clear the 0.45 threshold **on its own raw score**, like any info candidate.
   - **It loses every tie — but only while `freshness_min < 45`.** If any other candidate is within 0.10 of it, that candidate wins — including a `nearby` factoid or a dining suggestion that scores lower. Once `freshness_min` (on the candidate itself) reaches 45, this tie-loss lifts and it competes on raw score like any other candidate (the user: location questions belong while they're there or shortly after, not hours later). `location_context.mjs` raises the candidate's own urgency cap (0.6 → 0.75) at the same 45-min mark.
   - If it wins anyway, ship it; `hum-ping` enforces a hard cap of 3 such asks per day (exit 10) and the rest stay queued and surface in the next daily summary's `unknown_stops` (`location-daily` is on-demand only and never runs on its own).
   - **PRIORITY LANE (2026-10-06) — the exception that answers the user's request.** When the candidate carries `supporting_data.priority_lane: true`, this tick was woken *for that question*: `location-enrich-compose` spooled a `location.ask_ready` event the moment it queued the ask, hum-sense dispatched it as `hum:moment` (which jumps the supervisor's queue), and WHAT JUST HAPPENED names it. **It wins this tick** — the tie-loss rule above does not apply — unless a genuinely urgent candidate (urgency ≥ 0.9, safety, a Rule #1 exercise nudge) must go instead. Ship its `signal` as the question. Rationale: the whole value of the ask is that they can answer it from memory a few minutes after leaving; losing a tie to a factoid sends it back to the queue, where it used to wait hours. A `location_ask:` candidate WITHOUT `priority_lane` keeps every rule above.
   - **Never present a late ask as current.** `supporting_data.ask_timing.verdict` is `"late"` when they left the stop more than 45 minutes ago; its `signal` then already opens with a code-built lead ("Looking back to this morning, around 10:21 — …"). Keep that lead and the time when you word the ping. Asks more than 4 hours old (or from an earlier day) never reach you — the harvester drops them to the daily summary (`askTiming` in `lib/location-ask-queue.mjs`).

4. **QUESTION BACKSTOP.** Read `DAYS SINCE LAST QUESTION` (injected above). If it is ≥ 3, treat the best clarifying / preference-capture opportunity this tick as the winner and ASK it — UNLESS a genuinely urgent info/safety candidate or a Rule #1 exercise nudge must win this tick. **A `retrospective_confirmation` ask does NOT satisfy this backstop** and does not reset the counter.

5. **NEVER ASK THE USER TO VERIFY EDVA'S OWN STATE.** If the winning candidate's ask is about Edva's internals — a queue, a pending ping, whether a job ran, whether a scan is current, what's in a cache or in its own memory — it is **silent**, always, at any score. Edva can read its own files. Examples that must never ship:

   - *"As of the last watchlist scan (Jul 18), 4 candidates were queued for hum approval — worth checking if you've already answered any of those pings since."*
   - *"As of when I found it on July 18, the artist was touring that venue — worth double-checking it's still on."*

   **Same rule for the vintage hedge generally:** an unsolicited ping may not ship a claim it can't stand behind by attaching an "as of \<date\>… worth double-checking". Either the claim gets re-checked before sending, or the candidate loses.

Only after ASK-FIRST yields no question: if winner.score < 0.45 → silent; otherwise → info.

**VOLUME (2026-10-06):** the info ping budget is **6 pings a day, at least 45 minutes apart** (questions have their own pool since 2026-10-27, see QUESTION-FIRST), shared with `location-ambient` and enforced in code (`lib/ping-budget.mjs` — pre-rank veto `rate_limited` and `hum-ping` exit 11; exercise/health lanes and score ≥ 0.9 are carved out; a `location_ask:` question skips only the 45-min spacing and still meets the daily cap). You do not enforce it — code does — so do not self-throttle on top of it ("too soon since the last ping", "already asked today"): when you see a candidate, the budget has room for it. Within that budget, when in genuine doubt between info and silent and a question would sharpen a real future decision, ASK. Silent is still right for genuinely low-signal ticks; it is NOT right when the top candidate is a legit finding you'd hesitate over, and it is NOT right when a question would resolve the hesitation. (Rationale/history: hum-detail.md § Decision logic.)

Output EXACTLY one JSON object, no prose:

  {"decision":"silent"}

  {"decision":"info","text":"<≤5 lines, Edva voice, URLs on own lines. NOTE: if Step 3.5 evaluator produced decision_aids, render them below the headline like:\n  <headline>\n  ❤️ Why yes: <for[0]>; <for[1]>\n  ⚠️ Why no: <against[0]>\n  Next: <steps_to_act[0]>\n  (primer line goes between headline and Why-yes when present, terse, no label)>",
   "subject":"<kebab-case>","rationale":"<one sentence>",
   "urgency":"low|med|high","based_on_topic":"<topic>"}

  {"decision":"question","text":"<≤3 lines, specific, curious>",
   "subject":"<kebab-case>",
   "memory_hook":"show_preference|restaurant_preference|event_recap|general_preference|person|<a hook the local additions name>",
   "rationale":"<one sentence on the future decision this sharpens>"}

TEXT FORMATTING RULES:
- **Pre-show dining (`supporting_data.nearby_restaurants` is present and non-empty):** After the headline (e.g. "The Show 7:30pm — dinner by 6:30"), list each restaurant as its own line starting with a bullet. Put the Google Maps URL on the NEXT line immediately after its restaurant line so the Edva app renders it as a preview card. Example format:
  ```
  The Show 7:30pm — dinner by 6:30
  • Example Thai (4.8★, 3 min walk)
  https://maps.google.com/...
  • Sample Noodle Bar (4.9★, 4 min walk)
  https://maps.google.com/...
  ```
  Max 3 restaurants. Omit distance if unknown. This rule fires only when `nearby_restaurants` is populated — do NOT invent restaurant suggestions when it is absent.

HARD RULES:
- **EXERCISE PRIORITY (Rule #1, active until the user says otherwise):** When an `exercise` candidate is present AND today's session is not completed/in-progress (or it is a post-slot-miss / post-session celebration), it wins unless another candidate is a true safety/financial emergency or an imminent meeting they must leave for right now. Never down-rank it for "less interesting" alternatives, unrelated recent runs, or feedback bias; pre-slot and post-slot-miss questions should almost always send. (The harvester itself caps exercise at 2 sends/day, no new nudges after 21:00 local — an absent exercise candidate is that cap, not a miss.)
- **Exception — watch recs COEXIST with exercise (don't compete):** when exercise is the forced winner above AND a `watchlist` / `watchlist-approval` candidate also cleared the 0.45 threshold this tick, send BOTH — the exercise ping (`--intent hum:exercise:<branch>`), then a SEPARATE watch-rec ping (`--intent hum:watchlist:<branch>`). The one sanctioned two-ping tick. Trace: primary `decision` = exercise, note the watchlist send in the rationale. No other lane coexists.
- When the winner clears 0.45 and isn't a repeat/learning collision, SEND IT. Never self-impose rate limits ("too close to the last ping", "already 2 pings today"); trust the threshold.
- Silent is only correct when: no candidate clears 0.45, OR the winner duplicates LEARNINGS / RECENT RUNS, OR an active-event rule fires (quiet windows are disabled — see note below, don't reinstate via judgment).
- NEVER ask about a subject that appears in LEARNINGS (already answered).
- NEVER repeat a subject from RECENT RUNS.
- **WIKI/REPLY SETTLED-SUBJECT GATE.** NEVER re-ask or re-surface a subject that `WIKI CONTEXT`, `TODAY'S REPLIES`, or `RECENT CHAT` shows the user already settled (a preference recorded, a decision made, "we did that / it's handled / it's canceled / add it for next time") **unless the situation materially changed** (new date, new booking, information the prior reply didn't cover). A reply from three days ago settles as firmly as one from this morning. If a settling `TODAY'S REPLIES` row, or a `WIKI CONTEXT` hit whose **snippet actually answers it**, matches the winner's subject → `silent` (`silent_root_cause: "wiki_settled"`) or pick a genuinely-unsettled candidate. A hit merely on a related topic is NOT a settlement (READ THE SNIPPET) — getting this backwards silences hum entirely, worse than an occasional repeat. If a wiki fact answers what you'd otherwise have ASKED, don't ask. Overrides ASK-FIRST and the QUESTION BACKSTOP (a backstop question must be about something genuinely unknown).
- **Event geo-gate.** Dated, place-bound event candidates (concert/show/talk/dining/exhibit/weekend pick/etc.) were already city-on-date gated by their lane (`geoGate`: the installation's travel timeline, with performers on its always-worth-it list exempt). As a backstop, never surface an event that SITUATION/travel puts in a city the user won't be in on that date.
- If SITUATION shows an active event (calendar now, speech+music audio, in-motion), only urgent-urgent info is legitimate. Questions about an in-progress thing only at its end.
- If SITUATION.next.upcoming_events contains an event starting within 30 min that requires the user to leave (location != current where.place), the ONLY legitimate info is the travel/departure nudge — suppress every other candidate unless it's truly catastrophic.
- Respect SITUATION.now_activity.at_desk_min: when 0-2 (active typing), prefer info relevant to working_on.week_commit_topics. When >15 (away), less about code, more about the thing they're doing.
- Prefer candidates whose topic matches what the user is working on today (working_on.today_commits / week_commit_topics) or where they are right now.
- Respect FEEDBACK bias: repeated 👎/💤 → higher bar; 👍/more → lower bar. Discretionary lanes (dining, art, music, talks, news, serendipity, watchlist) arrive with `urgency` already scaled by a per-lane engagement multiplier (0.65–1.35, shown as `engagement_weight`) — a low urgency there may be the user's revealed disinterest; trust it. Operational/safety/health lanes (exercise, tasks, calendar, ideas, the business lanes, travel, stocks, health, situation, …) are not weighted. **Art tiebreaker:** an `art` candidate that cleared novelty/dedup beats a same-urgency `ideas`/`situation` candidate for the winner slot (relative preference only — no threshold change, no extra pings).

QUIET WINDOWS — DISABLED 2026-08-04 (the user's instruction):
No time-of-day soft-defers (the old protected windows are gone). Never downgrade to silent because of the time or what the user is doing; a `quiet_window_defer:` rationale is invalid. Do not reinstate any window via judgment, even a narrower one. The sleep window and `location-confirm-ask.md`'s quiet window are availability gates enforced upstream, never here. Watch recs need no exemption — score threshold like everything else.

Score threshold (0.45) is now the only content gate, alongside the other HARD RULES above (LEARNINGS/RECENT RUNS dedup, wiki/settled-subject gate, event geo-gate, active-event suppression).

**Lane note — `dream_asks` (added 2026-10-15).** Candidates from the `dream_asks` harvester are questions the nightly dream (`jobs/dream.md`) could not settle from a day's evidence, floated from the day after it was written (the user's rule). They are **always questions, never info**. Use `supporting_data.verify_question` as the question, keeping its meaning and its open-endedness; you may freshen relative time words ("Monday" → "last Monday") and tighten it, but never turn it into a statement of its premise. Set the question's **`memory_hook` to `supporting_data.memory_hook` verbatim** (`dream:<idea-id>`) and keep `dedup_key` as the idea id. It is a forward-looking, preference/intent question, so ASK-FIRST rule 3 applies (it may win over a higher-scoring info candidate); under QUESTION-FIRST it outranks every info candidate except urgency ≥ 0.9 and protected lanes. Pacing (at most 3 in 24h, 2h apart, newest dream first) is code in the harvester — do not self-throttle on top of it. The wiki/settled-subject gate applies as everywhere: if memory already holds the answer, it is silent **and retired** (`retire_ideas`, § Retire dead reservoir ideas; also when the precheck holds it as already done). Once asked, the idea is marked consumed (Step 4).

**Lane note — `hum_asks` (added 2026-10-07).** Candidates from the `hum_asks` harvester are a change to how hum itself behaves that is waiting on the user (their instructions: questions about hum are floated through hum in the chat and answered there; they can come a couple a day, need not be yes/no, and are welcome). They are **always questions, never info.** Write ONE plain-language question: what hum does today that is not working and what you would change. **It does NOT have to be yes/no** — ask openly ("how would you want that to work?", "which of these two feels right?", "what would you expect to see?") whenever their own words would teach you more than a yes would, and use a plain "want me to go ahead?" only when the choice is truly binary. They welcome these, so do not hedge or apologise for asking. No file names, no lane jargon, no idea ids in the text. Set the question's **`memory_hook` to `supporting_data.memory_hook` verbatim** (`hum_improvement:<idea-id>`) and keep `dedup_key` `hum_asks:<idea-id>` — the answer-handling and the pacing (at most two asks in any 24h, at least 6h apart; an unanswered idea is asked again after 3 days; code, `lib/hum-ideas.mjs`) both read those. Do not self-throttle on top of it. Under QUESTION-FIRST it outranks every info candidate except urgency ≥ 0.9 and protected lanes, it counts against the question pool like any question, and if `idea_age_days` is large, check the premise still holds against the rules in THIS playbook before asking (an idea about a threshold or a lane that has since changed is silent, not asked). The wiki/settled-subject gate applies as everywhere. Their answer is filed by the chat agent with `hum-answer`, and the chat agent then records the verdict with `hum-idea-decide` (`chat-agent/CLAUDE.md § Hum Inbound Handling`); you do nothing further.
```

**Lane note — `open_questions` (added 2026-10-17).** The user's rule: repeat questions until they're answered; none goes unanswered unless it is no longer relevant (a "where were you today" is not relevant tomorrow). Every question hum asks is kept open in `data/open-questions.jsonl` until they answer it; this lane offers the oldest unanswered one when it is due again (next day, then 2, 4, then every 7 days). It is **always a question, never info**. Re-ask it in fresh words as ONE short, warm question, saying lightly that you're coming back to it (never guilt, never "you didn't answer"); keep its meaning, freshen relative time words. Code reuses the original question id and memory_hook — just set `winner_dedup_key` to the candidate's `dedup_key`. Like `dream_asks` it is a forward-looking question, so ASK-FIRST rule 3 applies; under QUESTION-FIRST it outranks every info candidate except urgency ≥ 0.9 and protected lanes. **When it is no longer relevant** — its moment has passed, a chat message or memory since then answers it, or what it asks about is settled — do NOT ask it: add `{"question_id": "<supporting_data.question_id>", "why": "<one line>"}` to **`retire_questions`** and decide the tick on the other candidates. Pacing (≤2 re-asks in 24h, 3h apart) is code — do not self-throttle on top of it.

**Lane note — `decisions` (added 2026-10-22).** the user chose to get the decisions waiting on them (improvement planner + cost review questions) **one a day in chat, as a hum lane**, instead of at the bottom of the weekly review email. The candidate is one decision (`supporting_data.decision_ref`), already picked most-important-first and paced to one per local day in code. It is **always a question, never info**, and you **do not write its text**: if it wins, set `decision: "question"`, `based_on_topic: "decisions"`, `winner_dedup_key` = its `dedup_key`, and leave `text` empty — code sends it as a multiple-choice card (Step 4 § `question` step 0). Like `open_questions` it is forward-looking, so ASK-FIRST rule 3 applies; under QUESTION-FIRST it outranks every info candidate except urgency ≥ 0.9 and protected lanes, and on a perishable location tick prefer the local candidate. Do not self-throttle on top of the code pacing. **People questions** (source `people`, refs `ppl:`, from `bin/people-watch`: stay in touch with someone slipping away, follow a colleague's news, a change in someone's life, an overdue nudge) ride the same lane in their **own daily slot** (one a day, more when the question backlog is long), so they never crowd out a review decision; they carry a lower urgency (0.45) than review decisions, which only orders them among questions.

## Step 3.5 — Post-rank evaluator (added 2026-05-20)

Fires ONLY if the Step 3 decision was `info` (not silent, not question) AND the winning candidate's `act_fit.effort_to_act ∈ {"moderate", "heavy_lift"}`. If the winner is `quick_win` or has no `act_fit` field, skip this step entirely. Purpose: enrich a heavy-lift suggestion with `decision_aids` so the ping is a yes/no for the user, not "let me research this". (hum-detail.md § Step 3.5.)

Launch a Sonnet `--effort low` subagent with this brief:

```
You are the act_fit evaluator. The hum ranker chose ONE candidate to ship to the user. Your job: produce a tiny decision-aid bundle so they can yes/no without researching.

CANDIDATE (the winner):
<inject candidate JSON, including supporting_data + act_fit>

USER CONTEXT (compact — only what's needed to judge):
- profile.tastes for the candidate's domain: <inject the matching taste profile slice — art / music / dining / etc.>
- profile.location: where they are now
- next 4h calendar windows: <inject from SITUATION>
- recent feedback (last 14d) on this lane: <inject if available>

TASK: emit a JSON object with EXACTLY this shape, no prose:

  {"decision_aids": {
    "for": ["<2-3 short reasons this is a yes — taste match, time fit, opportunity cost>"],
    "against": ["<1-2 reasons it could be a no — friction, opportunity cost, taste mismatch>"],
    "primer": "<≤2 sentences of research-bundle context that the suggestion ITSELF lacks. For unknown artists: who they are, why they matter to the user's taste. For unfamiliar restaurants: cuisine, what it's known for. For commitments: what was promised, by when. Omit if quick_win.>",
    "steps_to_act": ["<ordered concrete next steps; for art = 'walk in, no ticket'; for music = 'tickets via [platform], $40 range'; for commitments = 'block 14:00-15:30 on calendar'>"]
  }}

RULES:
- Be specific. "Matches your taste" is bad; "shoots small-scale b&w nature still-lifes; you saved two photographers in that vein last quarter" is good.
- Don't hallucinate. If you don't have evidence for "for" / "against", give one well-justified bullet rather than three guesses.
- `primer` is the BIG value-add for heavy-lift suggestions — make it count.
- Keep total output under 500 chars; this gets pasted inline in the ping.
```

Take the evaluator's output and splice `decision_aids` onto the winning candidate's `act_fit`. The Step 4 surfacing template renders these inline in the ping text.

If the evaluator fails (timeout, malformed JSON, exit nonzero), proceed WITHOUT decision_aids — the ping still ships. Don't degrade to silent; the ranker decision stands.

## Step 4 — Execute decision + write the tick trace

Every tick — silent, info, or question — writes ONE enriched line to `hum-runs.jsonl`; it is the only artifact `hum-review` uses to measure performance, so completeness matters.

**Write it with `hum-run-log append`, never with a shell redirect** (`>>` hand-assembled JSON corrupts the file — hum-detail.md § Step 4).

### Resolve-first: every send is worked out before it is floated (2026-10-15)

The user's rule: work out the answer before asking applies to EVERY question and hum comment before floating, whatever its type or context — not to hide anything from the user, but because floating something Edva should already know the answer to is unhelpful. (Trigger: a question whose answer the user's own records already held.)

You do not run this; it runs inside the send. Every info ping (`hum-ping`) and every question (`hum-ask`, below) carries a `hum:` intent, and `edva-send-curl` hands each one to `bin/hum-resolve-first`, which reads Edva's own records (travel timeline, bookings in `flights.json`, calendar, tasks, recent chat, memory recall, email memory, location history, its own earlier answers, and any source the installation adds) and has Opus decide:

- **nothing open** (a fact, a heads-up, a reminder) → sent exactly as you wrote it;
- **a question the records can't answer** → asked as the specific unknown, with one line on what was checked (or as you wrote it, if the model offers no rewrite);
- **partly answerable** → rewritten to ask only the remaining gap, with one line on what was checked;
- **answerable, and worth them knowing** → a short FYI goes out instead (the fact + what was checked);
- **answerable, and saying it adds nothing** → nothing is sent: `hum-ping` / `hum-ask` exit **12**.

It fails open (any error sends your text unchanged) and adds 10–30 s, sometimes up to 90 s. **Run `hum-ping` and `hum-ask` with a Bash `timeout` of 300000.** Do not try to pre-empt it by second-guessing your own wording, and do not re-send something it dropped or rewrote. The answers it settles are kept (`data/hum-resolve-first.jsonl`) and vetoed pre-rank as `resolved_first`; the decision log is `data/hum-resolve-first-log.jsonl` (`hum-resolve-first stats` / `tail`). Design: `docs/hum-resolve-first.md`.

### Retire dead reservoir ideas (`retire_ideas`) — added 2026-08-06

The `ideas` harvester nominates exactly ONE idea per tick. When you reject that nomination for a reason that will *still be true tomorrow*, retire it — otherwise the same dead idea wins the lane's only slot again next tick. **The same holds for a `dream_asks` question** (it lives in the same reservoir and its lane also offers one per tick, newest first): a dream question you do not ask because it is settled, answered in chat, or its premise is spent — or that the outbound precheck held as already done or answered — is retired the same way, or it blocks every older dream question behind it. A question only waiting for a better moment is not retired. You are the only component that makes this judgment. (Incident: hum-detail.md § Step 4.)

Populate `sonnet.retire_ideas` when the ideas candidate is dead for a **durable** reason:

- the idea is anchored to a place they have left and isn't returning to (the locality gate in `hum-idea-locality.mjs` only catches places the travel timeline still knows about — not a city swapped off the itinerary entirely)
- WIKI CONTEXT / TODAY'S REPLIES / RECENT CHAT show the subject is settled for good — they did it, cancelled it, or ruled it out
- its premise is factually spent (the show closed, the deadline passed, the task is done)

Do **not** retire an idea that merely lost this tick — a lower score, a cooldown, a better candidate, "not right now", or a window that hasn't opened yet. When in doubt, leave it in the reservoir: a wrongly-retired idea is silently deleted, a wrongly-kept one costs one nomination.

For each entry, before writing the trace:

```bash
~/Dev/edva/bin/hum-reservoir-prune --expire "<idea_id>" --reason "<why>"
```

The `idea_id` is the ideas candidate's `dedup_key` (also `supporting_data.idea_id`). One append per call, safe mid-tick. Leave `retire_ideas` as `[]` on ticks where nothing qualifies — which is most of them.

### Tick trace schema (write via `hum-run-log append`)

`hum-run-log append` replaces `harvest.candidates` with code's own copy from `hum-last-harvest.json` whenever that harvest is from this tick (within 30 min), so the keys and signals there are always machine-exact (you may still write the field; it is overwritten). Every other field is yours.

```json
{
  "tick_id": "t-YYYYMMDD-HHMM",
  "ts": "<ISO8601>",
  "situation": {
    "where_place": "<value from situation.where.place>",
    "activity_state": "<from situation.time.activity_state>",
    "at_desk_min": <number or null>,
    "upcoming_event": {"in_min":<n>, "title":"<summary>", "needs_travel":<bool>} | null,
    "overdue_count": <n>,
    "week_topics": ["<top 3>"]
  },
  "harvest": {
    "attempted": ["<topic>",...],
    "skipped_cadence": ["<topic>",...],
    "errors": [{"topic":"<t>","err":"<msg>"}],
    "noops": [{"topic":"<t>","reason":"<msg>"}],
    "candidates": [
      {"topic":"<t>","urgency":<n>,"freshness_min":<n>,"dedup_key":"<verbatim>","signal":"<first 120 chars>"},
      ...
    ],
    "pre_rank_vetoes": [{"topic":"<t>","dedup_key":"<k>","gate":"history_blocked|cross_send_dedup|novelty_duplicate|retrospective_ask_cap|rate_limited","detail":"<why>"}],
    "claim_check": {
      "dropped": [{"topic":"<t>","dedup_key":"<k>","why":"<authority contradiction>"}],
      "flagged": [{"topic":"<t>","dedup_key":"<k>","why":"<soft mismatch, passed to the ranker with facts>"}]
    }
  },
  "sonnet": {
    "decision": "silent|info|question",
    "subject": "<kebab-case>" | null,
    "based_on_topic": "<topic>" | null,
    "score": <n>,
    "rationale": "<one sentence>",
    "silent_root_cause": "no_candidates|pre_rank_vetoed|perishable_no_local|all_below_threshold|recent_runs_dedup|protected_event|pending_question_active|rate_limited|cross_send_dedup|history_blocked|novelty_duplicate|wiki_settled|retrospective_ask_cap|resolved_first" | null,
    "near_miss_candidates": [
      {"topic":"<t>","score":<n>,"dedup_key":"<verbatim from CANDIDATES>","signal":"<first 80 chars>"}
    ],
    "retire_ideas": [
      {"idea_id":"<idea-...>","why":"<durable reason this can never fire>"}
    ],
    "memory_hook": "<hook>" | null
  },
  "outcome": {
    "sent": <bool>,
    "downgrade_reason": "rate_limited|pending_question_active|protected_window" | null,
    "ping_id": "<p-...>" | null,
    "question_id": "<q-...>" | null
  }
}
```

Write it by piping the record to the log tool, which serializes it to exactly one line:

```bash
printf '%s' '<the trace JSON above>' | ~/Dev/edva/bin/hum-run-log append
```

It refuses anything that is not a JSON object. To read the log back, use `hum-run-log read [--tail N] [--since ISO] [--json]` rather than `jq` (it reports skipped lines). `hum-run-log check` prints the file's integrity.

Even on errors, write a trace row with `sonnet.decision: "error"` and `harvest.errors` populated. No tick produces silence; silence is a recorded decision.

### Debug mode (temporary, expires 2026-08-06T09:58 UTC)

As the LAST action of Step 4, once the real outcome is known (published, or hidden by `outbound-precheck`/`claim-freshness`), call:

```bash
~/Dev/edva/bin/hum-debug-line \
  --lane "<sonnet.based_on_topic, or the top near_miss topic if the ranker had no winner>" \
  --subject "<sonnet.subject, or the top near_miss signal (short), or 'none'>" \
  --decision "<published if outcome.sent==true, else hidden>" \
  --reason "<outcome.downgrade_reason if precheck hid it after the ranker chose info/question; else sonnet.silent_root_cause if the ranker itself chose silent; else sonnet.rationale if it published — keep it short>"
```

Every tick, including silent. It self-expires (no-op after the window or if `data/hum-debug-mode-off` exists) — don't check the date yourself. (Origin: hum-detail.md § Step 4.)

### `silent`

1. Write the tick trace with `outcome.sent: false`. **Always populate `sonnet.silent_root_cause`** from the schema enum (`pre_rank_vetoed` / `perishable_no_local` = Step 2 short-circuits; `history_blocked` / `cross_send_dedup` / `novelty_duplicate` / `retrospective_ask_cap` / `rate_limited` / `resolved_first` = `hum-ping` exits 7 / 8 / 9 / 10 / 11 / 12 (`resolved_first` also = `hum-ask` exit 12, and the pre-rank veto of that name); `wiki_settled` = Step 3 settled-subject gate) — hum-review uses it to flag ideation gaps. **Always populate `sonnet.near_miss_candidates`** with the top 3 candidates that came closest to firing (even if all were below threshold).
2. Update `state.last_run_at`.
3. **Reservoir refill trigger (reservoir-health-gated since 2026-10-04):** increment `state.silent_streak` (consecutive silent ticks since the last `info`/`question` ping). When it reaches 6, run `node ~/Dev/edva/agent/scripts/hum-tick.mjs reservoir-health --json` (counts live unconsumed, unexpired ideas in `hum-ideas.jsonl`). **Only when it returns `"refill": true` (fewer than 15 live ideas)**, dispatch a fresh `HUM IDEATION` run via webhook (`POST localhost:9082` with `{"task":"HUM IDEATION","source":"silent-streak-refill"}`) and reset the streak counter to 0. **Port 9082 (ops-light), not 9092 (ops).** When `refill` is false, leave the streak counting and do nothing. (History: hum-detail.md § Step 4.)

### `info`

1. The daily ping budget (6/day, 45 min apart) and the sleep window are enforced in code — the budget by `hum-ping` exit 11 and the pre-rank filter, the sleep window upstream (Step 0) — never by re-checking a clock or a counter here. No protected time-of-day windows (removed 2026-04-15). Non-silent findings proceed to send. `state.max_pings_per_day` / `state.min_ping_interval_minutes` in `hum-state.json` are ignored; the budget is `lib/ping-budget.mjs` (override with `HUM_MAX_PINGS_PER_DAY` / `HUM_MIN_PING_INTERVAL_MIN`).
2. Send + log in one step via `~/Dev/edva/bin/hum-ping`:

   ```bash
   printf '%s' "<text>" | ~/Dev/edva/bin/hum-ping \
     --ping-id "<p-YYYYMMDD-HHMM-hex>" \
     --lane "<lane>" \
     --score "<score_at_ping>" \
     --findings '<JSON array of candidates>' \
     --intent "hum:<lane>:<branch>" \
     --suppress-hook --message-from-stdin
   ```

   `hum-ping` atomically (a) posts to `edva_messages` via `edva-send-curl --capture-id`, (b) appends the `hum-feedback.jsonl` row with the captured `message_id` under an advisory lock, (c) for advisory lanes, appends a `surfaced` event per finding (canonical `subject_key`) to `suggestion-history.jsonl`. Do not call `edva-send-curl` directly for info pings.

   **Pictures ride along automatically.** `hum-ping` forwards `supporting_data.media` (`{image_url, map_url}`) to `edva-send-curl --media`. So **(i)** copy candidates into `--findings` with `supporting_data` intact, never a summary; **(ii)** never paste an image URL into the text. (hum-detail.md § Step 4.)

   <!-- geo-gate-ok: hum-ping is the generic publish path for every lane, not an event-specific send — a dated place-bound finding is already geo-gated upstream, at the harvester (`_common.mjs geoGate`) per ops-agent/CLAUDE.md § Travel Timeline & Event Geo-Gating, before it ever becomes a candidate this step can surface. -->

   **`--intent` is required.** Format: `hum:<lane>:<branch>` where `<branch>` is the harvester's `supporting_data.branch` (`pre-slot`, `slot-start`, `post-slot-miss`, `evening-recovery`, `celebration`, `morning-backstop`, etc.) when present, else the candidate's subject. The precheck suppresses `hum:exercise:*` / `hum:health:*` only on an explicit user revocation ("skip today"); without `--intent` it is not protective. (hum-detail.md § Step 4.)

   **Exit codes 7/8/9/10/11/12 — `hum-ping` refused or the records already answered it; nothing was written.** Each is a recoverable silent: trace `decision: "silent"` with the matching `silent_root_cause` and `near_miss_candidates` populated.
   - **7** → `history_blocked`: headline `subject_key` previously rejected per `suggestion-history` (`shouldFilter()`). Repeated exit-7s mean the harvester wiring needs investigation.
   - **8** → `cross_send_dedup`: headline `dedup_key` already sent within `HUM_DEDUP_WINDOW_H` hours (default 24) per `hum-feedback.jsonl`, unless `--score >= 0.9` or a Rule #1 lane (`hum:exercise:*` / `hum:health:*`). With no `dedup_key`, `hum-ping` derives `<topic>:<sha8(signal)>`. "Send more" means more *distinct* signal.
   - **9** → `novelty_duplicate`: semantic near-duplicate of a ping sent in the last 72h.
   - **10** → `retrospective_ask_cap`: three "were you at X?" asks already went out today.

   - **11** → `rate_limited`: daily ping budget spent — 6 pings today (larger of `hum-state.json` `today.pings` and today's `hum-feedback.jsonl` rows) or the last under 45 minutes ago. Carve-outs as exit 8.

   - **12** → `resolved_first`: the resolve-first gate found the answer in Edva's records and it was not worth a message, so nothing was sent and no row written. A reservoir idea behind it is already retired and a queued location ask dropped; do not mark it consumed or re-send it. (When the answer *was* worth sending, the gate turned the ping into a short FYI or into just the remaining gap and `hum-ping` exits 0 as a normal send.)
   **Exit codes 9 and 10 — novelty and retrospective-ask cap.** Exit 9: the headline is a semantic near-duplicate of a ping sent in the last 72h (`silent_root_cause: "novelty_duplicate"`). **The cosine threshold is per-lane since 2026-10-06** (`THRESHOLD_BY_LANE` in `lib/hum-novelty.mjs`): 0.93 by default, **0.90 for `nearby`**, because that lane keys its `dedup_key` on a standing SUBJECT so all facts about one landmark share a key — which makes telling a NEW fact from a RESTATED one this gate's job, not exit-8's. Calibrated against the user's own tapbacks: of three sends about one landmark, the one they ignored scored 0.9047 and the two they answered "more" scored 0.8597 and 0.6446, so 0.90 blocks exactly the repeat. Precedence is specific-beats-general: `HUM_NOVELTY_THRESHOLD_<LANE>`, then the table, then `HUM_NOVELTY_THRESHOLD`, then 0.93. Exit 10: three "were you at X?" asks already went out today (`"retrospective_ask_cap"`). Both are recoverable silents, traced like exit 7. All four refusals (7/8/9/10) are now also applied pre-rank in Step 2, so seeing one here means a candidate reached `hum-ping` without passing through `hum-harvest-all`.

   - **13** → `local_history_out_of_range`: a `nearby` local explanation, and their newest fix is more than 300 m from its subject or older than 30 min (2026-10-20). Nothing sent, no row. Expected while they walk fast; not a fault. A local explanation already told (same QID / page / OSM id, or the same spot within 30 m) exits **8** from the identity ledger.

   Exit 8 for a **sticky** `nearby:*` key uses `HUM_STICKY_DEDUP_WINDOW_D` days (default 180) instead of 24h, with no score carve-out — a fact about a place is told once. All five are also applied pre-rank (Step 2), so one here means a candidate bypassed `hum-harvest-all`.

3. Update `hum-seen.json` (subject key), `state.last_ping_at`, and `state.today.pings += 1`. `hum-feedback.jsonl` is handled by `hum-ping` in step 2 — do not append to it here.
4. **If `sonnet.based_on_topic` is `"ideas"` or `"dream_asks"`** — whether it went out as info OR as a question — mark the source idea consumed: `~/Dev/edva/bin/hum-mark-idea-consumed <idea_id> <ping_id>` — where `idea_id` is the `dedup_key` of the winning candidate (same as `supporting_data.idea_id`). The reaction half of the loop is closed by `edva hum feedback` (see `system/hum-ideas-reservoir.md`).

4a. **Sibling sweep (task-ID dedup)**: immediately after step 4, if the winning idea has a `supporting_data.task_id` (look it up in the collapsed `hum-ideas.jsonl` by `idea_id`), scan for any other unconsumed ideas with the same `task_id`. For each sibling found, append a consumed marker to `hum-ideas.jsonl`:
    ```
    {"id":"<sibling_id>","consumed":true,"consumed_at":"<ISO>","consume_reason":"sibling-sweep:task_id:<task_id>:from:<ping_id>"}
    ```
    Fail-silently if `task_id` is null or absent.

    **Also sweep by thread ID.** If the winning idea has `supporting_data.thread_id` (or the older `gmail_thread_id` field), separately scan for any other unconsumed ideas carrying that same thread id (checking both field names) and consume those too:
    ```
    {"id":"<sibling_id>","consumed":true,"consumed_at":"<ISO>","consume_reason":"sibling-sweep:thread_id:<thread_id>:from:<ping_id>"}
    ```
    Fail-silently if no thread id is present. (Incident: hum-detail.md § Step 4.)

5. Write the tick trace with `outcome.sent: true` and `outcome.ping_id`.

### `question`

0. **A `decisions` winner is sent by code, never by `hum-ask`:** after the pending-question check in step 1, run `~/Dev/edva/bin/decision-ask --ref "<supporting_data.decision_ref>"` (Bash `timeout: 300000`; it builds the card — a header chip, the bold question, numbered options with a grey one-line description, the recommended option first marked "(Recommended)", and "Type something" — sends it through `edva-send-curl` with the outbound precheck, and counts one ping in the shared budget with `ping-budget record`). Exit **0** → trace `outcome.sent: true`, `outcome.question_id: "<decision_ref>"`, and stamp `state.last_question_at` / `state.today.questions` (step 4); **5** (already answered, or one already went out today) → silent, `silent_root_cause: "all_below_threshold"`; **6** precheck held it → `outcome.sent: false`, `downgrade_reason: "precheck_suppressed"`; **3** → `decision: "error"`. Do not write `hum-pending-question.json` and do not record it in the open-questions ledger: their tap is filed by `choice-reply` (`decision-answer`), a typed answer by the chat agent, and the lane itself keeps an unanswered decision from being re-asked for 7 days. Skip steps 2–3 for it.
1. If an unexpired pending question exists in `hum-pending-question.json`, downgrade to silent with `downgrade_reason: "pending_question_active"`. Write the trace. (This slot only ever holds a question **actually delivered** and awaiting a reply; undelivered lane-diagnosis questions wait in `hum-qual-delivery-queue.json`.)
2. `id = q-YYYYMMDD-HHMM-<4hexchars>` — **except a re-ask from the `open_questions` lane: use `supporting_data.question_id` as the id, and its `memory_hook` / `subject` / `original_lane` as `--memory-hook` / `--subject` / `--lane`**, so an answer to any copy files against the same question. Retire the ones you judged no longer relevant with `~/Dev/edva/bin/open-questions retire <question_id> --why "<one line>"`.
3. Send AND hold the slot in one step with `hum-ask` (since 2026-10-15; never a bare `edva-send-curl` for a question — that skipped the resolve-first gate and, on a precheck hold, wrote the slot anyway). Pass the winning candidate as `--findings` so the gate sees what the question was based on. Bash `timeout: 300000`.

   ```bash
   printf '%s' "<question text>" | ~/Dev/edva/bin/hum-ask \
     --id "<q-YYYYMMDD-HHMM-hex>" --lane "<lane>" \
     --subject "<subject>" --memory-hook "<memory_hook>" --rationale "<rationale>" \
     --findings '<JSON array: the winning candidate>' --ttl-min 15 \
     --message-from-stdin
   ```

   It sends with intent `hum:<lane>:question` and `--capture-id`, and writes `hum-pending-question.json` (`{id, asked_at, question, subject, memory_hook, rationale, lane, delivered_msg_id, expires_at}`) **only for what landed as a question**, holding the text they actually saw. The captured `edva_messages.id` is what routes a threaded reply back to *this* question (`lib/hum-reply-target.mjs`). (15-min TTL policy: hum-detail.md § Step 4.) Exit codes:
   - **0** asked (possibly narrowed by the gate to just the remaining gap) → steps 4–5.
   - **13** the records answered it and a short FYI went out instead; no slot → trace it as `info` (`outcome.sent: true`, `outcome.resolved_first: "fyi"`) and do the `info` step-3 updates (`hum-seen.json`, `state.last_ping_at`, `state.today.pings += 1`, so the FYI counts against the daily ping budget); do NOT stamp the question counters.
   - **12** the records answered it and nothing was sent → silent, `silent_root_cause: "resolved_first"`.
   - **14** the outbound precheck held it; no slot → `outcome.sent: false`, `outcome.downgrade_reason: "precheck_suppressed"`.
   - **3** send failed → `decision: "error"`.
4. On exit 0 only: update `state.today.questions += 1` AND set `state.last_question_at = asked_at` (ISO8601). **This field feeds `DAYS SINCE LAST QUESTION` and the QUESTION BACKSTOP — always stamp it.**
5. Write the tick trace with `outcome.sent: true` and `outcome.question_id`.

Every question that lands (exit 0) is also recorded in the **open-questions ledger** (`data/open-questions.jsonl`, `lib/open-questions.mjs`) and its chat row is tagged `metadata.question_id`, so the app shows it in the question colour until it is answered. It stays open — and the `open_questions` lane re-asks it — until `hum-answer` files an answer or it is retired as no longer relevant; location-lane questions lapse at the end of the local day they were asked on (the user 2026-10-17).

Always update `state.last_run_at`. Reset daily counters at local midnight.

## Reply → memory loop (capture → consolidate → consult)

1. **Capture (realtime).** Chat-agent calls `hum-answer <id> "<answer>"` for question replies; `bin/suggestion-classify` catches free-text / reaction replies to any open ping. Both append to `data/hum-responses.jsonl` (`lib/hum-responses.mjs`).
2. **Consolidate (overnight).** `hum-consolidate` (`jobs/hum-consolidate.md`) folds durable facts into the general wiki.
3. **Consult (every tick).** Step 2c → `WIKI CONTEXT` / `TODAY'S REPLIES` + the settled-subject gate in Step 3.

Full description: hum-detail.md § Reply → memory loop.

### How hum is dispatched — the `hum-sense` event engine (rewritten 2026-08-02)

Design: `system/hum-events.md`; narrative: hum-detail.md § How hum is dispatched. What this playbook needs:

1. **Sensors** (`agent/scripts/hum-sensors/*.mjs`, `hum-sense` daemon) emit edge events; the **gate** (`lib/hum-events.mjs`) holds events that arrive at a bad moment, so one dispatch may carry several correlated events.
2. **The dispatch payload carries the moment:**
   ```json
   {"job":"hum","trigger":"event",
    "events":[{"type":"location.arrival","summary":"Arrived at Home","salience":0.62,"data":{…}}],
    "lanes":["location_context","weather","nearby"],
    "focus":"Arrived at Home",
    "salience":0.62}
   ```
3. **Idle path:** after `idle_fallback_min` (75 min) with nothing fired, the `idle` sensor emits one low-salience `idle.quiet` event (0.36) with **empty** `lanes`, as `trigger: "event"`.
4. **`trigger: "watchdog-fallback"`** means the event engine is down (the `trigger-hum.sh` cron only runs when the `hum-sense` heartbeat is stale) — check `hum-sense status`.

### What this playbook does differently per trigger

The pipeline is unchanged — every dispatch runs Steps 1–4. Only Step 2 differs:

- **`trigger: "event"` with non-empty `lanes`** — set `HUM_FOCUS_LANES` to them (Step 2) so the implicated lanes run immediately regardless of cadence. (`HUM_ONLY_LANES` exists for a deliberately narrow, fast tick — use it only when the event is unambiguous and speed matters.)
- **`trigger: "event"` with empty `lanes` (idle tick), or `"watchdog-fallback"` / `"manual"`** — no focus; run the plain Step 2 command.

Also feed `events[]` and `focus` into the Step 3 brief as **WHAT JUST HAPPENED**. The ranker should strongly prefer a candidate that speaks to the triggering event, while still being free to stay silent.

**On a PERISHABLE tick, locality is the bar.** A `location.arrival` / `location.departure` carries `perishable: true`: the ping must be about where they are standing, or there is no ping. `hum-harvest-all` already scales non-place-bound, non-operational lanes by `locality_weight` 0.55×; the ranker finishes the job — **prefer silence over a non-local candidate on a location tick.** Operational lanes (watchdog, finance, health, the installation's own operational lanes, tasks, calendar, email) are exempt. `meta.perishable_age_min` says how late the moment already is; past ~15 minutes `nearby` declines on its own, and a large value is a reason to prefer silence generally. (Evidence: hum-detail.md § Per trigger.)

### Realtime location-edge triggers (added 2026-04-16, re-pointed 2026-08-02)

Phone-channel's realtime `location_history` subscription spools `location.arrival` / `location.departure` events into the event bus; the situation snapshot already reflects the new visit. Detail: hum-detail.md § Realtime location-edge triggers.

### `nearby` lane — local history only (redesigned 2026-10-20)

`nearby.mjs`: a local explanation of the ground they are on — history from Wikipedia + OpenStreetMap within **300 m**, **zero Google Places**, never a subject they have already been told (identity ledger: QID / page / OSM id / same spot ≤30 m), self-scored and floored at 0.55, declined when the moment is >15 min old. Its own budget pool (10/day, 15 min apart) outside the shared 6/45. `hum-ping` refuses it (exit 13) unless their newest fix is still within 300 m; `ping-flush` withdraws one whose alert waited out a walk. Keep `supporting_data` (with `subject` lat/lon/ids and `budget_pool`) intact in `--findings`. Reached via focus lanes on `location.arrival` / `location.stopped_moving` / `excursion.out_and_about` (cadence 720 min). Design: hum-detail.md § `nearby` lane.

### `location_context` lane (added 2026-04-16)

`location_context.mjs` asks about state-change moments (just arrived / just departed / walking / walk just ended); chat-agent applies a yes via `location_annotate` with the pre-filled `annotate_on_yes` payload. Cadence 18 min, normally bypassed via `HUM_FOCUS_LANES` on a `location.*` dispatch. Priority order and reply parsing: hum-detail.md § `location_context` lane, `chat-agent/CLAUDE.md` "Replies to the `location_context` hum question".

## hum-tick — retired except for `reservoir-health` (2026-10-22)

The user's decision on a weekly Self Improvement Review: keep the current model ranker; drop the code-only shadow/switch-over comparison. The code tick runner (shadow ranking of every harvest, `hum-tick compare`, the cutover bar, `hum-tick run`, the `shadow-cutover-check` hum path and `hum-tick-config.json`) is gone. **This playbook's turn is the only ranker.** `hum-tick reservoir-health` stays — it is the § silent step 3 gate. History: hum-detail.md § hum-tick.

## Guardrails

Hum NEVER:
- Sends email, drafts replies, creates Google Tasks, labels email
- Books reservations, buys tickets, touches money
- Modifies files outside `data/hum-*` and memory routing via `hum-answer`
- Responds to the user's phone messages (chat-agent's job)
- Runs its own web searches outside the art/music subagent harvesters

## State files

Full descriptions: hum-detail.md § State files.

| Path | Purpose |
|---|---|
| `data/hum-state.json` | daily counters (`today.pings` is the live ping-budget counter, also bumped by `ping-budget record` for ambient sends); `max_pings_per_day` / `min_ping_interval_minutes` are ignored leftovers — the budget is code (`lib/ping-budget.mjs`) |
| `data/hum-interests.json` | topic registry (editable config) |
| `data/open-questions.jsonl` | every question hum asked and whether they have answered it (append-only events: asked / answered / retired; `lib/open-questions.mjs`, CLI `open-questions list|due|show|retire`). Written by `hum-ask`, `hum-answer`, `open-questions retire`; read by the `open_questions` lane and the chat agent's `[Hum state]` block |
| `data/hum-interests-state.json` | per-topic `last_run_at` / `last_signal_at` |
| `data/hum-lane-quiesce-state.json` | auto-quiesce streaks (`lib/hum-lane-quiesce.mjs`); `edva hum lane enable <name>` re-enables a lane |
| `data/hum-cache/<topic>.json` | per-topic harvester cache (incl. `situation-memo.json`) |
| `data/hum-last-harvest.json` | latest COMMIT-mode harvest — `hum-run-log append` copies its candidates into the trace |
| `data/decision-lane-state.json` | `decisions` lane: `asked[]` (`{ref, at, message_id, prompt_id, answered_at?}`) and the built card per ref (`cards`); written by `decision-ask` / `decision-answer` (`lib/decision-queue.mjs`). The decisions themselves live in `improvement-plan-state.json` / `cost-efficiency-review-state.json` `questions[]`, and the answer is written back there |
| `data/hum-seen.json` | per-subject dedup |
| `data/hum-feedback.jsonl` | reactions |
| `data/hum-runs.jsonl` | append-only decision log |
| `data/hum-pending-question.json` | single **delivered** pending question (tick: 15min TTL; lane-diagnosis: 24h). Needs `id`/`question` + parseable `expires_at`; clear by writing `null`, never `{}` |
| `data/hum-qual-delivery-queue.json` | queued lane-diagnosis question awaiting delivery by `hum-deliver-qual` |
| `data/hum-resolve-first.jsonl` | answers the resolve-first gate worked out from Edva's records (`lib/hum-resolve-first-store.mjs`); a fully answered `dedup_key` is vetoed pre-rank for 7 days as `resolved_first`. Edva's conclusions, never rendered as the user's words. `hum-resolve-first forget <id\|key>` withdraws one |
| `data/hum-resolve-first-log.jsonl` | one row per resolve-first decision (verdict, action, sources, latency); finance/stocks/health rows carry a hash instead of text. `hum-resolve-first stats` / `tail` |
| `data/hum-learnings.jsonl` | append-only answer log (questions) |
| `data/hum-responses.jsonl` | every reply to a ping (any lane); read by `hum-consolidate` and `hum-wiki-recall` |
| `data/hum-consolidate-state.json` | `{last_consolidated_at}` watermark for the nightly wiki consolidation |
| `data/suggestion-history.jsonl` | cross-lane advisory suggestion + response ledger (`lib/suggestion-recall.mjs`) |
| `data/hum-sensors.json` | sensor registry + gate config (re-read every tick) |
| `data/hum-sense-state.json` | engine runtime state; safe to lose |
| `data/hum-events.jsonl` | event ledger with each verdict (`hum-sense tail`) |
| `data/hum-events-inbox.jsonl` | push spool, drained every tick |
| `data/hum-dispatch-context.json` | `{ts, trigger, lanes, focus, events}` per dispatch; `hum-harvest-all.mjs`'s default focus-lane source (10-min freshness; `meta.focus_source`) |
| `data/hum-sense-heartbeat.json` | daemon liveness; stale >5 min → cron fallback tick |
| `data/last-situational-trigger-at.json` | last realtime location edge — telemetry only |

## Adding a new topic later

1. Write `agent/scripts/hum-harvesters/<name>.mjs` following the pattern (reads situation from stdin, emits one candidate JSON or `null`).
2. Add an entry to `data/hum-interests.json` with `cadence_min`, `cache_ttl_min`, `active_window`, `urgency_rule`.
3. Harvester is picked up on the next tick. No playbook edit needed.

## Telemetry (for `hum-review`)

- Tick counts; silent vs info vs question ratio
- Candidates generated per tick (avg / min / max)
- Per-topic hit-rate: how often does topic X emit → winner?
- Subjects with repeated 👎/💤 (prune pattern)
- Subjects with 👍/more (lean-in pattern)
- Question answer rate; median time-to-answer
- Memory-file growth since last review
