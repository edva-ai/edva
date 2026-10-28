Daily review of where Edva's Max-subscription budget actually went, and what to cut. Runs as an ephemeral Opus 5 agent at 02:40 local.

> **This instance's additions** to this playbook (its own people, places and decisions) are in `agent/local/jobs/cost-efficiency-review.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (an ephemeral or by-hand run), `Read` that file before you start.

## Purpose

Edva spends the user's weekly Max budget continuously and silently. On 2026-08-05/06 a single overnight window burned **a large slice of the weekly cap — at that pace, most of the week's allowance** — and nothing in the system noticed. The `nightly-review` job has a cost lens, but it runs weekly (Tue) and looks at *jobs*, which cannot see the actual failure: **85% of that spend was cache traffic, not work** (45% cache-write, 40% cache-read, 13% output).

That failure is structural, not per-job. A job whose every dispatch re-writes a 100k-token prefix looks identical, in a by-job table, to one doing real work. This job exists to watch the **structure**: the context floor, the working window above it, and the compact/rotate churn that follows when the window closes.

**Output: no email, no ping, ever (2026-10-06).** Every finding ends as exactly one of: a change landed by `self-improve-auto-apply`, a Face-ID card in Improvements, a question in `questions[]` for the weekly Self Improvement Review, or a note in state. The user's rule: the results and suggestions are built automatically, or go to the improvements review when they need a decision. See § Step 5.

## Why daily, and why Opus

Daily because the failure mode is a *drift*: the floor grows a few thousand tokens at a time as CLAUDE.md sections, MCP servers, and skills accumulate, and each addition is paid on every dispatch forever. A weekly cadence lets a week of overspend land before anyone looks.

Opus 5 because this is an improvement process, and the user's standing rule is that every improvement-related process runs on the Opus tier — and because `"model": "opus"` in `job-routing.json` is only a TIER label that routes to the Sonnet supervisor (the 2026-07-28 lesson). It runs via `lib/run-ephemeral-opus.sh`, launched by **launchd, never cron** — a `claude -p` under cron cannot unlock the keychain holding the Max credentials.

## Pipeline

### Step 0 — Read the measurement (already fetched)

The trigger script has already written today's report to
`~/Dev/edva/data/cost-efficiency-today.json` — the output of
`edva-cost-report --since 24h --efficiency --json`. **Read that file; do not
re-run the report.** The fetch happens in the un-sandboxed trigger process for
the same reason `chat-consolidate` does it there.

**What that payload can and cannot see (2026-10-06).** It carries a `coverage` key; read it. `by_tier` rolls up the three supervisor ledgers **plus `logs/ephemeral-forks/job-costs.ndjson`**, which every Opus launchd fork (via `run-ephemeral-opus.sh` and the installation's own fork triggers), the supervisor's `web-read` helper and the installation's own `claude -p` tools now write from their own `claude -p --output-format json` usage (`bin/fork-cost-record`, rows tagged `runner: "ephemeral-fork"`) — so this job's own cost is on the ledger from 2026-10-06. **An `opus` 0 is still a blind spot, not a measurement, on any window before 2026-10-06**, and the fork ledger still misses forks killed by their turn cap, `run-ephemeral-fable.sh`, the opus escalation tier of `day-statements` (`daily-summary-review` writes `daily-summary-review:review` / `:repair` rows since 2026-10-15, as its default reviewer is now Opus), and `job-run` forks. (`local` is blind permanently: local Gemma writes no row.) Opus 5.5 is priced at its own $4/$20/$0.20 per Mtok via `MODEL_RATES` in `edva-cost-report`, not Opus 5's tier rate. A **non-zero** opus row with zero tokens is still unattributed turns (empty `models[]`, priced as opus deliberately). `edva-allowance-coverage --since <window>` cross-checks against the transcript tree and now counts a fork workload as on-ledger when the fork ledger has rows for it; do **not** add its dollars to these (its Sonnet rate table differs). **Transcript-derived figures before 2026-10-11 are inflated 1x-3x:** that tool and `self_cost_series` summed every transcript line, and a multi-block reply repeats its usage on each line. Both now count each message id once, and the coverage tool includes `<session>/subagents/` transcripts. Never compare a pre-10-11 coverage %, off-ledger dollar figure or self-cost to a later one.

**Dated prices, and a one-time Sonnet step (2026-10-13).** Anthropic cut Sonnet 5.5 cache reads from $0.20 to $0.10 per Mtok on 2026-10-07 and launched Haiku 5.5 (`claude-haiku-5-5`) the same day. `edva-cost-report`, `edva-allowance-coverage` and both transcript scans in `cost-review-prefetch` now price each row or message at the rate in force when it was spent (Sonnet 5.5 cache read $0.20 before 2026-10-07, $0.10 from it; `claude-sonnet-5` unchanged; Haiku 5.5 at its own rates, its long-prompt price charged in the report whenever a row's prompt total is over 100k because the ledger cannot see per-request length). The report re-prices every row on each run, so any Sonnet `weighted_cost_usd` covering 2026-10-07 onward reads about 20% lower than the same window measured before 2026-10-13. **That step is a price correction, not a saving:** never credit it to a cut, and re-base a stored Sonnet baseline before comparing against it. The same goes for the per-job cost index: today's `usd_per_run` for Sonnet lanes (`gmail:*`, `hum`, `hum:moment`) is re-priced while its 30-day band still comes from the SDK's own cost figure, which keeps pricing Sonnet 5.5 cache reads at about $0.20, so those lanes read below their bands (on 10-13, by roughly a quarter each). Do not report that as a step-down until the band is rebuilt on the dated rates. `--push` re-sends only the last 2 days, so the hosted /usage series keeps 2026-10-07..10-11 at the old price unless someone runs a one-off `edva-cost-report --since 8d --push`.

**Sessions no ledger sees, and the ops-dir split (2026-10-09).** `offledger_sessions` in the derived file lists every transcript in the three supervisor project dirs whose session id appears in no ledger row, de-duplicated by message id and priced at list rates. Its first night it found a `job-run` Sonnet fork that builds a daily digest (one of the larger daily lines, tens of turns a run) which no earlier run of this review had ever seen, plus the installation's own forks and pre-10-06 Opus forks. Read it before any composition or allowance claim: those dollars are in none of `weighted_cost_usd`, `top_jobs` or `by_tier`. The same change split `mcp_tool_listing`'s ops-agent dir three ways: `ops` (supervisor sessions only, matched by ledger session id), `opus-forks` and `sonnet-forks`. Before it, fork listings were read as the supervisor's.

Also read:
- `~/Dev/edva/data/cost-efficiency-review-state.json` — the baseline and the last N days of headline numbers.
- `edva-cost-report --since 7d --efficiency --json` output at `~/Dev/edva/data/cost-efficiency-7d.json` (also pre-fetched) for trend.

### Step 1 — Compare against baseline

The state file carries the **baseline** (the 2026-08-06 measurement, when this job was built) and a rolling history. Compute, for the last 24h:

| Metric | Baseline (2026-08-06) | Why it matters |
|---|---|---|
| `context_overhead_pct` | **85%** | share of spend that bought context, not work. **A tripwire, NOT the headline** — see below. |
| `weighted_cost_usd` (24h) | see `baseline` in state | absolute burn |
| `top_jobs[].usd_per_run`, stable set | see `job_cost_index` in state | **the headline** — the only mix-robust efficiency signal |
| `cost_per_1k_output_usd` | **$0.10** | efficiency — what a unit of real output costs |
| `turns_per_dispatch` | **5.1** | the OTHER multiplicand — cache-read is `turns × floor` |
| floor, per supervisor | ops 149k / ops-light 151k / ops-haiku 110k | the irreducible prefix |
| working window | ops 36k / ops-light 34k / ops-haiku 75k | room for real work before a rotate |
| compacts + rotates (24h) | 101 compacts / 29 rotates | churn caused by a closed window |
| `max_usage.seven_day_peak` | not captured until 2026-09-02 | **the only NON-estimated number here** — Anthropic's own metering of the weekly Max allowance |

**The churn counters are a lower bound whenever `churn_partial` is true (added 2026-08-14).** `compacts` / `rotates` / `compacts_skipped` are counted from `agent/logs/supervisor-*/events.ndjson`, which the supervisor **rotates on size**. A window starting before the live file does sees only its tail, and the report used to render that shortfall as a zero — indistinguishable from a supervisor that genuinely never compacted. Each supervisor now carries `events_coverage_from` and `churn_partial`; when the flag is set, **do not reason about that tier's churn at all** and say so rather than reporting the number. Measured the day this shipped: `ops-light` rotated at 00:45Z and reported "0 compacts, 1 rotate" for a window it covered 79 minutes of, while its 7d view claimed 0 compacts across 197 sessions. That undercount had already been misread across several entries in state as `compacts_skipped` "migrating between tiers" — it was migrating between *log rotations*. **Floors are unaffected**: they come from `job-costs.ndjson`, which is not rotated this way.

**The supervisor event logs ARE readable from this agent turn — the runtime floor question is answerable (settled 2026-08-14).** State carried an open item saying otherwise ("no `*.ndjson` resolves under `data` inside the sandbox… DO NOT RETRY IT FROM THE AGENT TURN"), and it was simply looking in the wrong place: the ledgers live at **`agent/logs/supervisor-<tier>/events.ndjson`**, not under `data`, and they read fine. The question it blocked is now closed as a negative — see § The runtime floor below.

**Neither `context_overhead_pct` nor `$/dispatch` measures efficiency — use the per-job cost index (2026-08-08).** Two clean post-extraction days proved both are mix-dominated. Cutting the floor 23k shrank cache-write and cache-read in nearly the same proportion, so overhead sat at 85.0 → 84.1 → **85.3%** — numerically *above* baseline — on a day `location-enrich` cost 40% less per run and `session-handoff` 57% less. `$/dispatch` failed the same way from the other side: flat to within a third of a percent, because the day's mix shifted toward long-turn research jobs while the high-volume jobs got cheaper. Reporting either as the headline would have said "no progress" about a change that plainly worked.

So: **rank cuts and report wins in $/day, and judge efficiency on `usd_per_run` for a fixed set of high-volume jobs day over day** — `location-enrich`, `session-handoff`, `hum`, `hum:moment`, `context-guard`. (**Since 2026-10-04 `session-handoff` has no rows of its own** — the digest is built in code and prepended to the fresh session's first real dispatch, and ops-light/ops-haiku rotate instead of compacting, so `context-guard` rows come from ops only. A zero for either after that date is the change, not a gap; count rotations from the `session_handoff.injected` events, which `edva-cost-report --efficiency` reports as `handoffs`.) Record them as `job_cost_index` in state each run (Step 6) so tomorrow compares like with like. **`gmail:*` joined the set on 2026-10-07** (email triage, ~30-40 runs/day, folded from `gmail:<id>`). Three of the original five became structurally thin within three days, each by design: `session-handoff` and ops-light's `context-guard` on 10-04, and `location-enrich` on 10-05, when it moved into code (the agent only sees residue). Their rows stay in the index and report as non-comparable. A thin day for any of those three is the change, not a gap.

**An index member that barely ran is NOT comparable, and must not be recorded as a bare number (added 2026-08-31).** Mark each member `comparable: false` with a `reason` when either test fires:

- **Thin volume** — the day's `runs` is below 25% of that job's own 7d daily median (from `cost-efficiency-7d.json`: `runs / 7`). A `usd_per_run` over 1–2 runs is a coin flip, not a measurement.
- **Known degradation** — the job's own state file says it is blocked or paused (the local additions name each job's budget-state file); check the job's drop log for the named cause rather than inferring one.

A job absent from `top_jobs` entirely is **unknown, not zero** — `top_jobs` is a top-12 cut, so absence means "below the cutoff," which is exactly the thin-volume case. Never write `runs: 0` for it without confirming against the raw ledger (`agent/logs/supervisor-*/job-costs.ndjson`).

*Why this is a rule.* On 2026-08-31 the index's highest-volume, best-sampled member ran **once**, against dozens a day on the three preceding days, because a paid API budget it depends on had been `level: "blocked"` for ten days. Nothing in the index would have said so: 2026-08-26 already carries a bare `runs: 0` for it, indistinguishable from a genuinely quiet day. This is the same defect family as `cost-churn-coverage-20260814`, `cost-skip-episodes-20260819`, `cost-history-row-durable-20260825` and `cost-mcp-floor-sweep-20260827` — **a measurement that reads a degraded or absent input as a valid value.** The metric this whole job is judged on cannot be the one place that mistake keeps landing. Keep `context_overhead_pct` only as a jump detector: a sudden *rise* still means something broke, but its absolute level says almost nothing.

**Flag a REGRESSION when any of these hold:**
- `context_overhead_pct` rose more than 5 points vs the 7-day median
- any supervisor's **`floor_attribution.tiers[].prefix_floor_tokens`** grew more than **1.5k in one day, or 3k across three days** — measured against the rolling `history[]` entries in state, **not** against `baseline.floors` (fixed 2026-08-10). The old test read "more than 5k vs the recorded baseline", and `baseline.floors` is the 2026-08-06 *pre-extraction* measurement (ops 149k). Once the extraction cut the floor to ~126k, the tripwire could not fire until the floor had regrown the whole 22.6k *and* 5k on top — so it was structurally dead for exactly the period it was built to watch, staying silent through +253, +612 and then **+3,256** token days on ops. Treat `baseline.floors` as a historical marker, never as a threshold: compare today against yesterday's `history[]` entry and against the entry three days back.
  **A 1-day floor delta must be CORROBORATED ACROSS TIERS before it counts (added 2026-08-11, after the rule above false-positived on its first day of operation).** All three ops tiers read the same always-loaded files, so a real content change moves all three *in proportion to their tokenizers* — the standing `ops-haiku`:`ops-light` ratio is **0.725**, stable to 0.2% across four days. That makes the ratio a free discriminator between content and noise:

  - **Corroborated** (→ flag): the `ops-haiku`:`ops-light` *delta* ratio lands within about ±0.15 of 0.725 and the signs agree. Worked example, 2026-08-10's genuine +7,282-char commit burst: deltas +3,256 / +3,869 / +2,823, haiku:light = **0.730**. Real, and it would still fire under this rule.
  - **Uncorroborated** (→ record in state, do not flag): the deltas are not in proportion. Worked example, 2026-08-11: deltas +1,703 / +1,011 / +240, haiku:light = **0.237** and ops:light = **1.68** where the day before it was 0.84. No file that all three read can produce that.

  Two supporting checks, both cheap, and **do the mtime one first** — it is one command and it settles most cases outright:
  1. **`stat` the always-loaded surfaces**, do not just `git log` them. On 2026-08-11 the shared `agent/CLAUDE.md` had an mtime nearly two days older than the window while 36 commits landed elsewhere in the repo, which proved no ops-tier prefix had changed — committed *or uncommitted*. `git log` alone cannot see a working-tree edit, and the live agents read the working tree, not `HEAD`.
  2. **Weight by `floor_samples`.** A tier with fewer than ~12 measured session starts does not get to raise a 1-day flag on its own; defer to the best-sampled tier. On 2026-08-11 the two anomalous deltas came from the two thinnest samples (ops 9, ops-haiku 6) while the well-sampled tier (ops-light, 31) moved +1,011 — *below* the very threshold ops tripped.

  The **3-day test is unchanged and needs no corroboration** — it integrates over enough sessions that sampling noise averages out, and it is what actually catches sustained creep. This rule only restrains the 1-day test, and by construction it cannot hide a real shared-file change, because a real one is visible on all three tiers.

  **Read the PREFIX floor, never `floor_tokens` — the reported floor is mix-contaminated (added 2026-10-06).** `floor_tokens` and the guard's runtime `floorTokens` both measure ONE SESSION's uncompactable context, and that includes the dispatch message itself — which for a scheduled job is its whole playbook, injected inline. `jobs/hum.md` is 95,659 chars, ~33k tokens at the calibrated ~0.35 tok/char. So a tier's reported floor is decided by **which jobs happened to start sessions in the window**, not by the always-loaded prefix.

  Worked example, the night this shipped — and it is the night a ~24k cut was due to be measured. ops-light's 19 session-start floors were **bimodal**: `gmail:*` (n=6) 126,168-128,761, `chat-consolidate` 127,106, a watch job 126,737 — the real post-cut prefix, **-23,500 against a predicted -23,970** — against all eight hum-family sessions at **159,851-160,484**, straddling the 160,000 cliff. The ledger median landed in the high mode, so the tier reported floor **160,484 (+9,998)**, working window 24,516, and fired `compaction_died_on_a_live_session` — on a night its prefix had FALLEN 23,500 tokens exactly as predicted. Read naively that is a floor regression and a dead compactor; both are artifacts of job mix.

  `floor_attribution.tiers[]` carries `prefix_floor_tokens` (the lightest dispatch cohort with n>=3, falling back to the outright minimum), `payload_inflation_tokens`, `working_window_on_prefix_tokens` and the full `floor_by_source` breakdown. Flags: **`floor_reading_is_mix_contaminated`** (lightest-to-heaviest gap >5k — the reported floor is not comparable day over day), `prefix_floor_thinly_sampled`, `prefix_floor_above_min`, `prefix_floor_unmeasured` (no session start measured a floor — unmeasured, NOT clear). Record `prefix_floors` in state each run so tomorrow compares like with like.

  **The per-session floor in `rotation_overhead.bands` is unchanged and still correct for the cliff question** — a hum session genuinely cannot compact. What changed is only which number the always-loaded tripwires read.

- any supervisor's `working_window_tokens` fell below **40k** (below that, a session does 2–5 dispatches before a rotate and most spend is re-loading context)

  **`floor_tokens` is the CURRENT floor, not the window average** (fixed 2026-08-07). It is the median of the most recent run of session starts that agree with each other, so a config change landing mid-window reports the *new* floor rather than a blend of both. Read `floor_second_half - floor_first_half` (the `shift` column) alongside it: a large value means the floor moved *during* the window, and `floor_tokens` is the value on the far side of that move. `floor_window_median` preserves the old whole-window statistic for continuity — do **not** regression-check against it, it is the number that hid a 23k cut. Also check `floor_samples`: a floor derived from 2–3 starts is a hint, not a measurement. `floor_samples_rejected` (added 2026-10-07) counts session starts thrown out because their reading exceeded the rotate threshold. One turn cannot read more prefix than the context holds, so such a row is another dispatch's usage landing on it, not a floor. A single one (hum:moment, 2026-10-06T09:41Z, 1.54M) had made the 7d ops-light floor read 1,540,772 with a working window of 0. Non-zero means a ledger artifact. If it ever climbs steadily, check whether a real prefix has outgrown 185k.

  **A floor is only comparable to ITSELF, never across model families (measured 2026-08-08).** A floor is a token count reported by the model that produced it, and Haiku counts the same text ~0.73× what Sonnet does. Two independent measurements agree: the identical symlinked text the 2026-08-06 extraction removed cost 22.6k tokens on each Sonnet tier but 16.6k on `ops-haiku` (ratio 0.732), and the standing `ops-haiku`:`ops-light` floor ratio is 0.725 both before and after that cut. **`ops-haiku`'s floor looking ~35k smaller than `ops-light`'s on byte-identical config is therefore arithmetic, not 35k of recoverable content** — scaled to Sonnet-equivalent tokens the residual gap is ~1.2k. This closes the `open_thread_ops_haiku_floor_gap` carried since 2026-08-07 as a definitive negative: **it is not a lever, do not re-open it.** The same caution applies to `working_window_tokens`, which is `185_000 - floor` for every tier regardless of model; it is internally consistent per supervisor (the context guard compares against the same counter) and meaningless across them.
- 24h `weighted_cost_usd` is more than 1.4× the 7-day median
- `compacts_skipped_episodes` is high while `rotates` is also high — the floor has grown past the point where compacting helps at all. **Read the episode count, never the raw `compacts_skipped` (added 2026-08-19).** A skip is a *poll*, not a condition: the guard re-checks on a fixed ~90s tick, so one session it cannot compact emits an identical event until something else moves it. Measured the day this shipped — `ops-light` logged **19 skips inside 27 minutes**, every one reading context 180,533 / floor 162,232 / compactable 18,301, cleared by a rotate; that is `19/1ep`, one session having a bad half hour, not a fleet-wide compaction failure. Skips are also **free**: they do not create a `context-guard` job run (its run count equals total *compacts*, 1:1), and no dispatch landed during that window. A single episode is worth recording and not worth proposing against; reach for `compacts_skipped_stuck_min` to size it, and escalate only if episodes exceed ~1/day or a dispatch is measurably delayed by one — the latter is reliability, which belongs to `watchdog.sh` and `system-issue-review`, not here.
- **The live compact band fell under 10k tokens on any tier, or a tier is within 10k of the compaction cliff (added 2026-09-24).** Read `rotation_overhead.bands` in the derived file; do not re-derive it. A `/compact` fires only when `ctx` is in `[COMPACT, ROTATE)` **and** at least `MIN_COMPACTABLE` sits above the floor, so the band a session can actually compact in is `[max(COMPACT, floor+MIN_COMPACTABLE), ROTATE)` — it **narrows as the floor grows**, and at `floor >= ROTATE - MIN_COMPACTABLE` (160,000 today) it is **empty and the session can never compact at all**. `context-guard.mjs` has said this in prose since 2026-08-06; until this block nothing measured it, and the 40k working-window alarm does not substitute — it says the floor is big, not what breaks.

  Measured the day this shipped, the first with both Sonnet floors above `COMPACT - MIN_COMPACTABLE`: `ops-light` band **15,000 -> 6,792 tokens (-55%)** and **6,792 from the cliff**, with 95 skip polls / 11 episodes / 126 minutes parked against 3 compacts and 22 rotates; `ops` band 9,528, dead zone 5,472. Four `ops-light` episodes parked **282 / 414 / 613 tokens short** of the 25,000 threshold.

  **`tokens_to_compaction_death` is an UPPER bound on a live session's margin, not the margin — read `past_cliff_episodes` for the condition itself (added 2026-10-01).** The margin is computed off the **session-start** floor; the guard gates on the **runtime** `floorTokens` at poll time, which carries whatever uncompactable content the session has picked up since it started. So the cliff can be crossed while the margin still reads healthy — and it was, on 2026-09-29: ops parked at runtime floor **161,427** (36 polls, ctx to 175,985) and ops-light at **173,040** (20 polls, ctx to 184,988, twelve tokens under `ROTATE`), both past the 160,000 cliff, on a night `compaction_death_margin_under_10k` was **empty** and the margins read 14,901 / 12,259. The flags were not wrong about their own quantity; the quantity was the wrong one — the same family as `cost-churn-coverage-20260814`, `cost-skip-episodes-20260819` and `cost-index-comparability-20260831`.

  `rotation_overhead.bands` now carries `max_skip_floor_tokens` / `past_cliff_polls` / `past_cliff_episodes` per tier, read off `context_guard.compact_skipped` events, with flag **`compaction_died_on_a_live_session`**. Count **episodes, never polls** (a poll is a fixed-tick re-check — the 2026-08-19 lesson). A tier with no skip polls lands in `live_margin_unmeasured` and is **unmeasured, not clear**. Direct cost is ~**$0.13 per occurrence** (a rotate standing in for a compact), so this is an instrument rather than a cut: judge it on whether it sees the next crossing. Skip events stay OUT of the floor *estimate* — that is settled as `runtime_floor_closed` (2026-08-14) and this does not reopen it; they are used only where the tail itself is the question.

  **Do NOT reach for the tempting fixes.** Lowering `MIN_COMPACTABLE_TOKENS` re-opens the 2026-08-06 runaway it was added to stop; raising `CONTEXT_ROTATE_THRESHOLD_TOKENS` spends the overflow margin. **Parking is also NOT the defect** — the context-guard header measures it as cheap and correct, and it is. The remedy is the one that file already names: **cut the floor.** This tripwire exists to say how much room is left before the guard stops working, not to propose against the guard.

- **Rotation overhead rose, and the number to read is the UNIT cost (added 2026-09-24).** *(From 2026-10-04 there is no `session-handoff` row to price: the rotation's cold write lands on the first real dispatch of the new session instead, and the rotation cap counts dispatches, not tool steps — so expect this series to fall sharply and then go quiet. Do not report the drop as a regression in rotation tracking.)* `rotation_overhead.series` carries, per day, `session-handoff` + `context-guard` as a share of raw spend plus its two multiplicands. **The COUNT of rotations is volume-driven and noisy** — this is why the 2026-09-21 run checked handoff-per-dispatch, found it inside its own range, and correctly declined to claim a second-order floor cost. **`usd_per_handoff` and `cache_write_per_handoff` are not noisy**, because a bigger floor means each rotation cold-writes a bigger prefix. Flag when `rotation_pct` on the latest FULL day exceeds 20%, or `usd_per_handoff` lands outside its own 14-day pre-step range. Worked example, 2026-09-23: share 22.6% (14-day range 9.5-22.6), `usd_per_handoff` **$0.360 against a 09-10..09-18 mean of $0.258**, `cache_write_per_handoff` **91,209 against a prior max of 74,899** — a few dollars a day raw attributable to the unit-cost step alone. **Never compare against the last series row**; the window ends mid-date and that row is flagged `partial_day`.

- **A `context-guard` row read more than ~1M cache tokens — a `/compact` that ran away (added 2026-08-21).** A normal compaction reads roughly one pass over the context (~170-185k) and costs $0.18-$0.28; about 2% instead read 1-8M and cost $1.29-$6.73. **`$/run` will not tell you this and neither will `turns_per_run`** — the guard dispatches `/compact` with `num_turns: 0`, so a single runaway just inflates the day's average and reads as tier mix. Check the *rows*: filter `source == "context-guard" && cache_read_tokens > 1e6` in `agent/logs/supervisor-*/job-costs.ndjson`. The trigger looks normal every time (`context_guard.compact` with ctx 172-185k, compactable 45-55k), so the `events.ndjson` side tells you nothing on its own. Each one emits a **`context_guard.compact_runaway`** event followed by a rotate within a minute — a runaway row with no matching event means the detection is broken, not that the cost is new.

  **A flagged row is NOT automatically a runaway compaction — check that it could have BEEN one (added 2026-09-08).** The SDK attributes a turn's usage to whichever dispatch id closes, so a `/compact` enqueued while the session has async `Agent` subagents or an unfinished turn in flight collects *their* usage on its row. Two free discriminators, both decisive: **a compaction issues no web searches**, and **it is not a turn loop** (`num_turns` 0, occasionally 1). Either `web_search_requests > 0` or `num_turns > 1` means the row is another job's work wearing the compactor's name — read the session transcript before crediting or blaming the guard. Also sanity-check the rate: 1,206,254 cache tokens in 2,218 ms is 544k tok/s and is not a read. Over all 669 rows ever flagged, 41 (6.1%) fail one of these tests. **This contaminates the `compact_runaway_fix_20260821` measurement** — at least 4 of the 9 rows since 2026-07-22 carry web searches, so the pre-fix base rate that card was scored against is overstated.
- **`max_usage.seven_day_peak` reached 0.80, or `seven_day_warn_samples` is above zero (added 2026-09-02).** Every dollar figure in this report is an estimate; this one is not. It is the utilization Anthropic returns on every turn, and it measures the constraint that actually binds — **the weekly Max allowance is a cliff, not a slope.** `overage_available: false` (`overageDisabledReason: "out_of_credits"`) has held on every sample we hold, so above 1.0 there is no degraded mode: per the auth model in `agent/CLAUDE.md`, Edva is down, and routing around it is forbidden.

  **Read the PEAK and the TRAJECTORY, never the latest sample** — the counter zeroes on the window boundary, so a low reading means "early in the window", not "plenty of room". Worked example, the run that added this: 2026-09-01 peaked at **0.83** with **126 warning samples**, having climbed 0.25 → 0.37 → 0.56 → 0.71 → 0.83 over four days (~+0.145/day); on that line the window ending 09-03T03:00Z would have exhausted about a day and a half early. The window before it peaked at **0.84**. Two consecutive weeks near the ceiling and none of it was visible anywhere — the signal lived only in `events.ndjson`, which the supervisor **rotates on size**, so the evidence expires. Honour `max_usage.partial`: when true the peak is a LOWER BOUND, same rule as `churn_partial`.

  **A warning is not automatically a proximity warning — read `seven_day_warn_min_util` (added 2026-09-04).** The count alone was wired to this tripwire on the premise that Anthropic warns when you are near the ceiling. That premise expired within two days of being written. Every seven-day `allowed_warning` in the event log from 2026-08-26 to 2026-09-01 fired at **0.75-0.84** utilization; from **2026-09-03T22:30Z** they began firing at **0.25-0.28**, on all four supervisors, 60 samples in one night, in a window whose peak was 0.29. Read as "near the ceiling" that is nonsense. Read as a **pace** warning it is exact: that same window's `segment.window_needs` was 1.80.

  So: a warning at **>= 0.7** means proximity — check the peak. A warning **below** that means the metering is flagging the **burn rate**, and the number to read is `segment.window_needs` / `projected_exhaustion`, not the peak. Those two produce opposite readings on the same day, which is why the band is recorded rather than just the count. Where the 24h and 7d views disagree on the rate, prefer the one whose segment starts at the real window boundary (`util_from: 0`) — a segment that starts mid-window inherits an unmeasured head and understates.

  **This is a capacity finding, not a per-job regression — file it as a `questions[]` entry (Step 4), do not "fix" it.** No single cut moves it; the answer is the fleet's composition, and shrinking a capability the user uses is their call under § Guardrails. Give them the composition instead. Over the 7 days to 2026-09-02: the **hum family was about a third of the week's raw spend** (`hum`, `hum:moment`, `hum-ideation`, `cron-hum-action-executor`), and `session-handoff` + `context-guard` — pure rotation overhead, not work — were another **sixth**.

- **`turns_per_dispatch` rose more than 20% vs the 7-day median, or any single job's `turns_per_run` doubled.** Cache-read is `turns × floor` (verified linear: ops reads 143k at 1 turn, 287k at 2, 434k at 3), so once churn is fixed this is where the money is — at a ~146k floor each round trip costs ~$0.043 whether or not it accomplishes anything.

### The runtime floor — CLOSED as a negative, 2026-08-14

The reported floor was under suspicion for a while: sessions that hit skip-compact logged their own `floorTokens` about **31k above** what the cost report gave, and if that were systematic the real working windows would be ~22k rather than ~53k and the 40k alarm would be calibrated against the wrong number entirely. **It is not systematic — it is a selected tail, and the reported floor is right.** Measured over the 7 days to 2026-08-14 from `agent/logs/supervisor-ops/events.ndjson`:

| event | n | runtime `floorTokens` (min / median / max) |
|---|---|---|
| `context_guard.compact` | 61 | 126,176 / **128,416** / 140,375 |
| `context_guard.compact_skipped` | 16 | 158,934 / **158,934** / 161,044 |

The compact median lands within **0.2%** of the report's `floor_tokens` (128,401), so the estimator is sound. The ~31k gap belongs entirely to the 16 skip events, and that is causal rather than coincidental: a session only *reaches* skip-compact when its uncompactable portion is already huge, so selecting on the skip is selecting on a big floor. **Do not re-open this, and do not add a `floorTokens` pre-fetch to the trigger script for it** — state named that as the blocking dependency, and no such change is needed.

### Step 2 — Attribute any regression to a cause

Do not report "cost went up." Report **what changed**. Check, in order:

1. **Did the floor grow?** A new always-loaded section or MCP server is the usual cause, and it is the most expensive kind of change in the system: paid on every dispatch, forever. Check the surfaces in this order — the first one is a single command and usually ends the search:

   ```bash
   # 1. mtimes FIRST — catches committed AND uncommitted edits. Agents read the working tree, not HEAD.
   #    .mcp.json only NAMES a server; the tool schemas live in the server's own source, so stat those too.
   stat -f '%Sm  %N' -t '%Y-%m-%dT%H:%M:%SZ' agent/CLAUDE.md agent/ops-agent/CLAUDE.md \
     agent/config/agents.json agent/ops-agent/.mcp.json bin/wiki-session-context \
     agent/tools-mcp/index.mjs   # + every other alwaysLoad server's source the local additions name
   # 2. only if an mtime lands inside the window, find out what changed
   git log --since="7 days ago" --stat -- agent/CLAUDE.md agent/ops-agent/CLAUDE.md \
     agent/*/.mcp.json agent/tools-mcp/index.mjs
   git diff --stat -- agent/CLAUDE.md      # uncommitted content the live agents are already carrying
   # 3. the two surfaces git cannot see at all
   ./tools/bin/wiki-session-context | wc -c ; ./tools/bin/wiki list --pinned | tail -1
   find ~/.claude/skills -name SKILL.md -newermt '<window start>'
   ```

   **Every mtime older than the window start means the prefix did not change, full stop** — no committed edit, no working-tree edit, no pull. That is a stronger negative than a clean `git log`, and on 2026-08-11 it was what converted an apparent +1,703-token regression into a measurement artifact. Record the bundle chars and pinned-page count every run regardless (see `carry_forward.always_loaded_surfaces_not_visible_to_git`); a floor jump with clean mtimes *and* a flat bundle is noise, not content.

   **That negative is only as strong as the file list, and the list was missing the MCP tool schemas (fixed 2026-08-27).** `.mcp.json` marks `tools` (and any server the installation adds) as `alwaysLoad`, so every tool such a server exposes is prefix on every dispatch of all three tiers — but `.mcp.json` itself only *names* the server, and has not changed since 2026-05-14. A tool added to the server's own source therefore raised the floor while the sweep reported every mtime clean. First real instance: a commit (2026-08-26) added a personal-domain tool, ~700 chars of description + schema, in the same commit as a +786-char `CLAUDE.md` section — it was caught only because the prose half showed up in `git log`. Had the commit touched the server alone, this step would have returned all-clean and the run would have written "the prefix did not change, full stop" about a floor that had just grown. Same family as `cost-churn-coverage-20260814`, `cost-skip-episodes-20260819` and `cost-history-row-durable-20260825`: a check that reads absence of data as absence of condition.
2. **Did a job's volume change?** Compare `top_jobs[].runs` against the 7d file. A gate that stopped gating (see `location-enrich`'s dispatch gate) shows up here.
3. **Did a job's per-run cost change?** `usd_per_run` moving without `runs` moving means the job itself got heavier — a bigger prompt, a new tool, more turns.
4. **Is a job paying full freight for nothing?** Large `cache_write_per_run` with tiny `output_per_run`. `session-handoff` at the baseline was 87.5k cache-write for **208 output tokens** — a symptom of rotation frequency, not a job to delete.
5. **Did a job's `turns_per_run` grow?** Two known causes, both prompt-level and both fixed once in `ops-agent/CLAUDE.md` § Turn Discipline: **narration turns** (a round trip whose only output is "Now I'll check…" — 20% of all turns at the 2026-08-06 baseline) and **unbatched tool calls** (96% of tool-calling turns called exactly one tool). If a playbook drives a long sequential read/inspect chain, that chain is the thing to batch.

### Step 3 — Propose cuts

Rank candidate cuts by **$/day saved ÷ risk**. The durable ones, in the order they usually pay:

1. **Cut the floor.** Every token removed is repaid on every dispatch. Candidates: a large always-loaded CLAUDE.md section that only one job reads (the `email-triage-rules.md` extraction on 2026-08-06 cut ~15k tokens off all three ops agents); an MCP server loaded by an agent tier that never calls it; an always-on skill.

   **Rank an MCP/connector cut on CALLS, never on `ungranted_tokens_est` alone (added 2026-09-25).** A tool the agent is *allowed* to call and never does costs exactly as much as one it is forbidden to call, so "ungranted" was measuring the wrong thing — and it pointed the wrong way in both directions on the day it was checked. `mcp_tool_listing.usage_30d` in the derived file now carries the answer; read it, do not re-derive it:

   - **`never_called`** — zero calls anywhere in the fleet over 30 days. This is the honest cut list. When this was added it was a handful of claude.ai connectors — a couple of hundred tool names, **several thousand tokens on ops** — some of them duplicating capabilities Edva already reaches through its own servers.
   - **`rarely_called`** — 1–30 calls in 30 days. This is a **judgement, not dead weight**, and must be presented as one: the single largest ungranted server can be one that *is* used, a couple of dozen times a month. Never fold this bucket into a headline saving.
   - **A high call count exonerates a server even when every one of its tools is ungranted.** The supervisors run `--permission-mode bypassPermissions`, so `allowedTools` is an auto-approve list, not a whitelist — an "ungranted" call still succeeds. The duplicate `edva-tools` registration (1,822 tok) was carried as dead weight on the strength of its allowedTools status until 728 successful calls in 30 days were counted against it.

   **State the account-wide trade every time.** claude.ai connector enablement is per-account, so turning one off removes it from the user's own interactive sessions too, not just Edva's — Guardrails, "never propose disabling a capability the user uses without saying that is the trade."
2. **Right-size cadence** for a high-volume job whose gate passes more often than the work justifies.
3. **Right-size tier** — but **never propose a tier downgrade for a job whose output the user reads** without saying plainly that it is a quality trade. `location-enrich`'s routing rationale explicitly argues for Sonnet over Haiku ("reasoning > pure classify"); that is a decision, not an oversight.
4. **Cache TTL** — jobs on a 15–30 min cadence against a 5-minute default cache TTL are a guaranteed cold cache every dispatch. Flag if the spawn path gains extended-TTL support.

### Step 4 — File the improvements

Route **every** improvement through the **unified self-improvement pipeline**, and since rubric schema v4 (2026-09-29) that means **`self-improve-auto-apply` first**: it lands a low- or moderate-risk change on its own when it touches nothing high-blast-radius, and exits 3 — "file a card" — otherwise. Only then file a **Face-ID approval card** with `self-improve-request`, posted to the **Improvements** channel. A model-tier change is always a card (`agent/config/agents.json` is a high-blast-radius path), and so is anything that reduces a job's output quality, whatever its size. Both CLIs require the four plain-language parts: `--problem` (what is wasting money, as they'd notice it), `--impact` (dollars a day, measured), `--fix` (what changes), `--side-effects` (any quality trade, said plainly). `self-improve-auto-apply` also requires `--base-rev "$(git -C ~/Dev/edva rev-parse HEAD)"` taken right before you read the files you change (rubric schema v5, 2026-10-22); exit 7 means one moved on since — re-read it, redo the change once, resubmit with a fresh base and `--redo`, and on a second 7 leave it for the next run.

**There is no auto-apply path here (aligned 2026-08-25).** This step used to send low/moderate risk straight to auto-apply with a green-check card. The user retired that pattern across the improvement family on 2026-08-24 (everything the implementer would have done on its own goes to the Improvements channel for an approved run) — and a commit converted `nightly-review.md` / `self-improvement-executor.md`, following `improvement-plan.md`, `system-issue-review.md` §6b and `hum-action-executor.md` (2026-08-23). This playbook was the last one still documenting the retired path; it was missed because the 08-24 commit touched only the nightly executor's own files.

Risk still matters, but as a **label on the card**, not a routing decision. Say plainly in the rationale when a change touches model tier, a job's output quality, the auth path, or removes a capability — the card is what they are signing, so it has to say what it is.

**Build it tonight; do not narrate a cut and defer it (2026-10-06).** The emails of 2026-09-30 to 10-06 repeatedly described a buildable fix and then held it ("I will size it once the measurement is closed", "next card, kept separate") — and with no reader, a deferred finding is a lost one. If a cut is concrete, build it and route it this run. The only legitimate holds are: the target file has someone else's uncommitted edits (record `held: "dirty-tree"` with the patch path so tomorrow lands it), a prior cut on the *same* surface is still inside its measurement window (record `held: "measuring:<proposal id>"` and the date it frees up), or the run is out of time (record `held: "time-cap"` with the patch path, under the time budget below). A hold is a state entry with a release condition, never prose.

**Mind the time budget: the runner kills the whole run at its cap.** `trigger-cost-efficiency-review.sh` launches this run with `--timeout-min`, and at that minute the process is killed outright; nothing survives except what is already on disk. The independent critic that `self-improve-auto-apply --critic` needs can take ten minutes or more when it copies the code into a scratch tree and runs test suites, so a second build cycle started mid-run is exactly what the cap cannot fit. **A critic's copy of the code is a scratch tree, never a hand copy:** Make it with `bin/scratch-tree make [--label <name>] [--bundle <files.json>]` (tracked files plus the change, nothing gitignored: no `.env`, no `data`), run in it with `scratch-tree run <dir> -- <command>` (sets `EDVA_HOME` to the copy), and delete it with `scratch-tree remove <dir>` when done. Never copy the tree by hand: a hand copy carries `.env` and its backups into `/tmp`. A test run from a copy whose installation still resolves to the real tree, or that inherits the agent's environment, reads the real key and can post to the real chat; `scratch-tree run` points `EDVA_HOME` at the copy and leaves the installation's secrets out of the command's environment (`--keep-env NAME` passes one through on purpose, and is logged). Run `date -u +%s` as your first command and keep the number; check elapsed minutes against it before starting a build and before waiting on anything.

- **Run the critic in the foreground, on Opus at medium effort.** Call it with `run_in_background: false`, `model: "opus"` and `effort: "medium"`. This run is a one-shot `claude -p` process: it exits when your turn ends, so a critic left running in the background never reports back, and ending the turn to wait for it ends the run. Opus keeps the standing rule that improvement work runs on Opus; medium effort keeps a critic's cost down without weakening the gate. A foreground call cannot be abandoned midway, so the minute-12 rule below is what keeps a critic inside the cap.
- **Write state before you wait.** Annotate today's row (Step 6) and add any `questions[]` entry as soon as the finding is known, before spawning a critic or waiting on one, and update `routed` as each item lands. Never hold a state write until a critic returns: a write that waits on a critic dies with the run.
- **No new build cycle late in the run.** Once about 12 minutes have elapsed, do not start a new implement + critic cycle. A cut found after that is saved as a patch under `data/tmp/cost-review-<date>/` (not `/tmp`, which the next run does not read) and recorded in `proposals[]` with `held: "time-cap"` and the patch path. Its release condition is the next run, which lands every held `time-cap` patch first, re-checking each against current code (re-read the target, take a fresh `--base-rev`, rebuild the patch if it no longer applies), before it starts new analysis.
- **A critic still running near the cap dies with the run.** Before starting any critic, its patch is on disk under `data/tmp/cost-review-<date>/` and its `proposals[]` entry is already written with `held: "time-cap"` and that patch path (see "Write state before you wait"); clear the hold once it lands. If the run is killed while it waits, the next run finds the item held, with "critic did not return", and lands it first.

*What this defends against:* a run that lands its first fix, builds a second patch partway through, spawns a critic that is still running tests when the cap fires, and is killed while it waits. The trigger's headline row survives that kill, but the annotation and the question it was holding for the critic are lost, along with the second patch (drafted only under `/tmp`) and its card.

**A finding that needs the user's judgement and has nothing to sign goes to `questions[]` in state**, not a card and not an email: capacity/composition questions (the weekly allowance, which workloads to shrink), a claude.ai connector cut (account-wide — it also leaves their interactive sessions), a quality trade. Shape: `{id, asked_at, question, options[], recommended, recommendation, why_it_matters, est_usd_per_day, status: "open"}`, plain language (`recommended` = 0-based index of the option you recommend). Since 2026-10-22 the hum `decisions` lane asks open ones in chat, one a day, and writes their answer back as `status: "answered:<their choice>"` plus `answer`, `answered_at`, `answered_via: "chat-decision"`; act on it the same as a review-thread answer. The weekly `nightly-review` lists open ones under QUESTIONS FOR YOU in the Self Improvement Review, and its reply thread answers them; set `status: "answered:<what they said>"` when you see the answer in `improvement-plan-state.json` or the review thread. Ask a question once — while it is `open`, do not re-add it.

**Do not edit supervisor code or CLAUDE.md directly from this job** — everything goes through the pipeline so it is reviewable and revertible. **Never self-approve.**

**Kernel files stay generic** (`agent/CLAUDE.md` § Kernel boundary). A change to a file listed in `system/kernel-manifest.json` carries no personal data: the measurement story and the dates go in `--details` and the `system/changelog.md` entry, never a code comment; a threshold tuned to this installation goes in `agent/local/config/<module>.json` with a generic default in code. Run `bin/kernel-guard` before filing. `self-improve-auto-apply` exit 8 (`self-improve-request` exit 65) means the change added personal data to a kernel file or left a new file unclassified: move it as the reasons say and resubmit once; it may not go on a card.

### Step 4b — Verify a filed proposal against its MECHANISM, not just the outcome

A fix earns credit only for the outcomes its mechanism can actually produce. Before recording a proposal as measured, ask what the change *does*, and test that.

**The case that established this (2026-08-28).** `cost-compact-runaway-20260821` bounds a runaway `/compact` by hard-rotating the session **after** one is detected — it cannot stop the first runaway, only a second one on the same session. Its own measurement note said *"zero over that span is strong (Poisson lambda 5.1 gives P(0)=0.006)"*, and seven days later the span was indeed zero: 82 compactions, no runaways at all. Read naively that closes the card at the full pre-fix rate. But of the 22 pre-fix runaways in the same regime, only **2 were continuations** — the 9% the patch addresses. Matched to the mechanism the expectation is lambda ~= 0.5 and **P(0) = 0.63**: observing zero continuations is what you would see most weeks with no fix at all. The disease vanished; the patch explains a twelfth of it. Crediting it with the full rate would have put a phantom saving into `savings_reconciliation`, which has already had to walk one estimate back by more than half.

**The rule.** Record two numbers per proposal, not one:

- **outcome lambda** — what the pre-fix rate predicts for the whole condition.
- **mechanism lambda** — what it predicts for the subset the change can actually prevent.

A zero result is evidence for the fix only when the **mechanism** lambda is large enough that zero is surprising. When outcome lambda is large and mechanism lambda is small, the honest entry is **"improved, cause unattributed"** — keep the card open and go looking for what else changed. Do not close it, and do not bank the saving.

**This generalizes past this job.** The improvement family verifies fixes "against recurrence over a 3-day window" (`system-issue-review.md`). Recurrence-absence is an outcome test, so it over-credits every **bounding** or **damage-limiting** change in the same way — anything that makes a failure cheaper rather than rarer. State which kind a fix is when filing it, so the verifier knows which test to run.

**A volume cut is netted at the TIER, not at the job (added 2026-09-14).** When a proposal removes dispatch volume from a supervisor tier, its saving is the tier's total $/day before versus after — never the removed job's own $/day. **A high-frequency cheap lane is partly a cache-warming subsidy for every other lane on its tier.** At a 5-minute cache TTL, a tick every 20-30 minutes keeps the prefix resident; take it away and the survivors, which fire hours apart, each re-write the floor.

Worked example, the case that established this. `location_ambient_gate_20260912` removed `cron-location-ambient` from `ops-haiku`: dozens of runs a day at **a few cents a run**, cw/run only **~2.5k** — nearly free per run *because* it ran every 30 minutes into a warm cache. Day-one it was credited at its own cost. Measured across the two full days since, the tier delivered **about three quarters of that**, because the surviving dispatches went **~37% up per run** and from **40k to 66k cache-write per run**. In absolute terms the same jobs cost **more** than before while running fewer dispatches. **About a quarter of the credited saving was eaten back.**

**The test, before banking any volume cut:** take the tier's `job-costs.ndjson`, compute total $/day over a clean pre window and a clean post window, and record BOTH the removed lane's own cost and the survivors' $/run on each side. If the survivors' $/run rose, the difference is a cold-cache tax and it comes out of the saving. If it did not rise, say so — that is the evidence that the tier had enough other traffic to stay warm, and it is worth recording either way.

**Do not "fix" this by folding the tier upward.** `ops-haiku` at 17 dispatches/day is measurably colder than it was, but its work reads a Haiku-priced cache; moving it to `ops-light` would buy warmth at roughly double the per-token rate and cost more. Whether a tier with this little traffic should still exist is a composition question for the user under § Guardrails, not a cut this job makes.

**This is the same error family as Step 4b's mechanism/outcome rule, running in the other direction.** That rule stops a *bounding* fix being over-credited for an outcome it cannot produce; this one stops a *prevention* fix being over-credited for a second-order cost it does produce. Both are measurements that read a changed input as a valid comparison — `cost-churn-coverage-20260814`, `cost-skip-episodes-20260819`, `cost-index-comparability-20260831`.

### Step 5 — Deliver: nothing (retired 2026-10-06)

**This job sends no email, phone pointer or push.** Its daily email went unread, so the findings in it — however careful — were reaching no one, and the fixes it narrated were waiting on a reader who wasn't there. Delivery is now the pipeline itself:

| Finding | Where it goes |
|---|---|
| A cut or fix you can build | `self-improve-auto-apply` (lands it) → on exit 3, `self-improve-request` (Face-ID card in Improvements) |
| Needs a decision, nothing to sign | `questions[]` in state → the weekly Self Improvement Review |
| A measurement, a cleared check, a regression with no fix yet | state only (`history[]` annotations, `carry_forward`) |

Do not call `digest-deliver`, `email-send`, `edva-send-curl` or `edva-notify` from this job. A regression you cannot fix tonight is a `carry_forward` entry with what would close it, plus a question if the fix is their call — not a message. The weekly review already rolls up what landed automatically, so a change they did not expect stays visible and revertible there.

### Step 6 — Annotate today's state row

**The trigger has already written today's headline row** into `history[]` in
`data/cost-efficiency-review-state.json` — carrying `written_by: "trigger"`
and `agent_annotated: false`. Dispatches, cost, overhead, floors, working
windows and churn are all arithmetic over the pre-fetched report, so they are
captured before your turn starts and survive it. **Do not create a second row
for today.**

Your job is to ANNOTATE that row in place: set `agent_annotated: true` and add
`job_cost_index`, `regression`, `routed` (what each finding became: applied commit, card id, question id, or `state-only`), and the attribution notes this run
earned. Then update `last_run_at` and `silent_streak_days`, and record any
proposal ids filed so tomorrow's run can check whether they landed and what they
actually saved. History keeps 30 days; the trigger already trims it. Write each of these as soon as its finding is known, not at the end of the run and never after a critic returns (the time budget in Step 4).

*Why the trigger owns the row (2026-08-25).* On 2026-08-24 the run dispatched
against 141 dispatches and never reached this step, so that day's measurement was
lost outright — `cost-efficiency-today.json` is overwritten by the next run, and
the following morning's 1-day floor tripwire silently compared across a two-day
gap with nothing in the file marking it as such. A measurement that depends on an
agent turn remembering to write it will eventually not be written.

## State file

`data/cost-efficiency-review-state.json`:

```json
{
  "baseline": {
    "captured_at": "2026-08-06",
    "note": "the runaway that motivated this job",
    "context_overhead_pct": 85.0,
    "weighted_cost_usd_24h": 0.0,
    "cost_per_1k_output_usd": 0.10,
    "floors": { "ops": 149000, "ops-light": 151000, "ops-haiku": 110000 },
    "compacts_24h": 101,
    "rotates_24h": 29
  },
  "history": [ { "date": "YYYY-MM-DD", "context_overhead_pct": 0, "weighted_cost_usd": 0,
                 "cost_per_1k_output_usd": 0, "floors": {}, "compacts": 0, "rotates": 0,
                 "usd_per_dispatch": 0,
                 "max_usage": { "seven_day_peak": 0, "five_hour_peak": 0, "seven_day_warn_samples": 0,
                                "overage_available": false, "partial": false },
                 "job_cost_index": { "location-enrich": { "runs": 0, "usd_per_run": 0, "turns_per_run": 0,
                                                            "comparable": true, "reason": null } } } ],
  "proposals": [ { "id": "", "filed_at": "", "summary": "", "est_usd_per_day": 0, "status": "", "held": null } ],
  "questions": [ { "id": "", "asked_at": "", "question": "", "options": [], "recommended": 0, "recommendation": "", "why_it_matters": "", "est_usd_per_day": 0, "status": "open" } ],
  "silent_streak_days": 0,
  "last_run_at": null
}
```

Gitignored — it carries usage history. The shape is documented here.

**Settled memory lives in a sibling archive, and the live file keeps a stub pointing at it (2026-09-11).** Before every dispatch the trigger runs `agent/scripts/lib/cost-review-state-prune.mjs`, which moves three classes of settled content into `data/cost-efficiency-review-archive.json`: a `carry_forward` entry whose `status` **starts with** CLOSED / RETRACTED / SUPERSEDED, the prose annotations on `history` rows older than the most recent 7, and the detail on `proposals` filed more than 14 days ago whose status starts with APPLIED / SIGNED / VERIFIED. **Nothing is deleted.** Each pruned item leaves a stub — `{"archived": true, "status": "…", "read_it_at": "…"}` on a carry_forward entry, `annotations_archived: true` on a history row, `detail_archived: true` on a proposal — so a run can still tell a question was settled, and can open the archive when it needs to know *how*. Every field Step 1's tripwires read stays live on every row, at every age.

**Why:** the review was measured on 2026-09-11 at **nearly a tenth of the account's weekly spend** (via `edva-allowance-coverage`), well over this playbook's own ~$3/run bug threshold — the largest ephemeral-Opus line in the fleet, and the one it actually controls. The cause was this file: 360,372 bytes and growing ~7k/day, parsed and sliced into an Opus xhigh context every night. The prune takes it to roughly 205k.

**The settled test is a strict PREFIX, deliberately.** "Is this entry settled" is a judgment about prose, and Rule #0b forbids a regex deciding that — so the pruner does not try. It reads a convention instead: an entry that has been settled is written with the verdict first (`"CLOSED 2026-08-14. …"`), which is how this file's entries have been written all along. An entry whose status buries the verdict mid-sentence simply stays live and costs a little. That is the safe direction, and the convention to follow when writing a new status.

## Guardrails

- **Read-only on the ledger.** Never rewrite, prune, or "correct" `job-costs.ndjson` or `events.ndjson`. If a row looks wrong, record it in state; do not touch it.
- **Never self-approve a high-risk change.** Face-ID card or nothing.
- **Never propose unpausing crons the user paused deliberately** as a cost measure (the local additions name them) — that is a settled decision.
- **Never propose disabling a capability the user uses** to save money without saying explicitly that is the trade. Cheaper-and-worse is their call, not this job's.
- **Do not run the cost report from inside the agent turn** for the day's measurement — the trigger pre-fetches it, and re-running it is the whole reason the pre-fetch exists. Running it to *verify a code change you just made to the report itself* is a different act and is fine. **The raw ledgers under `agent/logs/supervisor-<tier>/` (`events.ndjson`, `job-costs.ndjson`) read fine from the agent turn** — reach for them when you need something the report does not expose, as the runtime-floor question above did.
- **No `edva doctor` hand-roll.** If a pre-flight is wanted, `doctor-preflight-check cost-efficiency-review`.
- **Dollar figures are SDK-estimated** under Max-only auth (no metered API spend). They are a faithful *relative* signal and the right basis for ranking cuts; do not present them to the user as a bill. Say "model-weighted" as the report does.

## Failure modes

- **No ledger rows / report file missing** → exit silent, log to `data/logs/cost-efficiency-review.log`. Do not page; a missing ledger is `watchdog.sh`'s business, not this job's, and an in-turn self-check would be exactly the sandboxed false positive the System Channel rule warns about.
- **Report present but window is short** (supervisor restarted recently, <6h of data) → note it in state, skip regression flagging for the day, stay silent.
- **A proposal from a previous day never landed** → if it is `held`, re-check its release condition and land it when it clears; otherwise record why in state once. Do not re-file it every day.
- **Killed at the runner's cap** (`--timeout-min` in `trigger-cost-efficiency-review.sh`) → the trigger's headline row survives by design (Step 6). Under the time budget in Step 4 the annotation, `routed` and any `questions[]` entry were written before any wait, so the kill costs at most the item in flight, and that item is a held `time-cap` patch. The next run lands held `time-cap` patches first, re-checked against current code, before new analysis. A kill that still loses an annotation means the budget was not followed: record it in state and fix it like any other bug in this job.
- **The job itself becomes expensive** → it is one ephemeral Opus run/day over a small JSON input. If its own `usd_per_run` exceeds ~$3, that is a bug: file a fix for it like any other cut.
