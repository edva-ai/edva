HUM — 20-minute proactive check-in. Evaluates the user's current situation, harvests every standing interest in parallel, and decides whether to surface the best finding, ask a context-building question, or stay silent.

This is a full rewrite (2026-04-14) of the tick model — situation → parallel topic harvest → Sonnet-ranked decision. The monolithic "Sonnet reads everything" design is retired.

## Purpose

Hum has two jobs, in order of precedence:

1. **Notice the moment.** Every 20 min, assemble a compact picture of the user's current situation and check every standing interest for deltas. Candidates are ranked by urgency × relevance-to-situation × freshness; the best one wins, the rest go to the run log.

2. **Be curious.** When an event has just happened that's worth learning from (show, meal out, new place, meeting a notable person), ask **one** focused question whose answer will make future recommendations sharper. Memory of the answer is the point.

Most ticks end silently. That's the design.

## Pipeline

```
tick
├─ Step 0: bash gates (already run by trigger-hum.sh)
├─ Step 1: SITUATION snapshot        merlin hum situation --json
├─ Step 2: TOPIC HARVEST              hum-harvest-all.mjs (parallel fan-out, 14 interests)
├─ Step 3: SONNET RANK + decide       Agent(model=sonnet)
└─ Step 4: execute + state update
```

## Step 0 — Bash gates (pre-dispatch)

By the time a dispatch reaches this playbook, `trigger-hum.sh` has already verified:
- Not in sleep window (00:00-09:00 local)
- Activity state is not `sleeping` / `winding_down`
- Not paused; daily ping cap not hit

Increment `state.today.runs` in `data/hum-state.json`.

## Step 1 — Situation snapshot

Single cached composite (2-min TTL), used as input to every harvester + Sonnet:

```bash
${MERLIN_HOME}/bin/merlin hum situation --json
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

**`next.upcoming_events`** is a first-class context signal: a meeting in 30 min trumps most other candidates. **`now_activity.at_desk_min`** signals whether the user is actively at their host machine (0–2 min = active typing; >15 min = away). **`working_on.week_commit_topics`** gives Sonnet a shorthand for current focus without scanning raw commit titles.

If the snapshot fails (empty/invalid JSON), log `run:error:no_situation` to `hum-runs.jsonl` and exit.

## Step 2 — Topic harvest (parallel, one shell call)

```bash
SIT=$(${MERLIN_HOME}/bin/merlin hum situation --json 2>/dev/null)
echo "$SIT" | node ${MERLIN_HOME}/agent/scripts/hum-harvest-all.mjs
```

The wrapper reads `data/hum-interests.json`, builds the unified context bundle (see Step 2b), fans out to every enabled harvester, and returns:

```json
{
  "candidates": [
    {"topic","signal","urgency","freshness_min","dedup_key","supporting_data"},
    ...
  ],
  "meta": {"attempted": [...], "skipped_cadence": [...], "errors": [...]}
}
```

Art/music/dining/crossref harvesters can call a `claude -p` Sonnet subagent with WebSearch or hit `context-search` (150s budget). Fast harvesters <15s. They run in parallel; wall time ≈ slowest.

## Step 2b — Context bundle (unified knowledge access)

Each harvester receives `{situation, context}` on stdin. The `context` object is produced by `lib/merlin-context.js` (`merlin context --json`) and carries:

```json
{
  "profile":   { /* user profile fragments — household, residences, recurring people */ },
  "tastes":    { /* preference domains — art, food, music, etc. */ },
  "projects":  { /* active projects + their current focus */ },
  "knowledge": { "calendar", "tasks", "email", "photos", "notes", "imessage", "slack",
                 "location", "watchlist", "weather", "supabase", "memory_files", "hum_learnings" },
  "recent":    { "today_commits", "today_triage", "recent_learnings", "counts" }
}
```

This is how hum leverages **everything Merlin knows** — harvesters read `context.tastes[domain]` for preferences, `context.projects` for active priorities, `context.knowledge[source]` for how to reach additional data, `context.recent.recent_learnings` for preference dedup. Adding a new data source = one entry in `lib/merlin-context.js` + optional lazy fetch in `recent`. Harvesters don't change.

`profile`, `tastes`, and `projects` ship empty in the public repo — populate them by adding `user_*`, `project_*`, and `reference_*` pages to your wiki/memory corpus; `merlin-context.js` pulls them at runtime.

## Step 3 — Haiku ranking + decision

Launch a Haiku subagent via the `Agent` tool with `model: haiku`. Build the brief below and pass it as the prompt. Haiku emits one JSON object.

Rank is a bounded scoring + JSON-output job — no multi-step reasoning, no tool calls. Haiku 4.5 handles it at ~5x lower per-token cost than Sonnet (switched 2026-04-23 as part of token audit). If the decision quality regresses (more bad pings, more quiet_window misses visible in hum-review), revert this line to `model: sonnet` and flag the outcome in nightly-review.

### Decision logic (pass to the rank subagent)

```
You are ranking candidate findings for the user's hum tick. One shot — no follow-up calls.

SITUATION (where/environment/time/now/next/working_on):
<inject situation JSON>

CONTEXT (compact — tastes + active projects + recent learnings; do NOT inject the full merlin-context bundle):
<inject { tastes: context.tastes, projects: context.projects, recent_learnings: context.recent.recent_learnings } only>

CANDIDATES (harvesters already ran):
<inject candidates array>

RECENT RUNS (last 24 from hum-runs.jsonl, for dedup):
<inject recent runs>

FEEDBACK (last 14d reactions — bias signal):
<inject hum-feedback.jsonl tail>

LEARNINGS (last 30d answered questions — do NOT re-ask these):
<inject hum-learnings.jsonl tail>

TASK: choose exactly one action.

Use CONTEXT to make relevance specific — when a candidate mentions art, weigh it against `context.tastes.art`; when a candidate is about a restaurant, check `context.tastes.restaurants` + `context.tastes.food`. `context.projects` lists active priorities that deserve lower-bar surfacing. If a candidate would benefit from data you don't have (profile details, knowledge-base entries, etc.), lower its confidence rather than guess — rank cannot make tool calls.

Scoring: for each candidate, compute
  score = urgency * 0.5 + relevance * 0.3 + freshness_bias * 0.2
where
  relevance is your natural-language judgment of how well the candidate fits SITUATION right now
  freshness_bias = 1 if freshness_min <= 30, 0.5 if <= 180, else 0.2

Pick the winner. If winner.score < 0.45 → silent.
If the winner is best expressed as a question (event just ended, preference worth capturing) → question.
Otherwise → info.

The threshold defaults to 0.45 (permissive). Silent is still right for genuinely low-signal ticks; it is NOT right when the top candidate is a legit finding you'd hesitate over. To make hum quieter, raise the threshold in `data/hum-state.json` (`config.score_threshold`). To make it more vocal, lower it.

Output EXACTLY one JSON object, no prose:

  {"decision":"silent"}

  {"decision":"info","text":"<≤5 lines, Merlin voice, URLs on own lines>",
   "subject":"<kebab-case>","rationale":"<one sentence>",
   "urgency":"low|med|high","based_on_topic":"<topic>"}

  {"decision":"question","text":"<≤3 lines, specific, curious>",
   "subject":"<kebab-case>",
   "memory_hook":"show_preference|restaurant_preference|event_recap|project_insight|general_preference|person",
   "rationale":"<one sentence on the future decision this sharpens>"}

HARD RULES:
- **TOPIC PRIORITY OVERRIDE (optional):** If the user has declared a specific topic as a high-priority focus (e.g. a habit they're trying to lock in, a deadline they're working toward), the ranker can enforce a per-topic override: when a candidate from that topic clears its harvester's gates, it becomes the winner unless another candidate represents a true safety/financial emergency or an imminent meeting the user must leave for right now. Configure via `data/hum-priority-topics.json` (`{topic: <name>, until: <date>, reason: <string>}`). Without this file, all topics compete on score alone.
- When the winner clears the 0.45 threshold and isn't a repeat/learning collision, SEND IT. Do not self-impose rate limits ("too close to the last ping", "already 2 pings today") — the min-interval gate and daily cap were intentionally removed (see note below) and you must not reinstate them via judgment. the user wants more flow; trust the threshold.
- Silent is only correct when: no candidate clears 0.45, OR the winner duplicates LEARNINGS / RECENT RUNS, OR a quiet-window / active-event rule fires.
- NEVER ask about a subject that appears in LEARNINGS (already answered).
- NEVER repeat a subject from RECENT RUNS.
- If SITUATION shows an active event (calendar now, speech+music audio, in-motion), only urgent-urgent info is legitimate. Questions about an in-progress thing only at its end.
- If SITUATION.next.upcoming_events contains an event starting within 30 min that requires the user to leave (location != current where.place), the ONLY legitimate info is the travel/departure nudge — suppress every other candidate unless it's truly catastrophic.
- Respect SITUATION.now_activity.at_desk_min: when 0-2 (active typing), prefer info relevant to working_on.week_commit_topics. When >15 (away), less about code, more about the thing he's doing.
- Prefer candidates whose topic matches what the user is working on today (working_on.today_commits / week_commit_topics) or where they are right now.
- Respect FEEDBACK bias: topics with repeated 👎/💤 face a higher bar. Topics with 👍/more get lower bar.

QUIET WINDOWS (soft defer — allow urgent, hold the rest):
The following windows in the user's local timezone (`SITUATION.time.local_hour` + minutes) are quiet. During a quiet window, DOWNGRADE any finding whose `urgency != "high"` to `{"decision":"silent"}` with rationale starting `quiet_window_defer:` so hum-review sees it. Urgency=high (time-sensitive, a deadline approaching, a reply needed, an imminent departure, a safety/financial issue) still sends — the windows do not block urgent.

Quiet-window entries are user-configurable. Examples to copy/adapt (drop into `data/hum-quiet-windows.json` or hard-code here):

- `12:00-13:30` — lunch
- `20:00-22:00` — evening unwind / family time
- Recurring-meeting windows — read a state file written by an upstream meeting watcher; quiet from N min before the meeting starts to N min after it ends.
- Activity-conditional windows — defer ONLY when `SITUATION.where.activity` matches a specific pattern (e.g. `walking` between 17:00–18:30 because the user usually walks after work; if they're at the desk in that window it's NOT quiet).

Outside configured windows (and outside the hard sleep window enforced by `trigger-hum.sh`), no window-based defer applies — score threshold is the only gate.
```

## Step 4 — Execute decision + write the tick trace

Every tick — silent, info, or question — writes ONE enriched line to `hum-runs.jsonl`. This is the only artifact `hum-review` uses to measure performance, so completeness matters.

### Tick trace schema (write to `hum-runs.jsonl`)

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
    "candidates": [
      {"topic":"<t>","urgency":<n>,"freshness_min":<n>,"signal":"<first 120 chars>"},
      ...
    ]
  },
  "sonnet": {
    "decision": "silent|info|question",
    "subject": "<kebab-case>" | null,
    "based_on_topic": "<topic>" | null,
    "score": <n>,
    "rationale": "<one sentence>",
    "silent_root_cause": "no_candidates|all_below_threshold|recent_runs_dedup|quiet_window|protected_event|pending_question_active|rate_limited" | null,
    "near_miss_candidates": [
      {"topic":"<t>","score":<n>,"signal":"<first 80 chars>"}
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

Even on errors, write a trace row with `sonnet.decision: "error"` and `harvest.errors` populated so the review sees it. No tick produces silence; silence is a recorded decision.

### `silent`

1. Write the tick trace with `outcome.sent: false`. **Always populate `sonnet.silent_root_cause`** with the structured enum (one of: `no_candidates`, `all_below_threshold`, `recent_runs_dedup`, `quiet_window`, `protected_event`, `pending_question_active`, `rate_limited`) — this is the signal hum-review uses to flag ideation gaps. **Always populate `sonnet.near_miss_candidates`** with the top 3 candidates that came closest to firing (even if they all bottomed out below threshold) so retrospective analysis can see what the harvester proposed. There must always be something to review — silence is a recorded decision with diagnostics, not an absence of data.
2. Update `state.last_run_at`.
3. **Reservoir refill trigger:** if `state.silent_streak` (count of consecutive silent ticks since last `info`/`question` ping) hits 6 (≈2 hours at the 20-min cadence), dispatch a fresh `HUM IDEATION` run via webhook (`POST localhost:9092` with `{"task":"HUM IDEATION","source":"silent-streak-refill"}`) and reset the streak counter to 0 to avoid re-dispatching every tick. The cron-scheduled 4x/day baseline still fires; this is an extra refill when the live signal has gone cold. Long silent streaks usually mean the reservoir lacks fresh winners — re-generate before lowering thresholds.

### `info`

1. Out of the box, no min-interval gate and no daily cap. The hard sleep window (configurable in `trigger-hum.sh`) is the only built-in rate-limit. Non-silent findings proceed to send. If you want to re-introduce rate-limiting, set `state.min_ping_interval_minutes` > 0 — it is respected only when urgency != "high".
2. Send + log in one step via `${MERLIN_HOME}/bin/hum-ping`:

   ```bash
   printf '%s' "<text>" | ${MERLIN_HOME}/bin/hum-ping \
     --ping-id "<p-YYYYMMDD-HHMM-hex>" \
     --lane "<lane>" \
     --score "<score_at_ping>" \
     --findings '<JSON array of candidates>' \
     --suppress-hook --message-from-stdin
   ```

   `hum-ping` atomically (a) posts the message to `merlin_messages` via `merlin-send-curl --capture-id`, (b) appends the feedback row to `hum-feedback.jsonl` with the captured `message_id` under an advisory lock, (c) for advisory lanes, computes a canonical `subject_key` per finding and appends a `surfaced` event to `suggestion-history.jsonl`. There is no way to land the ping on the phone without its feedback row. Do not call `merlin-send-curl` directly for info pings.

   **Exit code 7 — pre-send filter blocked the headline.** Before sending, `hum-ping` checks the headline finding's `subject_key` against `suggestion-history` via `shouldFilter()`. If the subject was previously rejected (e.g. the user thumbs-downed it, or their free-text reply was classified as a price/already-seen/explicit-no rejection), `hum-ping` exits with code 7 and writes nothing — no `merlin_messages` insert, no `hum-feedback` row, no `surfaced` event. Treat this as a recoverable silent: write the tick trace with `decision: "silent"`, `silent_root_cause: "history_blocked"`, and `near_miss_candidates` populated so `hum-review` sees what was dropped. This is the safety net — the harvester's recall block + post-search filter should have caught it earlier; if exit-7 fires repeatedly, the harvester wiring needs investigation.

3. Update `hum-seen.json` (subject key), `state.last_ping_at`, and `state.today.pings += 1`. `hum-feedback.jsonl` is handled by `hum-ping` in step 2 — do not append to it here.
4. **If `sonnet.based_on_topic == "ideas"`**, mark the source idea consumed so it doesn't surface again: `${MERLIN_HOME}/bin/hum-mark-idea-consumed <idea_id> <ping_id>` — where `idea_id` is the `dedup_key` of the winning candidate (same as `supporting_data.idea_id`). This closes half of the reinforcement loop; the reaction half is closed by `merlin hum feedback` (see `system/hum-ideas-reservoir.md`).
5. Write the tick trace with `outcome.sent: true` and `outcome.ping_id`.

### `question`

1. If an unexpired pending question exists in `hum-pending-question.json`, downgrade to silent with `downgrade_reason: "pending_question_active"`. Write the trace.
2. `id = q-YYYYMMDD-HHMM-<4hexchars>`.
3. Send via `merlin-send-curl --suppress-hook`.
4. Write `hum-pending-question.json` with `{id, asked_at, question, subject, memory_hook, rationale, expires_at: asked_at + 15min}`. (Policy 2026-04-30: 15 minutes, down from 2h. If the user doesn't reply within 15 min, the question wasn't important enough to block subsequent pings — let other signal land. the user can always answer later as a fresh message; chat-agent will route past-expiry replies as a regular command, not a stale answer.)
5. Update `state.today.questions += 1`.
6. Write the tick trace with `outcome.sent: true` and `outcome.question_id`.

Always update `state.last_run_at`. Reset daily counters at local midnight.

## Question → answer loop (chat-agent side)

Chat-agent reads `hum-pending-question.json` on every inbound, calls `${MERLIN_HOME}/bin/hum-answer <id> "<answer>"`. See `agent/CLAUDE.md` "Pending-Question Recognition."

### Realtime location-edge triggers (added 2026-04-16)

Phone-channel subscribes to `location_history` via Supabase realtime. When the user arrives at or departs from a visit, phone-channel POSTs `{job: "hum", trigger: "location-edge", edge: {event, row_id, place_name, lat, lon, arrived_at, departed_at}}` to the ops-supervisor webhook.

The trigger lands here as a **normal hum tick** — this playbook runs end-to-end. The realtime edge is just a reason to tick sooner than the 20-min cron cadence. The situation snapshot already reflects the new visit (Step 1 queries `location_history`), so the `location_context` harvester naturally picks up the fresh edge. The edge's urgency (0.75 for in-progress / arrivals / departures vs 0.5 retrospective) bubbles it to the top of Sonnet's ranking when appropriate — a boring arrival at Home still loses to other candidates or silent default.

Phone-channel pre-gates the dispatch (sleep window, edge dedup per row_id 30 min, active pending question) so this playbook rarely wastes a tick on already-answered state. The `trigger` and `edge` fields in the webhook payload are currently telemetry-only (not injected into Sonnet's brief) — the data reaches the pipeline via `location_history` in Supabase.

### `location_context` lane (added 2026-04-16)

Harvester `location_context.mjs` watches for **state-change moments** — the user just arrived at a visit, just departed a visit, or is in-progress walking. These edges are the best time to ask because he's at a decision point and the answer can still shape action (route, invite, navigate, remember).

Priority order within the harvester:
1. **Just arrived** (visit.arrived_at within last 10 min) → "At [place]?" (guesses place_name / nearest named)
2. **Just departed** (visit.departed_at within last 10 min) → "Heading to [calendar event]?" if a physical event is within 45 min; else "Left [place] — where are you going?"
3. **In-progress walk** (started <15 min ago, still walking) → "Out for your morning walk?" when pattern matches a known recurring habit
4. **Just-finished walk** (ended <20 min ago) → retrospective yes/no fallback

Emits yes/no when a hypothesis fits; falls back to an open question otherwise. On confirmation, chat-agent calls `location_annotate` with the pre-filled `annotate_on_yes` payload; `scan_similar_on_yes: true` (set only for recurring habits, e.g. the user's daily walk pattern) also retroactively tags past matching walks.

Cadence: 18 min (matches hum's 20-min tick). Dedup keys are per-edge-event or per-walk-start so the same transition isn't asked twice. See `chat-agent/CLAUDE.md` "Replies to the `location_context` hum question" for the parsing heuristics.

## Guardrails

Hum NEVER:
- Sends email, drafts replies, creates Google Tasks, labels email
- Books reservations, buys tickets, touches money
- Modifies files outside `data/hum-*` and memory routing via `hum-answer`
- Responds to the user's phone messages (chat-agent's job)
- Runs its own web searches outside the art/music subagent harvesters

## State files

| Path | Purpose |
|---|---|
| `data/hum-state.json` | daily counters, min-ping-interval, max-pings-per-day |
| `data/hum-interests.json` | topic registry (editable config) |
| `data/hum-interests-state.json` | per-topic `last_run_at` / `last_signal_at` |
| `data/hum-cache/<topic>.json` | per-topic harvester cache |
| `data/hum-seen.json` | per-subject dedup |
| `data/hum-feedback.jsonl` | reactions |
| `data/hum-runs.jsonl` | append-only decision log |
| `data/hum-pending-question.json` | single pending question (15min TTL) |
| `data/hum-learnings.jsonl` | append-only answer log |
| `data/suggestion-history.jsonl` | cross-lane append-only ledger of every advisory suggestion + the user's response (tapbacks, free-text rejections, visits). Read by every advisory harvester via `lib/suggestion-recall.mjs`; written by `hum-ping` (surfaced events) and `phone-channel/suggestion-classify` (reaction events). See `system/architecture.md` 2026-05-04 entry for the full design |

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
