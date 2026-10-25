# Hum — going from empty to useful

Hum is the always-on ambient-awareness loop. Cheap **sensors** watch for situational edges (a meeting just ended, rain is coming, you're back at your desk, a task went overdue); a deterministic gate decides whether the moment is worth an agent turn; when it is, the `hum` job fans out to **harvesters**, ranks what they found, and may surface one thing as a phone ping. It's how the agent goes from "passive responder" to "noticing things." Design: [`system/hum-events.md`](../system/hum-events.md) and `system/architecture.md` § Hum.

Out of the box hum has the engine, the sensors, the generic harvesters and its playbooks — but no registry config, so it detects little and harvests nothing. This doc gets you from that empty state to a working loop.

## Ground state

Right after `edva init` / `edva up`:

| Path | State | What |
|---|---|---|
| `bin/hum-sense` | shipped | The event engine: sensors → events → gate → dispatch (`hum-sense daemon`) |
| `agent/scripts/hum-sensors/*.mjs` | shipped | `daypart`, `calendar`, `desk` (macOS), `comms`, `weather`, `tasks`, `idle` |
| `agent/scripts/hum-harvest-all.mjs` | shipped | The harvester fan-out + ranker |
| `agent/scripts/hum-harvesters/*.mjs` | shipped | `weather`, `news`, `calendar`, `tasks`, `watchdog`, `serendipity`, `ideas`, `open_questions`, `hum_asks`, `dream_asks` (`_common.mjs` is shared code) |
| `agent/ops-agent/jobs/hum*.md` | shipped | `hum`, `hum-review`, `hum-ideation`, `hum-consolidate`, `hum-daily`, `hum-explore` |
| `data/hum-sensors.json` | **you create it** | Which sensors run, how often, gate tuning |
| `data/hum-interests.json` | seeded by `edva init` | Which harvesters run, on what cadence |
| `data/hum-intent.md` | seeded by `edva init` | Hum's north star — what `hum-review` grades against |
| `data/user-timezone.json` | seeded by `edva init` | Local-hour gates (the companion app keeps it current) |
| `data/hum-state.json`, `hum-runs.jsonl`, `hum-feedback.jsonl`, `hum-learnings.jsonl` | written at run time | Counters, tick trace, pings + reactions, answers |

Everything in `data/` is gitignored; the templates live in `examples/`.

## Step 1 — the sensors

```bash
cp examples/hum-sensors.example.json data/hum-sensors.json
```

Each sensor entry names a script in `agent/scripts/hum-sensors/` (or your own in `hum-sensors/_ext/`), its interval and whether it is enabled; `config` tunes the gate (salience threshold, refractory period, quiet hours — `start`–`wake_floor` is a hard drop, `wake_floor`–`end` a soft shoulder). The daemon re-reads the file every tick. Defaults for every `config` key are in `lib/hum-events.mjs`.

Run the engine:

```bash
./bin/hum-sense once                 # one pass, prints the verdict
./bin/hum-sense once --sensor daypart
agent/launch-agents/install.sh ai.claude.hum-sense   # always-on, macOS
./bin/hum-sense status               # heartbeat, gate state, recent verdicts
```

`agent/scripts/trigger-hum.sh` stays in cron every 20 minutes as a **watchdog only**: it exits at once while the engine's heartbeat is fresh and dispatches a tick only when the event path is down.

## Step 2 — the harvesters

`data/hum-interests.json` (seeded from `examples/hum-interests.example.json`) enables `weather`, `news`, `calendar`, `tasks` and `watchdog`; `serendipity` is off by default. Each topic:

```jsonc
{
  "name": "weather",         // agent/scripts/hum-harvesters/<name>.mjs (or _ext/<name>.mjs)
  "enabled": true,
  "cadence_min": 20,         // minimum minutes between runs
  "cache_ttl_min": 60,       // the harvester's own cache TTL
  "active_window": "daily",  // "daily" | "mon-fri 09:00-17:00" | "sat-sun" | "21:00-23:00"
  "urgency_rule": null       // optional ranker-weight override
}
```

Lanes that are location-bound or operational are listed in `agent/local/config/hum-lanes.json` (`extend_place_bound`, `extend_operational`; template in `examples/local/config/`), so a harvester of your own is classified like the kernel's.

## Step 3 — the intent doc

`hum-review` (weekly) grades the prior week's pings and silences against `data/hum-intent.md`. Fill in the template's success criteria, anti-patterns, operating assumptions (work hours, sleep window) and durable "no" categories. It is read by the review and by you — not on every tick.

## Step 4 — test it

```bash
./bin/edva hum test                # one tick now, bypassing the gates
./bin/edva hum status              # next run, pings today, cool-down, pause state
./bin/hum-sense log --since 6        # events → dispatch → what hum did
```

`./bin/edva hum pause 2h | today | until-morning | weekend` and `hum resume` silence it; `hum feedback last 👍` records a reaction by hand.

## Writing your own harvester

A harvester is a small Node script that reads `{situation, context}` JSON on stdin, does its work and prints exactly one candidate object (or `null`) on stdout:

```jsonc
{
  "topic": "your-topic",
  "signal": "≤ 280-char one-line summary of the finding",
  "urgency": "low" | "med" | "high",
  "freshness_min": 5,
  "dedup_key": "stable-id-for-this-finding",
  "supporting_data": { }
}
```

Start from `agent/scripts/hum-harvesters/news.mjs`. Put yours in `agent/scripts/hum-harvesters/_ext/your-topic.mjs` (gitignored; link it from your overlay repo) and add `{ "name": "your-topic", "enabled": true, "cadence_min": 30 }` to `data/hum-interests.json`. The harness re-reads the registry on every tick; after `edva hum test`, `tail -n1 data/hum-runs.jsonl | jq .harvest` shows your topic under candidates or errors. A sensor of your own works the same way in `agent/scripts/hum-sensors/_ext/`.

## Hum CLIs

| CLI | What |
|---|---|
| `bin/hum-sense` | The event engine (daemon, one-shot pass, status, log, emit). |
| `bin/hum-ping` | Send and log a ping atomically (Supabase message, hum-feedback row, suggestion history). Called by the hum playbook. |
| `bin/hum-ask` / `bin/hum-answer` | Ask the user a question / record the answer into `hum-learnings.jsonl`. |
| `bin/hum-ideas-append`, `hum-idea-decide`, `hum-ideas-resolve`, `hum-mark-idea-consumed` | The ideas reservoir: add, decide, resolve, mark surfaced (`system/hum-ideas-reservoir.md`). |
| `bin/hum-reservoir-review`, `hum-reservoir-prune` | Drop handled ideas; nightly pruning and scorecard rebuild. |
| `bin/hum-resolve-first` | Check a candidate against evidence sources before it is surfaced ([`hum-resolve-first.md`](hum-resolve-first.md)). |

## What hum doesn't do out of the box

- **No tastes or projects.** The ranker's `context.tastes` and `context.projects` come from your wiki pages (`type: user`, `type: project`) and from `lib/_ext/edva-context.cjs` if you add one. Empty until you write them ([`memory.md`](memory.md)).
- **No personal harvesters.** Stocks, music, dining, fitness and the like are yours to write in `_ext/`.
- **No presence timeline.** Location- and travel-aware checks fail open until you provide `lib/_ext/presence.mjs` (contract in `lib/_ext/.gitkeep`).
- **A quiet ideation loop.** `hum-ideation` needs project and taste context before it produces anything worth surfacing.

## Disabling hum

1. Stop the engine (`agent/launch-agents/install.sh --uninstall ai.claude.hum-sense`) and remove the `trigger-hum.sh` cron line.
2. Set every topic in `data/hum-interests.json` to `enabled: false` (or delete the file).

Email triage, scheduled jobs and chat work fine without hum.
