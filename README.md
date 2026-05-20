# Merlin

**An assistant that pays attention — even when you're not asking.**

Most assistants wait. You type, they reply, the moment passes. Merlin stays on. It learns what you like, watches what matters, and quietly handles the things you'd rather not think about.

> Runs on the Claude subscription you already have. No API keys. No per-token bills.

→ Read the full story: **[silo.co/merlin](https://silo.co/merlin)**

---

## On the Claude you already have

You may have seen agent frameworks like *openclaw*. They're powerful, but they plug into the Claude API — separate account, pay per token, a bill that scales with how much your agent does.

Merlin works the other way around. It runs through Anthropic's official Claude environment on the subscription you already use in your browser. Sign in once with `claude`, and Merlin works through your account.

- **No API key to manage.** No per-token billing.
- **No new account.** Same Claude, just always on.
- **Flat monthly cost** — built for an assistant that runs continuously.

If you'd rather pay by usage, Merlin will use an API key too. But the subscription path is the one it was designed for.

---

## What Merlin does

- **Keeps an eye on your inbox.** The urgent things find your phone the moment they arrive. Receipts, newsletters, and the routine noise get sorted and out of the way before you sit down.
- **Manages your calendar.** "Put Alice on for Tuesday at 2." Done. Move it, decline a conflict, send the invite — Merlin handles the rest.
- **Books your table.** Mention the place and the night. If a window opens up, Merlin grabs it.
- **Brings you the morning.** A quiet brief with today's calendar, your tasks, the weather, and the headlines you'd care about — waiting for you before you're out of bed.
- **Knows your taste.** Recommends restaurants by what you actually like and where you are, not what's popular this week.
- **Watches the world for you.** A flight you've been pricing drops. Tickets to a show you'd want. A friend's birthday is in a week. The follow-up call you meant to schedule. You'll hear about it at the right moment, from the right direction.
- **Helps with the rest.** "Write that no for me." "Summarize this." "Plan a long weekend in Lisbon under two thousand." Describe what you need; Merlin does the work.
- **Stays close.** A companion iOS/macOS app keeps the conversation going. Reply with 👍 to confirm, or "skip" to teach Merlin what not to bring up again.

## What makes Merlin different

Five things most AI assistants miss.

🧠 **It remembers you.** Your preferences, your decisions, the things you said last month. The longer you use it, the more it understands what *you* actually want.

🐝 **It reaches out.** When Merlin notices something worth knowing, it tells you. Quietly. At the right moment. When there's nothing useful to say, it stays quiet.

🛠️ **It gets things done.** Doesn't just suggest. Writes the email, books the dinner, sets the reminder, runs the research. With safety rails for the things that matter — no money moves without you saying yes.

⏰ **It shows up on time.** Recurring work happens on schedule, in the background. You don't have to remember; it does.

📈 **It gets better as you live with it.** Every week, Merlin reviews how it did, learns from how you responded, and tunes itself to fit your life more closely.

---

## Quickstart

For the technically inclined:

```bash
git clone https://github.com/mraccah2/merlin.git ~/Dev/merlin
cd ~/Dev/merlin

# 1. Install deps, set up runtime dirs, check Ollama
./scripts/bootstrap.sh

# 2. Interactive setup — writes .env, generates a webhook token, seeds example configs
./bin/merlin init

# 3. Start everything in the foreground (Ctrl-C to stop)
./bin/merlin up

# In another terminal — fire a test job
./bin/merlin dispatch morning-digest

# Watch it work
./bin/merlin tail ops
```

For 24/7 deployment, install the launchd or systemd service per [`docs/installer.md`](docs/installer.md).

## What ships out of the box

| | |
|---|---|
| Kernel | process-manager, supervisors, channel framework, MCP shell bridge, kernel test suite |
| CLIs | 22 tools — `merlin`, `wiki`, `memory`, `email-*`, `context-*`, `hum-*`, `suggestion-*` |
| Libraries | `wiki-store`, `memory-store`, `local-llm`, `apns-push`, `supabase-rest`, `merlin-context` |
| Apps | Two SwiftUI companion apps — chat (`apps/companion/`) and fitness tracker (`apps/spotter/`) |
| Reference jobs | `morning-digest`, hum + 5 hum-* playbooks, wiki-audit, memory-snapshot, chrome-cdp-watch, context-sync |
| CI | iOS + macOS TestFlight workflows, secret-scan |

## What you'll build yourself

Merlin is deliberately a small, opinionated kernel — not a turnkey product. The integrations are sparse because *your* assistant should know about *your* life.

- **Populate Hum's awareness loop.** Empty on day 1. See [`docs/hum.md`](docs/hum.md).
- **Populate your memory corpus.** Empty on day 1. See [`docs/memory.md`](docs/memory.md).
- **Wire up integrations** — Gmail ([guide](docs/integrations/gmail.md)), Supabase ([guide](docs/integrations/supabase.md)), SMTP ([guide](docs/integrations/smtp.md)), or your own.
- **Write your own jobs.** Markdown playbooks. See [`docs/writing-a-job.md`](docs/writing-a-job.md).
- **Set your Apple signing identity** — for the companion apps. See [`apps/companion/CODE-SIGNING.md`](apps/companion/CODE-SIGNING.md).

---

## Requirements

Minimum:

- **macOS** (Apple Silicon preferred) or **Linux**
- **Node.js 22.5+** (built-in `node:sqlite`)
- **[Ollama](https://ollama.com)** with `gemma3:4b` and `nomic-embed-text` pulled
- A **Claude Max subscription** (recommended) OR a **Claude API key**

Full dependency matrix, per-feature requirements, and platform notes in [`docs/dependencies.md`](docs/dependencies.md). The bootstrap script probes for what's installed and warns about gaps.

## Under the hood

For the curious. Merlin is built on Claude Code with persistent `claude -p` supervisors, durable session resume, an MCP shell bridge that turns any CLI into an agent tool, a SQLite memory layer with full-text + embedding search, a local Ollama model handling latency-sensitive acknowledgments, and markdown playbooks describing every scheduled job. Read the architecture: [`system/architecture.md`](system/architecture.md).

## License + contributing

Apache 2.0 — see [`LICENSE`](LICENSE). Contributions welcome; see [`CONTRIBUTING.md`](CONTRIBUTING.md). Security disclosures via [`SECURITY.md`](SECURITY.md).

→ Read more: **[silo.co/merlin](https://silo.co/merlin)**
