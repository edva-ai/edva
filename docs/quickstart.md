# Quickstart

Five commands and a few prompts. Result: Edva's supervisors running on your host, a webhook you can dispatch jobs to, and an event stream in your terminal.

## Before you start

Install once:

- **Node.js 22.5+** (built-in `node:sqlite`). Verify with `node --version`.
- **The Claude Code CLI**, logged in with a **Claude Max** subscription: `npm install -g @anthropic-ai/claude-code`, then run `claude` once and sign in. Every agent runs through `claude -p` on that login; the supervisors deliberately hide `ANTHROPIC_API_KEY` from those sessions (see [`agent-auth-model.md`](agent-auth-model.md)).
- **[Ollama](https://ollama.com)** for local classification and memory embeddings:
  ```bash
  ollama pull gemma3:1b              # small local classifier
  ollama pull nomic-embed-text       # embeddings for memory
  ollama serve                       # leave running
  ```

The bootstrap script probes for everything else and tells you what is missing. Edva is developed on macOS; parts of it (launchd, Keychain, `ioreg`) are macOS-only — see [`dependencies.md`](dependencies.md).

## Step 1 — Clone + bootstrap

```bash
# Clone this repository — copy its URL from the green "Code" button on GitHub
git clone <this repository's URL> ~/Dev/edva
cd ~/Dev/edva
./scripts/bootstrap.sh
```

What the bootstrap does:

- Verifies Node 22.5+, npm, Ollama and optional tools (`claude`, `gh`, `op`, `gog`, `jq`).
- Runs `npm install` in every package (root, `agent/`, the supervisor, `tools-mcp`, the channels, `browsing-skills/`, `bin/`).
- Creates the runtime directories: `data/`, `logs/`, `agent/logs/`, `agent/supervisor/state/{ops,chat}/`, `agent/local/`, `secrets/`, `credentials/`.
- Marks the CLIs and scripts executable and copies `.env.example` → `.env` if `.env` is absent.

Idempotent — re-run it after every `git pull`.

**Cloned somewhere else?** The CLI and scripts find the installation through `EDVA_HOME` (default `~/Dev/edva`). Export it in your shell and keep it in `.env`.

## Step 2 — Configure

```bash
./bin/edva init
```

A short wizard:

1. **`EDVA_HOME`** — the checkout path. Enter accepts it.
2. **`ANTHROPIC_API_KEY`** — optional; only developer tools such as `edva review-pr` use it.
3. **Identity** — your name, email, the From: address for mail the agent sends, your time zone, your GitHub user. Written to `agent/local/instance.json`, which the kernel reads through `lib/instance.cjs`.
4. **Supabase** (optional) — project ref, service-role key, Management API token, anon key. Without it the phone channel and companion apps stay off.
5. **Ollama** — URL and model names (defaults match the models above).
6. **Telemetry** — whether to send one anonymous install ping (no PII, no raw IP; `EDVA_NO_TELEMETRY=1` skips the question and the ping).

It also generates a random webhook token in `secrets/webhook-token`, creates the runtime dirs, and seeds `data/hum-interests.json`, `data/hum-intent.md` and `data/user-timezone.json` from `examples/` (never overwriting). Re-run with `--force` to overwrite. Every variable is documented in [`.env.example`](../.env.example).

Then check the install:

```bash
./bin/edva doctor
```

Before `up`, the supervisor and channel checks fail (nothing is running yet); everything else should pass or tell you what to fix.

## Step 3 — Run

```bash
./bin/edva up
```

That runs `agent/bin/process-manager.mjs` in the foreground: the chat supervisor, the three ops tiers (`ops`, `ops-light`, `ops-haiku`) and the channel processes. Ctrl-C stops the tree. Logs go to `agent/logs/`.

## Step 4 — Fire a job (in another terminal)

```bash
./bin/edva dispatch morning-digest
```

`dispatch` posts `{"job": "morning-digest"}` to the webhook of the job's tier (its `model` in `agent/config/job-routing.json`: haiku → `ops-haiku` :9072, other non-opus → `ops-light` :9082, opus → `ops` :9092), falling back to a higher tier when that one isn't healthy. The supervisor loads `agent/ops-agent/jobs/morning-digest.md`, appends your own additions from `agent/local/jobs/morning-digest.md` if you wrote any, and hands it to the agent. With no arguments, `edva dispatch` lists the playbooks and their tiers.

## Step 5 — Watch it work

```bash
./bin/edva tail ops
```

That follows `agent/logs/supervisor-ops/events.ndjson`, one JSON line per event. Others:

```bash
./bin/edva tail ops-light      # or ops-haiku, chat
./bin/edva tail --all          # every supervisor
./bin/edva tail usage-push     # agent/logs/<name>.log (else logs/<name>.log)
```

---

## What now

1. **Tell Edva about you.** Put your standing rules in `agent/local/shared.md` (every agent) and `agent/local/chat.md` / `ops.md` (one role) — template: [`examples/local/shared.example.md`](../examples/local/shared.example.md). The supervisors append them to the kernel rules and reload them on change.
2. **Tune a job without forking it.** Add `agent/local/jobs/<job>.md` to extend a kernel playbook, or drop a whole new playbook in `agent/ops-agent/jobs/_ext/`. See [`writing-a-job.md`](writing-a-job.md).
3. **Keep your own layer in a private repo.** `agent/local/` and the `_ext/` dirs are gitignored; `./bin/edva overlay add <path>` links a private repo into them. See [`architecture-public-private.md`](architecture-public-private.md).
4. **Wire Gmail** — [`integrations/gmail.md`](integrations/gmail.md).
5. **Read the architecture map** — [`system/architecture.md`](../system/architecture.md).

For 24/7 operation see [`installer.md`](installer.md).

---

## When something doesn't work

- `./bin/edva status` — supervisor health, last activity, restart counts.
- `./bin/edva doctor` — drift and health checks (schedules vs tasks, MCP configs, Claude Code on PATH, ...).
- `./bin/edva logs <component>` — a slice of a log instead of following it.
- `./scripts/bootstrap.sh --quiet` — re-run setup; reports missing prerequisites.

Most first-run problems are one of: `claude` not logged in (or not on a Max plan), `EDVA_HOME` not set for a checkout outside `~/Dev/edva`, Ollama not running, or a port already in use (the supervisors use 9071–9073, 9081–9083, 9090–9095).
