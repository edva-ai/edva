# Quickstart

Five commands. About 15 minutes of clicking through prompts. Result: agents running on your host, talking to a webhook channel, logging to your terminal.

## Before you start

Install once:

- **Node.js 22.5+** (built-in `node:sqlite` requires 22.5+). Verify with `node --version`.
- **[Ollama](https://ollama.com)** — the phone-channel ack layer + memory embeddings run against a local model. After installing:
  ```bash
  ollama pull gemma3:4b              # ~2.5 GB — the ack model
  ollama pull nomic-embed-text       # ~280 MB — embeddings for memory
  ollama serve                       # leave running
  ```
- **A Claude API key** at https://console.anthropic.com — OR an active Claude Max subscription (in which case you'll also install the Claude Code CLI: `npm install -g @anthropic-ai/claude-code` and log in once with `claude`).

That's the floor. The bootstrap script will probe for everything else and tell you what else (if anything) you're missing.

## Step 1 — Clone + bootstrap

```bash
git clone https://github.com/mraccah2/merlin.git ~/Dev/merlin
cd ~/Dev/merlin
./scripts/bootstrap.sh
```

What the bootstrap does:

- Verifies Node 22.5+ / npm / Ollama / optional tools (`claude`, `gh`, `op`, `gog`, `jq`).
- Runs `npm install` in every subpackage (root, agent, supervisor, tools-mcp, the 4 channels, bin).
- Creates the runtime directories: `data/`, `logs/`, `agent/logs/`, `agent/supervisor/state/{ops,chat}/`, `secrets/`, `credentials/`.
- Marks every CLI in `bin/`, `agent/bin/`, `agent/scripts/`, and `scripts/` executable.
- Copies `.env.example` → `.env` if `.env` is absent.

Idempotent — re-run any time after `git pull`.

## Step 2 — Configure

```bash
./bin/merlin init
```

This walks you through about 8 questions:

1. **`MERLIN_HOME`** — usually `~/Dev/merlin`. Press Enter to accept.
2. **`ANTHROPIC_API_KEY`** — paste it, or leave blank if you'll use Max subscription.
3. **`MERLIN_OWNER_EMAIL`** — the address agent-originated email goes to.
4. **`MERLIN_OWNER`** — your GitHub login.
5. **`SUPABASE_URL`** — optional. If blank, the phone-channel + companion app are disabled.
6. *(if Supabase)* **`SUPABASE_SERVICE_ROLE_KEY`** + **`MERLIN_SUPABASE_PROJECT`** — your project's URL slug.
7. **`OLLAMA_URL`** — default `http://127.0.0.1:11434` is right if Ollama is local.
8. Model overrides — defaults `gemma3:4b` + `nomic-embed-text` match what you pulled in step 0.

It also generates a random 32-byte `WEBHOOK_TOKEN`, writes it to both `.env` and `secrets/webhook-token` (the latter is what cron-driven scripts read), and creates the runtime dirs.

You can re-run `merlin init --force` to overwrite an existing `.env`. To skip the wizard, copy `.env.example` to `.env` by hand and fill in the values.

## Step 3 — Run

```bash
./bin/merlin up
```

That spawns `agent/bin/process-manager.mjs` in the foreground. You'll see lines like:

```
[process-manager] starting children…
[chat-supervisor] listening on :9094
[ops-supervisor]  listening on :9090 (gmail) :9092 (webhook) :9093 (health)
```

Ctrl-C cleanly stops the tree.

## Step 4 — Fire a job (in another terminal)

```bash
./bin/merlin dispatch morning-digest
```

This POSTs to the ops-supervisor webhook. With no args, `merlin dispatch` lists dispatch-able jobs. The job's playbook lives at `agent/ops-agent/jobs/morning-digest.md` — the supervisor reads it at dispatch time, hands the contents to `claude -p`, and lets the agent execute.

If you set up Supabase + the companion app, the agent's output gets pushed to your phone. If not, it lands as an HTML email via `email-send` (if SMTP2Go is wired) or just shows up in the supervisor event stream.

## Step 5 — Watch it work

```bash
./bin/merlin tail ops
```

That tails `agent/logs/supervisor-ops/events.ndjson` — one JSON line per turn the agent takes. Other tails:

```bash
./bin/merlin tail chat        # chat-supervisor events
./bin/merlin tail --all       # both, multiplexed
./bin/merlin tail morning-digest   # logs/morning-digest.log when a job emits one
```

---

## What now

You have a working Merlin. To make it actually useful, the next things to do (in roughly this order):

1. **Customize the morning-digest job** — `agent/ops-agent/jobs/morning-digest.md` is generic. Edit it to compile the summary you actually want.
2. **Wire Gmail** — see [`docs/integrations/gmail.md`](integrations/gmail.md) for the Pub/Sub + OAuth flow.
3. **Write your first job** — see [`docs/writing-a-job.md`](writing-a-job.md).
4. **Read the architecture map** — [`system/architecture.md`](../system/architecture.md). Skim once now, refer back when something doesn't behave.
5. **Decide on auth model** — API key (default) is fine to start. If you'd rather flat-rate via Claude Max, see [`docs/hardening.md`](hardening.md).

For 24/7 deployment (not just terminal-session-runtime), install the launchd/systemd service — see [`docs/installer.md`](installer.md).

---

## When something doesn't work

- `./bin/merlin status` — supervisor health, child PIDs, last activity, restart counts.
- `./bin/merlin doctor` — drift checks: tasks.json vs cron, playbook references, supervisor config consistency.
- `./bin/merlin logs <stream>` — same as `merlin tail` but prints a slice rather than following.
- `node --check agent/bin/process-manager.mjs` — syntax-check the kernel boot.
- `./scripts/bootstrap.sh --quiet` — re-run setup. Idempotent. Reports missing prerequisites.

Most "it doesn't work" reports trace back to: Ollama not running, the wrong `ANTHROPIC_API_KEY`, or the supervisor binding to a port already in use (default ports are 9090–9094 + 9096). Check those three first.
