# Hum — going from empty to useful

Hum is the always-on ambient-awareness loop: every 20 min, fan out to a set of **harvesters**, rank candidate findings with a sub-LLM, optionally surface one as a phone-channel ping. It's how the agent goes from "passive responder" to "noticing things."

The kernel ships with the harness and 7 generic harvesters but **no registry config** — meaning out of the box, hum ticks every 20 min and finds nothing because no topics are enabled. This doc gets you from that empty state to a working loop.

## Ground state

Right after `merlin init` / `merlin up`:

| File | State | What |
|---|---|---|
| `agent/scripts/hum-harvest-all.mjs` | shipped | The fan-out + ranker harness |
| `agent/scripts/hum-harvesters/*.mjs` | shipped (7 files) | Generic harvesters: `_common`, `weather`, `news`, `calendar`, `tasks`, `watchdog`, `serendipity` |
| `agent/ops-agent/jobs/hum*.md` | shipped (6 playbooks) | hum, hum-canary, hum-daily, hum-ideation, hum-operations, hum-review |
| `bin/hum-*` | shipped (4 CLIs) | hum-answer, hum-ping, hum-mark-idea-consumed, hum-reservoir-review |
| `data/hum-interests.json` | **missing — you create it** | Which harvesters to run, on what cadence |
| `data/hum-intent.md` | **missing — you create it** | Hum's "north star" — what hum-review grades against |
| `data/user-timezone.json` | **missing — you create it** | Read by the trigger script's sleep-window gate |
| `data/hum-state.json` | auto-created on first tick | Daily counters, min-ping-interval, pause flag |
| `data/hum-runs.jsonl` | auto-appended on each tick | Tick trace |
| `data/hum-feedback.jsonl` | auto-appended on each ping | Per-ping records + reactions |
| `data/hum-learnings.jsonl` | auto-appended on each Q+A | Answers to hum's questions |

Everything in `data/` is gitignored. The three files marked "you create it" come from `examples/`.

## Step 1 — seed the registry

The harvest runner reads `data/hum-interests.json` to decide which harvesters to run. Without it, hum fires the empty-list code path and exits silent.

```bash
cp examples/hum-interests.example.json data/hum-interests.json
```

The shipped example enables 5 of the 7 generic harvesters (`weather`, `news`, `calendar`, `tasks`, `watchdog`) with sensible cadences. `serendipity` is disabled by default (it needs richer place-scoring than we ship). `_common` isn't a topic — it's the shared utilities module the other harvesters import.

Edit to taste. Each topic entry takes:

```jsonc
{
  "name": "weather",         // matches agent/scripts/hum-harvesters/<name>.mjs
  "enabled": true,           // false = skipped entirely
  "cadence_min": 20,         // minimum minutes between runs
  "cache_ttl_min": 60,       // per-topic cache TTL (harvester reads cache before network)
  "active_window": "daily",  // when this topic should run; see below
  "urgency_rule": null       // optional override of ranker weight
}
```

`active_window` formats the runner understands:

- `"daily"` or omitted/null → always runs
- `"mon-fri 09:30-16:00 ET"` → weekday market hours
- `"sat-sun"` → weekends only
- `"21:00-23:00"` → evenings local time
- Combined: `"mon-fri 17:00-19:00 ET"`

## Step 2 — seed the intent doc

Hum-review (weekly, Sundays 09:30 by default) grades the prior week's ticks against `data/hum-intent.md`. Without intent, the review has nothing to grade against and proposes nothing.

```bash
cp examples/hum-intent.example.md data/hum-intent.md
```

The example is a template — fill in the sections marked as initially-empty. Important parts:

- **Success criteria** — what makes a ping "good" vs "bad" for you specifically
- **Anti-patterns** — what hum should never do (don't pester on rejection, no re-surfacing, etc.)
- **Operating assumptions** — your work hours, sleep window, pre-meeting buffer, etc. These become the agent's defaults.
- **What the user has explicitly said no to** — durable category-level rejections (start empty; hum-review will propose additions over time)

The doc isn't read by hum itself on every tick (that would be expensive). It's read by hum-review weekly + by you when you tune.

## Step 3 — seed the timezone file

Trigger-hum.sh gates on the local hour (skips during sleep window). It reads timezone from `data/user-timezone.json` first, falls back to `America/New_York`.

```bash
cp examples/user-timezone.example.json data/user-timezone.json
# edit if you're not in ET
```

If you've wired the companion iOS app + phone-context publishing, this file gets overwritten automatically from device data — you only need to seed it for hosts without the app.

## Step 4 — wire the trigger

Hum needs to actually fire. Add to your crontab (`crontab -e`):

```cron
*/20 * * * * /Users/<you>/Dev/merlin/agent/scripts/trigger-hum.sh
```

Replace the path with your `${MERLIN_HOME}`. The script self-gates on sleep window + supervisor liveness, so it's safe to fire every 20 min.

Test it ad-hoc without waiting for cron:

```bash
./bin/merlin dispatch hum
```

Should produce a tick in `data/hum-runs.jsonl` within seconds.

## Writing your own harvester

A harvester is a small Node script in `agent/scripts/hum-harvesters/<name>.mjs` that:

1. Reads `{situation, context}` JSON on stdin
2. Does its work (fetch RSS, query a DB, hit an API, scan a file…)
3. Emits exactly one candidate JSON object on stdout, OR `null` to skip this tick

The candidate shape:

```jsonc
{
  "topic": "your-topic-name",
  "signal": "≤ 280-char one-line summary of the finding",
  "urgency": "low" | "med" | "high",
  "freshness_min": 5,                // how fresh is the underlying signal in minutes
  "dedup_key": "stable-id-for-this-finding",
  "supporting_data": { /* anything the ranker should see */ }
}
```

Reference: read `agent/scripts/hum-harvesters/news.mjs` — it's the simplest non-trivial harvester (RSS scan + freshness filter). Use it as a template.

Then add an entry to `data/hum-interests.json`:

```jsonc
{ "name": "your-topic-name", "enabled": true, "cadence_min": 30, "cache_ttl_min": 5, "active_window": "daily" }
```

Restart isn't required — the harness re-reads the registry on every tick. Fire ad-hoc to test:

```bash
./bin/merlin dispatch hum
tail -n1 data/hum-runs.jsonl | jq .
```

You'll see your topic in `harvest.candidates` if it emitted, or in `harvest.errors` if it crashed.

## Hum CLIs

| CLI | What |
|---|---|
| `bin/hum-ping` | Send + log a ping atomically. Inserts into Supabase, appends to hum-feedback.jsonl, writes a surfaced event to suggestion-history. Used by the hum playbook, rarely called directly. |
| `bin/hum-answer <id> "<answer>"` | Record an answer to a pending hum question. Writes to hum-learnings.jsonl; the chat-agent calls this when it detects a reply that matches a pending-question file. |
| `bin/hum-mark-idea-consumed <id>` | Mark an idea from the reservoir as "we surfaced this". Bookkeeping. |
| `bin/hum-reservoir-review <keyword>... --reason "..."` | Drop matching ideas from the reservoir. Called by chat-agent when the user signals "already handled X". |

You won't typically invoke these by hand — they're called by the hum playbook + chat-agent reply-handlers. They're documented here so you know what each does when you read the logs.

## What hum doesn't do out of the box

Until you populate it, hum doesn't have any of the things that made it feel valuable in the upstream system:

- **No tastes / preferences.** The `context.tastes` object hum's ranker reads is sourced from your wiki pages (`user_food_taste.md`, `user_art_taste.md`, etc.). Empty by default; add `type: user` pages to your wiki.
- **No active projects.** Same — `context.projects` reads `type: project` pages. Empty until you author them.
- **No harvesters for stocks, music, art, dining, fitness, etc.** These were personal in the upstream source; the public tree ships only the generic 7. Write your own.
- **No ideation loop running.** `hum-ideation` (the playbook that generates new ideas) needs project/taste context to produce useful ideas. Stays mostly silent until your wiki has substance.

The ramp from "5 generic harvesters running" to "hum surfaces something I'd have missed daily" is the part where the system stops being a kernel and starts being yours.

## Disabling hum

If you don't want the ambient loop at all:

1. Remove the `trigger-hum.sh` cron entry.
2. `rm data/hum-interests.json` (or set every topic's `enabled: false`).
3. Stays out of the way; everything else (email triage, scheduled jobs, chat) works fine without hum.
