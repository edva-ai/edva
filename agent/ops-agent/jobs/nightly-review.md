SELF IMPROVEMENT REVIEW — Weekly holistic system self-assessment and improvement memo.

> **This instance's additions** to this playbook (its own people, places and decisions) are in `agent/local/jobs/nightly-review.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (an ephemeral or by-hand run), `Read` that file before you start.

Runs weekly Tuesday at 5:00 AM local (moved from 3:00 AM on 2026-10-22, the user's decision: yesterday's daily summary is written at 4:00 AM, so a 3:00 run read a day that did not exist yet). Analyzes the prior 7 days of conversations, email triage, pulse activity, system health, and external ecosystem developments. Every section should include concrete suggestions for making Edva smarter, faster, and more helpful. Ends with a prioritized action item list.

**Runtime (2026-07-28).** This job no longer runs on the ops supervisor. It runs as a dedicated ephemeral `claude -p --model $EDVA_MODEL_OPUS --effort xhigh` (`claude-opus-5-5` since 2026-10-06; id pinned in `agent/config/models.env`) launched by the **`ai.claude.improvement-review` launchd user agent** (not cron — cron can't unlock the keychain holding the Max credentials), via `agent/scripts/lib/run-ephemeral-opus.sh`. The user's standing rule is that every improvement-related process runs on the Opus tier — the heavy supervisor has run `claude-sonnet-5` since 2026-07-02, so `"model": "opus"` in `job-routing.json` (a tier label, not a model id) had this running on Sonnet.

**What happens after you finish (2026-07-28).** On a clean exit the trigger chains **`improvement-plan`**, which reads the state file you write and turns your ACTION ITEMS into Face-ID cards in the Improvements channel — the loop the user used to close by hand. Two consequences for how you work: (a) **Step 4d/6 state is now load-bearing for a downstream job, not just for next week** — an action item that never lands in `suggestions[]` is one the plan pass will never see; (b) **write each item concretely enough to be built from** — what is wrong, which files, how you would verify a fix. A vague item ("improve error handling in triage") gets dropped by the plan job's Step 3 rather than becoming a card. The email is unaffected and still goes out; the cards are additive.

**Cadence note (file name is historical).** Job is still named `nightly-review` for repo-stability — every state file (`nightly-review-state.json`), trigger script (`trigger-nightly-review.sh`), webhook task (`NIGHTLY REVIEW`), and supervisor reference uses that name and renaming would touch dozens of call sites. Treat the name as a label, not a cadence claim. Wherever the playbook below says "today", "tonight", "this run", etc., interpret it as "the prior 7 days since the last review". Wherever it says "yesterday" (`YDAY`) in a per-day walk (Daily Log accuracy, Live-Day Accuracy Verification), walk that step once for each of the 7 days T-1 → T-7 (oldest first), and dedup against `daily_log_drift[]` so already-reviewed dates don't re-emit findings.

## CRITICAL RULES

1. **This review analyses and classifies; it does not implement (2026-09-29, rubric schema v4).** It never modifies the live repo. Every action item is classified in Step 4, and the chained `improvement-plan` job — which runs the moment this one exits — gives each one a disposition: applied automatically (`self-improve-auto-apply`, for low- and moderate-risk changes that touch nothing high-blast-radius), filed as a Face-ID card (`self-improve-request`, for complex or high-blast-radius ones), asked of the user, or dropped with evidence. Until 2026-09-29 this review also drafted and carded items itself in Step 4b, which duplicated the plan job's cards and was skipped three weeks running for exactly that reason; that step is retired. This playbook, `improvement-plan.md`, `self-improvement-executor.md`, `system-issue-review.md` and the rubric are all recursion-guarded — nothing in the pipeline may draft a change to them.
2. **Safe changes land on their own; Face-ID cards are for complex, high-blast-radius ones (since 2026-09-29, rubric schema v4).** `self-improve-landing.mjs` decides from the real file set, not from your risk label: a low- or moderate-risk change that touches no high-blast-radius path lands through `self-improve-auto-apply` (a green check in Improvements, listed under APPLIED AUTOMATICALLY), and everything else waits for their Face ID. (Until 2026-10-22 this rule still said nothing lands without Face ID, which stopped being true on Sept 29.) The only items that skip both and stay in the email's ACTION ITEMS section for a YES/NO/LATER reply are the recursion-guard/FORBIDDEN exclusions and multi-option architectural choices (§ Step 4a) — those need a human decision before any draft can exist at all.
2b. **A proposed fix keeps kernel files generic** (`agent/CLAUDE.md` § Kernel boundary). When an action item's `change` touches a file listed in `system/kernel-manifest.json`, describe it so the personal part lands in its own home: the incident and the dates in the changelog entry and commit message, this installation's rules in `agent/local/`, its values in `agent/local/config/`, its behaviour in an `_ext/` hook. `improvement-plan` implements it that way, and `self-improve-auto-apply` refuses (exit 8) a change that puts personal data in a kernel file or leaves a new file unclassified.
3. **Never send email to anyone other than the user's own address.**
4. **No tool-call budget.** This review is one of the two most important jobs the system runs (the other is named in this instance's additions). Take as many tool calls as the analysis genuinely needs — re-query, cross-check, dig into anomalies, iterate until the picture is honest and the suggestions are solid. Parallel batches are still preferred for latency, but not because there's a cap. Quality of insight is the only thing that matters here; throughput and cost are not constraints.
5. **Web research is scoped.** Only search for Claude Code / Anthropic / agent-framework topics. No open-ended browsing.
6. **Freshness — verify before reporting.** Before including ANY issue, alert, or error in the memo:
   - Check git log: was it fixed by a subsequent commit? (`git log --oneline --all --grep="<keyword>"` or scan today's commits)
   - Check current system state: is the service healthy NOW? (`edva status`, health endpoints)
   - Check log recurrence: did the error repeat after the initial occurrence, or was it a one-time event that self-healed?
   - If an issue was already fixed or self-resolved, mention it ONLY as "resolved" context, NOT as an open action item.
   - Never report stale alerts as current problems. The user should only see issues that need attention RIGHT NOW.

## Step 1 — Load previous state

Read `~/Dev/edva/data/nightly-review-state.json`. If missing, initialize:
```json
{"schema_version": 4, "last_run": null, "suggestions": [], "patterns": {"frequent_asks": [], "automation_candidates": []}, "context_gaps": [], "skill_proposals": [], "daily_log_drift": [], "live_day_accuracy": []}
```

`daily_log_drift[]` (added 2026-04-30) tracks accuracy gaps from the previous day's daily-summary across nights so recurring mislabels become visible. See Step 3 § "Daily Log accuracy" for the full spec — each entry is `{date, centroid, expected_name, actual_name, source, signal, fix_status}`. A single drift entry from an authoritative signal (email/chat/late-confirm/unknown-answered) auto-promotes to `confirmed-stops.json`. **Since 2026-10-06 code writes most of these rows itself, at the moment the correction lands:** `location-confirm save-visit` (called by every user-confirmed `findme resolve` — hum asks, chat corrections, segment-ask taps) and `location-confirm save` (a card answer that is not the lead candidate) append `{…, visit_id, ref, recorded_at, recorded_by: "location-confirm"}` with `fix_status: auto_resolved` when the answer was promoted to `confirmed-stops.json` in the same step, `open` when it was not (an answer over 60 chars). Before that only this playbook wrote the ledger, by noticing corrections in a week of chat — which is why it recorded nothing from 2026-09-18 to 2026-10-05 while corrections kept arriving. Rows written this way are already handled; do not re-promote them, and dedup your own findings against `ref`/`visit_id`.

`live_day_accuracy[]` (added 2026-04-30) stores each day's `live-day accuracy` snapshot: `{date, interval_count, covered_min, resolution_rate, name_accuracy, corroborated_min, contradicted_min, unexamined_min, contradictions[], calendar_supports, calendar_missed, calendar_unmatched_physical, calendar_total_physical, calendar_accuracy, user_confirmed_share, coverage_gaps, resolution_gaps}`. **The `verified_correctness` / 99%-for-7-days target is RETIRED (2026-10-06, the user's decision on the 2026-10-06 review).** In 64 stored days it never produced a number — it depended on a drift ledger nothing in code wrote — and it had been reported as a programme for nine weeks. Do not compute, back-fill or report it, and do not run a streak. Older rows still carry `verified_correctness: null` / `drift_count_at_t_plus_7: null`; leave them, ignore them, and never treat them as a measurement. `live_day_accuracy_target_hit_at` is likewise dead. See Step 3 § "Live-Day Accuracy Verification".

Note which suggestions are `pending` (no response yet), `implemented` (YES), or `rejected` (NO). Do not re-suggest rejected items unless the situation has materially changed. Do not re-suggest pending items less than 7 days old.

## Step 2 — Batch data gathering (one parallel turn is preferred, but not a cap)

Issue the following as a **single parallel batch** when possible — not to stay under a budget, but because it's faster. If any query surfaces something that needs a follow-up (anomaly, gap, unexpected number), absolutely run the follow-up; don't suppress curiosity to fit into one turn.

   In every SQL query below, `<TZ>` is this installation's home time zone: `node ~/Dev/edva/lib/instance.cjs tz`.

1. **Supabase SQL** — phone conversations from the last 7 days:
   ```sql
   SELECT role, content, created_at FROM edva_messages
   WHERE created_at >= (now() AT TIME ZONE '<TZ>')::date::timestamptz - INTERVAL '7 days'
   ORDER BY created_at
   ```

2. **Bash** — email triage stats (last 7 days):
   ```bash
   ~/Dev/edva/bin/edva triage stats --since 7d 2>/dev/null \
     || ~/Dev/edva/bin/edva triage stats 2>/dev/null \
     || echo "no triage stats"
   ```

3. **Bash** — system health:
   ```bash
   ~/Dev/edva/bin/edva status 2>/dev/null || echo "status unavailable"
   ```

4. **Bash** — last 7 days of hum runs, selected by each row's own timestamp (`ts`, UTC ISO). Until 2026-10-22 this grepped for local date strings, which matched any row that merely mentioned a date (an upcoming event, a summary) and missed runs whose UTC stamp fell on the next day:
   ```bash
   SINCE=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)
   jq -c --arg since "$SINCE" 'select((.ts // "") >= $since)' ~/Dev/edva/data/hum-runs.jsonl 2>/dev/null | tail -100
   ```

5. **Bash** — last 7 days of hum feedback, by its own timestamp (`sent_at`, falling back to `ts`):
   ```bash
   SINCE=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)
   jq -c --arg since "$SINCE" 'select(((.sent_at // .ts) // "") >= $since)' ~/Dev/edva/data/hum-feedback.jsonl 2>/dev/null | tail -50
   ```

6. **Google Calendar** — list events for the prior 7 days (T-7 through T-1).

7. **Bash** — last 7 days of watchdog alerts. `watchdog.log` rotates at midnight into `watchdog-YYYY-MM-DD.log` and is then gzipped, so the live file holds only today; until 2026-10-22 this step read only it and saw about 3 hours instead of 7 days. Read every file touched in the last 8 days (`gzip -cdf` passes plain files through; macOS `zcat` cannot read `.gz`) and keep lines by their own leading timestamp (the host's local time):
   ```bash
   SINCE=$(date -v-7d '+%Y-%m-%d %H:%M:%S')
   find ~/Dev/edva/agent/logs -maxdepth 1 -name 'watchdog*.log*' -mtime -8 -print0 \
     | xargs -0 gzip -cdf 2>/dev/null \
     | awk -v since="$SINCE" 'substr($0,1,19) >= since' | sort \
     | grep -i "alert\|error\|fail\|restart\|crash\|disconnect" | tail -60
   ```

7b. **Bash** — last 7 days of supervisor incident signals. The 2026-04-18 hum outage added structured signals the supervisor emits on auth failures, hung turns, queue backups, hard rotations, and forced outer-watchdog kills. Use the `edva-logs` CLI to merge the sources and grep for named incidents:
   ```bash
   ~/Dev/edva/bin/edva-logs --last 7d --source ops,chat,launch \
     --grep "TURN WATCHDOG|AUTH ERROR|AUTH OUTAGE|QUOTA REFUSED|QUEUE ALARM|HARD ROTATION|STUCK|disp .* error|dispatch_error" \
     --no-color | tail -120
   ```
   Any non-empty match is a **current** incident unless the subsequent lines show recovery (e.g. an AUTH OUTAGE followed by `credentials refreshed — rotating session and resuming`). An auth outage with no recovery line = Max auth is still broken and the dispatcher is paused; cross-reference `/health` for `dispatcherPaused:true`. **`QUOTA REFUSED` is an outage too (2026-10-22):** the supervisors log it when the Max plan's usage limit refuses a turn and dispatch is held until the reset (`quota hold released` / `quota cleared` mark the end; `/health` shows `rateLimitHoldUntil`). Count each hold as an outage with its window, the same as an auth outage, and do not read a paused dispatcher as auth-only: it can mean the allowance is used up. A recurring TURN WATCHDOG on the same source is a playbook bug (tool call that hangs); flag it as a P1 action item.

8. **Bash** — git commits from the last 7 days:
   ```bash
   cd ~/Dev/edva && git log --oneline --since="7 days ago" --no-color 2>/dev/null || echo "no commits"
   ```

9. **Bash** — reclassified emails (triage corrections):
    ```bash
    ~/Dev/edva/bin/email-mem search "reclassified" --limit 30 2>/dev/null || echo "none"
    ```

10. **Bash** — full git log for the week (for cross-checking fixes against issues):
    ```bash
    cd ~/Dev/edva && git log --since="7 days ago" --no-color 2>/dev/null || echo "no commits"
    ```

11. **Daily Log inputs** — yesterday's summary + every drift signal needed for the Step 3 § "Daily Log accuracy" pass. Run as one parallel batch:

    - **Supabase** — yesterday's daily-summary row:
      ```sql
      SELECT date, narrative, wake_at, sleep_at, places_count, photos_count, key_events, resolved_day_json, updated_at
      FROM daily_summaries
      WHERE date = ((now() AT TIME ZONE '<TZ>')::date - 1)
      ```
      The `resolved_day_json` column is the snapshot the email was rendered from — drift detection compares that frozen state against current ground truth.

    - **Bash** — yesterday's episode file (markdown narrative as written):
      ```bash
      HOME_TZ=$(node ~/Dev/edva/lib/instance.cjs tz)
      YDAY=$(TZ=$HOME_TZ date -v-1d +%Y-%m-%d)
      YMONTH=$(TZ=$HOME_TZ date -v-1d +%Y-%m)
      cat ~/Dev/edva/data/episodes/$YMONTH/$YDAY.md 2>/dev/null || echo "no episode file"
      ```

    - **Gmail** — the user's reply to yesterday's "Day of" email (canonical correction channel; a reply saying a day email missed a stop is the prototypical case):
      ```
      mcp__claude_ai_Gmail__search_threads with query:
      from:<the user's address> to:<Edva's own address> subject:"Day of" newer_than:2d
      ```
      Get any matching thread's full content; classify the reply against the 6 drift signals in Step 3.

    - **Supabase** — chat corrections from today that retroactively reference yesterday:
      ```sql
      SELECT role, content, created_at FROM edva_messages
      WHERE created_at >= (now() AT TIME ZONE '<TZ>')::date::timestamptz
        AND role = 'user'
        AND (content ILIKE '%yesterday%' OR content ILIKE '%we were at%' OR content ILIKE '%I wasn''t at%' OR content ILIKE '%actually that was%' OR content ILIKE '%not%' AND content ~* '\\b(at|in)\\b')
      ORDER BY created_at
      ```
      Heuristic — the analysis pass disambiguates which messages are actual corrections vs. false matches.

    - **Bash** — `confirmed-stops.json` entries saved AFTER yesterday's resolve-day finalized. These are user answers that didn't make it into the email (reply arrived after 00:10 local, OR the chat-agent path was broken before today's fix). Each is a candidate for a silent re-render of yesterday's summary:
      ```bash
      YDAY_RUN_AT=$(jq -r '.resolved_day_json.generated_at // empty' <<<"$DAILY_SUM_ROW")
      jq --arg cutoff "$YDAY_RUN_AT" '[.[] | select(.ts > $cutoff)]' ~/Dev/edva/data/confirmed-stops.json
      ```

    - **Bash** — yesterday's `unknown_stops[]` from the frozen snapshot, plus today's confirmation state (have any been answered?):
      ```bash
      jq '.resolved_day_json.unknown_stops // []' <<<"$DAILY_SUM_ROW"
      jq '.' ~/Dev/edva/data/location-confirm-pending.json
      jq '.' ~/Dev/edva/data/location-confirm-recent.json 2>/dev/null || echo "[]"
      ```

    - **State** — prior `daily_log_drift[]` history for cross-night pattern detection (the 3-corrections-at-same-centroid auto-promote rule):
      ```bash
      jq '.daily_log_drift // []' ~/Dev/edva/data/nightly-review-state.json
      ```

12. **How often Edva was wrong about Edva — the self-report noise rate** (2026-10-06, the user approved; recomputed every week from existing state, no running counter). The week that added this, 13 of 25 signed fixes were the system misdescribing its own state and 18 of 68 alert clusters were `severity: "noise"`, and nobody tracked either as a number. The arithmetic is code's; reading what a fix was ABOUT is yours (Rule #0b). Two passes:
    ```bash
    ~/Dev/edva/bin/self-report-noise-rate --json > /tmp/self-report-noise-pass1.json
    ```
    `alerts` is done: the share of system-issue clusters active this week that system-issue-review judged noise, plus the all-time share. `fixes.linked_to_noise_cluster[]` are fixes structurally tied to a noise cluster. Every other applied fix is in `fixes.unlabelled[]` — read each `summary` (and `self-improve-show <id>` when the summary is not enough) and decide one thing: **was the defect this fixed Edva misdescribing its own state** (a report, alert, log or status saying something about Edva that was false — a success read as failure, a job reported missing that ran, a healthy check paging), yes or no. A fix to the user's data or to an external integration's behaviour is `false`. Write the answers to `/tmp/self-report-labels.json` as `{"<id>": true|false}` and re-run:
    ```bash
    ~/Dev/edva/bin/self-report-noise-rate --json --labels /tmp/self-report-labels.json
    ```
    Use the numbers exactly as printed — do not recount by hand. `fixes.complete` must be `true` before you quote the fix rate as final; if anything is still unlabelled, say so in the memo. Compare against last week's `self_report_noise` in this job's state (Step 1) for the trend.
13. **Bash** — replies Edva rewrote after the user could already see them (added 2026-10-06). The chat row holds only the corrected text; the version it replaced is kept ONLY here, in a local append-only log (`lib/superseded-replies.mjs`, written by phone-channel's send-then-correct freshness rewrite before it overwrites the row). This is the only way the review can find a wrong figure that reached their phone and was quietly fixed — a wrong money figure in a draft reply is the motivating case:
    ```bash
    SINCE=$(TZ=$(node ~/Dev/edva/lib/instance.cjs tz) date -v-7d +%Y-%m-%d)
    jq -c --arg s "$SINCE" 'select(.ts >= $s) | {ts, reason, row_id, original, replacement}' \
      ~/Dev/edva/data/superseded-replies.jsonl 2>/dev/null || echo "none"
    ```
    In § Conversations, read each row and judge (you, not a pattern match) whether the superseded text stated a **money** or **health** figure or claim that was wrong. Every such row is a finding: name the figure that reached them, what replaced it, and which source fed the wrong one. Quote money/health text in the email only as far as needed to identify the incident. Count superseded replies per week alongside the other self-report numbers.

14. **Bash** — the hum improvement loop (added 2026-10-07, the user's request: larger, structural changes go in the weekly improvement recommendation email). The loop's routing is `lib/hum-ideas.mjs`: safe ideas land on their own, high-risk ones become a card, ones needing their yes are asked in the hum chat, and ideas too big for one unattended run have NO other way to reach them but this email.
    ```bash
    ~/Dev/edva/bin/hum-ideas-reconcile >/dev/null 2>&1 || true   # settle ledger status against the cards first
    ~/Dev/edva/bin/hum-ideas-brief --json > /tmp/hum-ideas-brief.json
    ```
    `structural[]` is the part that matters: each is a change too large to design and land in one run, waiting for their call. Report them in Step 5's HUM — IMPROVEMENT LOOP section in plain language (what is wrong today, why it matters, what the change would do, what it could affect — the same four parts as every other item); do NOT file a card or build anything for them here. Report `landed[]` as one line so they can see the loop working. Read-only: never edit `hum-improvement-ideas.jsonl` from this step.

## Step 2b — External research (second parallel batch)

Issue these web searches in a **single parallel batch** using WebSearch. Capped at **2 queries** (down from 4, 2026-04-23 token audit — Claude Code + Anthropic announcements are the two highest-signal sources; community tips and agent-research papers rarely produced actionable items, so rotate them in ad-hoc via the phone channel when the user asks):

1. **Claude Code + Anthropic releases (combined)** — search for:
   `site:anthropic.com/news OR site:docs.anthropic.com OR site:github.com/anthropics/claude-code 2026`
   Look for: new models, API changes, new Claude Code features, bug fixes, MCP improvements, hook changes, permission updates, pricing shifts.

2. **Claude Code community + agent research (combined)** — search for:
   `"claude code" (agent OR MCP OR hooks) 2026 site:github.com OR site:reddit.com`
   Look for: creative agent patterns, MCP servers worth adopting, CLAUDE.md best practices, hooks people are using. If nothing, say so — don't pad.

**Extraction rule:** For each search, extract only what is NEW since the last self improvement review (check `last_run` in state file). Skip anything older. If nothing new, say so — don't pad with stale results.

## Step 2c — Triage learning pass (merged from standalone job, 2026-04-23)

The previously-separate `triage-learning` cron (daily 9 PM) is now a step in this review. One Opus dispatch instead of two.

Update `~/Dev/edva/data/email-triage-playbook.md` based on the last 7 days of email outcomes:

1. **Find sent replies:** Gmail search `is:sent newer_than:7d`. For each sent message, get the thread, find the original inbound, check email-mem for the agent's classification.
2. **Find priority miscalibrations:** cross-reference `is:sent newer_than:7d` with emails the agent archived (P3). Any match = underclassified; should have been P2.
3. **Update the playbook** — same structure as the old triage-learning.md:
   - **Sender Patterns:** response rate, average response time, typical priority (based on actual behavior).
   - **Topic Patterns:** new patterns observed.
   - **Classification Corrections:** over/underclassified examples with the correction.
   - **Response Rate Summary:** rolling stats.
4. Remove stale entries (senders not seen in 30+ days). Keep each sender entry to 3–5 lines. If there's nothing new to learn, skip the update.

Note the update (or skip) briefly in the Triage section of the memo below.

## Step 2d — Cost lens (per-job usage + optimization proposals)

Added 2026-04-23 alongside the per-turn job attribution in supervisor/index.mjs. This is a standing section — **every nightly-review must walk it**, because runaway spend tends to creep in one tweak at a time, and the point of catching it early is to stop the creep before it becomes a bill.

**Data sources (parallel batch):**

```bash
# 7d cost rollup by job (structured)
~/Dev/edva/bin/edva-cost-report --since 7d --json

# 7d cost trend (per-day × per-job grid)
~/Dev/edva/bin/edva-cost-report --since 7d --trend --json

# 7d vs prior-period outliers (auto-flagged — primary signal)
~/Dev/edva/bin/edva-cost-report --outliers --json
```

If `edva-cost-report` errors with "no job-costs.ndjson" the supervisor hasn't written any turns yet (e.g. it was restarted <1 tick ago) — skip this section for this run and say so in the memo.

**What to surface in the memo:**

1. **Top 5 spenders (7d).** `source`, `dispatches`, `total_cost_usd`, `avg_cost_per_dispatch`, `cache_read_tokens`. If `cache_read_tokens / (input_tokens + cache_read_tokens) < 0.8`, prompt caching is under-performing for that job — flag it.
2. **Outliers.** Any job whose last-7d cost is ≥1.5× or ≤0.5× its prior-period average. Up-outliers get a "what changed?" investigation (compare git log for changes to the playbook / prompts / data-load size); down-outliers get a "is the job still working?" sanity check (silent failure looks the same as cost reduction).
3. **7-day trend.** Flag any job with a monotonic upward trend across ≥4 of the last 7 days — that's the creep pattern.

**Optimization proposals (draft-and-stage-eligible):**

Token-reduction proposals flow through the same classifier + staging pipeline the rest of Step 4 uses. **Risk no longer decides whether one gets staged — every item does, except the recursion-guard/FORBIDDEN/multi-option exclusions in Step 4a — but it still decides the label on the card and how much scrutiny the rationale should ask for.** Scored **low-risk** when they tighten a numeric bound without removing functionality:

- Cap a WebSearch query count (`4 → 2`, `8 → 5`) in a playbook whose outputs aren't materially affected by the dropped queries.
- Increase a `cadence_min` in `hum-interests.json` for a topic that's been silent for ≥5 consecutive days.
- Trim a context-bundle field that rank/analysis doesn't actually use (cite the transcript or output that proves non-use).
- Swap `model: sonnet` → `model: haiku` on a bounded-scoring subagent (the hum rank precedent; pair with a revert instruction in the same PR).
- Tighten a tool-call budget ceiling when the actual usage has been well below it for ≥14 days.

Scored **moderate/high** (still drafted and staged — but the rationale must say so plainly, and the diff needs to earn its approval, not just its classification) when they:
- Drop a playbook step, cut a cron's frequency below "once per day", or change delivery behavior (email → phone-only).
- Lower a model's reasoning quality in a way that affects user-facing output (e.g. daily-summary narrator, a financial-analysis job).
- Touch a financial-analysis playbook at all — anything affecting financial analysis depth is high-risk by default. (Still stageable — such a playbook can be FORCE-HIGH without being one of the four recursion-guard files — but flag the financial-depth angle prominently in the card's rationale; this is exactly the kind of change the user should read closely before signing.)

**The framing in the memo:**

> COST LENS — 7d total $X.XX across N dispatches.
> Top spenders: [...]
> Outliers: [...]
> Trend: [...]
> Proposals: [N auto-apply, M deferred]

If cost-lens surfaces nothing worth acting on, say `nothing this run` — an affirmative no-op entry is required so the user can see the lens is live.

## Step 2e — Recall lens (memory retrieval quality)

Added 2026-08-09. Recall is the one capability whose decay is **completely invisible** from the outside: a wiki page that has quietly stopped being findable produces no error, no alert, and no failed job — it produces an agent that answers as if the memory were never written. Nothing else in this review would notice.

**Run it:**

```bash
# ~80 local embeds, a few seconds, no API cost
~/Dev/edva/bin/wiki-recall-eval --json
```

27 hand-keyed questions taken from the user's own chat history, scored against the live corpus in three classes (`episodic` / `curated` / `asked`). Answer keys were verified by direct substring over `body_md`, not by the retriever, so the set cannot drift into grading the system against itself.

**Reference numbers (2026-08-09, the run that set the current defaults):**

| config | overall hit@5 | MRR | episodic | curated |
|---|---|---|---|---|
| `+cues` (production) | 70% | 0.532 | 64% | 78% |
| `episode_search` path (fts, type=day) | — | 0.643 | **79%** | — |

**What to surface:**

1. **Any class down more than ~7pp from the table above.** That is a regression, not noise, on a 27-case set — name the queries that flipped to a miss.
2. **A config that has overtaken the production one.** If `fts` starts beating `+cues` overall, the semantic layer has stopped earning its place and should be re-examined rather than left on.
3. **Nothing at all if it is flat.** This lens is a tripwire; a quiet night deserves one line, not a paragraph.

**Do not tune thresholds against this set.** 27 cases is enough to catch a regression and far too few to fit a constant to — that is how you get a number that scores well here and worse everywhere else. If the set itself starts feeling stale (queries all passing, no headroom), the fix is to add real questions from `edva_messages`, not to relax the retriever. Rationale and full history: `system/wiki-architecture.md` § Measuring recall.

## Step 3 — Analyze and recommend

With all data loaded, analyze across these dimensions. **Every section must include specific recommendations** — what should change, what file/config to edit, what pattern to adopt. Don't just report facts; propose improvements.

### Conversations
- What did the user ask about today? Group by topic.
- Multi-turn conversations >4 messages on one topic = friction. What could be automated or pre-answered?
- Requests the system couldn't handle — what new capability would fix each one?
- Repeated patterns across days (check `patterns.frequent_asks`) — propose new automations for recurring asks.
- **Recommend:** specific new jobs, CLAUDE.md rules, or tools that would reduce friction.

### Daily Log accuracy (location + activity narrative)

The 00:10 local daily-summary email is Edva's foundational record of where the user was and what they did the prior day — every inaccuracy degrades the system's awareness of their life and downgrades the quality of every future suggestion that depends on it. This section is FIRST-CLASS, not an optional sub-pass. Walk it every night, even on quiet days, and surface drift as concrete proposals.

**The 6 drift signals to walk in order:**

1. **Email reply correction.** Did the user reply to yesterday's "Day of" thread? Parse the reply for the failure pattern. The prototypical case is a day email that missed a lunch stop and a walk — Edva's own follow-up found that several 6-9 min stops along the walk got dropped by the 15-min dwell floor. For each correction:
   - Identify the exact stop, gap, or mislabel.
   - Classify the fix path: (a) **threshold/floor change** if the data was in raw GPS but filtered out (e.g., `min_stop_min` too aggressive for walk-loops); (b) **data-source fix** if the data was missing (e.g., GPS gap, photo not indexed); (c) **resolver mislabel** → propose a `confirmed-stops.json` entry for future auto-resolution at that centroid; (d) **playbook drift** if the narrator chose to omit something the resolver provided.
   - Surface as an action item with the specific file/line to change.

2. **Chat correction from today about yesterday.** Today's `edva_messages` show the user retroactively correcting ("we were at X, not Y" / "actually that was Z" / "I wasn't at the dentist"). Same fix-path classification. Cross-reference yesterday's `resolved_day_json.stops[]` to find the corrected stop and propose the patch.

3. **Unknown stop unanswered.** Yesterday's email surfaced `unknown_stops[]` as questions in the "Corrections & follow-ups" section. Did the user answer any in chat or email? If yes, propose patching `location_history` retroactively + silent re-render of yesterday's summary. If no, decide: re-ask once more this morning (one-shot, gentle), or accept as truly forgotten and stop asking.

4. **Late confirmation that didn't make it into the email.** `confirmed-stops.json` entries with `ts` AFTER yesterday's `resolved_day_json.generated_at` are user answers that arrived too late. Each is a candidate for a silent re-render of yesterday's `daily_summaries` row + episode file. (Once the late-correction re-render is built per the location-spine work's deferred P2 item, this becomes auto-apply eligible.)

5. **Calendar/GPS mismatch.** Yesterday's `unmatched_calendar_events[]` includes a physical event whose coords or known address overlap a GPS stop's centroid within ~300m, and the time windows overlap by ≥5min, but the matcher didn't connect them. If this fails repeatedly for the same calendar event title or location, propose tolerance widening or a known-address mapping.

6. **Repeat mislabel pattern (cross-night).** Cross-check today's drifts against `daily_log_drift[]` history. The 1-correction auto-promote in Step 6 already handles authoritative single-reply cases; this signal is for unconfirmed heuristic mislabels — e.g., the resolver picks the same wrong OSM venue at the same centroid 3 days running but the user never explicitly corrected it. Surface as an action item asking the user to confirm the actual venue, then auto-promote on their single reply.

7. **Phantom location questions (since 2026-10-07).** For each day in the window run `~/Dev/edva/bin/ask-gate audit <YYYY-MM-DD> --tz <that day's timezone>`. Every entry in `phantoms[]` is a location question they answered that the ask gate now refuses: a slice of a stay they never left (`same-stay`) or a stop with no point away from it afterwards (`no-departure`). On days after 2026-10-07 each one means a question got past `ask-gate` — surface it as an action item naming the stop, the check and the ask path that sent it (`data/ask-gate-log.jsonl` shows whether the gate ran for that `visit_id`). Zero phantoms is the expected result; say so in one line.

8. **Questions they had already answered (since 2026-10-08).** For each day in the window run `~/Dev/edva/bin/stop-evidence audit <YYYY-MM-DD> --tz <that day's timezone>`. Every entry in `would_have_named[]` is a stop they were asked about although the chat or their own photos already said where they were — their words, Edva naming the place from their photo and them going along with it, or a sign in a photo. The case that built it: a lunch stop asked about an hour after they had sent a photo saying they were having lunch there and Edva had named the place. The step (`lib/stop-evidence.mjs`, run inside `stop-passage` before every ask) should have caught these live, so each hit is a defect: surface it as an action item naming the stop, the basis the audit found, and why the live run missed it. The `stop-passage-log.jsonl` row for that `visit_id` shows whether the probe held, what evidence the step saw and what it decided. Zero is the expected result; say so in one line.

**Cross-cutting health metrics to surface every run:**

- **Resolution rate.** Yesterday's `stops_count` vs. count with `place.source ∈ {user_confirmed, named_location, confirmed_stop, known_recurring}`. ≥80% = healthy. Below threshold for ≥3 days = the resolver ladder needs attention.
- **Answer-loop friction.** Of yesterday's unknown_stops + asked-during-the-day asks, how many got an answer within 24h? Trending down = chat-agent reply detection is degrading or the asks aren't reaching the user.
- **Drift volume trend.** Total drift entries this week vs. prior 4-week average. Up = something regressed. Down = improvement (fix landed, pattern resolved).

**Recommendation framing per drift item:**

```
DRIFT [signal-type] · YYYY-MM-DD · stop=<HH:MM-HH:MM>
  was: <actual_name> (<actual_source>)
  is:  <expected_name> (per <signal source: email/chat/late-confirm>)
  fix: <specific file + change> · classification: <auto-apply | needs-setup | moonshot>
```

Quality over quantity. Don't pad with low-signal drift; the section is for items that actually changed Edva's behavior or that build toward a recurring fix. Empty sections are honest — say `no drift this run` if the day was clean.

**Live-Day Accuracy Verification (NEW 2026-04-30)**

This sub-pass runs every review (one walk per day of the window). **The old exit condition — "7 consecutive days at ≥99% verified_correctness", then downgrade to weekly — is retired (2026-10-06): that metric never produced a single number, so the pass never had a reachable finish line.** The point is unchanged: treat every discrepancy as a learning event. Calendar prediction failures, GPS coverage gaps, and unresolved place names are all explicit signals to fix.

Run for yesterday:

```bash
YDAY=$(TZ=$(node ~/Dev/edva/lib/instance.cjs tz) date -v-1d +%Y-%m-%d)
~/Dev/edva/bin/live-day accuracy "$YDAY"
```

Returns:

| Metric                          | What it measures                                                                              | Target  |
|---------------------------------|----------------------------------------------------------------------------------------------|---------|
| `interval_count`                | Total intervals on the day                                                                    | —       |
| `covered_min`                   | Minutes covered by intervals (vs. ~960 for a 16h waking day)                                  | ≥80% of waking |
| `resolution_rate`               | **COVERAGE, not correctness** — fraction of minutes with a high-confidence place *source* (`user_confirmed`, `named_location`, `known_recurring`, `confirmed_stop`, `wifi_ssid`, `osm_overpass`/`google_places` ≥ 0.7). Says a name was produced, never that it was right. **Never report this alone.** | ≥0.85 |
| `name_accuracy`                 | **CORRECTNESS** — of the minutes whose asserted name could be checked against the user's own corrections, the fraction that matched (geometrically, within 60m). **`null` means nothing was checkable — that is not 1.0 and must never be reported as success.** | ≥0.95 when non-null |
| `corroborated_min` / `contradicted_min` / `unexamined_min` | The three buckets behind `name_accuracy`. `unexamined` is the honest majority: most stops are never corrected. | — |
| `contradictions[]`              | The intervals we named wrongly — `said` vs `he_said` and how far off. **Each one is an action-item candidate**, more valuable than any resolution gap because it is a confirmed error rather than an absence. | empty |
| `calendar_supports/missed/unmatched_physical/total_physical` | Calendar prediction breakdown                                  | —       |
| `calendar_accuracy`             | `supports / total_physical` — what % of scheduled physical events GPS confirmed              | ≥0.85   |
| `user_confirmed_share`          | Share of minutes the user personally validated                                                  | rising  |
| `coverage_gaps[]`               | Daytime ≥30min stretches with no interval (excludes 00–06 local overnight)                      | empty   |
| `resolution_gaps[]`             | Intervals that flunked the high-confidence test — candidates for tomorrow's location-confirm asks | empty (asymptotic) |

**Surface in the email:**
- One-line yesterday summary: `Live-day accuracy YYYY-MM-DD: resolution=X% calendar=Y% gaps=N user_confirmed=Z%`
- Each `resolution_gap` becomes an action item (low-risk auto-apply: dispatch a one-shot `location-confirm` ask if the user is awake, or queue for next morning).
- Each `coverage_gap` becomes a question: "no GPS 14:30–15:45 — phone offline? indoor dead zone? venue worth tagging?"
- Each `calendar_missed` (calendar said dentist 14:00–15:00 but no GPS at the dentist) becomes a question: "missed dentist appt or attended remotely?"

**Retired: `verified_correctness` and the 99%-for-7-days streak (2026-10-06).**

This was meant to be the lagging truth metric — `1 - drift_count / interval_count` back-filled at T+7 from `daily_log_drift[]`, with a milestone ping after 7 days at ≥99% and a downgrade to weekly. It never produced a figure: `verified_correctness` was null on all 64 stored days, because the drift ledger it counted was written only by this playbook, by hand, and went silent after 2026-09-18. The user chose on the 2026-10-06 review to retire it rather than keep reporting a programme that does not run. **Do not compute it, back-fill it, track a streak, send the milestone ping, or mention it in the email.** The honest correctness number is `name_accuracy` above — and when it is null, say "no correctable evidence", never a substitute. The drift ledger itself is NOT retired: since 2026-10-06 code writes a row whenever an answer corrects Edva's guess (see the `daily_log_drift[]` note at the top), and those rows are what the Daily Log accuracy pass reads.

**Persist every drift to `nightly-review-state.json.daily_log_drift[]`** with shape:

```json
{
  "date": "2026-04-29",
  "centroid": {"lat": 12.345, "lon": -67.89},
  "expected_name": "Example Cafe",
  "actual_name": "Sample Bistro",
  "actual_source": "osm_overpass",
  "signal": "email_reply",
  "fix_status": "open"
}
```

`fix_status` advances `open → patched` when the recommended fix lands, or `auto_resolved` when the auto-promote rule fires. Prune entries with `fix_status: patched|auto_resolved` older than 60 days; keep `open` entries indefinitely (recurring drift is the most valuable signal we have).

### Triage
- P1/P2/P3 distribution — any anomalies?
- Reclassifications — what rule change would have gotten it right the first time?
- New senders not yet in the triage playbook — propose the exact playbook entry.
- High volume from a single sender — propose the exact spam-filter or batching rule.
- **Recommend:** specific triage-playbook edits, new email-mem entries, or spam-filter rules.

### Pulse
- Runs, pings, log-only decisions, engagement.
- Which lanes are consistently skipped/snoozed? Should they be down-weighted?
- Which topics get reactions? Should the threshold or lane weights be adjusted?
- **Recommend:** specific ping-budget values (`lib/ping-budget.mjs`: 6/day, 45 min apart as of 2026-10-06) with before→after, grounded in the week's per-day ping counts from `hum-feedback.jsonl`.

### System health
- Restarts, crashes, watchdog alerts — only CURRENT issues (cross-check against git commits for fixes already applied).
- **Supervisor incident signals from Step 2 #7b**: for each hit, classify as active-outage / self-healed / transient-blip. A self-healed AUTH OUTAGE (alert sent + creds refresh + session rotation) is information for patterns, not an action item. An active outage or a hung turn that recurred is. A single QUEUE ALARM that cleared on its own means dispatch was briefly slow — note the cause if recoverable from context (e.g. Max rate-limit window), otherwise skip.
- **Anthropic API-key spend is not tracked** — as of 2026-04-16 zero components make billed Anthropic calls (agents run on Max, acks run on local Gemma via Ollama). Skip this section unless a regression reintroduced API-key usage. Never report SDK estimated totalCostUsd figures.
- MCP failures, webhook errors, queue anomalies.
- **Reviewed-and-dismissed system issues (added 2026-07-25).** Read `data/system-issue-review-state.json` and report the clusters whose `reviewed_at` falls in the last 7 days with `resolution: "reviewed-no-fix"` — `system-issue-review` root-caused these and concluded no code change was warranted, deliberately posting no card. **This roundup is their only visibility surface**, so it is not optional: without it, "reviewed, nothing to fix" is indistinguishable from "nobody looked," which is the exact failure the 2026-07-25 change removed. One line each: the condition, what healed it (`self_heal_mechanism`), and `why_no_fix`. Group identical mechanisms rather than listing repeats.
  - **Push back when the dismissals cluster.** Three or more no-fix reviews in a week sharing one `self_heal_mechanism` is a signal in itself: either that heal is carrying real load and deserves hardening, or the condition should stop paging at `🔴`. Say so as an action item — the per-issue reviews correctly each concluded "no fix," and the pattern across them is only visible from here.
- **Recommend:** specific fixes for any open issues. Architecture changes for recurring problems. If a specific dispatch source keeps tripping the turn watchdog, propose either a per-playbook timeout or a prompt change that avoids the hang.

### Claude Code & Anthropic ecosystem
- New Claude Code features worth adopting — which ones, and how they'd improve Edva.
- Anthropic releases — model upgrades, API changes, pricing impacts.
- Community innovations — MCP servers, CLAUDE.md techniques, hook patterns worth stealing.
- **Recommend:** specific features to adopt with implementation sketch (which files, what changes).

### Agent research & self-improvement
- Practical memory/autonomy/RL techniques applicable to Edva.
- Only items that are implementable with our current stack (Node.js, Claude Code, Supabase, file-based state).
- **Recommend:** specific architectural changes with effort estimate (quick win / half-day / multi-day).

### Tools & Integrations — aggressive capability wishlist

**This section is a brainstorming engine, not a triage gate.** The goal is to surface *new external capabilities* Edva could gain by wiring in an API, MCP server, SDK, hardware sensor, or service — things that expand what Edva can *do*, not just what it knows. Propose generously; classification below lets the user filter the noise.

**Walk every category on every review.** For each, ask: "what's the highest-leverage integration we haven't built yet, given how the user actually spent today?" If no credible idea surfaces for a category, say `no fit today` — don't silently skip.

- **Travel & logistics** — flight search (Google Flights / Amadeus / Kayak), hotel search (Booking / Hotels.com / Expedia), itinerary-service deep integration (TripIt-style), rental-car (Turo / Hertz), airport lounge APIs (LoungeBuddy), global transit (Citymapper / Rome2Rio), visa / entry-requirement DBs, AllTrails for hikes.
- **Voice & audio** — on-device speech-to-text via Whisper.cpp for iPhone recordings, voice-memo harvesting from Apple Voice Memos, music / Shazam / AudioD, podcast episode discovery + auto-queue (Overcast / Pocket Casts), ambient audio classifier (restaurant vs. quiet vs. commute — privacy-gated).
- **Smart home & IoT** — Alexa Skill (requires AWS dev account + skill review), Google Home, Home Assistant / HomeKit bridge, Ecobee / Nest, Hue / Lutron, August / Schlage locks, ring doorbells, security-cam APIs, weather stations, pet trackers (Apple AirTag / Tractive), Tesla / connected-car APIs.
- **Search & knowledge** — Perplexity API, Brave / Kagi search, Wolfram Alpha (already partial), Wikipedia / Wikidata SPARQL, PubMed / arXiv / SSRN for research tasks, Google Scholar via SerpApi, Bloomberg Terminal (if authorized), Fred (economic data).
- **Financial & markets** — brokerage read-only beyond the connected one (other brokerages), bank-txn feeds (Plaid read-only), crypto portfolio (CoinGecko / CMC / ledger addresses), real-estate valuation (Zillow / Redfin).
- **Vision & OCR** — document OCR (receipt → expense), business-card scan, whiteboard photo → structured notes, product recognition (visual shopping), handwriting → text (iOS ScribbleKit), license-plate reading.
- **Reservations & booking** — OpenTable / Resy / Tock, event-ticketing platforms, SeatGeek / Vivid / StubHub secondary, Calendly reverse-booking, Uber / Lyft ride request, Zocdoc for appointments.
- **Communication & relationship** — Twilio SMS (dedicated Edva number for third-party comms instead of the user's iMessage), Signal bridge, WhatsApp business, LinkedIn messaging (authorized only), Zoom / Meet scheduling via API, contact-enrichment (Clearbit / Apollo).
- **Productivity & dev** — Linear / Jira / Asana bridges, GitHub beyond current (issues triage, PR comments as tasks), Notion / Coda / Airtable reads, Pinecone / Weaviate / Chroma for vector memory (complements the nomic-embed-text experiment).
- **Media & entertainment** — JustWatch (fills a streaming-platform lookup gap), Letterboxd export, Last.fm / Spotify listening history, Goodreads / Hardcover, Criterion / MUBI indie libraries.
- **Health & wearables** — Oura / Whoop if the user adds one, continuous glucose monitors, Dexcom / Libre, Fitbit bridge (if relevant), Strava for runs, MyFitnessPal for calorie tracking, Apple Health → Edva push webhooks for anomaly triggers.

**Classification per proposal (pick exactly one):**

- **[auto-apply]** — an accept from the user is sufficient to ship it. This means: the integration is a pure API wrapper (HTTP + published docs), credentials exist in 1Password or can be created with a free-tier signup that doesn't require the user's hands-on, no physical hardware, no OAuth redirect that needs a browser click from them, no financial-write access, no mobile-app permission, no AWS/GCP dev-account registration, and the integration pattern matches an existing tool in `bin/` we can copy. Examples: Perplexity API key wrapper, CoinGecko read-only, Wolfram Alpha.
- **[needs-setup]** — credible proposal, but the user has to do *something* (create an account, enable a scope, pair a device, approve an OAuth scope in their browser, sign an ISV agreement). Examples: Alexa Skill (AWS Developer + skill certification), Plaid (bank login + ISV approval), Ring (Amazon device login), new brokerage API (per-broker OAuth).
- **[moonshot]** — big ambition, non-trivial build, or depends on research we haven't done. Examples: "iOS on-device audio classifier", "car GPS → drop-off reservation pre-booking."

**Output per proposal** (terse — 3 lines max, this is the brainstorm scan, not a design doc):

```
<name> — <one-line what it unlocks for Edva, grounded in a specific the user moment if possible>
<API / vendor / stack> · <classification: [auto-apply] | [needs-setup] | [moonshot]>
<the single blocker: credential, vendor signup, hardware, research, etc.>
```

**Limits & discipline:**

- **3–6 proposals per review.** Mix of classifications — don't stack six `[moonshot]`s; try for at least one `[auto-apply]` every review.
- **Don't re-propose.** Track in `nightly-review-state.json` under a new `integration_proposals` array (id, status: `pending` | `auto-applied` | `accepted` | `rejected` | `deferred`, `proposed_at`, `response`). Same 7-day cooldown on pending; once rejected, don't re-propose unless the world changed (vendor shipped a new SDK, the user's context shifted, etc.).
- **Ground most proposals in today.** Something from today's conversations / triage / pulse that a new integration would have unlocked. If you genuinely can't ground any proposal in today, include 1 speculative `[moonshot]` and say so.
- **This section does NOT apply integrations on its own.** The review stays read-only. `[auto-apply]` means *the user's one-tap accept* dispatches to ops-agent, which then builds the wrapper — NOT that the review itself shells out to build it.

**Acceptance flow (routing to ops-agent for accepted items):**

When the user replies to the review with `N: YES` for an `integration_proposals` item tagged `[auto-apply]`, chat-agent dispatches to ops-agent webhook as:

```
POST http://localhost:9093/dispatch
Body: {"content": "INTEGRATION IMPLEMENT: <id> <name>", "source": "chat-agent"}
```

Ops-agent then reads the `integration_proposals` entry for full spec and builds the wrapper + wires it through the normal tool/playbook/MEMORY cycle per `edva-docs-sync`. Treat this like the existing `RECLASSIFICATION ACCEPT` flow pattern: ops-agent loads the spec, applies the change, commits, restarts the affected supervisor(s). For `[needs-setup]` items, chat-agent instead surfaces the blocker list so the user can kick off the manual steps — do NOT dispatch a build until they say the blocker is resolved.

### Context gaps — what Edva wants to know

This is Edva's self-assessment of its own blindspots. Review today's conversations, triage events, pulse runs, and any moments where the system had to ask a clarifying question, made a wrong assumption, guessed when it should have known, or couldn't help because context was missing.

For each gap identified, provide:
- **Gap**: what information was missing
- **When it mattered**: specific moment from today (or recurring pattern from `patterns` in state file)
- **What it would unlock**: concrete service improvement — be specific about what Edva could DO differently
- **How to close it**: one of these approaches, in order of preference:
  1. **Infer from existing data** — can Edva derive this from signals it already has? (calendar patterns → daily routine, email frequency → work hours, location history → frequent places)
  2. **New sensor/integration** — iOS HealthKit, Apple Watch, Home Assistant, car GPS, browser history, screen time
  3. **Background observation** — the phone app could passively report this without the user doing anything (e.g., continuous location, motion activity, ambient noise level, Wi-Fi network name → "at home" vs "at office")
  4. **Ask the user once** — a one-time question that fills a permanent knowledge gap (e.g., "which credit card do you prefer for travel purchases?")
  5. **Ask the user in context** — a just-in-time question when the situation arises (e.g., "you're near 3 restaurants — are you looking for lunch?")

**Categories of context to consider:**

**Real-time situational awareness:**
- Location + heading + velocity → where is the user going? (enables: proactive restaurant/store suggestions along the route, ETA-based notifications, "you're 10 min from home — the AC is off, want me to turn it on?")
- Activity state → walking, driving, sitting, exercising (enables: don't interrupt during exercise, adjust notification urgency by activity, suggest walking-distance vs driving-distance options)
- Who is the user with → alone, with family, with friends (enables: shared show recommendations when not alone, restaurant suggestions sized for the group, skip work notifications during social time)
- Current environment → home, office, restaurant, airport, hotel (enables: context-appropriate suggestions, suppress irrelevant notifications)

**Behavioral patterns (inferrable over time):**
- Actual sleep/wake times vs nominal schedule — when do they really go to bed? (enables: better protected-window accuracy, morning digest timing)
- Decision patterns — which types of requests get instant replies vs "let me think about it"? (enables: pre-research on slow-decision topics)
- Communication preferences — when do they prefer phone-channel vs email for different types of info? (enables: route notifications through the right channel at the right time)
- Energy/productivity cycles — when are they most focused vs winding down? (enables: schedule complex suggestions for high-energy windows)

**Relationship & social context:**
- Close friends beyond documented family — who do they see regularly, who do they email/text often? (enables: birthday/event awareness for friends, social context for scheduling)
- Service providers — doctors, lawyers, accountants, mechanics they trust (enables: proactive appointment reminders, referral suggestions)
- Social patterns — regular weekly meetups, recurring dinners, standing calls (enables: avoid scheduling conflicts, prep context for recurring social events)

**Preference depth (beyond what's documented):**
- Evolving food preferences — what have they tried recently and liked/disliked? (enables: sharper restaurant recommendations, avoid re-suggesting rejected cuisines)
- Gift philosophy — beyond a category, what makes a gift feel right to them? (enables: better birthday brainstorm quality)
- Travel style — hotel vs short-term rental, room preferences, airline preferences, seat preferences (enables: autonomous booking assistance)
- Shopping patterns — preferred brands, price sensitivity by category, return behavior (enables: better Amazon/product recommendations)

**Framing rules:**
- Present gaps as a WISH LIST. "If I knew X, I could help you with Y" — always lead with the value, not the data collection.
- **Ground most gaps in today's interactions** — specific moments where better context would have helped. These are the high-priority, immediately actionable ones.
- **But also dream.** Once or twice per review, include a speculative "moonshot" gap — something ambitious, maybe even crazy, that would fundamentally change what Edva can do. Examples:
  - "If I had your Apple Watch health data, I could correlate your resting heart rate with decision quality and suggest holding off on big calls when your HRV is low"
  - "If I could listen to ambient audio (with consent), I could detect when you're in a social dinner vs alone and adjust my interruption threshold in real-time"
  - "If I had read access to your browser tabs, I could anticipate what you're researching and pre-fetch related information before you ask"
  - "If the car reported GPS, I could have dinner reservations ready by the time you park"
- Moonshots should be tagged `[moonshot]` in the email. They don't need to be immediately practical — they're meant to provoke the user into thinking about what's possible and occasionally saying "actually, let's build that."
- For each gap, note the **privacy sensitivity** (low/medium/high) and whether it requires a new app feature, a one-time question, sensor integration, or can be inferred from existing data.
- Limit to 3-5 gaps per review (including at most 1-2 moonshots). Track in `nightly-review-state.json` under `context_gaps` to avoid repeating. Once closed, mark resolved.

### Skills to add or improve

Skills live at `~/.claude/skills/<name>/SKILL.md` — user-invocable Claude Code knowledge modules (distinct from scheduled jobs). They encode reusable patterns, data-source maps, framing rules, and checklists for recurring kinds of work. Current skill inventory is documented in `system/architecture.md` under **Skills (user-invocable)**.

Every nightly review MUST brainstorm whether skills should be added, updated, or retired. Three questions to answer in order:

1. **Do any existing skills need updates?** Walk each current skill and check:
   - Does it reference files, tables, or CLI commands that were renamed / moved / deleted today?
   - Did today's work reveal a new pattern the skill should codify (a new query shape, a new failure mode, a new clinical scenario, a new data source)?
   - Is the skill's `description` frontmatter specific enough that future Claude sessions will invoke it when relevant? (Generic descriptions → skill sits unused.)
   - For `health-support`: did the user confirm new medication/allergy/condition data, a new trip, or a new clinical finding that should update the medication reference, data-source dictionary, or conditions list?
   - For `edva-docs-sync`, `edva-job-author`, `outbound-comms-policy`: did today's changes expose a pattern the skill missed (a new failure mode, a new channel, a new authoritative doc)?
   - For `secrets-1password`: did any secret get rotated, added, or expire? Is the expiration table synced with `~/.claude/CLAUDE.md`?

2. **Did any recurring friction point emerge today that suggests a new skill?** Signals to watch for in the data:
   - **Repeated ad-hoc work** — the same type of task (restaurant research, trip planning, inbox-triage reasoning, health reasoning on a new topic) came up more than once, and each instance rebuilt the scaffolding from scratch.
   - **Cross-cutting rules the agent got wrong or almost got wrong** — e.g., a close call on outbound comms framing, a financial limit that was re-derived rather than invoked from policy, a doc-update that was nearly skipped.
   - **A category of question the user asked that required stitching together multiple data sources** — if they ask the same cross-source question monthly, that's a skill candidate.
   - **A third-party integration** that got built today without encapsulation — next time someone touches it, will they have to rediscover the auth dance / rate limits / quirks?

3. **Did the user explicitly ask for something that should be codified?** Direct requests to "turn this into a skill" / "add this to the instructions" / "remember for next time" — always surface these as skill proposals (not memory entries, if the knowledge is procedural rather than factual).

**Output format** under a dedicated "Skills to add or improve" section in the email:

- **Updates to existing skills:** list each skill that needs updating + the specific edit (e.g., *"`health-support` — add post-2026-Q2 lab panel format to `references/data_sources.md`; current FHIR shape doc is 2026-Q1 only"*).
- **New skills proposed:** for each, state (a) the name + one-line description, (b) the recurring pattern it would capture, (c) a link to 1–2 specific moments from today that motivated it, (d) expected call sites (chat-agent, specific ops-agent jobs, etc.).
- **Skills to retire:** if a skill's area has been obsoleted or merged, say so.

**Boundaries:**
- **Brainstorm only.** Never author or edit skills in this job. The user decides what to add; they'll ask Claude to author/update in a separate interactive session.
- **No more than 3 proposals per review.** Aim for high-value, high-confidence suggestions — not speculative "could be useful" items. A good skill addition saves real time on recurring work; a bad one is dead weight.
- **Track proposed skills in `nightly-review-state.json`** under a new `skill_proposals` array (pending / accepted / rejected) so the same proposal isn't re-surfaced every night. Same 7-day cooldown rule as other suggestions.

If no skill changes are warranted today, say so explicitly: *"No skill updates or new skills warranted this cycle — no new patterns or friction points observed."* Silence implies the section wasn't considered; an explicit null is the signal that it was.

## Step 3.5 — Second-critic pass

Before writing the email, spawn **one** `Agent` subagent (general-purpose) that acts as a critic reading the analysis draft you just assembled in Step 3. Its job is to find what this review missed or got wrong. A confidently stated hallucinated fact is the exact kind of blind spot a second reader catches.

Prompt for the critic (tune to match this day's draft, don't paste verbatim):

> You are a second reviewer of a draft self-improvement review for Edva, an always-on AI assistant. Below is the assembled analysis across conversations / triage / hum / system health / ecosystem / research / context gaps / skills.
>
> Your job: find **1–2** concrete blind spots. Candidates:
> - A claim in the draft that's stated confidently but may be wrong (fact errors, miscounted events, misattributed causes).
> - A recurring pattern in today's data that the author underweighted or missed entirely.
> - An action item that's over- or under-scoped (too big to ship, or too small to matter).
> - A contradiction between sections.
> - A Claude Code / Anthropic / research development the author skipped that should have been flagged.
>
> Do NOT propose brand-new action items unless they're directly tied to a blind spot you found. Do NOT rewrite the review. Do NOT summarize back what's already there.
>
> Output format: 1–2 bullet points, each ≤60 words, each ending with one concrete adjustment to make. Under 150 words total. If you genuinely find nothing worth flagging, say `NO BLINDSPOTS` — don't pad.
>
> DRAFT:
>
> <paste the Step 3 output verbatim, including the raw `Decisions & Action Items` section>

Fold the critic output into the email as its own section **immediately before** `ACTION ITEMS`, titled `SECOND-CRITIC BLINDSPOTS`. Leave the critic's wording as-is — do not re-author it. If the critic returned `NO BLINDSPOTS`, omit the section (don't print an empty heading).

If the critic surfaces a blind spot that justifies a new action item (e.g., "the proposed fix for X doesn't address the root cause Y"), add that as its own numbered action item with a brief note attributing it to the critic (`[second-critic]`). The critic is additive — it doesn't override existing items, but its findings CAN become items.

Cost: one extra Agent subagent per run. On Max subscription this is effectively free. Rationale: single-author analysis once missed a hallucinated fact that a second reader would have caught.

## Step 4 — Classify every action item (implementation is `improvement-plan`'s)

Classify every action item from Step 3 + Step 3.5 against the risk rubric. **This review no longer drafts or stages anything** (rubric schema v4, 2026-09-29): the chained `improvement-plan` job implements every classified item and lands it — automatically when `self-improve-landing.mjs` allows, as a Face-ID card when it doesn't. The user's instruction was that everything in the review be acted on "either automatically or via improvements", and one implementer, not two, is how that stays true without duplicate cards. `auto_apply.enabled = false` is still honoured as the kill switch: `improvement-plan` reads it and runs classification-only.

Authoritative references (read first):
- `data/self-improvement-risk-rubric.md` — rubric + path rails + classifier contract (schema v4) + how a change lands (§1.0).
- `agent/ops-agent/jobs/self-improvement-executor.md` — the classifier prompt contract.

### Step 4a — Classify every action item (runs every run)

Spawn **one** `Agent` subagent (`subagent_type: "general-purpose"`). Hand it the Step 3 action items + the rubric contents (or a pointer to the rubric file the subagent can Read). Follow the classifier prompt template in the executor playbook.

For each returned classification:

1. Re-check `rails_hits` locally against rubric §2.2 FORCE-HIGH / §2.3 FORCE-MODERATE (classifier may have missed a rail). Apply any missing rail hit deterministically.
2. Set `auto_actionable = (no FORBIDDEN rails_hits) AND (no recursion-guard rails_hits) AND (architectural_options.length <= 1)`, and `landing_hint` = `"card"` if any FORCE-HIGH hit, `risk: high`, or a card category (rubric §1.0), else `"auto"`. The hint is only a forecast for the email; the real decision is made from the actual diff when the change lands.
3. Append to `data/self-improvement-classifier-feedback.jsonl`: `{ts, id, risk, risk_before_rails, rails_hits, auto_actionable, landing_hint}`.
4. Attach `{risk, risk_before_rails, category, classifier_rationale, rails_hits, auto_actionable, landing_hint}` to each item in the state-write (Step 7).

### Step 4b — retired (2026-09-29)

Do not dispatch an implementer here. `improvement-plan` does it next, for every item, and lands each automatically or as a card. Drafting here too is what produced two cards per finding.

### Step 4c — Collate for email

Report what **last week's** run of `improvement-plan` did with last week's items, from `improvement-plan-state.json` and `self_improve_approvals`, so each review closes the loop on the one before:

- **APPLIED AUTOMATICALLY** — items landed by `self-improve-auto-apply` since the last review: one line each in plain language, with the commit. Nothing to do; listed so a change they did not expect can be reverted.
- **WAITING ON YOUR SIGNATURE** — cards still unsigned, with how long they have waited.
- **QUESTIONS FOR YOU** — `improvement-plan-state.json.questions[]` still `status: "open"`: each as one plain-language question with its options. These open the ACTION ITEMS section. (Since 2026-10-22 the hum `decisions` lane also asks these in chat one a day and writes their answer back — an entry answered that way, `answered_via: "chat-decision"`, is not listed again; mention it under what they decided this week.)
  Also include every `status: "open"` entry in `cost-efficiency-review-state.json.questions[]` — the daily cost review no longer emails (2026-10-06), so this section is the only place its decisions reach the user. Tag them `(cost)`. When they answer one in the review thread, write `status: "answered:<their words>"` back on that entry.
- **COST FIXES APPLIED THIS WEEK** — from `cost-efficiency-review-state.json` `history[].routed` over the last 7 days: one line each for what landed automatically (commit) and what was carded, so a cost change they did not expect is visible.
- **CARRIED** — items not reached last week (card cap, a file someone else was editing, the turn ran out), so nothing is silently dropped.

And for **this** week's items, the forecast: how many look likely to apply themselves versus need a card (`landing_hint`), stated as a forecast.

## Step 4d — Persist load-bearing state NOW (before the email)

> **This ordering is the fix for the state-finalization cutoff (2026-06-28).** Twice in a row a run applied + committed improvements but `nightly-review-state.json` never updated — `last_run` stayed days stale and the applied list stayed `[]` — because the expensive email build/send (Step 5) and the bulk state write (Step 6) sat *after* the apply gate, and the run's turn budget ran out / the session rotated before they ran. The email is recoverable; the bookkeeping is not. So write the load-bearing fields HERE, immediately after the stage gate, before spending any budget on the email. (The mechanics changed 2026-08-24 — staging a card instead of committing — but this cutoff risk and its fix are unchanged.)

Do this now — a cheap read-modify-write on `~/Dev/edva/data/nightly-review-state.json`, do NOT defer it to Step 6:
- `last_run` = now (ISO 8601) — this is the completion marker the trigger/doctor read to know the run finalized
- `auto_apply.last_night_staged` / `last_night_blocked` / `last_night_deferred` = the item IDs from Step 4c (empty arrays if none)
- `auto_apply.last_night_classifications` = the full Step 4a array
- `auto_apply.last_night_skipped_reason` = `null` (Step 4b is retired; kept for readers of the old field)

Step 6 below re-writes the complete state (these fields **plus** patterns / context gaps / accuracy backfill / pruning) and is idempotent — if the run reaches it, it simply re-affirms what you wrote here and adds the rest. If the run is cut off any time after this point, the critical record already survives. **Never reorder the email ahead of this step.**

## Step 5 — Build and send email

Write an HTML email body to `/tmp/nightly-review-<YYYYMMDD>.html`. Phone-optimized — short, scannable, no emojis. Any external URL referenced (research links, Anthropic/agent-framework docs, commits) goes through `~/Dev/edva/bin/og-card` — see ops-agent CLAUDE.md → "Use og-card for every URL in outbound email".

**Each section should contain its own inline recommendations**, not just observations. The reader should finish each section knowing exactly what to do.

End with a consolidated **ACTION ITEMS** section — a prioritized list of everything recommended in the memo, tagged by effort and category.

**Write every action item in plain language, for a reader without the background** (the user, 2026-09-29: they won't have the full background on every issue, so each item must say what we're trying to solve and why fixing it matters). Each item is the problem as they would notice it, why it matters now, what the fix would do, and what else it could affect — the same four parts every card and automatic change carries (rubric §1.4). The plan job builds from exactly this text, so an item they cannot understand is also one it cannot build well. Every item here will be acted on — applied, carded, asked or dropped with a reason — so do not pad the list with things not worth doing.

Format:
```
SELF IMPROVEMENT REVIEW — <YYYY-MM-DD>

CONVERSATIONS — [N] messages
[Topics, friction points, automation opportunities.]
Suggested: [specific improvements]

DAILY LOG — yesterday ([N] stops, [N] photos, [resolution_rate]% covered, [name_accuracy]% correct)
[Drift count + breakdown by signal: email-reply / chat-correction / unknown-unanswered / late-confirm / calendar-mismatch / repeat-pattern]
[For each drift item: DRIFT [signal] · stop=HH:MM–HH:MM · was: X (source) → is: Y (per signal) · fix: <file+change>]
[Cross-cutting: resolution rate, answer-loop friction, drift volume trend]

LIVE-DAY ACCURACY — yesterday: covered=X% correct=Y% (N contradicted) calendar=Z% gaps=N
[Yesterday's metrics from `live-day accuracy <YDAY>` — one-line summary]
[Contradictions FIRST: each is a name we asserted and they corrected — say what we said, what they said, and how far off. A confirmed error outranks an absence.]
[If name_accuracy is null, say "no correctable evidence" — do NOT report the coverage number as though it were accuracy. A day can score full coverage while naming the wrong place.]
[Resolution gaps: list each unresolved interval as an action-item candidate]
[Coverage gaps: list each ≥30min daytime gap as a question to the user]
[Calendar misses: each scheduled-but-no-GPS event as a question]
[Corrections that landed this week: the `daily_log_drift[]` rows with `recorded_by: location-confirm` in the window — what we guessed, what they said, promoted or open. (No verified_correctness / streak line: retired 2026-10-06.)]
Suggested: [specific recommendations — confirmed-stops entries, threshold tweaks, re-render triggers, schema fixes]

TRIAGE — [N] emails ([P1] P1 / [P2] P2 / [P3] P3)
[Accuracy, patterns, new senders.]
Suggested: [playbook edits, spam rules, batching]

PULSE — [N] runs, [N] pings
[Engagement, lane performance.]
Suggested: [threshold/weight tuning]

HUM — IMPROVEMENT LOOP
[From `hum-ideas-brief` (Step 2 item 14). One line on what landed on its own this week. Then each bigger change that needs their call, in plain language: what hum does today that is not working, why it matters, what the change would do, what it could affect. Omit the section entirely when `structural[]` is empty and nothing landed.]

SELF-REPORT ACCURACY — how often Edva was wrong about Edva
Alerts: [noise_active] of [clusters_active] alert clusters this week were noise ([noise_rate]); all time [noise_all_time] of [clusters_all_time]. Last week: [prior].
Fixes: [self_misreport] of [applied] fixes applied this week corrected Edva misdescribing its own state ([self_misreport_rate]). Last week: [prior].
[Numbers verbatim from Step 2 item 12. Name the two or three largest instances in a line each. If the rate went up, that is an action item: the shared cause (a status vocabulary, an exit code read as failure, a check that cannot tell "could not check" from "fine"), not one patch per instance.]

SYSTEM
[Cost, health, open issues — current only.]
Suggested: [fixes for open issues]

ECOSYSTEM
[Claude Code updates, Anthropic news, community innovations — new items only.]
Suggested: [features to adopt, upgrades to make]

RESEARCH
[Memory, autonomy, RL findings — practical only.]
Suggested: [architectural changes with effort estimates]

TOOLS & INTEGRATIONS — new external capabilities
[3-6 proposals, each with one-line unlock · stack · classification · blocker]
[Classifications: [auto-apply] (accept dispatches ops-agent to build) | [needs-setup] (the user does manual step first) | [moonshot] (research / big build)]
[Grounded in today's moments where possible]

CONTEXT GAPS — what would make Edva smarter
[3-5 specific information gaps from today's interactions]
For each: Gap → What it unlocks → How to close it (infer / sensor / app feature / ask once / ask in context)
[Privacy: low/med/high] [Effort: quick/half-day/multi-day]

SKILLS TO ADD OR IMPROVE
[Updates to existing skills: skill name → specific edit needed]
[New skills proposed: name, one-line description, recurring pattern captured, motivating moments from today, expected call sites]
[Skills to retire (if any)]
[Or: "No skill updates or new skills warranted this cycle." explicitly — do not silently omit]

STAGED FOR YOUR APPROVAL TONIGHT [N] — cards posted to the Improvements channel
1. [<category> · <risk>] <title>
   tests: <N> passed · doctor: <M/T → M/T> · critic: <SAFE|DEFER_TO_OPERATOR: …> · approval id <id>
2. ...
Nothing above is applied yet — approve or decline each from its own card.
[If the kill switch is off, omit this section.]

BLOCKED [M]
1. <title>
   Reason: <policy_violation | test_failure | doctor_regression | critic_revert>
   Item text: <…>
[If the kill switch is off, or none blocked, omit this section.]

AUTO-APPLY CLASSIFICATION (staging disabled)
Total items classified: N
  low: X · moderate: Y · high: Z (of which R forced-high by rails)
Would stage for approval if enabled: <csv of IDs>
Would need your input regardless: <csv of IDs>
Nothing was drafted tonight. Classification data at data/self-improvement-classifier-feedback.jsonl.
[Omit this section entirely when the kill switch is on.]

ACTION ITEMS (prioritized)
1. [P1 — critical] description [category] [effort: quick/half-day/multi-day]
2. [P2 — important] description [category] [effort]
3. [P2 — important] description [category] [effort]
4. [P3 — nice to have] description [category] [effort]
5. [P3 — nice to have] description [category] [effort]
...
Reply: "1: YES" / "2: NO" / "3: LATER" etc.
```

Deliver — email, Gmail labels, phone pointer and push in ONE command (2026-10-05: delivery via digest-deliver; the Step 7 pointer + push moved here). `bin/digest-deliver` sends, finds the message by exact subject (bounded wait), labels `personal` + star + mark read, verifies it is still in the INBOX, then sends the pointer and the push. Do not hand-run `email-send`, `gmail-action`, `edva-send-curl` or `edva-notify` for delivery. **No `p1`** (a Edva-initiated digest is not P1 per the 2026-08-17 correction) and no P1 triage-style re-notification — the pointer is the only ping. No content on the phone channel — the full review lives in email:
```bash
HOME_TZ=$(node ~/Dev/edva/lib/instance.cjs tz)
DATE=$(TZ=$HOME_TZ date +%Y-%m-%d)
SUBJECT="Self Improvement Review — $DATE"
~/Dev/edva/bin/digest-deliver \
  --subject "$SUBJECT" \
  --body-file /tmp/nightly-review-$(TZ=$HOME_TZ date +%Y%m%d).html \
  --intent nightly-review \
  --pointer "Self Improvement Review emailed — [one-line summary of top action item]" \
  --push "Self Improvement Review for $DATE is in your inbox"
```

Exit 0 = done. Exit 1 = the email did not send and nothing else ran — note it and carry on to Step 6 (state must still be written); do not hand-run the pieces. Exit 2 = sent but unlabeled (Gmail had not indexed it in time; pointer + push still went) — no further action.

## Step 6 — Update state (full, idempotent)

This re-writes the complete state. The load-bearing subset was already written in Step 4d — re-affirm it here and add the rest; do NOT skip this step just because 4d ran. Everything below is idempotent (set-to-current-value), so re-writing `last_run` / `last_night_staged` / `last_night_classifications` is harmless.

Update `~/Dev/edva/data/nightly-review-state.json`:
- Set `last_run` to now (ISO 8601)
- Append this run's action items (top 5) with `status: "pending"`, `response: null`. **Each suggestion additionally carries the Step 4a classification fields:** `risk`, `risk_before_rails`, `category`, `classifier_rationale`, `rails_hits`, `auto_actionable`. Staged items also carry `self_improve_request_id`, `critic_verdict`, `doctor_before`, `doctor_after`, and (when blocked) `reverted_reason`
- Update `auto_apply.last_night_classifications` with the full JSON array from Step 4a. If the kill switch was on, also populate `auto_apply.last_night_staged`, `auto_apply.last_night_blocked`, `auto_apply.last_night_deferred` with the item IDs from Step 4c
- Set `self_report_noise` to this week's Step 2 item 12 output (`window`, `alerts`, `fixes` minus the per-card lists) plus `labels` (the id → true/false map you wrote). It is overwritten weekly: the record of last week's number for next week's trend line, not a running counter
- Update `patterns.frequent_asks` based on conversation analysis
- Append new context gaps to `context_gaps` array with `status: "open"`. Mark as `"closed"` when the gap is resolved (feature built, question asked, inference implemented)
- Append new skill proposals to `skill_proposals` array with `status: "pending"`, `proposed_at: now`, `response: null`. Mark as `"accepted"` / `"rejected"` when the user replies. Do not re-propose rejected items unless conditions materially change; do not re-propose pending items <7 days old
- Append new integration proposals to `integration_proposals` array: `{id, name, unlock, stack, classification: "auto-apply" | "needs-setup" | "moonshot", blocker, status: "pending", proposed_at, response: null}`. Same 7-day cooldown on pending; rejected entries stay to block re-proposal. When the user replies `N: YES` for an `[auto-apply]` item, chat-agent dispatches to ops-agent per the Tools & Integrations Acceptance flow and this field advances `pending → auto-applied` on successful build (or `pending → rejected` on reply `NO`)
- Append yesterday's `live-day accuracy` output to `live_day_accuracy[]`. **Take this snapshot nightly and never recompute it later:** `name_accuracy` grades the archive as it stands, so once a correction lands and the archive is regenerated the wrong name is gone and the day becomes ungradeable — 2026-08-10 already shows every interval as `user_confirmed` and cannot be scored at all. The stored row is the only durable record that we were wrong. (per the shape in Step 3 § "Live-Day Accuracy Verification"). No `verified_correctness` back-fill and no streak — retired 2026-10-06. Prune `live_day_accuracy` entries older than 60 days.
- Append every Daily Log drift surfaced this run to `daily_log_drift[]` per the shape in Step 3 § "Daily Log accuracy". Auto-promote rule: **a single drift entry from an authoritative signal** (`signal ∈ {email_reply, chat_correction, unknown_answered, late_confirm}`) is sufficient to add the `expected_name` to `confirmed-stops.json` at that centroid (radius 30m, conf 0.95). Heuristic signals (`signal ∈ {calendar_mismatch, repeat_pattern}`) do NOT auto-promote — they surface as ordinary action items for the user to confirm. The classifier should score the auto-promote `low` → eligible to be drafted and staged. Once the resulting card is approved, mark the matching drift entry `fix_status: auto_resolved`. Items resolved by a later re-render or manual patch advance `open → patched` when detected. (Pre-2026-04-30 this required ≥3 corrections at the same centroid; lowered to 1 because the user's answers ARE authoritative — the user-confirmed precedence rule already trusts every reply absolutely.)
- Prune suggestions older than 30 days. Prune closed context gaps older than 14 days. Prune resolved skill proposals older than 30 days. Prune resolved integration proposals older than 60 days (longer retention — integration history is reference material for future reviews). Prune `daily_log_drift` entries with `fix_status: patched|auto_resolved` older than 60 days; keep `open` entries indefinitely (recurring drift is the highest-signal data the loop produces)

## Step 7 — *(Merged into Step 5 on 2026-10-05.)*

The phone pointer + push now go out with the email via `digest-deliver` in Step 5.

## Step 8 — retired (2026-08-24)

This used to send one extra "auto-applied N tonight" phone ping. It no longer does: every change `improvement-plan` lands shows in the Improvements channel on its own (a green check when it applied itself, a card when it needs a signature), and that **is** the surfacing — a second summary ping is redundant noise on top of N individual pushes (same reasoning `hum-action-executor.md` already documents for its own staging loop: "silent on a clean run... no digest section, no extra ping"). The Step 5 email is still the full-context record; nothing sends here.

## Edge cases

- **First run / no data**: Send a short email: "Self Improvement Review — first run. Not enough data for analysis yet. Tomorrow's review will have a full day to work with." Update state file with last_run only. Exit.
- **Ops-agent unhealthy mid-run**: If tool calls fail, send whatever partial analysis you have. Note the failure in the email.
- **Empty conversations**: Skip the conversations section. Focus on other sections.
- **Stale issues**: If a watchdog alert or system error was already fixed (check git commits), mark it as "resolved" in the report — do not list it as an open action item.
