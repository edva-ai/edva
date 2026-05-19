# Merlin

**A 24/7 personal-agent OS built on Claude Code.** Runs persistent agents under supervisors that restart on crash, wires them to ingress channels (webhook, Gmail, phone, custom), drives scheduled jobs from markdown playbooks, and backs the whole thing with a SQLite/FTS5 memory layer.

```
┌──────── init ────────┐  ┌──────────── process-manager ────────────┐
│ launchd (macOS)      │─▶│ chat-supervisor  ─▶ claude -p (chat)     │
│ systemd (Linux)      │  │ ops-supervisor   ─▶ claude -p (ops)      │
└──────────────────────┘  │ + channel daemons (webhook / gmail / …)  │
                          └────────────────┬───────────────────────────┘
                                           │ HTTP POST /dispatch
                          ┌────────────────┴──────────────┐
                          │ ingress channels (opt-in)     │
                          │  webhook · gmail-pubsub ·     │
                          │  phone-realtime · custom      │
                          └───────────────────────────────┘
```

Read [`system/architecture.md`](system/architecture.md) for the deep version.

---

## Quickstart

```bash
git clone https://github.com/<your-org>/merlin.git ~/Dev/merlin
cd ~/Dev/merlin

# 1. Install deps, set up data dirs, check for ollama
./scripts/bootstrap.sh

# 2. Interactive config wizard → writes .env + creates a webhook token
./bin/merlin init

# 3. Start everything in the foreground (Ctrl-C to stop)
./bin/merlin up

# In a second terminal — fire a test job
./bin/merlin dispatch morning-digest

# Tail the agent logs as it runs
./bin/merlin tail ops
```

That's the local-dev path. For 24/7 deployment, install the launchd/systemd unit (see `docs/installer.md`, TODO).

---

## What is Merlin actually doing?

The agents you'll run aren't general-purpose chatbots — they're job-runners. You write a **markdown playbook** describing what an agent should do (steps, tools to call, output format), tag it with a cron schedule or a webhook trigger, and the supervisor dispatches a `claude -p` child against that playbook on every firing.

The reference job in this repo is `agent/ops-agent/jobs/morning-digest.md` — compiles calendar + tasks + inbox + weather + headlines into one HTML email, ships it to the user, follows up with a one-line phone-channel pointer and an APNs push. Cron-driven, runs daily at 7:55 AM by default.

Six more reference jobs ship under `system/tasks.json` (`hum`, `hum-review`, `wiki-audit`, `memory-snapshot`, `chrome-cdp-watch`, `context-sync`) — extend from there.

---

## What ships out of the box

| Component | Path | What |
|---|---|---|
| **Kernel** | `agent/` | process-manager, supervisors, channel framework, MCP shell bridge, kernel test suite |
| **CLI** | `bin/` | 22 tools: `merlin` (status/tasks/triage/...), `wiki`, `memory`, `email-send`, `email-mem`, `context-search`, `hum-*`, `suggestion-*` |
| **Libraries** | `lib/` | `wiki-store`, `memory-store`, `local-llm`, `apns-push`, `supabase-rest`, `merlin-context`, etc. |
| **Apps** | `apps/` | Two SwiftUI apps — `companion/` (iOS+macOS chat) and `spotter/` (iOS fitness tracker) |
| **Reference jobs** | `agent/ops-agent/jobs/` | `morning-digest`, `hum.md` + 5 hum playbooks |
| **CI** | `.github/workflows/` | iOS + macOS TestFlight workflows for the companion app, secret-scan |

## What you'll build yourself

| Surface | Notes |
|---|---|
| Personal jobs | Specific to your life — replace the reference set or extend it |
| Hum harvesters | 7 generic ones ship (weather, news, calendar, tasks, watchdog, serendipity, `_common`) — add your own under `agent/scripts/hum-harvesters/` |
| Smart-home / location / messaging integrations | The MCP bridge has 23 working tools; 65 personal-tool blocks were removed. Add your own backends under `bin/` and register tool blocks in `agent/tools-mcp/index.mjs` |
| Code-signing identity | Apple Team ID, bundle IDs — see [`apps/companion/CODE-SIGNING.md`](apps/companion/CODE-SIGNING.md) |
| Your memory corpus | The wiki/memory layer is the substrate; your `user_*`, `project_*`, `feedback_*` pages live in Claude Code's per-project memory dir |

---

## Architecture in one paragraph

`launchd` (or `systemd`) launches `agent/bin/process-manager.mjs`. Process-manager spawns the supervisors as direct children — one per agent role from `agent/config/agents.json`. Each supervisor wraps a long-lived `claude -p` child with `--resume` semantics (session-id persists across restarts) and exposes an HTTP `/dispatch` port. Ingress channels (`agent/{webhook,gmail,phone,dispatch-bridge}-channel/`) start as additional children, listen to their respective protocols, and POST normalized events to the supervisor. The agent does work via MCP tools (the shell bridge in `agent/tools-mcp/index.mjs` exposes every binary in `bin/` as a callable tool, the wiki/memory layer is `lib/wiki-store.js` + `lib/memory-store.js`, and a local Ollama model handles low-stakes acks via `lib/local-llm.mjs`). All sessions log per-turn to `agent/logs/supervisor-{ops,chat}/events.ndjson`, with cost attributed per job for the `merlin cost-report` rollup.

Restart semantics: `POST /restart` on a supervisor rotates only the inner `claude -p` child (supervisor stays up). Killing the supervisor PID respawns it via process-manager. Killing process-manager respawns it via init. Session IDs persist through all three layers so conversations don't lose state.

The full doc is [`system/architecture.md`](system/architecture.md).

---

## Auth model

Two modes, picked in `agent/config/agents.json`:

- **API key (default)** — set `ANTHROPIC_API_KEY` in `.env`. Easiest. Pay-per-token.
- **Claude Max subscription** — authenticate `claude` once on the host; the supervisor strips `ANTHROPIC_API_KEY` from the child env so the Max session is the only auth path. Fixed monthly cost. Also a *hardening profile*: if Max is unavailable, agents go down rather than silently fall back to API-key calls.

The phone-channel ack layer (the "checking calendar…" status text while the real Claude reply lands) always runs against a local Ollama model — no Anthropic calls. See `lib/local-llm.mjs`.

---

## Requirements

Minimum to run *anything*:

- **macOS** (Apple Silicon preferred) or Linux
- **Node.js 22.5+** (built-in SQLite via `node:sqlite`)
- **[Ollama](https://ollama.com)** running locally with `gemma3:4b` and `nomic-embed-text` pulled
- A **Claude API key** OR an active **Claude Max** subscription

Per-feature dependencies (Gmail Pub/Sub, Supabase, SMTP outbound, iOS builds, GitHub Actions CI, etc.) are mapped in [`docs/dependencies.md`](docs/dependencies.md). Read it before committing to a deployment plan — there are real gotchas around things like the missing `gog` CLI (used by several reference jobs), self-hosted vs hosted GitHub runners, and what works on Linux vs requires macOS.

The bootstrap script probes for what's installed and warns about gaps.

---

## Project layout

```
.github/workflows/   ios-testflight, macos-testflight, secret-scan
agent/               kernel substrate
  bin/                 process-manager + companions
  chat-agent/          chat agent's cwd + CLAUDE.md
  ops-agent/           ops agent's cwd + CLAUDE.md + jobs/
  config/              agents.json + schema + loader
  dispatch-bridge/     server-to-server dispatch channel
  gmail-channel/       opt-in Gmail Pub/Sub ingress
  phone-channel/       opt-in companion-app realtime ingress
  webhook-channel/     opt-in HTTP webhook ingress
  scripts/             watchdog, gmail watch setup/renew, log rotation,
                       hum harness + 7 reference harvesters
  supervisor/          chat-supervisor, ops-supervisor, claude-session,
                       dispatcher, queue-persist, …
  test/                kernel test suite
  tools-mcp/           MCP shell bridge → bin/
  lib/                 managed-process, priority-dispatcher
apps/
  companion/           iOS/macOS chat app (+ CODE-SIGNING.md)
  spotter/             iOS fitness tracker
bin/                   user-facing CLIs (merlin, wiki, memory, …)
lib/                   shared libraries
system/
  architecture.md      cross-component map (read first)
  wiki-architecture.md memory layer detail
  tasks.json           scheduled-job registry
  services.json        launchd/systemd unit registry
scripts/               bootstrap + installer helpers
docs/                  user-facing guides (in progress)
```

---

## License + contributing

Apache 2.0 — see `LICENSE`. Contributions welcome; security disclosures via `SECURITY.md` (TODO).

Merlin is the open-source extraction of a personal Mac-Mini-hosted agent that's been running 24/7. The patterns are battle-tested; the integrations are deliberately sparse because they're the part you have to make yours.
