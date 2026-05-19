# Dependencies — what you actually need to run Merlin

The README's prereqs list is the minimum. This is the complete map: required vs optional, what platform expects what, where to get each piece. Read before committing to a deployment plan.

## Tier 1 — required to run *anything*

| Dep | Purpose | Where | Verify |
|---|---|---|---|
| **Node.js 22.5+** | Built-in `node:sqlite` requires 22.5+; all kernel code is JS/TS | [nodejs.org](https://nodejs.org) | `node --version` |
| **npm** | Dependency install across subpackages | ships with Node | `npm --version` |
| **A Claude account** | Either an API key (pay-per-token) or Max subscription | [console.anthropic.com](https://console.anthropic.com) | — |
| **A POSIX shell** | bash 4+ (macOS users: `brew install bash` for 5.x; the default `/bin/bash` is 3.2 from 2007 and may misbehave) | — | `bash --version` |

## Tier 2 — strongly recommended

| Dep | Purpose | Without it |
|---|---|---|
| **Ollama** + `gemma3:4b` + `nomic-embed-text` | Phone-channel ack layer + memory embeddings | Phone-channel falls back to canned "thinking…" messages. Memory search loses the semantic component (FTS-only still works). |
| **Claude Code CLI** (`@anthropic-ai/claude-code`) | The supervisor spawns `claude -p` children to run the agents | Agents won't start. This is the kernel binary. |
| **jq** | Used by trigger scripts + watchdog for JSON parsing | A few scripts will warn and skip. |
| **curl** | Used by webhook trigger scripts | Trigger scripts won't dispatch. (cron-driven jobs broken.) |

## Tier 3 — required if you use specific features

### Email triage (Gmail Pub/Sub)

- Google Cloud project + Gmail + Pub/Sub APIs enabled
- OAuth client (Desktop type)
- A tunnel: **Hookdeck CLI** (`brew install hookdeck/hookdeck/hookdeck-cli`) or ngrok or your own reverse proxy
- See [`docs/integrations/gmail.md`](integrations/gmail.md)

### Outbound mail (`bin/email-send`)

- An SMTP provider. The shipped `email-send` uses **SMTP2Go** but the code is easy to swap.
- See [`docs/integrations/smtp.md`](integrations/smtp.md)

### Phone-channel (companion iOS/macOS app)

- A **Supabase** project (free tier is enough)
- APNs auth key + Apple Developer account (for push notifications)
- See [`docs/integrations/supabase.md`](integrations/supabase.md) and [`apps/companion/CODE-SIGNING.md`](../apps/companion/CODE-SIGNING.md)

### Google Calendar / Tasks / Contacts inside agent tools

The `agent/tools-mcp/index.mjs` exposes tools like `contacts_search` that shell out to a `gog` CLI. **This CLI doesn't ship with Merlin.** It's a contract — the upstream gandalf source provided a personal `gog` binary; the public Merlin tree expects you to bring your own.

Three paths:

1. **Use the official Google MCP servers** (`@modelcontextprotocol/server-google-*` or similar). Wire them into `agent/supervisor/mcp-config.json` instead of relying on `gog`. Cleanest path for new adopters.
2. **Write a minimal `gog` shim** that matches the call shape the playbooks use: `gog calendar list [--results-only] [--from ISO] [--to ISO]`, `gog tasks list @default`, `gog contacts search <query>`. Drop it in `bin/`. The contract is whatever the playbooks happen to call; see grep `\bgog\b` for the exact invocations.
3. **Disable the affected playbooks.** The reference jobs that lean on `gog` are `morning-digest` and several hum harvesters. Replace or remove them; the rest of the kernel works without `gog`.

If you go path #1, please consider opening a PR documenting which official MCP server you used + how you wired it — it would help everyone after you.

### iOS/macOS companion app builds

- **macOS host with Xcode 16+** (Apple Silicon strongly recommended for build speed)
- **Apple Developer Program** account ($99/year) for code signing
- **Ruby** + the `fastlane` gem (`gem install fastlane`) — for `bundle exec fastlane` workflows
- For Spotter: **xcodegen** (`brew install xcodegen`) — generates `Spotter.xcodeproj` from `project.yml`
- See [`apps/companion/CODE-SIGNING.md`](../apps/companion/CODE-SIGNING.md)

### GitHub Actions CI (iOS + macOS TestFlight builds)

The shipped workflows (`.github/workflows/ios-testflight.yml`, `.github/workflows/macos-testflight.yml`) target a **self-hosted macOS runner** with labels `[self-hosted, macos, ios]`. Two reasons:

- Builds are 3-5× faster than GitHub-hosted `macos-latest` runners.
- Self-hosted has stable signing keychains; hosted runners frequently lose them between jobs.

**If you don't have a self-hosted runner**, you can either:

- **Use GitHub-hosted runners**: change `runs-on:` to `macos-latest` in both workflow files. Slower; you may need to add a `setup-xcode` step depending on which Xcode version you target.
- **Set up a self-hosted runner**: dedicate a Mac (mini, laptop, anything) per [GitHub's docs](https://docs.github.com/en/actions/hosting-your-own-runners). Tag with the labels above. The runner config script generates a LaunchAgent automatically.

**Required GitHub Actions secrets** (set under Settings → Secrets and variables → Actions):

| Secret | What |
|---|---|
| `IOS_CERTIFICATE_P12` | Base64-encoded `.p12` of your Apple Distribution certificate |
| `IOS_CERTIFICATE_PASSWORD` | Password for the `.p12` |
| `MAC_CERTIFICATE_P12` | Same for Mac Installer Distribution certificate |
| `MAC_CERTIFICATE_PASSWORD` | Password for the mac `.p12` |
| `MAC_PROVISIONING_PROFILE` | Base64-encoded mac app `.provisionprofile` |
| `MAC_NOTIFSERVICE_PROFILE` | Base64-encoded notification-service `.provisionprofile` |
| `ASC_KEY_ID` | App Store Connect API key ID |
| `ASC_ISSUER_ID` | ASC API key issuer ID |
| `ASC_KEY_P8` | ASC API key contents (the `.p8` file, base64 or raw) |

See [Apple's docs](https://developer.apple.com/documentation/appstoreconnectapi/creating_api_keys_for_app_store_connect_api) for generating the ASC API key.

### Always-on host (launchd / systemd)

If you're putting Merlin on a dedicated machine (Mac mini, Intel NUC, Raspberry Pi if Linux, anything 24/7):

- **macOS**: `launchctl`, auto-login enabled, FileVault disabled, `pmset` tuned for never-sleep. Full procedure in [`docs/installer.md`](installer.md).
- **Linux**: `systemctl --user`, `loginctl enable-linger` for the user. Procedure in [`docs/installer.md`](installer.md).
- **Tailscale** (or equivalent) if you want to reach the host's wiki UI at port 9096 from elsewhere on your network. Optional — Merlin works fine on localhost only.

## Tier 4 — purely optional convenience

| Dep | What it adds |
|---|---|
| `gh` | Some Merlin scripts use `gh` to inspect runs/issues; without it those features short-circuit silently. |
| `op` (1Password CLI) | Lets you reference secrets via `op://Vault/Item/field` instead of plaintext in `.env`. See [`docs/hardening.md`](hardening.md). |
| Chrome + chrome-devtools-mcp | If you want agent-driven browser automation (the gandalf source used this for Tripit scraping, lottery entries, etc.). Not wired into any shipping job. |
| Python 3 | Spotter's `ci/distribute_external.py` uses Python. Not needed if you're not building the iOS apps. |

## Hardware notes

Merlin will run on:

- **Mac mini / iMac / MacBook**, M1 or newer recommended for fastlane build speed. Intel works for everything except the iOS-build CI runner (slower).
- **Linux server / VPS**, any 64-bit. We've tested on Ubuntu 22.04 and Debian 12. Memory: 4 GB is enough for the supervisors + Ollama with a small model; 8 GB is comfortable.
- **Raspberry Pi 4/5** — should work for the supervisor-only deployment (no iOS app builds). Ollama is the limiting factor — small models only, or use the API-key auth mode and skip Ollama.

What you cannot do:

- **Run the companion-app builds on Linux.** Apple toolchain is macOS-only. You can still run the agent + use the wiki UI on Linux; the iOS app just has to be built elsewhere.
- **Run any AppleScript-based tools on Linux** (Notes, iMessage, etc.). Already excluded from the shipping tool registry; if you adapt them, scope them to macOS-only.

## Network notes

The supervisor binds to localhost on ports **9090** (gmail-pubsub), **9092** (webhook), **9093** (ops health), **9094** (chat health), and **9096** (wiki UI). If you have services running on those ports already, change them in `agent/config/agents.json` and the corresponding wiki-server / Hookdeck config. The bootstrap script doesn't probe for conflicts — `merlin up` will fail loudly on `EADDRINUSE`.

Outbound connections you'll see:

- `api.anthropic.com` — Claude
- `127.0.0.1:11434` — Ollama (local, no egress)
- `*.supabase.co` — if Supabase wired
- `googleapis.com` — if Gmail Pub/Sub wired
- `hkdk.events` — if Hookdeck wired
- `api.smtp2go.com` — if outbound mail wired
- `api.appstoreconnect.apple.com` — only during iOS CI

No telemetry, no analytics, no "phone home" anywhere in the kernel.
