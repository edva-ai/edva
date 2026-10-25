HUM REVIEW — Weekly comprehensive self-assessment of the hum subsystem.

> **This instance's additions** to this playbook (its own people, places and decisions) are in `agent/local/jobs/hum-review.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (an ephemeral or by-hand run), `Read` that file before you start.

Runs Sundays at 09:30 local. Examines every aspect of hum — what we built, what we're trying to achieve (intent), how it's actually working — scores against the declared intent, and proposes tuning only where reality diverges from intent. Analysis only; never applies changes.

**Ideation now lives in `hum-improvement-ideation.md`** (also Sundays 09:30 local via a separate cron; the two run in parallel after 2026-05-20). hum-review continues to grade against `hum-intent.md` and produce the comprehensive memo; hum-improvement-ideation produces the concrete improvement-ideas file consumed by `self-improvement-executor`. Where this playbook used to embed "propose tuning," it now defers to that playbook. Don't duplicate ideas in both files — write the grade here, write the proposals there.

**Primary KPIs are now `signal_per_surfaced` + `surface_rate`** per `data/hum-improvement-loop.md`. The metrics below remain as secondary diagnostics. Read both `hum-intent.md` AND `hum-improvement-loop.md` before grading.

## Critical rules

1. **Read-only.** Never modify hum state files, memory files, or config. Proposals only in the email; the user applies.
2. **Intent-driven.** Every metric reported must tie back to a criterion in `data/hum-intent.md`. If a criterion isn't in the intent file, you aren't allowed to grade against it — add a proposal to update the intent file instead.
3. **Silent-on-empty.** If fewer than 20 tick traces in the 7-day window, send a short "not enough data" email and exit.
4. **One email, one phone ping.** Sent to the user's address via `email-send` plus a one-line Edva notification that the review is ready.

## Step 1 — Load the north star

Read `data/hum-intent.md` — this is the contract. Quote the success-criteria table, the anti-patterns list, and the operating-assumptions list verbatim in the memo. Every section in the output refers back to a specific intent item.

## Step 2 — Data harvest (ONE parallel batch)

Issue all in a single parallel turn:

1. `data/hum-runs.jsonl` — last 7 days of tick traces (enriched schema)
2. `data/hum-feedback.jsonl` — reactions
3. `data/hum-learnings.jsonl` — answered questions + routed memory hooks
4. `data/hum-pending-question.json` — current state
5. `data/hum-state.json` — daily counter history
6. `data/hum-interests.json` — topic registry (changed during the week?)
7. `data/hum-interests-state.json` — per-topic last_run_at / last_signal_at
8. `edva hum insight --since 7d --json` — pre-computed aggregate (fast path)
8a. `edva hum reactions --since 7d --json` — per-lane reaction-rate (added 2026-05-20). Surfaces `lanes[lane].decay` ∈ {`low_engagement`, `mostly_negative`, null} so the review can call out specific topics that are silent or actively disliked. Use this to populate a "lane decay" section in the email when any lane is flagged.
9. `git log --since="7 days ago" -- agent/ops-agent/jobs/hum.md agent/scripts/hum-harvesters/ bin/edva data/hum-interests.json data/hum-intent.md` — what we built or changed this week
10. **Memory growth — measure the WIKI, not the retired flat files.** hum consolidation (`hum-consolidate`) writes durable answers into the general wiki now, not the 6 hardcoded flat files (4 of which don't even exist, so `wc -l` always read 0 — the perennial false FAIL). Measure hum-attributable memory growth this week as the SUM of: (a) wiki pages created or updated in the last 7 days — `~/Dev/edva/bin/wiki list --json` and count entries whose `updated_at` (or `revised_at`) falls in the window; if the CLI doesn't expose timestamps, fall back to `wiki search` over the week's hum subjects, or query `pages.updated_at` in memory-index.db directly; plus (b) rows added to `hum-learnings.jsonl` in the window (answered questions) and consolidated rows in `hum-responses.jsonl` — the direct hum→memory contribution. Report both components. Do NOT `wc -l` the old flat files.
11. `agent/logs/watchdog.log` grep `[hum:` — dispatch-level skip reasons
12. Structural-validity scan of `hum-runs.jsonl` — count rows lacking `sonnet.decision` (legacy schema; ignore for metrics but count for completeness)

## Step 3 — Score every intent criterion

For every row in the success-criteria table, report the measurement and `PASS` / `FAIL` / `N/A`. **This is computed in code — do not re-derive it.** `edva hum insight --since 7d --json` (Step 2 item 8) returns a `criteria[]` array with `{criterion, value, target, status, detail?, note?}` for every row below (since 2026-10-04). Quote its values and statuses verbatim. Only rows with `status: "MODEL"` need you: **Memory growth** (the CLI counts `hum-learnings.jsonl` rows; add the wiki half from Step 2 item 10), **Attention hit-rate** and **LLM-invocation efficiency** (they need the situation fields / `watchdog.log` judgement the CLI does not read). The table stays here as the definition of what the code computes.

| Criterion | Measurement | Target |
|---|---|---|
| Silent rate | `count(sonnet.decision=="silent") / total_ticks` | ≥ 0.85 |
| Info positive rate | `count(reactions in {👍,helpful,more}) / count(reactions)` | ≥ 0.60 |
| Info response rate | `count(feedback rows with non-null reaction) / count(info sent)` | ≥ 0.30 |
| Question answer rate | `count(learnings in window) / count(questions asked)` | ≥ 0.40 |
| Median time-to-answer | median `answered_at - matching question.asked_at` | ≤ 30 min |
| Memory growth | hum-attributable wiki writes this week (wiki pages updated in-window + new `hum-learnings.jsonl`/consolidated `hum-responses.jsonl` rows) — NOT the retired flat files | ≥ 3 per week |
| Subject dedup | count subjects appearing in >1 tick within 7d | = 0 |
| Harvester error rate | per-topic `errors / attempts` | ≤ 0.10 |
| Attention hit-rate | `info pings with based_on_topic matching week_commit_topics OR next.upcoming_events OR 👍-history / total info` | ≥ 0.70 |
| LLM-invocation efficiency | `bash-gated skips (watchdog.log) / total tick attempts` | ≥ 0.40 |

## Step 4 — Anti-pattern scan (zero tolerance)

Walk the intent file's "Anti-patterns (hard no)" list. For each, scan the week's pings and questions. Flag every violation with tick_id + subject + exact rule broken.

1. Restated visible info (weather/calendar/tasks surfaced without added judgment) — scan info pings for low-value content
2. "How was your X?" for routine events — scan question subjects against a routine list (commute, standing meetings, doctor, coffee)
3. Asked a question whose subject appears in `hum-learnings.jsonl` within 30d
4. Pinged during a protected window without `urgency: high`
5. Ignored `next.upcoming_events` within 30 min requiring travel
6. Low-information pings (subjective judgment — spot-check 3 downvoted subjects)
7. Repeated a topic with 👎/💤 reaction in last 14d without cool-off

Each violation = a proposal in Step 7.

## Step 5 — Verify operating assumptions

For each assumption in the intent file, do a spot-check. Mark `VERIFIED` / `FAILED` / `NOT-CHECKED`.

- **HID at-desk signal real**: sample 3 random ticks where `situation.at_desk_min: 0` — were phone-channel inbound messages absent for ±5 min? (inbound activity = the user NOT at the Mac)
- **Calendar authoritative**: any tick where `situation.next.upcoming_event` was null while chat-agent logs mentioned a meeting in the same window?
- **Timezone correct**: check a protected-window skip tick; does `situation.time.local_hour` match the user's expected local time based on recent `user-timezone.json`?
- **Find My fresh**: ticks where `situation.where.place` null for >3 consecutive ticks with evidence of movement elsewhere?
- **Memory = source of truth**: any answered question whose subject was already documented in a memory file before the question was asked?
- **Push reliability**: compare `outcome.sent: true` count to `hum-feedback.jsonl` entries — should be 1:1

## Step 6 — Aspect-by-aspect review

Narrative, one subsection per dimension. Each references metrics from Step 3 and findings from Steps 4–5.

### 6a. What we built this week (Step 2 #9)
Commits touching hum itself. Registry diff vs last week. Intent-file edits. Purpose: remind the user of the system's shape as it evolves.

### 6b. Attention & situation quality
- How often were situation fields populated vs missing?
- Did `next.upcoming_events` suppress non-urgent candidates correctly? Cite tick_ids.
- `at_desk_min` distribution — does it match the user's believed schedule?
- `week_commit_topics` stability — did Sonnet use them?

### 6c. Harvester health
- Per-topic hit rate table (wins ÷ candidates).
- Zero-win topics — propose cadence widening or disabling.
- Per-topic error rate (Step 3 criterion) — any > 10% → propose a specific harvester fix citing the error message.
- Cadence effectiveness: for each topic, `skipped_cadence` count vs `attempted` count. Heavily-skipped topics may need `active_window` loosening.

### 6d. Ranker quality (Sonnet)
- Score distribution (median, p10, p90). Is 0.55 separating real wins?
- False-negative hunt: ticks where silent was chosen but a candidate had `urgency ≥ 0.75` — spot-check 3, quote `sonnet.rationale`, judge.
- False-positive hunt: info pings that got 👎 or no reaction — quote rationale, propose why Sonnet misread.
- Relevance check: sample 3 info pings; did the signal actually match `situation`?

### 6e. Questions & memory growth
- Answer rate + time-to-answer (Step 3).
- Memory growth: N wiki pages created/updated this week + M new answered-question / consolidated hum rows (Step 2 #10). The per-flat-file breakdown is retired — content lands in the wiki now.
- Per-hook answer rate — which hook types are earning their keep, which are dead?
- Sample 3 answered questions: are their routed memory entries specific enough to sharpen a future decision, or too vague?

### 6f. Reactions & topic bias
- Top 3 subjects with 👍/helpful/more → "lean into these." Quote exact subjects.
- Top 3 subjects with 👎/💤 → "back off." Propose a cool-off or per-topic urgency-bar increase.
- Any subject repeated despite a negative reaction → rule violation (Step 4).

### 6g. Cost & efficiency
- LLM-invocation efficiency (Step 3).
- Art/music subagent invocation count — verify daily cadence holds (should be ~7 runs each per week, not 72).
- Stocks harvester — verify cheap-skips during closed markets (count early-exit vs full-run).

## Step 7 — Propose tuning (cited, copy-pasteable)

**Every proposal must cite a failing metric or rule violation from Steps 3–5.** No free-floating suggestions.

Format each:
```
Proposal N — <one-line change>
Rationale: <metric + number>. <why this fix follows from that number>.
Edit: <file path>:
  <key>: <old value> → <new value>
Risk: <single sentence on what could go wrong>
```

If the proposal retires a harvester or topic:
```
Proposal N — Disable "X" topic
Rationale: 0 wins / 14 candidates over the last 4 weeks; dominant error = <message>.
Edit: data/hum-interests.json → topics[].enabled = false for "X"
Risk: lose coverage of that interest; re-enable if the user asks.
```

## Step 8 — Compose memo

HTML email to `/tmp/hum-review-<YYYY-MM-DD>.html`. Phone-readable; no emojis. Any external URL referenced in the body goes through `~/Dev/edva/bin/og-card` — see ops-agent CLAUDE.md → "Use og-card for every URL in outbound email". Structure:

```
HUM WEEKLY — <YYYY-MM-DD>

INTENT (quoted from hum-intent.md)
<short paragraph on purpose>

SCORECARD
<table: criterion | target | actual | result>

WHAT WE BUILT THIS WEEK
<commit summaries, registry diff>

ATTENTION & SITUATION QUALITY
...

HARVESTER HEALTH
<per-topic table: candidates | wins | errors | hit% | err%>

RANKER QUALITY
...

QUESTIONS & MEMORY GROWTH
<per-hook table, sampled answers>

REACTIONS & TOPIC BIAS
...

COST & EFFICIENCY
...

ANTI-PATTERN VIOLATIONS
<list — zero is success>

OPERATING-ASSUMPTION CHECK
<assumption | status>

PROPOSED TUNING
1. ...
2. ...
```

Send:
```bash
~/Dev/edva/bin/email-send \
  --to <the user's address> \
  --subject "Hum weekly — <YYYY-MM-DD>" \
  --body-file /tmp/hum-review-<YYYY-MM-DD>.html \
  --html

~/Dev/edva/bin/edva-send-curl "Hum weekly review emailed — <one-line top finding>"
```

## Step 9 — Persist state for next review

Write `data/hum-review-prev.json`:
```json
{
  "reviewed_at": "<ISO>",
  "memory_growth": { "wiki_pages_updated_7d": <n>, "hum_learnings_7d": <n>, "hum_responses_consolidated_7d": <n> },
  "registry_snapshot": <entire data/hum-interests.json>,
  "intent_hash": "<sha256 of hum-intent.md>",
  "proposals_made": [
    {"id": 1, "text": "...", "cited_metric": "silent_rate=0.72", "status": "pending"}
  ]
}
```

Next week's review diffs memory sizes, compares registry (was a proposal adopted?), and checks whether the intent file changed (`intent_hash` diff).

## Edge cases

- **First run / no data**: short email ("Hum weekly — first run, <N> ticks, need ≥20. Next week will be comprehensive."), exit after minimal state write.
- **Intent file missing**: abort with one system-channel line (`edva-send-curl --channel system --skip-precheck --intent hum-review "⚠️ hum-review: data/hum-intent.md missing, no memo this week"`), not a chat message. Don't send a memo.
- **All tick traces legacy schema**: treat as no-data, note in memo, wait for new-schema week.
- **Pending question mid-review**: quote subject; do not clear or alter.
- **Previous-week state file missing**: run the review without growth numbers; note "first baseline."
