# Dependencies — what you actually need to run Edva

The README's prereqs list is the minimum. This is the complete map: required vs optional, what platform expects what, where to get each piece. Read before committing to a deployment plan.

## Tier 1 — required to run *anything*

| Dep | Purpose | Where | Verify |
|---|---|---|---|
| **Node.js 22.5+** | Built-in `node:sqlite` requires 22.5+; all kernel code is JS/TS | [nodejs.org](https://nodejs.org) | `node --version` |
| **npm** | Dependency install across subpackages | ships with Node | `npm --version` |
| **Claude Max + Claude Code CLI** | Every agent runs as `claude -p` on a Max login; the supervisors hide `ANTHROPIC_API_KEY` from it ([`agent-auth-model.md`](agent-auth-model.md)) | `npm install -g @anthropic-ai/claude-code`, then `claude` once | `claude auth status` |
| **macOS** (primary target) | launchd jobs, Keychain-held Claude credentials, AppleScript tools, `ioreg`; the kernel also assumes Node at `/opt/homebrew/bin/node` and the install at `~/Dev/edva` (or `EDVA_HOME`) — see [`installer.md`](installer.md) | — | — |
| **A POSIX shell** | bash 4+ (macOS users: `brew install bash` for 5.x; the default `/bin/bash` is 3.2 from 2007 and may misbehave) | — | `bash --version` |

## Tier 2 — strongly recommended

| Dep | Purpose | Without it |
|---|---|---|
| **Ollama** + `gemma3:1b` + `nomic-embed-text` | Local classification (`lib/local-llm.mjs`) + memory embeddings | Local classifiers fail open to a normal dispatch; memory search loses the semantic component (FTS still works). |
| **jq** | Used by trigger scripts + watchdog for JSON parsing | A few scripts will warn and skip. |
| **curl** | Used by webhook trigger scripts | Trigger scripts won't dispatch. (cron-driven jobs broken.) |

## Tier 3 — required if you use specific features

### Email triage (Gmail Pub/Sub)

- Google Cloud project + Gmail + Pub/Sub APIs enabled
- OAuth client (Desktop type)
- A public HTTPS hostname tunnelled to the host's port 9090 (the kernel's watchdog knows a Cloudflare Tunnel; any reverse proxy works)
- See [`docs/integrations/gmail.md`](integrations/gmail.md)

### Outbound mail (`bin/email-send`)

- An SMTP provider. The shipped `email-send` uses **SMTP2Go** but the code is easy to swap.
- See [`docs/integrations/smtp.md`](integrations/smtp.md)

### Phone-channel (companion iOS/macOS app)

- A **Supabase** project (free tier is enough)
- APNs auth key + Apple Developer account (for push notifications)
- See [`docs/integrations/supabase.md`](integrations/supabase.md) and [`apps/companion/CODE-SIGNING.md`](../apps/companion/CODE-SIGNING.md)

### Google Calendar / Tasks / Contacts inside agent tools

Several kernel tools and harvesters shell out to the `gog` Google CLI (`gog calendar …`, `gog tasks …`). **It doesn't ship with Edva** — install it yourself (it needs `GOG_KEYRING_PASSWORD` in `.env` with a file keyring), or replace those calls.

Three paths:

1. **Install `gog`** and authorize it for Calendar and Tasks (`gog auth add <account> --services calendar,tasks`). `edva doctor` checks that it answers.
2. **Write a minimal `gog` shim** matching the call shapes the code uses (`grep -rn '\bgog\b' agent bin lib`) and put it on the agents' `PATH`.
3. **Use Google MCP servers** instead, wired into your MCP configs, and adapt the playbooks that call `gog` (`morning-digest`, the calendar/tasks harvesters and sensors).

If you go path #1, please consider opening a PR documenting which official MCP server you used + how you wired it — it would help everyone after you.

### iOS/macOS companion app builds

- **macOS host with Xcode 16+** (Apple Silicon strongly recommended for build speed)
- **Apple Developer Program** account ($99/year) for code signing
- **Ruby** + the `fastlane` gem (`gem install fastlane`) — for `bundle exec fastlane` workflows
- For Trainer: **xcodegen** (`brew install xcodegen`) — generates `Trainer.xcodeproj` from `project.yml`
- See [`apps/companion/CODE-SIGNING.md`](../apps/companion/CODE-SIGNING.md)

### GitHub Actions CI (iOS + macOS TestFlight builds)

The shipped workflows (`.github/workflows/ios-testflight.yml`, `.github/workflows/macos-testflight.yml`) target a **self-hosted macOS runner** with labels `[self-hosted, macos, ios]`. Two reasons:

- Builds are 3-5× faster than GitHub-hosted `macos-latest` runners.
- Self-hosted has stable signing keychains; hosted runners frequently lose them between jobs.

**If you don't have a self-hosted runner**, you can either:

- **Use GitHub-hosted runners**: change `runs-on:` to `macos-latest` in both workflow files. Slower; you may need to add a `setup-xcode` step depending on which Xcode version you target.
- **Set up a self-hosted runner**: dedicate a Mac (mini, laptop, anything) per [GitHub's docs](https://docs.github.com/en/actions/hosting-your-own-runners). Tag with the labels above. The runner config script generates a LaunchAgent automatically.

**Keep a self-hosted runner off a public repo.** A runner attached to a public fork can be made to run other people's workflow code on that Mac, with access to its keychain and everything Edva keeps on it. Attach the runner only to a private fork; if your fork is public, use GitHub-hosted runners.

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
| `ASC_PRIVATE_KEY` | ASC API key contents (the `.p8` file) |

Plus the secret `MAC_INSTALLER_IDENTITY` — the full name of the "3rd Party Mac Developer Installer: … (TEAMID)" identity in the runner's keychain, used to sign the macOS package. It is a secret, not a variable, because it names the developer and public repos have public build logs.

See [Apple's docs](https://developer.apple.com/documentation/appstoreconnectapi/creating_api_keys_for_app_store_connect_api) for generating the ASC API key.

### Always-on host (launchd / systemd)

If you're putting Edva on a dedicated machine (Mac mini, Intel NUC, Raspberry Pi if Linux, anything 24/7):

- **macOS**: `launchctl`, auto-login enabled, FileVault disabled, `pmset` tuned for never-sleep. Full procedure in [`docs/installer.md`](installer.md).
- **Linux**: `systemctl --user`, `loginctl enable-linger` for the user. Procedure in [`docs/installer.md`](installer.md).
- **Tailscale** (or equivalent) if you want to reach the host's wiki UI at port 9096 from elsewhere on your network. Optional — Edva works fine on localhost only.

## Tier 4 — purely optional convenience

| Dep | What it adds |
|---|---|
| `gh` | Some Edva scripts use `gh` to inspect runs/issues; without it those features short-circuit silently. |
| `op` (1Password CLI) | Resolve secrets from a vault at start-up instead of keeping them in `.env`. See [`docs/hardening.md`](hardening.md). |
| Chrome + chrome-devtools-mcp | Agent-driven browser automation on the `ops` tier (automation Chrome on :9222; `examples/mcp/ops-agent.mcp.example.json`, `browsing-skills/`). Jobs that need it are listed in `agent/config/chrome-jobs.json`. |
| Python 3 | Trainer's `ci/distribute_external.py` uses Python. Not needed if you're not building the iOS apps. |

## Hardware notes

Edva will run on:

- **Mac mini / iMac / MacBook**, M1 or newer recommended for fastlane build speed. Intel works for everything except the iOS-build CI runner (slower).
- **Linux server / VPS**, any 64-bit — possible but secondary: the macOS-only pieces stay off and the Node-path convention needs a symlink ([`installer.md`](installer.md)). Memory: 8 GB is comfortable for the supervisors + a small Ollama model.
- **Raspberry Pi 4/5** — untested; the macOS assumptions above apply, and Ollama limits you to small models.

What you cannot do:

- **Run the companion-app builds on Linux.** Apple toolchain is macOS-only. You can still run the agent + use the wiki UI on Linux; the iOS app just has to be built elsewhere.
- **Run any AppleScript-based tools on Linux** (Notes, iMessage, etc.). Already excluded from the shipping tool registry; if you adapt them, scope them to macOS-only.

## Network notes

The supervisors bind to `127.0.0.1`: ops **9090** (Gmail push, the only port meant to be reachable through your tunnel), **9091** (control), **9092** (webhook), **9093** (health); ops-light **9081–9083**; ops-haiku **9071–9073**; chat health **9094**; the process manager **9095**; the wiki UI **9096**; the WhatsApp channel **9100**. Ports are set in `agent/config/agents.json` (kernel file — override per host only if you must). `edva up` fails loudly on `EADDRINUSE`.

Outbound connections you'll see:

- `api.anthropic.com` — Claude
- `127.0.0.1:11434` — Ollama (local, no egress)
- `*.supabase.co` — if Supabase wired
- `googleapis.com` — if Gmail Pub/Sub wired
- `api.smtp2go.com` — if outbound mail wired
- `api.appstoreconnect.apple.com` — only during iOS CI
- `edva-telemetry.vercel.app` — the one anonymous install ping `edva init` asks about (off with `EDVA_TELEMETRY=off` or `EDVA_NO_TELEMETRY=1`), and the private `/usage` push only if you set `EDVA_USAGE_TOKEN`

Nothing else phones home.
