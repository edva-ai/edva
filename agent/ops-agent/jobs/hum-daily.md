HUM DAILY — End-of-day chronicle of the last 24h of hum ticks, RECORDED (not sent).

> **This instance's own specifics** for this job (its people, places and decisions) are recorded in `agent/local/jobs/hum-daily.md`.

Runs daily at 23:00 local. Aggregates everything the harvesters noticed, every proactive ping/question sent (and why), what was held back, harvester health and plumbing drift, and appends ONE structured row per day to `data/hum-daily.jsonl`. **No email, no phone pointer, no push** since 2026-10-06 — the user asked for the record to feed the improvements, not a daily email. Read-only on hum state.

## Purpose

A daily record of what hum actually did, consumed by the improvement loop rather than by the user's inbox: `hum-improvement-ideation` reads the trailing week of `hum-daily.jsonl` as evidence (held-back near-misses, silent harvesters, harvester errors, plumbing drift), and its ideas reach the user through the Improvements channel. `hum-review` (weekly) grades against intent. To look at a day by hand: `hum-daily-run --dry-run` renders the old HTML for the current window.

## Critical rules

1. **Read-only.** Never modify hum state files, memory files, config, or `hum-runs.jsonl`. The only write is `hum-daily.jsonl`.
2. **Nothing outbound.** Never email, ping or push. Fewer than 5 ticks is recorded as `low_ticks: true`, not announced.
3. **One row per local (home-zone) date.** A re-run the same day replaces that day's row.

## How it runs — code, no agent turn (since 2026-10-04)

`trigger-hum-daily.sh` (23:00 local) runs **`bin/hum-daily-run`**. Aggregation and rendering live in `lib/hum-daily-report.mjs` (tests: `tests/hum-daily-report.test.mjs`). Every number is arithmetic over the files below and the HTML is a fixed template, so there is no model in the loop — it used to be a Sonnet turn doing the counting by hand. The row is the aggregate itself (`ticks, decisions, harvestErrors, discoveries, pings, questions, heldBack, reactions, harvesters, silentHarvesters, topTopic, notable, pending, audit`) plus `date`, `window`, `low_ticks`, `skipped_trace_lines`.

**Inputs (trailing 24h):** `hum-runs.jsonl` through `hum-run-log read --since` (unparseable lines are counted and called out in the email, never silently dropped), `hum-feedback.jsonl` (joined by `ping_id`), `hum-learnings.jsonl` (joined by question id), `hum-pending-question.json`, and `edva hum audit --window 24h --json` for plumbing drift. Canary rows (`mode: canary`) are not ticks.

**Output:** one row appended to `data/hum-daily.jsonl` (runtime state, gitignored like the other hum logs). `hum-daily-run --dry-run` prints the HTML view (TL;DR · what hum noticed · pulses sent · questions · held back · harvester activity · reactions · plumbing · pending) and records nothing. Failures land in `watchdog.log` as `[hum-daily] FAILED`.

**Retired 2026-10-06:** the `Hum daily, <date>` email (via digest-deliver), its phone pointer and its push.

## Why this exists

Edva Rule #1: self-awareness. Hum is Edva's densest loop — the system should keep an exact daily record of what it saw and what it chose to do, and improve itself from that record without asking the user to read it. `hum-review` (Sundays) evaluates against intent; `hum-daily` is the raw chronicle.
