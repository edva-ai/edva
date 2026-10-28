# Edva Architecture

The always-on server that powers the user's email triage, proactive hum, scheduled digests, and iOS chat.
Runs on an always-on macOS host under `~/Dev/edva/`. For live state, use the `edva` CLI.

This map covers the generic kernel. The installation's own subsystems and jobs, and the instance specifics this map leaves generic (accounts, hostnames, project ids), are in its local companion `system/architecture-local.md` (private); the dated history is in `system/changelog.md` (private).

## Host

| Setting | Value | Why it matters |
|---|---|---|
| User | the operator's macOS account (auto-login at boot) | LaunchAgent runs in the user GUI session, so a logged-in user is always present |
| `pmset sleep` | `0` (disabled) | System stays awake 24/7 so cron + supervisors never pause |
| `pmset disksleep` | `0` | Disks stay spun up; Gmail Pub/Sub watch + Cloudflare Tunnel never drop |
| `pmset displaysleep` | `180` min | Display may sleep; GUI processes keep running (Chrome, tmux GUI) |
| GUI session | Always active | Enables visible Chrome automation (via `chrome-devtools-mcp`) without Xvfb or headless workarounds |
| Automation Chrome | LaunchAgent `com.edva.chrome-cdp` (KeepAlive=true) — separate Chrome instance with `--remote-debugging-port=9222 --user-data-dir=~/.cache/chrome-devtools-mcp/chrome-profile` | Browser-automation target for `chrome-devtools-mcp`; binds IPv6 :9222 (the user's interactive Chrome on the default profile silently grabs IPv4 :9222 with a stub HTTP/404 server, so probes use `localhost` which resolves to ::1 first). Distinct from the user's interactive Chrome — automation profile needs its own logins on the sites it automates. |
| Interactive Chrome | Launched normally by the user from the dock | Default profile, no debug port, no Edva dependency on it |
| FileVault | Off (incompatible with auto-restart for 24/7 ops) | Chrome still protects saved cards via macOS Keychain |
| `ai.claude.session` LaunchAgent | RunAtLoad + KeepAlive | Boots process-manager, which spawns chat-supervisor + ops-supervisor + wiki-server + whatsapp-channel + imessage-channel + slack-channel directly (no tmux in the supervision path). The Gmail-push Cloudflare Tunnel is a separate launchd agent (`com.cloudflare.cloudflared`). |
| tmux | `edva` session (observability only) | Used for attaching to live panes during debugging; not in the critical path — supervisors run as direct children of process-manager |

## Process Tree

```
launchd
└── ai.claude.session                (LaunchAgent, KeepAlive)
    └── process-manager.mjs          (boots + restarts the supervisors + wiki server + whatsapp)
        ├── chat-supervisor.mjs      → wraps claude -p (chat-agent, Sonnet on Max)
        │     phone-channel ingress; HTTP :9094 (/dispatch, /health, /reply-draft, /rotate, /restart)
        ├── supervisor/index.mjs --agent ops
        │                            → wraps claude -p (ops-agent, Sonnet 5.5 on Max)
        │     :9090 gmail pubsub (OIDC-verified) + /email-inbound (X-Inbound-Secret), :9092 webhook (auth'd), :9093 health/cost/rotate/restart
        ├── supervisor/index.mjs --agent ops-light
        │                            → wraps claude -p (ops-light-agent, Sonnet on Max)
        │     :9082 webhook (auth'd), :9083 health/cost/rotate/restart — NO gmail ingress; lean Chrome-less MCP set
        ├── supervisor/index.mjs --agent ops-haiku
        │                            → wraps claude -p (ops-haiku-agent, Haiku on Max)
        │     :9072 webhook (auth'd), :9073 health/cost/rotate/restart — NO gmail ingress; lean Chrome-less MCP set
        ├── wiki serve --port 9096   → HTTP wiki browser, 0.0.0.0:9096 (LAN + Tailscale)
        ├── whatsapp-channel/index.mjs → Baileys WhatsApp client (direct WebSocket, no browser), :9100
        ├── imessage-channel/index.mjs → tails chat.db (read-only) → imessage-inbox.jsonl, health :9107
        └── slack-channel/index.mjs    → Slack RTM websocket on the user's web session → slack-inbox.jsonl, :9108

Separate launchd agent (NOT under process-manager):
    com.cloudflare.cloudflared       → Cloudflare Tunnel <push hostname> → localhost:9090
                                       (Gmail Pub/Sub push + CF Email Worker ingress;
                                        replaced the Hookdeck CLI relay on 2026-05-30)
```

Both wrappers spawn `claude` with `--resume <session-id>` and stream-json transport so transcripts are persistent across restarts. Sessions are stored at `agent/supervisor/state/{chat,ops}/session.json`; chat's also holds a usage-limit outage in progress (`quotaOutage`: the hold and which notices went out), so a restarted chat supervisor keeps holding without announcing it again (`agent/supervisor/README.md`).

## Components

| Component | Role | Where it runs |
|---|---|---|
| **chat-agent** (Sonnet, Max) | Real-time iOS chat via Edva app; hum feedback recognition; replies through `mcp__phone-channel__reply` | `claude -p` spawned by chat-supervisor.mjs |
| **ops-agent** (**Sonnet 5.5**, Max) | Gmail triage + deep-synthesis jobs (daily/weekly/monthly summaries, nightly review) + Chrome/CDP jobs; the general remainder. **Flipped opus→claude-sonnet-5 on 2026-07-02**. The one Opus job runs as an ephemeral fork instead (see `system/architecture-local.md`). | `claude -p` spawned by `supervisor/index.mjs --agent ops` |
| **ops-light-agent** (Sonnet, Max) | Sonnet-tier cron/webhook jobs (job-routing.json model==sonnet, plus local-tier-on-supervisor) — digests, drafting, hum ideation/daily/review, moderate reasoning. Lean Chrome-less MCP set; no Gmail ingress. Routed by `webhook-auth.sh` to :9082/:9083. Added 2026-06-17 (Lever B). | `claude -p` spawned by `supervisor/index.mjs --agent ops-light` |
| **ops-haiku-agent** (Haiku, Max) | Haiku-tier pure scan/watch jobs (job-routing.json model==haiku; the list is in `system/architecture-local.md`). ~67% cheaper than Sonnet on these. Lean Chrome-less MCP set; no Gmail ingress. Routed to :9072/:9073 with a haiku→sonnet→opus health fallback. Added 2026-06-17 (Lever B Haiku tier). | `claude -p` spawned by `supervisor/index.mjs --agent ops-haiku` |
| **Cloudflare Tunnel** | Public ingress `<push hostname>` → :9090 (Gmail Pub/Sub push, OIDC-verified + CF Email Worker, X-Inbound-Secret). Replaced Hookdeck 2026-05-30. Also serves the wiki fallback origin (:9097) and further Access-gated hostnames, which verify the Access JWT at the origin too (hostnames in `system/architecture-local.md`) | `cloudflared`, own launchd agent `com.cloudflare.cloudflared` (NOT process-manager) |
| **wiki-server** | HTTP wiki browser at `0.0.0.0:9096` (always on; reachable on LAN + Tailscale, e.g. `http://<host>:9096`); reads `pages.raw_md` from `data/memory-index.db` | child of process-manager |
| **whatsapp-channel** | Baileys WhatsApp client (`:9100`); logs inbound to `whatsapp-inbox.jsonl`, pushes to chat by rule only for `always_push_senders` (1:1 direct messages stay silent unless `push_direct_messages: true` in `whatsapp-channel/filter-config.json`, since the phone already notifies for them); every other message, groups included, goes to message-alert, where Jev judges importance. No keyword matching | child of process-manager |
| **imessage-channel** | Realtime iMessage/SMS watcher (`agent/imessage-channel/index.mjs`): wakes on writes to `~/Library/Messages/chat.db-wal` (3 s poll fallback), reads rows past a persisted ROWID cursor (`data/imessage-channel-state.json`; no backfill on first start) through `lib/imessage-db.js`, and appends every message, 1:1 and group, both directions, to `data/imessage-inbox.jsonl` with the body decoded from `attributedBody`, the chat's name (display name, else its participants by Contacts name) and the sender's Contacts name. Pushes are opt-in by structure only (config `imessage-channel`: `push_direct_messages`, `push_group_messages`, `always_push_senders`, `always_push_chats`, `block_chats`; none by default, the phone already notifies). `GET /health` on :9107; pages the system channel once if chat.db is unreadable for 10 min (Full Disk Access). Sending stays with `imsg send` / `imsg send --chat <group>` (Messages.app via AppleScript). | child of process-manager |
| **message-alert** (cross-channel) | `lib/message-alert.mjs`: every inbound iMessage, WhatsApp and Slack message that the channel's own push rules did not push (and is not the user's own, a reaction, a status/newsletter/bot stream, a WhatsApp `block_chats` chat, a Slack `block_channels` channel, or an iMessage row older than 30 min) is judged urgent / important / normal by Jev site `message-alert` (Sonnet toolless shadow + fallback), with the chat's last 10 messages from its inbox as context (`RECENT_N`). Urgent or important → `edva-send-curl --intent message-alert` ("Urgent WhatsApp from … (in …): …"), so the outbound precheck and motion gate still apply. Ordinary channel traffic is held to a higher bar: a Slack channel message that does not @-mention the user (`rubric: "channel"`, slack-channel config `channel_alerts`, default `named-or-major`) is judged by Jev site `message-alert-channel` instead (same Sonnet fallback, reading that site's question file), which pings only for a message that calls the user by name or reports a really major issue; DMs, group DMs and @-mentions keep the standard rubric. The Slack runner renders `<@U…>` markup as @Name before either judgment, so the judge can see who a message is addressed to. Queue of 2 concurrent judgments, 200 max; log `data/message-alert-log.jsonl`; off switch `touch data/.message-alert-off`. Email keeps its own P1 path. | library used by the three channel runners |
| **slack-channel** | Realtime Slack runner (`agent/slack-channel/index.mjs` + pure `core.mjs`). Primary transport: the official installed Slack app over Socket Mode (`SLACK_USER_TOKEN` xoxp + `SLACK_APP_TOKEN` xapp; `transport: "socket-mode"`); backup when those are missing or rejected: the user's own web session (`SLACK_XOXC_TOKEN` + `SLACK_D_COOKIE` + `SLACK_TEAM_ID` in `.env`, captured from the automation Chrome by `bin/slack-session-capture`, verified with `auth.test`): `rtm.connect` websocket (web-gateway fallback), 30 s pings, backoff to 5 min. Logs every DM, group DM, channel message, thread reply, edit/delete and the user's own messages to `data/slack-inbox.jsonl` (reader `slack-inbox`), push decisions to `slack-filter-log.jsonl`; pushes only `always_push_users` DMs/mentions (config `slack-channel`); every other message goes to message-alert, where channel traffic that does not @-mention the user pings only when it names them or reports a really major issue (`channel_alerts`). HTTP on 127.0.0.1:9108: `/health`, `/conversations`, `POST /send` (`bin/slack-send`, dash-gated). On `invalid_auth` posts one system notice, retries every 6 h and re-reads `.env` each minute. Replaces the retired `slack-poll`. | child of process-manager |
| **process-manager** | Boots + restarts both supervisors + wiki server + whatsapp-channel + imessage-channel + slack-channel; health endpoint :9095 | child of `ai.claude.session` launchd agent |
| **heartbeat-sender** | Posts system health to Firebase RTDB every 2 min. On `internet_ok=false` also drops a layered local forensic snapshot to `logs/net-diag.log` (rate-limited 5 min; runs before the gcloud token gate so an outage still captures). Manual: `heartbeat-sender.sh --diag-test` | LaunchAgent (label in `system/architecture-local.md`) |
| **heartbeat-watchdog** (off-box) | Cloud Function `checkHeartbeat` reads `/heartbeat/latest`; if stale >5 min, alerts via email **+ APNs push** (independent channels). The one monitor that survives a full-host wedge — it runs in Google's cloud, not on the host. | Firebase Cloud Function (the operator's Firebase project), Cloud Scheduler every 5 min |
| **minibeat** + **checkMinibeat** (off-box) | FAST host liveness, added 2026-09-26: `bin/minibeat` PUTs a server timestamp to `/heartbeat/minibeat` every 30s (nothing else in it, so nothing can break it); Cloud Function `checkMinibeat` alerts email + APNs once it is 3 min stale (6 missed beats), ONE alert per outage, a recovery email when it returns. While that alert is open (`/heartbeat/minibeat_alert`), `checkHeartbeat` stays quiet so the slow 10-min alert does not duplicate it. A stale beat means the host, its router, or its internet link is down. | LaunchAgent `com.edva.minibeat` (KeepAlive) + Cloud Scheduler every 1 min |
| **watchdog** | Detects stuck/stale agents, gh/gog auth state, low free space on the data volume, restarts dead panes; warns ahead of the Max sign-in lapse (one daytime system-channel note with `--push`, from day 22 after the last sign-in it can infer); when a paged sign-in outage closes and the launchd sign-in check reads signed in again, starts again the launchd jobs it made miss that are on the installation's approved safe-to-run-late list (`bin/auth-outage-replay`, list in `agent/local/config/auth-outage-replay.json`) and posts one line saying what ran | cron every 2 min (`agent/scripts/watchdog.sh`) |
| **actions-runner** | GitHub Actions self-hosted runner for iOS/macOS CI | LaunchAgent `actions.runner.<owner>-<repo>.*` |
| **resilience-test** | Scheduled kill-tests of agents to verify recovery | LaunchAgent (cron-style StartCalendarInterval) |

## Channels (MCP)

| Channel | Direction | Agent | Purpose |
|---|---|---|---|
| `phone-channel` | ingress | chat-agent | Edva iOS ↔ Supabase Realtime ↔ agent (an installation's own card kinds: typed-reply hints in `agent/phone-channel/_ext/reply-hints.mjs`, tap handlers in `lib/_ext/choice-handlers.mjs`; the hum lanes a location edge fans out to: `agent/local/config/location-lanes.json`); also generates acks via local `gemma3:1b` (Ollama, see Auth Model), and streams long replies into the chat row while the agent writes them (polls chat-supervisor `GET /reply-draft`, see 2026-10-05) |
| `gmail-channel` | ingress | ops-agent | Google Pub/Sub push via Cloudflare Tunnel → email events (`:9090`, OIDC-verified) |
| `webhook-channel` | ingress | ops / ops-light / ops-haiku | Scheduled task dispatch. `dispatch_or_skip()` in `webhook-auth.sh` routes by job-routing.json `model`: haiku→ops-haiku `:9072`, sonnet→ops-light `:9082`, opus/chrome→ops `:9092` (Bearer token from `secrets/webhook-token`; haiku→sonnet→opus health fallback) |
| `tools-mcp` | tools | both | Shell bridge to `bin/` CLIs. Kernel tools live in `agent/tools-mcp/index.mjs`; an installation's own tools (its devices, accounts, services…) are modules in `agent/tools-mcp/_ext/*.mjs`, each exporting `tools` (or a function returning them) and an optional `after` (the tool they follow, so the served list — part of every session's cached prefix — keeps a stable order). Its wording comes from `agent/local/config/tools-mcp.json` and its server instructions from `agent/local/prompts/tools-mcp-instructions.md` |

HTTP endpoints — ops `:9090` (gmail pubsub), `:9092` (webhook, auth'd), `:9093` (health/cost/rotate/restart); ops-light `:9082`/`:9083` and ops-haiku `:9072`/`:9073` (webhook + health/cost/rotate/restart, no gmail port); chat `:9094` (dispatch/health/heartbeat/rotate/restart). `dispatch_or_skip()` in `agent/scripts/lib/webhook-auth.sh` resolves each job's tier from `job-routing.json` `model` (haiku→ops-haiku, sonnet/local→ops-light, opus/chrome/unknown→ops), gates POSTs on `childAlive` from the chosen `/health`, and degrades upward (haiku→sonnet→opus) when a cheaper sibling is unhealthy.

**Restart scope (read this before reading watchdog logs):** `POST /restart` on `:9093` (ops) or `:9094` (chat) rotates only the inner `claude-session` child — the supervisor process itself keeps running. Supervisor process restarts are owned by `process-manager.mjs`, which runs the supervisors as direct children and respawns them on exit. So a watchdog log line like `Crash loop detected: consecutiveZeroTurns=5 — POSTing /restart to supervisor` followed by an unchanged `restarts=N up=Xh` in `edva status` is **not** a bug — the inner child rotated as designed, while the outer supervisor PID kept its uptime. Use `edva status` `restarts` field for outer supervisor restarts; the inner child rotation is what `/restart` triggers.

## External Dependencies

- **Cloudflare Tunnel** — `<push hostname>` (launchd agent `com.cloudflare.cloudflared`) tunnels Gmail Pub/Sub push + the CF Email Worker to localhost:9090. Replaced Hookdeck 2026-05-30. Push path is OIDC-authenticated (`supervisor/oidc-verify.mjs`, config in `secrets/pubsub-oidc.json`). Hostnames and the other routes on the tunnel: `system/architecture-local.md`.
- **Google Cloud (the operator's project)** — Gmail push, Pub/Sub topic, OAuth (gcal/gtasks via `gog` CLI)
- **Supabase (the main project)** — Realtime `edva_messages`, `photos` tables (+ `watch_titles`/`watch_seasons`/`watch_feedback`, the shows & movies list); service-role key used by `edva-send-curl`.
- **Firebase RTDB** — heartbeat state + `/heartbeat/latest` (+ `/heartbeat/alert_state`, the alert-cooldown record). Watched **off-box** by the `checkHeartbeat` Cloud Function (`firebase/functions/index.js`, the operator's Firebase project, a Cloud Scheduler job every 5 min): on >5 min staleness it emails **and** APNs-pushes (30 min re-alert cooldown). This is the only liveness check that survives a full-host wedge (see 2026-07-07 in `system/changelog.md`). The APNs `.p8` signing key lives in Secret Manager as `APNS_KEY_P8` (bound to the function, not in git); device tokens are read from Supabase `device_tokens` with the service-role key, bound from Secret Manager as `SUPABASE_SERVICE_ROLE_KEY` (anon has no access to that table). Keep its Cloud Scheduler job **ENABLED** — a paused scheduler is a silently-dead watchdog.
- **APNs** — iOS push notifications (p8 key in `credentials/`). `lib/apns-push.mjs` builds the payload as a **plain notification**, which Siri announces on AirPods when *Settings → Notifications → Announce Notifications* is on (and Edva's *Show Previews = Always* so the body is read on a locked phone, not just "message from Edva"). The earlier **communication-notification** upcast (`NotificationService.swift` + `INSendMessageIntent`) was REMOVED on 2026-06-27: on-device it never actually formed a comm notification (always plain), and once Siri was authorized it reclassified the app as a SiriKit messaging provider, which **broke the plain AirPods announcement** that had worked all along. So no `mutable-content`, no reply category, no `IntentsSupported`/`NSUserActivityTypes` messaging declarations, no `requestSiriAuthorization`. `edva-notify --urgent` (→ `sendApnsPush({urgent})`) still sets `interruption-level: time-sensitive` directly in the payload so the ping pierces Driving/DND Focus (gated — reserve for genuinely time-critical nudges; needs the `time-sensitive` entitlement).
- **Active-device routing (2026-10-23)** — a visible push goes only to the device the user is actively using. Each app holds a 2-min lease, `device_tokens.active_until`, renewed every 45 s while in active use (`client/Edva/DeviceActivity.swift`: iOS = scene active; macOS = the app is frontmost, no input-idle check) and set to now when it leaves the foreground. `selectPushTargets()` in `lib/apns-push.mjs` (used by `sendApnsPush` and `sendPurchaseApprovalPush`) sends only to that device class (mac vs mobile = iPhone+iPad) while one class holds a live lease, and to every device when none or both do, so a crashed or asleep app fails open. On the active device the push lands silently in the open chat (`willPresent` suppresses the banner). Not routed: silent background pushes (iOS-only by design) and the off-box `checkHeartbeat` watchdog (`firebase/functions/index.js`), which still reaches every device. **Read on one, cleared on the others:** `sendApnsPush` records which device classes each message's push reached (`data/push-recipients.json`, 7 days; also logs `[apns-push] sent to …`). When a pushed message flips to read, phone-channel (`queueReadClear`, 3 s batch) calls `sendClearPush`, a silent push `{kind: "clear_notifications", message_ids, badge}` to exactly those classes; the app (`DeliveredNotifications` in `client/Edva/EdvaApp.swift`) removes the matching delivered banners and sets the icon badge. Best-effort: iOS may delay or drop background pushes, the Mac app hears it only while running, and a banner whose own delivery is slower than the clear still shows.
- **Voice (Siri / AirPods / CarPlay)** — rides the existing phone-channel round-trip, no new transport. **Outbound (works):** plain notifications are announced hands-free on AirPods (see APNs bullet). **Inbound (works, iOS 26):** the in-app `SendToEdvaIntent` **App Shortcut** (`client/Edva/EdvaIntents.swift`) — "Hey Siri, **Summon Edva**" → Siri prompts (`requestValueDialog`) → free-form dictation → `role:user` row in `edva_messages` → phone-channel acks + dispatches → answer returns as an announced push. Gotchas: App Shortcut phrases can't capture free text in one utterance (two-turn by design), must avoid Tell/Message/Send verbs (they collide with Siri's messaging and route to iMessage; "Summon"/"Ask" are safe), and their titles/phrases are iOS-cached (reboot to refresh after an app update). **The SiriKit messaging path was REMOVED** (2026-06-27): the `EdvaIntents` *extension* (`client/EdvaIntents/`, `INSendMessageIntentHandling`) is **no longer embedded** (un-embedded in the pbxproj — the target still exists but isn't shipped), and the NSE comm-notification upcast + messaging Info.plist declarations + `requestSiriAuthorization` are gone. That machinery never delivered third-party voice-reply ("Edva hasn't added support for that with Siri" on iOS 26) and, once Siri was authorized, it broke the plain announce. **True voice-reply to an announced message is deferred to iOS 27** (the messages App-schema `@AppIntent(schema: .messages.sendMessage)` + `content.appEntityIdentifiers`, Apple-Intelligence devices only). Until then, respond hands-free with "Summon Edva". The un-embedded extension still reads the app's Supabase session via shared keychain group (`<app bundle id>.shared`) if ever re-enabled.
- **Share sheet (in and out)** — **In:** the `EdvaShare` app extension (`client/EdvaShare/`, bundle `<app bundle id>.Share`, embedded in the iOS AND macOS apps) puts "Edva" in the share sheet / Share menu for text, a link/web page, up to 10 photos and up to 10 files. A small composer (preview + optional note) uploads photos (re-encoded JPEG ≤2048px) and files to the `edva-attachments` bucket via Storage REST (anon-insert policy), then inserts `role:user` rows into `edva_messages` (`metadata.source: "share"`): one bare-URL row per photo so it renders inline, then one row with the note + text + links + file URLs; since 2026-10-13 phone-channel bundles a share's rows (3 s quiet) into ONE dispatch, photos first. phone-channel appends `[Shared into Edva from another app via the share sheet]` so the chat agent knows it wasn't typed. Auth = the access token the app mirrors into the shared keychain group (`<app bundle id>.shared`) (`SharedSession`; mirrored on sign-in, foreground/background and every SDK token refresh via `SupabaseManager.mirrorOnTokenChanges`; the macOS app now declares that group too, its own group first so the existing session item keeps its default). The extension never refreshes the session (a refresh in another process would rotate the refresh token out from under the app); if the mirrored token is stale or the insert fails, the rows are parked in the keychain outbox (`client/Edva/ShareOutbox.swift`) and the app sends them on its next mirror. **Out:** every chat bubble's context menu has **Share…** (SwiftUI `ShareLink`) — text for messages, the public URL for photos.
- **SMTP2Go** — outbound agent mail via `bin/email-send` (From: Edva's own address, Reply-To: the user's address; both in `system/architecture-local.md`)
- **Anthropic** — hard invariant, see `agent/CLAUDE.md` "Auth Model". Both agents (chat + ops) run **exclusively** on the Max subscription, authenticated via the **login keychain** (`Claude Code-credentials`), **not** `~/.claude/.credentials.json` — resolution is keychain-first and that file must not be created on this host (2026-07-28); the supervisors strip `ANTHROPIC_API_KEY` from the `claude -p` child env (`unsetEnv: ["ANTHROPIC_API_KEY"]` in `claude-session.mjs`) so the key can't leak in. If Max is unavailable, Edva is down — **no API-key fallback is permitted for any agent**. **The one API-billed path is the wiki's model steps while Max is unavailable** (`lib/api-fallback.mjs`, key `EDVA_WIKI_API_KEY`, $25/month breaker paging the system channel; 2026-10-24, `docs/agent-auth-model.md` § The wiki's API fallback). Nothing else makes API-key-billed Anthropic calls (the ack layer switched to local Gemma on 2026-04-16, and to canned copy only on 2026-10-22 — see `system/changelog.md`). Strong preference for Max: a non-Anthropic model (Jev today) is used if, and only if, it has a capability Claude lacks, and never as a stand-in for Claude (`docs/agent-auth-model.md` § Non-Anthropic models).
- **Ollama (local)** — `http://127.0.0.1:11434`, serves **`gemma3:1b`** (~815MB on disk, ~1.5GB resident; lowered from gemma4:e2b's ~7.7GB on 2026-06-19 to reclaim RAM) for low-stakes local inference (the phone-channel ack layer used it until 2026-10-22; it is canned copy now) via `lib/local-llm.mjs`. Launched via `brew services start ollama`; `keep_alive` is **`15m`** (lowered from 24h on 2026-06-18 — `OLLAMA_KEEP_ALIVE` override) so the model unloads during genuine idle instead of pinning RAM round-the-clock; acks pay a cold-load only after a real idle gap. Ack layer falls through to `CANNED_REFRESH_MESSAGES` on Ollama error/timeout — that is the only permitted fallback in the whole system.
- **GitHub PAT** — `secrets/gh-token` for `gh` CLI in cron context
- **1Password Dev vault** — canonical archive for all developer secrets, plus runtime store for non-financial website credentials. `op` always runs under `OP_SERVICE_ACCOUNT_TOKEN` (set in `.env`); never personal-account auth. Website creds: 1P items titled `site:<domain>`, tagged `site-credential,edva`, read via `bin/dev-pass <domain>`. Financial sites (banks, brokerages — see `dev-pass` denylist) still go through `bin/apple-pass` for manual approval.
- **Twilio (SMS, outbound only)** — `bin/sms-send --to <+E164> --text "…" --authorized "<the user's words>" [--wait N]` sends one plain SMS through Twilio's REST Messages endpoint; `sms-send status <sid>` reads a message's delivery status. Only on the user's explicit ask; the authorizing quote is required and the text must open with the Edva identity line (both checked in code, `lib/sms-core.mjs`); a test run sends nothing (exit 9). Credentials are read at run time from the 1Password item named in `agent/local/config/sms-send.json` via the `@1password/sdk` (else `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`), never printed or logged. Gated by design like email and iMessage, not by outbound-precheck. Edva does not receive SMS replies. Log `data/sms-sent.jsonl`. Docs: `docs/sms-send.md`; this installation's account and number: `system/architecture-local.md`.
- **SerpApi (Google results as JSON)** — `bin/serpapi <engine> "<query>" [--param=value]` queries any SerpApi engine (google, google_maps, google_news, google_scholar, google_shopping, google_flights, google_hotels, google_events) and prints the result blocks as compact JSON; `serpapi account` shows plan + searches left without spending one. Free plan: 250 searches/month, 250/hour — every search counts, so cache and never loop. Key `SERPAPI_API_KEY` in `.env`; canonical copy in the 1Password Dev vault.

The installation's own integrations are in `system/architecture-local.md` § External dependencies (personal).

## Data Stores

| Path | Contents |
|---|---|
| `data/email-memory.db` | SQLite FTS5 of past email classifications (`email-mem` CLI) |
| `data/imessage-inbox.jsonl` | Realtime log of every iMessage/SMS (both directions, groups), written by imessage-channel (gitignored) |
| `data/whatsapp-inbox.jsonl` | Every WhatsApp message the gateway sees: inbound, the user's own (`from_me`, since 2026-10-27) and Edva's sends (`kind: "sent"`), with `group_name` (gitignored) |
| `data/slack-inbox.jsonl` | Every Slack message the slack-channel runner sees (DMs, group DMs, channels, threads, edits, own messages, `slack-send` rows); older rows from the retired poller (gitignored) |
| `data/sms-sent.jsonl` | Every `sms-send` event: `sent` (sid, to, from, status, text, the authorizing quote), `refused` (Twilio's error code) and `status` reads; never a credential (gitignored) |
| `data/context.db` | Cross-source index: Notes, iMessage, email memories, project files (`context-search` / `context-sync`) |
| `data/max-auth-relogin.json` | watchdog.sh's Max sign-in clock: last inferred sign-in and last renewal note (one JSON line, written only by watchdog.sh; gitignored) |
| `data/auth-outage-replay.jsonl` | `auth-outage-replay`'s ledger: one row per job a sign-in outage made miss (started, start failed, too late, or not on the list), which also keeps a second call from starting the same missed run twice (gitignored) |
| `data/memory-index.db` | Auto-memory index + **wiki page store** (DB-as-truth migration step 1, 2026-05-02). Existing v2 layer: `memory_chunks` + FTS5 + nomic-embed-text embeddings + `file_meta` + `memory_links` + `supersession` + `chunk_entities` + `entities`. New `pages` / `page_links` / `page_revisions` tables (`lib/wiki-store.js`) hold the entire memory corpus as DB rows: `pages.raw_md` is byte-equal to the source .md file, parsed frontmatter is promoted to columns (type/title/status/pinned/scope/confidence/last_verified_at/expires_at), `page_links` carries wikilinks + supersedes + related edges, `page_revisions` archives every save. Built by `wiki backfill`; round-trip enforced by `wiki verify`. CLI: `wiki backfill|verify|list|read|render|search|links|backlinks|edit|save|pin|unpin|pin-defaults|supersede|delete|history|show-rev|pinned|stats`. Existing `memory` CLI is unchanged. **`events_fts` (2026-07-08, `lib/event-fts.mjs`)** — an FTS5 recall index over the raw supervisor event firehose, teed live from `EventLog.append()` (fail-soft; JSONL is the durable source of truth, rebuildable via `recall-events rebuild`). Columns: ts/kind/source/agent/dispatch_id + the event text (`ev.result ?? ev`, 4000-char cap). Complements `pages_fts` (curated) — this is *everything that happened*, whether or not it became a page. Queried by the `recall_events` MCP tool + `recall-events` CLI (search/recent/rebuild/prune/stats), and by the session-handoff digest. **Hybrid extension (2026-07-08, `lib/hybrid-recall.mjs`):** a companion `event_embeddings` table (Float32 BLOB, `nomic-embed-text` 768-dim via local Ollama) over the high-value event kinds only (`result`/`dispatcher.dispatching`/`turn_complete`) enables semantic recall fused with BM25 via Reciprocal Rank Fusion (`recall_events mode:"hybrid"` / `recall-events --hybrid`). Embeddings are populated off the hot path (opt-in `recall-events embed` / nightly `recall-events-embed` cron); recall degrades to pure FTS when Ollama is down; `recall-events rebuild` clears embeddings too. **`page_embeddings` (2026-07-19, `lib/wiki-embed.mjs`)** — the same hybrid layer for the curated wiki: one `nomic-embed-text` 768-dim BLOB per active page, keyed by page id with a `body_hash` freshness column (pages are mutable, so a changed page is re-embedded; deleted pages are pruned). Powers `wiki_search mode:"hybrid"` (fuses `searchPages` BM25 + vector-KNN via RRF); backfilled off the hot path by the nightly `wiki-embed` cron (`bin/wiki-embed`, `trigger-wiki-embed.sh`); degrades to pure FTS when Ollama is down. Plus `pageMap` (MCP `wiki_map` / CLI `wiki map`) — a live-computed table-of-contents navigation tier, no persisted index pages. See `system/wiki-architecture.md`. |
| `~/.claude/projects/<project-slug>/memory/.git` | **Auto-memory backup repo** (separate from edva code repo). Snapshotted every 30 min via `bin/memory-snapshot` cron → pushed to a private backup repo (named in `system/architecture-local.md`). Restore via `bin/memory-restore`. The .md files here are the source of truth for Claude Code's auto-memory; losing them is catastrophic, so this repo is the primary protection. |
| `data/memory-snapshots/` | Pre-reindex tarballs (defense in depth). Created automatically before each `memory reindex`; rotated to last 14. Restore via `memory-restore --tarball <name>`. Gitignored. |
| Supabase `wiki_pages` / `wiki_page_links` / `wiki_page_revisions` | **Off-box mirror of the wiki** (2026-10-04). `bin/wiki-cloud-sync push` every 5 min (cron `wiki-cloud-sync`); `verify` checks parity, `restore --db <new-file>` rebuilds the wiki tables from it. The only wiki backup with revision history that survives the host's disk. Details: `wiki-architecture.md` § Backups. |
| `data/memory-db-snapshots/` | Hourly hot snapshots of `memory-index.db` itself (SQLite `VACUUM INTO`). Cron `wiki-db-snapshot` runs `bin/wiki-db-snapshot` at minute :07 of every hour, rotates to last 4 (was 24, ~76 GB, until 2026-10-17). Restore = `cp memory-db-snapshots/memory-index-<ts>.db memory-index.db`. Defense-in-depth complement to the file-based `memory-snapshot` cron — covers DB-level corruption (FTS5 internal state, accidental DROP, etc.). Gitignored. |
| `watch_rules` / `watch_matches` / `watch_events` (in `data/memory-index.db`) | **Watches** (2026-10-23) — standing trigger → action instructions; `watch_events` is the append-only tracking log behind `watch stats` and the weekly `watch-review`. `watch_rules` is the compiled rule (trigger kind event/anchor/at, event-type globs, the condition a model reads, anchor offset, action notify/task/agent, recurrence, expiry, `page_id` → the watch's wiki page, `type: watch`); `watch_matches` holds one verdict per (watch, candidate) plus fire_at/fired_at. Written by `bin/watch` + `lib/watches.mjs`; runtime state in gitignored `data/watch-state.json`, `watch-spool.jsonl`, `watch-mail/`. Design: `system/watch.md`. |
| `page_facts` / `page_fact_runs` / `page_coactivation` / `page_activation` / `assoc_meta` (in `data/memory-index.db`) | **Associative memory** (2026-10-24, `system/wiki-architecture.md` § Associative recall). `page_facts`: typed fact edges extracted from curated pages (subject → relation → object page, one-sentence `fact_text` + verbatim `evidence`, event time `valid_at`/`invalid_at`, system time `created_at`/`expired_at`, `superseded_by`; never deleted; current = `CURRENT_FACT_SQL` in `lib/wiki-assoc.mjs`), with `page_fact_runs` marking which body each page was last extracted from. `page_coactivation`: decayed Hebbian weight per page pair kept together by the auto-recall judge. `page_activation`: ACT-R base-level activation per page from its real uses. `assoc_meta`: writers' cursors. Written only by `bin/wiki-assoc` (nightly `wiki-assoc` task); read by the association graph, the KNN matrix (facts) and `wiki_read` (facts). In the hourly snapshot, not in the Supabase cloud copy; all rebuildable (facts by re-extraction, the rest from the logs). |
| `data/wiki-portal.json` | The wiki home portal's topics (2026-10-24): `{generated_at, curated_by, page_count, coverage, topics:[{slug, name, blurb, ids, prefixes, featured}]}`, written only by `bin/wiki-portal build` (Sonnet-curated, validated), read by `wiki serve` and pushed to the Worker as `wiki_config.portal` by `wiki-cloud-sync`. Absent → topics group by page type. |
| `data/wiki-link-candidates.json` | Strong co-used page pairs with no link (`lib/wiki-hebbian.mjs` `linkCandidates`), rewritten nightly by `wiki-assoc nightly`; read by `wiki-link-weave` Step 5.5, which decides whether each pair is a real relation. |
| `data/wiki-recall-eval-assoc.json` | The **associative** recall eval set (2026-10-24): multi-hop questions with a `gold` set of pages and a `final` hop, generated from the live graph by `bin/wiki-recall-eval-gen` (verbatim-evidence + no-lexical-leak filters, `split` per edge kind, `reviewed` flag) plus hand-labelled `asked` cases; read by `wiki-recall-eval --set assoc`. Created on the host on first generation. |
| `data/wiki-access.jsonl` | Append-only log of every `wiki_search` / `wiki_read` / `wiki_backlinks` call. One JSONL row per call: `{ts, tool, query, page_ids, caller}`. Caller tag is `mcp` for agent-originated (set via `WIKI_LOG_CALLER` env in `tools-mcp/index.mjs`) and `cli` for ad-hoc; the nightly `wiki-audit` cron only counts `mcp` rows when deciding pin/unpin moves. Gitignored (runtime state). |
| `data/auto-recall-judge.jsonl` | Append-only shadow log of the `auto-recall` relevance judge (2026-08-08). One row per JUDGED message: `{ts, message, n_considered, n_kept, kept:[i], candidates:[{i, source, id, type, score, cosine, rrf, snippet}], judge_ms}`. Written only when the Sonnet fork actually returned a verdict — a lexical-fallback run carries no label. This is the labelled corpus for calibrating a cheap gate against the model it would replace; both prior attempts (cosine thresholds, `gemma3:1b`) were judged on a handful of queries and one of them inverted on the live corpus. Carries the user's message text + memory snippets, so gitignored. Disable with `AUTO_RECALL_JUDGE_LOG_DISABLED=1`; relocate with `AUTO_RECALL_JUDGE_LOG` |
| `data/memory-eval-cases.json` | Eval harness cases (query → expected memory file, tagged by MemoryAgentBench competency). Consumed by `memory eval` |
| `data/memory-retrieval.jsonl` | Append-only retrieval log: one JSONL row per `memory search` call (caller, query, mode, latency, top-K) |
| `data/spam-blocklist.json` | Spam sender/topic patterns |
| `data/p1-senders.json` | **P1 sender allowlist** — the one home for "mail from this sender is always urgent." Managed by `bin/p1-sender add\|remove\|list\|check` (or `edva triage p1 …`); read by `gmail-source.mjs` (`intakeP1Sender` stamps `p1`+star at intake) and `lib/local-triage.mjs` (never auto-P3 a listed sender). Matched on the lowercased email ADDRESS only |
| `data/p1-push-ledger.jsonl` | **P1 push ledger** — one row `{messageId, threadId, sender, sent_at}` per P1 pointer that actually went out with `--p1-message`, written under a file lock by `bin/p1-push-fold claim` (from `edva-send-curl`); pruned to 24 h on write; a failed post releases its row. Read to fold a second push for the same email or a same-sender thread burst. Safe to delete (the fold simply has no history until the next push) |
| `data/p1-push-fold-log.jsonl` | Append-only decision log of the P1 push fold (`send` / `fold` / `release`, with reason and the earlier push). Read with `p1-push-fold tail` |
| `data/p1-reply-sweep-seen.json` | Per-thread `historyId` watermark for `bin/p1-reply-sweep` (Signal D of P1 resolution) plus the cached `p1` label id. A thread is re-fetched only when its historyId moved; a thread whose downgrade failed keeps its old watermark so it is retried. Safe to delete — the next tick re-walks every live P1 thread |
| `data/email-triage-playbook.md` | Triage playbook (updated by nightly-review Step 2c — formerly `triage-learning`) |
| `data/last-history-id.json` | Gmail history ID cursor |
| `data/hum-intent.md` | **North-star document** — hum's purpose, measurable success criteria, anti-patterns, operating assumptions. `hum-review` grades against this every week |
| `data/hum-interests.json` | Topic registry (18 topics, editable config). Each: `{enabled, script, cadence_min, cache_ttl_min, active_window, urgency_rule}`. **What hum can talk about** |
| `data/hum-sensors.json` | **Sensor registry + gate config** for the event engine. Each sensor: `{name, enabled, script, interval_sec, detects, cost}`; `config` holds every gate knob (thresholds, refractory, coalescing, quiet hours, `idle_fallback_min`). Re-read every tick — no restart to retune. **When hum fires.** See `system/hum-events.md` |
| `data/hum-sense-state.json` | Engine runtime: dispatch history, per-`dedup_key` cooldowns, held events, per-sensor memos (gitignored; safe to lose) |
| `data/hum-events.jsonl` | **Event ledger** — three record kinds forming the full causal chain: `event` (the verdict it met — `dispatched`/`held`/`dropped:<reason>`), `dispatch` (`dispatch_id`, lanes, score vs. threshold, delivery result), `outcome` (what the hum turn decided — silent/sent, ping id, rationale, `focus_source`, lag; joined on time and labelled `match`, with a missing run recorded as `no-run`). `hum-sense log` renders the joined timeline; `tail` shows raw rows |
| `data/hum-events-inbox.jsonl` | Push spool: any process appends an event here (`spoolEvent()` / `hum-sense emit`); drained each tick |
| `data/hum-sense-heartbeat.json` | Daemon liveness; read by `trigger-hum.sh`'s watchdog gate |
| `data/hum-dispatch-context.json` | `{ts, trigger, lanes, focus, events}` written at each dispatch; read by `hum-harvest-all.mjs` as the default source of focus lanes (10-min freshness gate). `HUM_FOCUS_LANES` overrides; `meta.focus_source` records which won |
| `data/hum-ideas.jsonl` | Append-only ideas reservoir + consumption + **expiry** + reaction log. See `system/hum-ideas-reservoir.md` |
| `data/hum-ideas-archive.jsonl` | Records for ideas dead (consumed/expired) >30d, moved out of the live log by `hum-reservoir-prune` so the file the ideation agent reads stays small |
| `data/hum-ideas-digest.json` | Live unconsumed inventory + pre-built dedup block sets, rewritten on every prune. **`hum-ideation` reads this, not the raw reservoir** |
| `data/hum-ideation-runs.jsonl` | One row per ideation cycle: ideas written, categories/lenses covered, dedup-blocked count, `thin_cycle` + reason. The yield series that did not exist when four cycles a day quietly produced 0–3 ideas for a week |
| `data/hum-ideas-scorecard.json` | Per-category reaction aggregates, rebuilt by `hum-ideation`. Drives exploit/explore mix |
| `data/hum-interests-state.json` | Per-topic `last_run_at` / `last_signal_at` (cadence accounting) |
| `data/hum-cache/<topic>.json` | Per-topic harvester output cache (TTL per registry) |
| `data/hum-question-sends.jsonl` / `data/question-backlog/` | The question pool's send log (written by `hum-ask`, `decision-ask` and `hum-ping` for a location ask) and each question lane's waiting count; `lib/question-pacing.mjs` reads both (gitignored) |
| `data/hum-state.json` | Daily counters (runs/pings/questions) — `today.pings` is the live counter of the shared daily ping budget (hum + any other proactive lane, which adds via `bin/ping-budget record`) — plus pause state. `max_pings_per_day` / `min_ping_interval_minutes` are a mirror hum-tick rewrites each tick from `lib/ping-budget.mjs`; the budget itself is code (6/day, 45 min apart) |
| `data/hum-seen.json` | Per-subject dedup |
| `data/hum-feedback.jsonl` | Per-ping records with reactions |
| `data/hum-runs.jsonl` | **Enriched tick trace** — one JSON line per tick with `{situation, harvest{candidates,errors}, sonnet{decision,score,rationale,based_on_topic}, outcome}`. Sole input to `hum-review` metrics |
| `data/hum-ping-vectors.jsonl` | **Novelty-gate vector cache** — append-only `{ping_id, lane, sent_at, dedup_key, signal, vec}` written by `hum-ping` after each confirmed send (`lib/hum-novelty.mjs`). `vec` is the 768-dim nomic-embed-text (Ollama) embedding of the headline's substantive text. Read back by the next send to compute max cosine against the last `HUM_NOVELTY_WINDOW_H`h (default 72) of pings — the exit-9 semantic near-duplicate gate. Bounded (≤400 rows, pruned on write); rebuildable-if-lost (gate simply fails open until it refills). See the 2026-07-09 entry in `system/changelog.md` |
| `data/suggestion-history.jsonl` | **Cross-lane suggestion ledger** — append-only event log keyed by canonical `subject_key` (e.g. `dining:<venue>:<area>`, source-URL-independent). Three event kinds: `surfaced` (written by `hum-ping` per advisory finding), `reaction` (written by `phone-channel` via `bin/suggestion-classify` for free-text rejections, and at backfill from `hum-feedback.jsonl` tapbacks), `visit` (written from `confirmed-stops.json`). Read by every advisory hum lane via `lib/suggestion-recall.mjs` to (a) inject a structured "past responses" block into scout LLM prompts and (b) hard-block resurfacing of negatively-disposed subjects. Rebuildable from sources via `bin/suggestion-backfill`. See the 2026-05-04 entry in `system/changelog.md` |
| `data/hum-responses.jsonl` | **Canonical reply-capture log** — append-only, one row per reply the user makes to ANY hum ping (`lib/hum-responses.mjs`). Written in realtime by `hum-answer` (question replies) and `suggestion-classify` (free-text / reaction replies, all lanes). Row: `{ts, ping_id, lane, subject, subject_key, ping_text, reply_text, disposition, source}`. Read by the nightly `hum-consolidate` job (→ folds durable facts into the general wiki), by `hum-wiki-recall` (today's not-yet-consolidated replies → ranker brief), and — since 2026-07-29 — by `lib/utterance-store.mjs`, which renders every row as a **permanently searchable dated statement** (`<date> · <user> said: "…"`) exposed as the `replies` source in `recall` and read by `claim-check` + `outbound-precheck`. That last path is what makes a reply from three days ago settle a subject as firmly as one from this morning. The capture half of the capture→consolidate→consult memory loop. See the 2026-06-28 and 2026-07-29 entries in `system/changelog.md` |
| `data/hum-consolidate-state.json` | `{last_consolidated_at}` watermark for the nightly `hum-consolidate` wiki fold |
| `data/hum-resolve-first.jsonl` | **Resolve-first answers** — append-only rows `{ts, decision_id, intent, lane, dedup_key, kind, verdict, action, question, answer, remaining_gap, sources, checked, private}` written by `bin/hum-resolve-first` when Edva's own records answered a hum question or comment before it was sent, plus `{forget}` rows from `hum-resolve-first forget`. Read by the gate itself (its last 14 days, as evidence) and by the pre-rank filter (`lib/hum-vetoes.mjs`, veto `resolved_first` on a fully answered `dedup_key` for 7 days). Edva's conclusions, so deliberately not in `hum-responses.jsonl` (rendered as the user's words). Private lanes (finance/stocks/health) keep the key and verdict only. See 2026-10-15 in `system/changelog.md` |
| `data/hum-resolve-first-log.jsonl` | **Resolve-first decision log** — one row per gate decision: verdict, action, cited sections, what was sent instead, model, latency, per-source load status. Finance/stocks/health rows carry `{sha8, len}` in place of any text. `hum-resolve-first stats` / `tail`. Gitignored runtime data |
| `data/claim-check-log.jsonl` | **Memory-gate audit trail** — append-only, one row per `bin/claim-check` invocation: `{ts, verdict, reasons, facts, contradictions, evidence}`. Written by the gate every suggestion/idea/question passes through before the user sees it. `verdict` ∈ `pass`/`rewrite`/`drop`; `facts` are the authoritative answers (currently presence from the installation's travel timeline); `evidence` quotes the user's own dated replies that drove a drop. The record of what the gate refused and why — read it before concluding hum "just didn't surface anything." See the 2026-07-29 entry in `system/changelog.md` |
| `data/hum-pending-question.json` | Single pending question or null (2h TTL) |
| `data/hum-resolved-topics.jsonl` | **Acknowledgment log** — append-only. Written by chat-agent (Step 2.5 of Hum Inbound Handling) and Reservoir Review when the user replies to an ideas ping or says "done/handled/X is doing it". Each row: `{ts, source_ping_id, task_id, topic, keywords, resolution, suppress_until}`. Read by `hum-ideation` (Step 1.5 — build `resolved_task_ids`/`resolved_keyword_sets`) and `outbound-precheck.mjs` (suppress if topic in active window). 48h suppress window. Created on first write. |
| `data/hum-learnings.jsonl` | Append-only answer log for hum *questions* — written by `bin/hum-answer`; surfaced to the ranker via `edva-context` `recent_learnings`. (Durable wiki memory now flows through `hum-responses.jsonl` → nightly `hum-consolidate`; `hum-answer`'s old realtime subsection routing was retired 2026-06-28.) |
| `data/hum-review-prev.json` | Last review's memory sizes + registry snapshot + intent hash + pending proposals; next review diffs against this |
| `data/phone_context` (Supabase table) | Single-row-per-device motion + Wi-Fi snapshot from the iOS app; 10-min staleness window |
| `data/user-timezone.json` | Last known timezone from phone (hum uses for protected windows) |
| `data/last-edva-message-at.json` | Stamp written by `edva-send-curl`; consumed by `edva-activity-state` + hum situation |
| `data/outbound-precheck-log.jsonl` | Append-only decision log from `bin/outbound-precheck.mjs` — one JSON row per invocation `{ts, decision, reason, message?}` (since 2026-10-13 a no-JSON fail-open row also carries `sonnet_head`, and an empty answer's reason reads `precheck_sonnet_unavailable:<kind>`; the rolling unchecked-rate window is `data/.outbound-precheck-health.json`). Drives nightly-review's "what did we suppress and was it right?" pass. Gitignored. See § Outbound Precheck |
| `data/dead-letter.jsonl` | Append-only log of every turn the ops-tier supervisors' hang watchdog dropped (2026-10-13, `agent/supervisor/dead-letter.mjs`). One row per drop: `{ts, agent, action (retry-queued|dropped), source, itemId, hangCount, reason, hungMins, hangRetry, retryOf, ownRequest (gmailId, rfcMessageId, subject, receivedAt, or null), replyState (replied|not-replied|unknown, null if not the user's), retryItemId, item (id, source, enqueuedAt, full content)}`. Written only by the supervisor; read by humans and reviews; content and subject may include email bodies or figures, local only, never outbound. Gitignored by `data/*.jsonl`. |
| `data/phone-channel-cursor.json` | Last inbound phone message ts — drives `at_desk_min` inference |
| `data/ping-hold-queue.json` | **Motion-gate waiting room** — non-urgent APNs alerts parked by `lib/apns-push.mjs` while the user is walking or driving, drained by the 5-min `ping-flush` cron once they are stationary. Rows: `{body, title, messageId, channel, held_at, reason}`; capped at 50, entries expire after 90 min. **Holds only the ALERT, never the content** — the message itself is already in `edva_messages` and readable in the app, so this file is safe to lose. Path overridable via `EDVA_PING_QUEUE` (tests). See the 2026-08-05 entry in `system/changelog.md` |
| `data/ping-media.json` | **Harvester → `hum-ping` media hand-off** — `{<dedup_key>: {ts, media: {image_url, map_url}}}`, written by a harvester that resolved a picture and/or a map for its candidate (`lib/ping-media.mjs`), read by `hum-ping` when the findings array it was handed came through without them. Exists because that array is composed by the tick's **agent turn**, so a nested `supporting_data.media` is precisely the field a rewrite drops, whereas `dedup_key` is load-bearing for the exit-8 gate and reliably survives. Self-pruning at 12h; safe to delete (the ping simply ships without its picture). Path overridable via `EDVA_PING_MEDIA_FILE` (tests). See the 2026-08-09 entry in `system/changelog.md` |
| `system/tasks.json` + `agent/local/tasks.json` | The scheduled task registry: the kernel's tasks plus the installation's own, merged by `lib/registry.cjs` (`loadRegistry("tasks")`). The same split holds for `system/services.json`, `agent/config/job-routing.json` and `agent/config/chrome-jobs.json` (local halves `agent/local/{services,job-routing,chrome-jobs}.json`). Every reader goes through registry.cjs (shell: `node lib/registry.cjs <name>`); writes from code go to the local half only |
| `agent/logs/*.log` | supervisor stdout/stderr, watchdog, webhooks, ack-trace, hookdeck |
| `agent/logs/supervisor-{chat,ops}/` | per-supervisor `events.ndjson` (full session stream), `cost.ndjson`, `timing.ndjson`. `supervisor-ops/job-costs.ndjson` (added 2026-04-23) attributes each turn to its job/source for the `edva-cost-report` CLI + nightly-review cost lens |
| `agent/logs/ephemeral-forks/job-costs.ndjson` | cost rows for `claude -p` runs outside the supervisors (added 2026-10-06): every Opus launchd fork via `lib/run-ephemeral-opus.sh` and the per-job Opus triggers, the supervisor's `web-read` helper, the installation's email Q&A tool. Same row shape as the supervisors' `job-costs.ndjson` plus `runner: "ephemeral-fork"`; written by `bin/fork-cost-record` / `lib/fork-cost-ledger.cjs` from each run's `--output-format json` usage; unioned in by `edva-cost-report` and `edva-allowance-coverage`. |
| `logs/triage.log` | Structured triage event log (cross-channel hum dedup source) |

The installation's own data stores are in `system/architecture-local.md` § Data stores (personal).

## Scheduled Tasks

`system/tasks.json` (kernel tasks) merged with `agent/local/tasks.json` (the installation's own) by `lib/registry.cjs` is the registry: a local entry with a new name is added, one with a kernel name overrides that task field by field. Each task has a trigger script (`agent/scripts/trigger-*.sh`) that POSTs to the ops-agent webhook (or runs locally for `context-sync`). Playbooks live in `agent/ops-agent/jobs/*.md` and load at dispatch time — playbook edits take effect on the next run, no agent restart needed.

Kernel jobs: `morning-digest`, `context-sync`, `hum` (**event-driven** via the `hum-sense` daemon — sensors detect real situational edges and a deterministic gate decides; the 20-min cron is now only a stale-heartbeat watchdog, and the old cadence survives as the low-salience `idle` sensor. A `questions` sensor ticks hum every 5 minutes while questions wait and the question pool has room (its own 5-min refractory, `question_refractory_min`), so the question queue drains on a quiet day. 00-09 quiet window. See § Dispatch: the `hum-sense` event engine), `hum-review` (Sun 09:30), `hum-ideation` (daily 06:00), `hum-daily`, `hum-consolidate`, `hum-explore`, `nightly-review` aka Self Improvement Review (Tue 03:00 — weekly self-assessment over the prior 7 days), `improvement-plan`, `system-issue-review`, `skill-repair`, `cost-efficiency-review`, `usage-push` (daily 04:25 — direct script; pushes per-day model-weighted Claude cost rollups to the hosted `/usage` telemetry monitor), `inbox-mem-sync`, `recall-events-embed`, and the wiki upkeep jobs (`wiki-audit`, `wiki-embed`, `wiki-assoc`, `wiki-cloud-sync`, `wiki-db-snapshot`, `memory-snapshot`). The installation's own jobs are listed in `system/architecture-local.md` § Scheduled tasks.

**Merged/retired jobs:** `triage-learning` (merged into `nightly-review` Step 2c on 2026-04-23 as part of the token-audit pass — one daily Opus dispatch instead of two).

## Browsing skills

Central registry of browser actions used by cron jobs, hum, and ad-hoc agent work, modeled on the public [browsing-skills/browsing-skills](https://github.com/browsing-skills/browsing-skills) library. Pattern: one file per action, structured JSON output, validated.

**Why centralized:** Before this registry, every cron that scraped a website had its own inline `page.evaluate(...)` block. When a site shipped a UI tweak, the same selector logic broke in 3–5 different playbooks independently. Now each action lives in exactly one file; selector fixes propagate automatically.

**Layout:**

| Path | Purpose |
|---|---|
| `browsing-skills/SKILL.md` | Umbrella — routes agents to the matching site index |
| `browsing-skills/skills/<domain>/` | Edva-private, site-specific skills — not upstream-shareable; the installation's private site index is `agent/local/browsing-skills.md` (the umbrella's § Site index points there) |
| `browsing-skills/external/skills/<domain>/` | Auto-synced from the operator's fork of the upstream public registry (named in `system/architecture-local.md`; it adds write actions) |
| `browsing-skills/tools/{validate,run-action,skill-health}.js` | Validator, ad-hoc CLI runner, daily health monitor |
| `bin/browsing-skills-sync` | Pulls fork → `external/` |

**Runtime:** all actions execute via the existing `chrome-devtools-mcp` against the automation Chrome on `localhost:9222`. Each playbook calls `page.evaluate(actionBlock)` (for inline use) OR `browsing-skills/tools/cdp-runner.mjs` (for CLI/cron use). Returns the upstream-standard `{ content: [{ type: "text", text: "<json>" }] }` shape.

**cdp-runner.mjs** (CLI + programmatic harness) — the canonical entry point for cron-driven and ad-hoc skill invocation. Drives the automation Chrome via CDP-over-WebSocket; no MCP layer, no npm deps. As of 2026-05-26 it also supports:
- `--capture-network=<pattern>` — captures matching `Network.requestWillBeSent` + `Network.responseReceived` events (joined by requestId) so write-actions whose submit causes the popup tab to navigate can still surface the POST response status + Location header (the previous "Inspected target navigated or closed" error now returns `{ok: false, error: "tab_navigated_mid_eval", tabNavigated: true, networkCaptures: [...]}` instead of throwing).
- `--capture-frames` — records `Page.frameNavigated` events for the top frame.

**Cron entries (host):**

- `0 10 * * *` — `bin/browsing-skills-sync` (pulls fork into `external/`)
- `0 23 * * *` — `browsing-skills/tools/skill-health.js` (alerts on any action with ≥3 consecutive failure days; queues a same-day repair on day 1)
- `trigger-skill-repair.sh` — kicked by `requestRepair()` the moment a repair is queued, plus an hourly cron safety net

**Same-day repair (2026-10-16):** a read action or page parser that stops reading its site is repaired the day the break is seen, not after the 3-day alert. Producers (an installation's ingest job on a source's first bad run, `skill-health` on the first failure day) call `lib/skill-repair.mjs` `requestRepair()`; admission is code (markup-break errors only, read actions only, 1/day per action, 2/week, 4/day overall); the `skill-repair` job (`jobs/skill-repair.md`, ops tier) reads the live page, rewrites the one action with the same output shape, verifies rows come back, gets a critic `SAFE`, and lands it via `self-improve-auto-apply`. Silent. Queue: `data/skill-repair-queue.json`; CLI `bin/skill-repair list|request|next|done`. Detail: `docs/browsing-skills.md` § Same-day repair.

**Write-action policy:** any action that modifies external state (posting a comment, booking a slot, submitting a form, voting) requires explicit user consent + DOM-verification of the write + structured error returns + a documented cooldown. See `browsing-skills/SKILL.md` § "Write-action policy."

**See also:** [`docs/browsing-skills.md`](../docs/browsing-skills.md) for the full architecture, design decisions, and the playbook-integration pattern.

## Hum — the always-on ambient-awareness loop

Hum is the single largest subsystem; it deserves its own section because it spans data / playbook / scripts / iOS / memory.

### Dispatch: the `hum-sense` event engine (2026-08-02 — hum is event-driven)

Hum fires because something **happened**, not because a clock ticked. Full design: `system/hum-events.md`.

```
sensors ──▶ events ──▶ gate ──▶ dispatch ──▶ ops-agent {job:hum, trigger:event, events[], lanes[]}
```

| piece | where | what it is |
|---|---|---|
| **sensors** | `agent/scripts/hum-sensors/*.mjs` | Cheap edge detectors — *did X just change?* One subprocess at most, sub-second, no LLM inside a sensor run. One exception sits beside a run, never inside it: the `calendar` sensor starts a background, never-awaited Jev + Sonnet read (Jev site `calendar-hold`) of each busy event over three hours, once per event, to decide whether it holds hum (`hold_id`). Kernel sensors: `daypart`, `calendar`, `desk`, `comms`, `weather`, `tasks`, `idle`; the personal ones are in `system/architecture-local.md`. |
| **push sources** | any process | Append one JSON line to `data/hum-events-inbox.jsonl` (`spoolEvent()` / `hum-sense emit`); drained every tick. `phone-channel` uses this for realtime `location_history` arrival/departure. |
| **registry** | `data/hum-sensors.json` | Which sensors run, intervals, and every gate knob. Re-read each tick — retuning needs **no restart**. |
| **gate** | `lib/hum-events.mjs` | Pure function, no LLM: expiry → dedup cooldown → quiet hours/pause/activity → meeting/conversation/pending-question → 10-min refractory → coalescing → dynamic salience threshold. Bad-timing events are **held** and re-evaluated, not dropped, so signals that land during a meeting arrive together when it ends. |
| **daemon** | `bin/hum-sense` (launchagent `ai.claude.hum-sense`, KeepAlive) | Runs sensors on their intervals, drains the spool, evaluates, dispatches, writes the ledger. `hum-sense status` / `once` / `tail`; also `edva hum sense`. |
| **watch tap** | `bin/hum-sense` → `lib/watches.mjs` | Every event the pass sees is also appended to `data/watch-spool.jsonl`, and the daemon kicks a detached `watch tick` (≤1/min, ~10 s after fresh events) — the user's standing "when X, do Y" watches. Hum's gate never sees watch work. `system/watch.md`. |

Rate limiting is a slope, not a cap: `threshold = min(0.9, 0.35 + 0.08 × dispatches_in_last_2h)`. A quiet day stays responsive; a busy one self-throttles without ever hard-refusing something important.

**The clock survives in two demoted places.** The `idle` sensor emits one low-salience (0.36) event after `idle_fallback_min` (75 min) of nothing — the path slow-moving lanes (news, watchlist, ideas, art) still reach the user through, now situationally gated. And `trigger-hum.sh`'s 20-min cron is a pure **watchdog**: it exits while the daemon heartbeat is fresh, and only reverts to a plain tick (`trigger: "watchdog-fallback"`) when the engine is down — so hum degrades to quieter, never to silent.

Every event, every dispatch, and what hum then *did* about it are appended to `data/hum-events.jsonl` (`hum-sense log`). That is the precise answer to "why didn't hum say anything all afternoon?" — *held: in a meeting*, *dropped: cooldown*, *held: below threshold (0.41 < 0.67)*, *dispatched → stayed silent, ranker found it already settled* — which the old cadence model could never give.

### Pipeline (per dispatch)

```
dispatch {job:hum, trigger:event, events[], lanes[]} → ops-agent
  1. edva hum situation --json      composite snapshot (2-min cached)
  2. hum-harvest-all.mjs               builds unified context, parallel fan-out
                                       across 30 topics; each harvester gets
                                       {situation, context} on stdin.
                                       HUM_FOCUS_LANES=<payload lanes> forces the
                                       lanes the event implicated to run regardless
                                       of cadence; everything else stays on its own
                                       cadence. (HUM_ONLY_LANES for a narrow tick.)
  3. Sonnet subagent ranks candidates  urgency*0.5 + relevance*0.3 + freshness*0.2
                                       with CONTEXT bundle + WHAT JUST HAPPENED
                                       (the triggering events) in its brief
  4. execute silent / info / question + write enriched tick trace
     (every send passes the resolve-first gate inside edva-send-curl:
      already answerable from Edva's records → FYI, the remaining
      gap only, or nothing — docs/hum-resolve-first.md)
```

**Questions first, paced by the backlog (2026-10-27, `lib/question-pacing.mjs`).** After the pre-rank vetoes, `hum-harvest-all` moves every eligible question candidate (decision cards, dream / hum-improvement questions, re-asks of open questions, location asks, low-confidence ideas) to the head of the ranker's list and marks it `question_first`; the ranker sends a marked question ahead of every info candidate, except one with urgency ≥ 0.9 or a protected lane. Questions draw on their own pool (`data/hum-question-sends.jsonl`; 6/day, 5 min apart), never on the shared info budget. Each question lane writes how many questions it has waiting to `data/question-backlog/<lane>.json`; at 4+ waiting every question cap doubles and every spacing halves, at 10+ they triple (the pool, each lane's own caps, decision cards per day, the location-ask cap). While an unanswered question holds the pending slot, the questions that would need it are not marked that tick. The run trace records `questions_first`, `question_backlog` and `question_scale`.

### The unified `edva context` primitive

`lib/edva-context.js` + `edva context [--json] [--fresh]`: a single object every harvester + the Sonnet ranker consumes. One place to change when a new data source comes online — harvesters don't change.

```json
{
  "profile":   { "<the user and the people and places in their life…>" },
  "tastes":    { "<the installation's preference domains (overlay tasteFiles)>" },
  "projects":  { "<the user's current projects>" },
  "knowledge": { "calendar","tasks","email","photos","notes","imessage","slack",
                 "location","watchlist","<personal sources>",
                 "phone_context","weather","supabase","memory_files","hum_learnings" },
  "recent":    { "today_commits","today_triage","recent_learnings","counts" }
}
```

Each `knowledge.<source>` entry carries `{via, mcp, scope}` so Sonnet knows HOW to reach the source even if it can't make the call directly. Taste/profile/project sections read memory files under `.claude/projects/.../memory/` and data/music-profile.md, with 5-min cache.

### Situation snapshot

`edva hum situation --json` — `{where, environment, time, now_activity, next, working_on}`. Includes current location + companions, weather, audio class from the phone, local-time activity state, `at_desk_min` (HID idle on the Mac), upcoming calendar events within 2h, tasks due today + overdue count, today's + this-week's commit topics.

### Topic harvesters (`agent/scripts/hum-harvesters/`)

Each is a standalone node script that reads `{situation, context}` on stdin, hits its source, emits one candidate JSON or `null`. Fail-closed. Taste-aware harvesters read `context.tastes.<domain>` (or a canonical profile file) + `context.recent.recent_learnings` for dedup.

| Topic | Source | Cadence |
|---|---|---|
| `weather` | `apple-weather --findme` + delta detection | 20 min (60m cache) |
| `news` | NYT HomePage RSS + freshness filter | 60 min (30m cache) |
| `tasks` | `gog tasks list @default --plain` (overdue + due-today) | 20 min |
| `calendar` | `gog calendar list --days 2` + conflict/imminent detection | 20 min |
| `serendipity` | deferred stub (disabled in registry) | n/a |
| `health` | `watchdog.log` tail + issue count | 60 min |
| `ideas` | `data/hum-ideas.jsonl` — best unconsumed, non-expired pre-computed idea from the reservoir. Competes against live candidates at the Sonnet rank stage. | 20 min |

The installation's own topic harvesters are in `system/architecture-local.md` § Hum.

### Ideas reservoir + ideation loop

The `ideas` harvester doesn't scan live data — it reads a pre-computed reservoir built by the `hum-ideation` job (twice-daily opus run). This fills the gap when live harvesters surface nothing new and hum would otherwise go silent. Design details: `system/hum-ideas-reservoir.md`.

Loop:
1. **Ideation** (`jobs/hum-ideation.md`, 06:00 + 14:00 local) — opus reads calendar, tasks, Gmail, trip history, recent reactions; synthesizes 8-15 proactive ideas across 12 category lenses; appends JSONL to `hum-ideas.jsonl`.
2. **Surfacing** — `ideas.mjs` picks the best unconsumed idea each tick; `dedup_key = idea_id`.
3. **Consumption** — when Sonnet picks an idea winner, `jobs/hum.md` step 4 calls `bin/hum-mark-idea-consumed <idea_id> <ping_id>` appending a consumption marker.
4. **Reaction** — `edva hum feedback <ping_id> <reaction>` records the reaction on the `hum-feedback.jsonl` row, writes it to `hum-responses.jsonl` + (when the ping carries a `subject_key`) `suggestion-history.jsonl` (same two logs a conversational reply writes via `suggestion-classify` — fixed 2026-07-08, see Recent changes), and — if the ping originated from an idea — appends a reaction record to `hum-ideas.jsonl`. Closes the loop.
5. **Reinforcement** — next ideation run rebuilds `hum-ideas-scorecard.json` (per-category hearts/👍/more vs skip/snooze/👎, Laplace-smoothed) and biases generation: 50% exploit top categories, 30% explore untested, 20% retry losers with variation. Anti-sycophancy guard: low `more` + silence tracks separately.
6. **Retirement** (added 2026-08-06) — `bin/hum-reservoir-prune`, nightly 02:40 local, expires ideas that can never fire (window passed · >21d undated · geo-stale · premise-dead · bad DOW), archives records dead >30d out of the live log, and rewrites `hum-ideas-digest.json`. The `--expire` form is also the ranker's write-back path (`sonnet.retire_ideas`, `jobs/hum.md` Step 4) for the durable rejections only a model can judge. **Nothing retired ideas before this** — the loop above accumulated for four months, and both ends were choking on it: the harvester's one nomination per tick kept going to dead entries, and the generator's keyword dedup was vetoing new ideas against 415 dead subjects. See `hum-ideas-reservoir.md` § Pruning.

### Memory growth loop

Questions carry a `memory_hook` tag. When the user answers (chat-agent's "Pending-Question Recognition" rule), `bin/hum-answer` appends to `hum-learnings.jsonl` and routes the answer to the target memory file under the auto-memory dir (the routing table is in `system/architecture-local.md`). Weekly review counts new lines per file as the "memory growth" metric.

The wiki also has whole-day and long-view writers (the dream, the deep dream); they are personal jobs, described in `system/architecture-local.md`.

### Observability

Three layers:
1. **Intent** (`hum-intent.md`): what success looks like, measurable.
2. **Per-tick trace** (`hum-runs.jsonl`): complete situation + all candidates + Sonnet decision + outcome per tick.
3. **Measurement** (`edva hum insight [--since Nd]` + the weekly `hum-review`): mechanical scoring vs intent, anti-pattern scan, assumption verification, aspect-by-aspect narrative, cited tuning proposals.

## Phone context (iOS → server)

Each `phone_context` upsert carries `motion_class` (from `CMMotionActivityManager`) + `wifi_ssid` + `wifi_bssid` (from `NEHotspotNetwork.fetchCurrent`; entitlement `com.apple.developer.networking.wifi-info` in `client/Edva/Edva.entitlements`). Sources: `client/Edva/PhoneContextPublisher.swift`, `client/Edva/WiFiContext.swift`. Triggers: app foreground (5-min debounce), `CLVisit didVisit` at a new place. Server-side mapping in `data/wifi-ssid-map.json` (SSID → named place); `whereami` uses it to override the GPS-derived place when the snapshot is fresh (≤10 min). Far more reliable than GPS indoors — no jitter, no drift, instant on Wi-Fi handoff. Migration: `data/migrations/20260424_phone_context_wifi.sql`.

## Motion Gate — can the user actually READ this right now?

**Architectural invariant (2026-08-05):** a non-urgent push is not delivered while the user is moving. Urgent pushes always are.

This is the third universal gate on agent → user traffic, and it asks a question the other two do not. **Outbound Precheck** asks *should this be said*; the **Release Freshness Gate** asks *is it still true*; this one asks **can the user read it**. A ping that lands while the phone is in a pocket is not a quieter ping — the banner is gone by the time the phone comes out, so it is a lost one.

**Where it lives.** At the `sendApnsPush` chokepoint in `lib/apns-push.mjs`, so all ~70 `edva-send` / `edva-notify` callers inherit it without a code change and a new job cannot forget it. Two collaborators:

- **`lib/motion-state.mjs`** — the oracle. Classifies the newest `location_history` row (the same signal `findme activity` reports; deliberately not a new sensor) into `mobile` / `stationary` / `unknown`. Mobile = a fresh (<12 min) transit row reading walking/running/cycling/scooting/driving. Stationary = an **open visit** (`departed_at IS NULL`), valid at any age up to 12h — a three-hour dinner is still sitting still, and a browsing stop inside a market is still a stop. **`unknown` fails OPEN**: a data gap, an empty table or a query error all deliver. A wrongly-sent ping costs a buzz; a wrongly-held one costs silence nobody notices.
- **`lib/ping-hold.mjs`** — the waiting room (`data/ping-hold-queue.json`). **Only the ALERT is deferred, never the content** — `edva-send` writes the row to `edva_messages` *before* pushing, so a held ping is still sitting readable in the app. That property is what makes gating safe at the chokepoint, and it is also why expiry is not data loss.

**Flush.** `bin/ping-flush`, every 5 minutes (`trigger-ping-flush.sh`; exits immediately on an empty queue, which is most runs). It re-checks motion, drops alerts held >90 min (the moment they belonged to has passed), and **coalesces the rest into one push per channel** — a 40-minute walk that queued four pings costs one buzz, showing the newest with a `(+3 more)` count and deep-linking to it. Channels stay separate because `chat` carries a badge and `system` deliberately does not. The queue is cleared *before* sending, so a crash mid-flush costs one alert rather than re-buzzing everything next tick. Inspect with `ping-flush --status`; kill switch `data/.ping-flush-off`.

**Two carve-outs, both principled:**

- **Urgent (`interruption-level: time-sensitive`) always goes.** It pierces Focus and gets read aloud over AirPods/CarPlay — which is precisely the delivery that works when the user cannot look at a screen. The `time_sensitive` flag on the phone-channel `reply` tool stays as narrow as it already was.
- **Phone-channel replies bypass the gate** (`skipMotionGate: true`). A reply is **solicited** — the user asked and is waiting — and Rule #2 already forbids withholding those. Nothing else may set this flag; `ping-flush` uses it only to deliver what the gate itself parked.

**A job whose value is being somewhere right now is re-anchored, not exempted:** it fires on a fresh stop rather than mid-walk, so the gate never parks it somewhere it no longer applies. The worked example (a personal location job) is in `system/architecture-local.md` § Motion Gate.

## Outbound Precheck — universal LLM gate on agent → user messages

**Architectural invariant (2026-05-11):** every agent-originated, programmatic message destined for the user's phone passes through a Sonnet `--effort low` reasoner that sees the last 8h of phone-channel chat + active calendar before the message lands. The reasoner returns one of three decisions: **send** (the proposed message is consistent with recent context), **suppress** (the message contradicts something the user just said — e.g., a harvester asking "when do you want to do it?" after the user already said it is done), or **modify** (small acknowledgment of recent context needed). This generalizes the location-confirm hybrid pattern (`bin/location-confirm-resolve.mjs`) to all outbound paths — what was a one-off for "are you at X?" is now the universal shape.

**Why:** harvesters (hum lanes, reminders, watchdog, digests, cron jobs) write user-facing text in code with no awareness of what the user just said in the conversation. The result before this change: programmatic pings that contradicted live state (a "15:00 slid by" reminder arriving 20 min after the user said they were already doing it). No amount of harvester-level hardening fixes the class — the only durable fix is a single chokepoint that every outbound caller goes through.

**The chokepoint is `bin/edva-send-curl`.** It's the bash binary that every harvester, hum-ping dispatcher, ops-agent triage notification, and cron job uses to push a `edva_messages` row + APNs notification. The precheck wires in there so callers get the gate for free — they don't change.

**Three components:**

| File | Role |
|---|---|
| `bin/outbound-precheck.mjs` | Stdin: `{message, intent?, supporting_data?}`. **Two-pass wiki lookup** (see 2026-05-16 entry): (1) keywords extracted from intent + message → `wiki search` (limit 3); (2) a fixed who-is-where query (limit 3; the query is in `system/architecture-local.md`) to always surface current who-is-where context. Then fetches the last 8h of chat-channel `edva_messages` + Google Calendar events from 2h ago to the end of the local day. Spawns `claude -p --model sonnet --effort low --allowedTools ""` with the full bundle (wiki context + transcript + calendar). Stdout: `{decision, message?, reason}`. No tool use — one inference, ~5–15 sec wall clock. Logs every decision to `data/outbound-precheck-log.jsonl`. |
| `bin/edva-send-curl` | Pipes `MESSAGE` (+ optional `--intent <topic>`) through the precheck unless `--skip-precheck` is passed. On `suppress` → silent exit 0, no DB write, no push. On `modify` → swaps `MESSAGE` with the returned text, continues. On `send` (or any failure) → posts as today. |
| `data/outbound-precheck-log.jsonl` | Append-only decision log — one JSON row per `outbound-precheck.mjs` invocation with `{ts, decision, reason, message?}`, plus `sonnet_head` on a no-JSON fail-open row (2026-10-13). Gitignored. Source for nightly-review's "what did we suppress and was it right?" pass. |

**Fail-open is a deliberate choice.** Any error path inside the precheck — Sonnet down, Supabase unreachable, malformed JSON reply, timeout — emits `{decision: "send"}` so the original send proceeds. This is the *opposite* posture from the location flow (where failure falls through to "ask"). The rationale: an entire silent agent is worse than an occasional dumb ping. The user will say when a ping was wrong; nobody can report a ping that never landed.

**`--skip-precheck` for known-safe callers.** Three classes of caller bypass the gate explicitly:

1. **Infrastructure liveness alerts** — supervisor `_sendPush` (auth outages, queue alarms), `watchdog.sh` (process crashed, disk full, network down), `chrome-cdp-watch.sh` (port 9222 unreachable). Gating these through Sonnet creates a chicken-and-egg: the precheck depends on Supabase + Sonnet, which are themselves things a liveness alert may be reporting on. A stuck supervisor must be able to alert about being stuck.
2. **Paths that already gate via their own LLM resolver** — the location-confirm flow (`bin/edva-send.mjs` after `location-confirm-resolve.mjs` decided to ask) doesn't go through `edva-send-curl`, so this is implicit; if it ever did, it should pass `--skip-precheck`.
3. **Diagnostic harnesses** — `resilience-test.sh`. We're verifying the channel itself; can't have Sonnet rewriting the test message.

Every other caller — hum harvesters (the original motivating bug), scheduled reminder notifications, ops-agent P1 email triage pings, cron-driven digests, ad-hoc chat-agent outbound — goes through unmodified. They don't need code changes; the chokepoint is at the binary they were already calling.

**Hum sends meet one more gate first: resolve-first (2026-10-15).** For a chat-channel `hum:` intent, `edva-send-curl` runs `bin/hum-resolve-first` before the precheck: Opus reads Edva's own records and, when they already answer what the message asks or leaves open, the message becomes a short FYI, just the remaining gap, or nothing. The precheck then reads whatever is left. See 2026-10-15 in `system/changelog.md` and `docs/hum-resolve-first.md`.

**This gate answers "should it be said", not "is it still so".** Truthfulness is a separate stage with a wider blast radius — it covers chat-agent replies too, which the precheck never touched. See § Release Freshness Gate below.

---

## Release Freshness Gate — is the message still TRUE at the moment it is released?

**Architectural invariant (2026-07-31):** every message that reaches the user in the chat — proactive or solicited — is checked for whether the state it asserts still holds *now*, not when it was written (Rule #2: relevant AND true).

**The incident class.** A proactive message asserted a third party's status (an enrollment, observed in an email two days earlier) after an idea sat in the reservoir with nobody re-reading the mailbox. It cleared every existing gate, correctly — none of them asks this question. `claim-facts` covers **places and dates**, and a status has neither. `outbound-precheck` covers **relevance**. The whole class of *stateful* claims — a status a third party controls, observed once and thereafter assumed — had no authority at all. (The original incident: `system/architecture-local.md`.)

**The inversion** (the same one `claim-facts` made for geography, applied to state): don't pattern-match phrasing to guess whether a claim went stale. Take the two facts code actually holds — when the evidence was observed, and when we are sending — and if there is a gap, ask a model what the message asserts that could have moved in that gap, then go re-read the source of record for that specific claim. The trigger is arithmetic, so no paraphrase defeats it. Per Rule #0b there is no regex over message text anywhere in the module: code owns the elapsed time, a model owns the language.

| File | Role |
|---|---|
| `lib/claim-freshness.mjs` | The gate. **Stage 0** — evidence age (free; anything under 90 min exits here). **Stage 1** — Sonnet `--effort low` extracts the stateful claims + a Gmail query per claim. **Stage 2** — `gog gmail search "<query> after:<evidence date>"`, read-only. **Stage 3** — Sonnet adjudicates `pass` / `rewrite` / `drop`. |
| `bin/claim-check` | Stage 1.5 of the hum ideas gate. A `drop` short-circuits before the memory stage; a `rewrite` replaces the working text and *still* faces the relevance stage — true-now and worth-saying are different questions. |
| `bin/outbound-precheck.mjs` | Runs freshness before the relevance reasoner. `drop` → `suppress`. `rewrite` → the corrected text is what the relevance stage judges and what ships, via `emitSend()` so a relevance-stage hiccup can never un-fix it. |
| `agent/phone-channel/index.mjs` | The `reply` tool, i.e. chat-agent's own answers — **previously documented as exempt**, and no longer. Runs with `solicited: true` (rewrite-only) and a 12s deadline; the corrected text is what lands in both the chat row and the APNs preview. |
| `data/claim-freshness-log.jsonl` | Append-only decision log: verdict, reasons, the claims extracted, and whether the mailbox was reachable. Read this before assuming a ping was wrongly hedged. |

**Fail-open, but never fail-TRUE.** Every error path delivers — the 2026-05-11 posture stands. But when a stale claim can't be re-verified, the message loses the right to *assert* it: it is rewritten to carry its own provenance ("as of Wednesday's email, the part hadn't shipped yet"), which remains true whatever happened since. **Silence in the mailbox is not confirmation.** Unverifiable degrades confidence, never delivery.

**Solicited vs proactive.** A reply to a question the user just asked passes `solicited: true` and the gate narrows to rewrite-only — an unanswered question is a worse failure than a dated answer. Proactive traffic (hum, digests, cron jobs) can be dropped outright.

**Cost shape — why this is affordable on every message.** Stage 0 is subtraction, and it retires everything composed from live work. Callers that did the work in-turn declare `evidence_as_of: "live"` and pay nothing; callers surfacing stored material pass the real `created_at` / `source_email.date`. Cost is controlled at the source — by callers declaring provenance — not by a cheap screening tier.

**A local pre-filter was built and then cut, on evidence.** Screening undated messages with `gemma3:1b` before spending anything is the obvious optimisation and the one Rule #0b's ladder suggests. Run against the canonical case, the 1B model answered **NO** to whether the canonical sentence describes a status someone else controls — clearing, for free, the exact ping this gate exists to catch. Rewording fixed that case, which is the trap: a tier that passes the examples in front of you and fails on the fifth paraphrase inside a nightly job. Measured: ~25–35 outbound messages/day × ~$0.004 per Sonnet `--effort low` extraction ≈ **$4/month** — what the filter was defending, against a false-clear on a gate that must hold. The ladder isn't wrong in general; it's wrong where the cheap tier's error mode *is* the failure being prevented.

**Verified end-to-end 2026-07-31** on the original incident text with its real provenance: stage 0 flagged it 48h stale, Stage 1 extracted both claims, the mailbox was reached, and with no resolving follow-up the gate returned `rewrite` with an "as of" provenance. 14s wall clock. Deterministic half covered by `tests/claim-freshness.test.mjs` (17 cases).

**Optional `--intent <topic>` flag** tags the message with a sender hint (`p1-email`, `hum:<lane>`, `supervisor-alert`, etc.) so the reasoner has a clearer signal about what the message is for. Optional — the precheck still works without it.

**What this does NOT gate:** chat-agent replies to the user's own messages (they flow through `mcp__phone-channel__reply`, not `edva-send-curl` — the reply is already LLM-authored in the conversational turn); `edva-send.mjs` (used only by the location-confirm flow, which has its own resolver); pure `edva-notify` push without a `edva_messages` row (rare; mostly a sibling of `edva-send-curl`). Outbound email + iMessage are separate channels with their own policies (see `agent/CLAUDE.md` § Outbound Email Policy / iMessage Policy); the precheck is phone-channel-only.

**Cost.** ~5–15 s wall-clock + one Sonnet `--effort low` inference per programmatic send. Cheap relative to the alternative (dumb pings that erode trust); negligible against the Anthropic Max subscription that funds both agents. If a future channel becomes high-volume enough that the wall-clock matters, the right fix is to widen the chokepoint (cache recent context across calls within a 60-sec window), not to remove the gate.

**Design doc:** none yet — this section IS the design doc. If the precheck grows enough independent state to need one, move it to `system/outbound-precheck.md` and link from here.


**Travel dates (2026-10-15):** memory has no calendar or travel authority, so Stage 3 is also handed the live travel timeline (`readTravelTimeline` in `lib/claim-freshness.mjs`); for trip, stay and flight claims the timeline outranks memory and is the only allowed source of a correction.
## Job Runner — protected, parallel background jobs

**Architectural invariant (2026-07-08, owner-authorized):** any long-running task (a multi-minute Opus research fork, a batch enrichment pass, anything that doesn't finish in a normal turn) can run as a fully independent OS process instead of living inside an agent session's conversation: a protected, uninterrupted process that runs in parallel to other tasks in the system. Two properties, both required:

- **Protected** — immune to context-rotation, crash-loop restarts, or a manual `/restart` of the agent session that launched it.
- **Parallel** — the agent that launches the job is NOT blocked for the job's duration; it returns immediately and can keep handling other dispatches.

**Why this exists.** A personal research job first ran its ~10-23min Opus research fork as a `run_in_background` Bash subprocess inside a conversational turn. That subprocess is a descendant of the `claude -p` session process, so any session rotation/restart killed it too — repeatedly in one day the turn ended right after kicking off the fork, orphaning it. Making that job one blocking script solved the orphaning for that job but neither of the two properties above — the whole ops-agent session was still monopolized for the run's full duration, and a crash-loop or hard-age-ceiling rotation could still kill it. This mechanism is the general answer, reusable by any long job. (The original story: `system/architecture-local.md` § Job Runner.)

**Three pieces, split by responsibility:**

| File | Role |
|---|---|
| `lib/job-runner.mjs` | `startJob({name, command, args, cwd, onComplete})` — writes a registry file at `data/jobs/<id>.json`, then spawns `job-runner-wrapper.mjs` with `detached: true` + `.unref()` and returns immediately. `cancelJob(id)` / `listJobs()` / `readRegistry(id)` for the CLIs below. |
| `lib/job-runner-wrapper.mjs` | The detached process (reparented to launchd/init, not to any agent session). It is the real `spawn()` parent of the target command — this matters because only a real parent can reap a child and learn its true exit code. Pipes stdout/stderr to `data/logs/jobs/<id>.log`, waits for exit, writes the terminal status (`done`/`failed`/`canceled`) back to the registry, and exits. Does nothing else — no notification, no retries — to keep its own crash surface minimal. |
| `agent/bin/process-manager.mjs` (job-completion watcher) | The one process that outlives every individual agent session. Polls `data/jobs/*.json` every 20s: dispatches a `{task, source:"job-runner"}` POST to the job's `on_complete.tier` webhook once a job reaches a terminal status (same `POST /` shape cron dispatch already uses); marks `status:"lost"` for jobs whose pid died without the wrapper updating status (debounced across two sweeps, so it doesn't race the wrapper's own near-instant write); prunes job files 7+ days past `finished_at`. |

**CLIs** (all in `bin/`, ESM, no `.mjs` extension — matches the rest of `bin/`):

```
job-run --name <label> [--tier ops|ops-light|ops-haiku] [--notify-task "<template>"] -- <command> [args...]
job-list [--running] [--json]
job-status <id> [--lines N]
job-cancel <id>
```

`--notify-task` is optional — a fire-and-forget job (one that already handles its own success/failure notification end to end) doesn't need one; jobs whose completion requires an agent to pick up the result (send the output, update a record) pass a template referencing `{{status}}`, `{{exit_code}}`, `{{id}}`, `{{name}}`.

**Visibility + cancellation were part of the ask, not an afterthought.** The owner asked for both once the core mechanism was proposed. `job-list`/`job-status` read the registry directly (no daemon needed to ask). `job-cancel` sends SIGTERM to the target command's pid (not the wrapper), waits up to 5s, SIGKILLs if still alive; the wrapper's own exit handler checks `cancel_requested` (set by `job-cancel` before signaling) to label the outcome `canceled` rather than `failed`.

**Why detaching preserves Max-auth keychain access.** `detached: true` only makes the wrapper the leader of a new process group — it does not change the macOS login session, so a wrapper launched from within an already-running, already-Max-authenticated agent session (chat/ops/ops-light/ops-haiku) still has that session's unlocked keychain access. This is why a job that itself forks `claude -p` (a research step, for example) must still be launched via `job-run` from *inside* an agent turn, not directly from cron — cron's separate, non-GUI session is exactly what breaks keychain access for Max auth (see the launchd note under § Effort Policy in `agent/CLAUDE.md`).

**Design doc:** none yet — this section IS the design doc. `lib/job-runner.mjs`'s header comment has the same design rationale for anyone reading the code directly.

## CLAUDE.md Hierarchy

Three CLAUDE.md files brief the running agents with the generic kernel rules — they're the operational rules, this doc is the map:
- `agent/CLAUDE.md` — shared agent rules (priorities, prompt-injection guard, financial limits, outbound email/iMessage policy, memory, system channel)
- `agent/chat-agent/CLAUDE.md` — chat-agent specifics (phone-channel, hum inbound handling, decision cards, purchases, escalation)
- `agent/ops-agent/CLAUDE.md` — ops-agent specifics (triage pointer, reclassify, committing, scheduled job dispatch loop, hum and self-improvement family). `ops-light-agent/` and `ops-haiku-agent/` symlink it.

**Local rules (the instance's own).** Everything about this instance's user — people, places, accounts, services, standing decisions and the user's own words — lives in `agent/local/`: `shared.md` (every agent), `chat.md`, `ops.md`. CLAUDE.md `@imports` cannot reach them (claude loads imports only from inside the agent's cwd), so at each session start the supervisor joins `shared.md` + its role file (`chat` for chat-supervisor, `ops` for every ops tier) into `agent/supervisor/state/<agent>/local-rules.md` and passes it with `--append-system-prompt-file` (`claude-session.mjs` `buildLocalRulesFile`). Missing files are skipped; no local rules → no flag. The file is rewritten only when its content changes, so the system prompt stays byte-identical across sessions for prompt caching. A polling watcher (`watchLocalRules`, 30s) schedules the same graceful restart as a CLAUDE.md edit when the joined content changes. Local rules extend the kernel and override nothing in its hard safety rules unless a local rule names the rule it overrides. Forks the supervisors do not start get the same rules when their cwd loads the agent CLAUDE.md files: the ephemeral runners and every launcher with its own `claude -p` line (`run-ephemeral-opus.sh`, `run-ephemeral-fable.sh`, `daily-summary-run`, …) source `agent/scripts/lib/local-rules.sh`, which joins the same files into a temp file for `--append-system-prompt-file` by the cwd's role (`edva_local_rules_role`); the chat fork executor passes the chat session's file; `runOneShot` (`core/one-shot.mjs`) builds one for its cwd (`claude-session.mjs` `localRulesFileForCwd`). A fork in a temp dir (no CLAUDE.md) gets none. Any other fork is told by the kernel CLAUDE.md to `Read` the two files.

**Playbook companions.** A kernel playbook's instance additions live in `agent/local/jobs/<job>.md`; the webhook dispatch (`http-server.mjs`) and the launchers that feed a playbook to their own `claude -p` (`local-rules.sh` `edva_job_prompt`) append the companion to `jobs/<job>.md` when it exists, and each kernel playbook that has one says so in its opening lines (for runs that read it by path). `email-inbound.md`'s prompt blocks are taken from the kernel and the companion alike (`sliceAll`), in the in-session dispatch and in the one-shot responder (`email-inbound-oneshot.mjs` `readPlaybook`). The triage ruleset's additions are `agent/local/email-triage-rules.md`, merged into `ops-agent/email-triage-rules.md` by `### ` heading (`dispatch-preamble.mjs` `mergeSectionedMarkdown`); the ops supervisor writes the merged copy to `state/<agent>/email-triage-rules.md` (on start and every 30s, only on change) and points `TRIAGE_RULES_FILE` at it, so `triage-rules core|index|section` read one ruleset. Every other reader goes through `triage-rules.mjs` `loadMergedRules()` at call time (the triage-decide and Jev shadow prompts, the `triage-rules` CLI): `TRIAGE_RULES_FILE` when set, else the same merge made on the fly (cron, CLI, forks).

Edits to these CLAUDE.md files and local rules take effect at the next session start (the supervisors' watchers schedule a graceful restart; `edva restart ops` / `edva restart chat` forces one). Playbooks (`jobs/*.md`, their companions, and the triage ruleset) load at dispatch time and don't need a restart.

## File Layout

```
~/Dev/edva/              git repo root (private repo)
├── client/                 iOS/macOS Edva app (build via `gh workflow run`)
├── tools/
│   ├── agent/
│   │   ├── chat-agent/CLAUDE.md
│   │   ├── ops-agent/
│   │   │   ├── CLAUDE.md
│   │   │   └── jobs/*.md            playbooks, loaded at dispatch
│   │   ├── supervisor/              chat-supervisor.mjs, index.mjs, dispatcher, gmail-source
│   │   ├── scripts/                 trigger-*.sh, watchdog.sh, lib/webhook-auth.sh
│   │   ├── phone-channel/           MCP server (iOS ingress + local Gemma acks)
│   │   ├── tools-mcp/               shell-bridge MCP
│   │   ├── logs/                    supervisor logs, watchdog, ack-trace
│   │   └── CLAUDE.md
│   ├── agent/scripts/hum-harvesters/   14 topic harvesters + hum-harvest-all.mjs wrapper
│   ├── bin/                         CLI utilities (edva, gmail-action, email-send, hum-answer, tickets, ...)
│   ├── lib/                         shared node libs (google-auth, email-memory, phone-context, supabase-rest, apns-push, ...)
│   ├── data/                        state + databases + hum-cache/
│   ├── credentials/                 OAuth tokens, APNs keys (gitignored)
│   ├── secrets/                     API tokens (gh, webhook, vault) (gitignored)
│   ├── firebase/                    Cloud Functions (heartbeat monitor)
│   ├── logs/                        triage.log
│   └── system/                      tasks.json, architecture.md (this), architecture-local.md + changelog.md (private), kernel-manifest.json, schemas
└── .github/workflows/               CI (iOS/macOS TestFlight)
```

## Live State Queries

```
edva status                   # health dashboard
edva services                 # LaunchAgents + tmux
edva tasks                    # automated task registry
edva cron                     # scheduled jobs with matched task names
edva triage stats --today     # email counts
edva triage recent [N]        # last N triage events
edva hum status               # daily counters + min-interval + pending question
edva hum situation [--json]   # current composite snapshot used by every tick
edva hum runs --tail N        # tail enriched tick trace
edva hum insight --since 7d   # aggregate metrics vs intent thresholds
bin/app-perf [--days N]    # Edva app responsiveness: hangs per platform/build/screen + MetricKit daily reports (hangs | diagnostics [--full])
edva hum question             # show the pending question (if any)
edva hum learnings --tail N   # answered questions with routed memory hook
edva hum feedback <id> <rxn>  # record a reaction after the fact
edva context [--json] [--fresh]  # unified profile + tastes + knowledge catalog
memory search "<q>" [--k N] [--mode hybrid|semantic|fts] [--caller X] [--no-expand] [--no-scope-rerank]  # auto-memory retrieval with scope + supersession + wiki-expansion
memory stats | memory eval | memory log        # index health / benchmark / recent retrievals
memory lint | memory entity list | memory show <f> # structural lint / canonical-entity registry / chunks+links for one file
memory-snapshot [--no-push] [--quiet]          # commit + push auto-memory dir to the private backup repo (cron every 30min)
memory-restore --list | --file <basename> [--at <ref>] | --snapshot <ref> | --tarball <path>  # roll back from git or pre-reindex tarball
wiki-db-snapshot [--quiet] [--keep N] [--dest <dir>]  # hot SQLite VACUUM INTO of memory-index.db; rotates to last N (default 4); cron hourly at :07
wiki-cloud-sync push [--dry-run] [--quiet] | verify [--json] | restore --db <new-file>  # Supabase mirror of pages/links/revisions; cron every 5 min
wiki backfill | wiki verify                    # ingest .md files into pages table; round-trip check
wiki search "<q>" [--mode fts|page]            # FTS5 search re-shaped per-page (uses memory_chunks index)
wiki read <id> | wiki list [--type T] [--pinned] | wiki links <id> | wiki backlinks <id>
wiki edit <id> | wiki save <id> --body @file   # mutate pages with revision history; auto-renders to disk unless MEMORY_DB_AUTHORITATIVE=1
wiki pin <id> [--lock] | wiki unpin <id> | wiki pin-defaults  # control SessionStart pinned subset
wiki lock-pin <id> | wiki unlock-pin <id>      # toggle pin_locked (auditor skips locked pages)
wiki supersede <old> <new> | wiki delete <id> | wiki history <id> | wiki show-rev <id> <rev>
wiki serve [--port N] [--host H]               # localhost HTTP browser (default :9096)
wiki-session-context                           # SessionStart hook payload: host-identity banner + pinned subset as additionalContext
edva whereami [--json|--banner|--role]      # which machine am I on? (the production host — an entry with "production": true or role "production" — another registered host, or unknown) — resolves via system/hosts.json
wiki-audit [--dry-run] [--no-log] [--json] [--window-days N] [--pin-threshold N]  # nightly self-tune of pinned subset
edva activity [--json]        # winding_down / active / sleeping / waking
edva doctor                   # drift checks (run before any digest)
edva logs ops-agent --tail N  # log tail
edva restart {ops|chat|whatsapp-channel|wiki-server|session}  # process-manager-aware: ops/chat POST supervisor /restart; whatsapp-channel/wiki-server SIGTERM the PM child (respawns); session kickstarts launchd
edva git                      # repo state
edva ci                       # recent GitHub Actions runs
kernel-guard [--summary|--json] [--new] [--staged] [paths]  # personal-data scan of the kernel files (system/kernel-manifest.json) against the private pattern list; --new = only hits not in system/kernel-guard-baseline.json
kernel-guard --unclassified [--staged]  # files in kernel directories that are neither kernel (manifest `files`) nor personal (`personal_globs`); --staged = only files the commit adds
kernel-guard --closure [--staged]  # kernel code leans only on kernel files, and spells no install path / Homebrew node beyond its install_path_allowance
kernel-guard --closure --write-install-allowance  # record the current per-file install-path counts (the portability ratchet)
```

## Deploy Model

- **Playbooks (`jobs/*.md`), trigger scripts, watchdog, CLI binaries, data files** — picked up on next invocation. No restart needed.
- **CLAUDE.md files and playbook-level agent config** — `edva restart {ops|chat}`. This rotates the inner `claude -p` session and re-reads `agents.json`; it does **not** restart the supervisor process.
- **Supervisor `.mjs` code** — reloaded automatically (shipped 2026-10-11, working since the 2026-10-12 re-check fix; see `system/changelog.md`): every watchdog tick runs `bin/supervisor-code-reload`, which SIGTERMs a supervisor whose import closure on disk is newer than its process (one per tick, only when idle, committed and `node --check`-clean, never on a five-minute cron boundary) and lets process-manager respawn it; holds and reloads are logged to `watchdog.log`, never paged, kill switch `data/.supervisor-code-reload-off`. To force it now, or for **MCP server code**: `edva restart session`. Nothing less works: `restart ops` leaves the Node process holding the HTTP servers untouched, so edited `.mjs` stays stale in memory while `edva status` reports a healthy, freshly-restarted agent. Verified the hard way on 2026-09-05 — a new `:9090` route returned 401s from the *old* handler for twenty minutes after `restart ops` reported success, and `ps -o lstart` on `supervisor/index.mjs` showed a process five days old. Check that, not `restartCount`, when a code change appears not to have landed.
- **LaunchAgent plist changes** — the kernel's plists in `agent/launch-agents/` are templates (`__EDVA_HOME__` / `__HOME__`, rendered by `agent/scripts/lib/launchd-render.sh`); install or refresh one with `agent/launch-agents/install.sh <label>` (renders into `~/Library/LaunchAgents`, boots the old copy out and bootstraps the new one). Never `cp` a template there. The agents' `.mcp.json` files use `${HOME}` and `${EDVA_SUPABASE_PROJECT}` (exported from `agent/local/instance.json` by `agent/scripts/lib/instance.sh`).

Always commit before restarting: the running supervisor reads from the working tree at spawn time, but pane recovery after a crash uses the committed code path.

## Design docs (read before changing the respective subsystem)

- `system/architecture.md` — this file. The map.
- `system/architecture-local.md` — the installation's own subsystems and instance specifics (private).
- `system/changelog.md` — the dated history of every change (private).
- `data/hum-intent.md` — hum north star: purpose, measurable success criteria, anti-patterns, operating assumptions. `hum-review` grades against this weekly.
- `data/hum-interests.json` — editable 17-topic registry (cadence, cache TTL, active window, urgency rule).
- `lib/edva-context.js` — unified knowledge primitive. Edit here to add a new data source; harvesters consume via `context.*` without change.
- `agent/ops-agent/jobs/hum.md` — the hum pipeline playbook (situation → harvest → Sonnet rank → execute). Rules only; rationale/history/lane mechanics in `docs/hum-detail.md`.
- `agent/ops-agent/jobs/hum-review.md` — the weekly self-assessment playbook.
- `agent/ops-agent/jobs/hum-ideation.md` — twice-daily opus playbook that refills the ideas reservoir with reinforcement-biased generation.
- `system/hum-ideas-reservoir.md` — ideas reservoir design: file format, scorecard formula, consumption/reaction loop, anti-sycophancy guard.
- `data/email-triage-playbook.md` — learned triage patterns (updated by `nightly-review` Step 2c — formerly `triage-learning`).
- `system/watch.md` — watches: standing "when X, do Y" instructions (wiki page + `watch_rules` row), event/anchor/at triggers, Jev `watch-match` decisions, hum questions when unsure, the 08:00–22:00 firing window.
- `system/associative-memory-research.md` — the research behind associative recall (2026-10-24): existing systems (Zep/Graphiti, Mem0, Letta, Hindsight, Cognee, HippoRAG, Basic Memory, …), 2025–26 papers (spreading activation, PPR, Hebbian, trigger cues, context reinstatement), the cognitive mechanisms, how to evaluate association, and the diagnosis of why the 2026-08-09 expansion measured zero. Read before changing `lib/wiki-assoc.mjs` or its writers.
- `system/wiki-architecture.md` — long-term context memory wiki: schema (`pages` / `page_links` / `page_revisions`), three-tier load (pinned subset → MCP search → wikilink expansion), write path semantics, `MEMORY_DB_AUTHORITATIVE` flag, migration phases, recovery cheatsheet. Read before changing wiki internals or moving the live memory dir.
- `lib/job-runner.mjs` — protected/parallel background-job mechanism: registry file shape, detach/reap design, why `on_complete` is optional, keychain-access-via-parent-session rationale. See § Job Runner above for the same content prose-form.

## Skills (user-invocable)

User-invocable Claude Code skills live at `~/.claude/skills/<skill-name>/SKILL.md` (with optional `references/` alongside). They are **not** dispatched by cron — they're invoked by Claude when a matching task/question appears in a Claude Code session (chat-agent, ops-agent dispatches, or the user's interactive CLI sessions). Skills encapsulate reusable know-how; jobs (under `agent/ops-agent/jobs/`) encapsulate scheduled playbooks. A job's playbook can tell the agent to invoke a skill internally.

Current skills (authored for Edva's operational surface):

| Skill | Purpose |
|---|---|
| `edva-docs-sync` | Enforces Rule #1 (self-awareness). Checklist for updating `architecture.md`, CLAUDE.md files, and job playbooks in the same change as any capability/architecture/job/channel/policy/data-store change. Identifies stale prose to retire; requires a dated entry in `system/changelog.md`; verifies via `edva doctor`. |
| `secrets-1password` | Canonical `op` CLI patterns (read, run-with-env, list, create, rotate), the Dev-vault project+service tag system, CI integration, expiration tracking (mirrors the table in `~/.claude/CLAUDE.md`), and safety rules (never hardcode, never leak to chat, never log). |
| `edva-job-author` | Full anatomy of a Edva job — playbook + trigger script + cron + state file + architecture entry. 8-step checklist for authoring a new job; references for delivery patterns (`email-send` + `og-card` + phone pointer + APNs) and state-file conventions (naming, schema, atomicity, gitignore rules). |
| `outbound-comms-policy` | Channel × identity matrix for every outbound path (email, iMessage, phone-channel, APNs). Incantations for each route; required Edva framing when iMessaging third parties; forbidden patterns (Gmail drafts as notifications, Slack, impersonating the user, leaking health content to third-party channels). |

The installation's own skills are in `system/architecture-local.md` § Skills.

Discovery: Claude Code auto-registers every `SKILL.md` under `~/.claude/skills/` at session start; each skill's YAML frontmatter (`name`, `description`) is what the model sees when deciding whether to invoke it. The `description` must be specific enough that invocation is obvious — generic descriptions cause skills to sit unused.

**Extending skills** — when a new pattern or cross-cutting concern emerges in the user's work, consider whether it belongs in a skill (reusable Claude know-how) or a job (scheduled task). The `nightly-review` job brainstorms skill improvements/additions as part of every run (see its playbook).

## Extending hum

**Add a new data source** (e.g., Home Assistant, calendar-other-account, HealthKit):
1. Add entry under `KNOWLEDGE` in `lib/edva-context.js` with `{via, mcp, scope}` — or, for a source only this installation has, in its overlay `lib/_ext/edva-context.cjs` (which also lists the profile and project pages; a table it returns replaces the kernel's, in the order given).
2. Optionally add a lazy read in `buildRecent()` (or the overlay's `counts`) so Sonnet sees a count/summary.
3. That's it. Every harvester now has access via `context.knowledge.<name>`.

**Add a new topic** (e.g., "podcasts", "crypto"):
1. Write `agent/scripts/hum-harvesters/<name>.mjs` — reads `{situation, context}` on stdin, emits one candidate JSON or `"null"` on stdout. Use `_common.mjs` helpers (`readStdinJson`, `readCache`, `writeCache`, `emit`, `emitNull`, `stampRun`).
2. Add a registry entry to `data/hum-interests.json` with `{name, enabled, script, cadence_min, cache_ttl_min, active_window, urgency_rule}`.
3. The next tick picks it up. No playbook edit needed.

**Add a new taste domain** (e.g., books):
1. Drop a file into the memory dir (e.g., `user_book_taste.md`).
2. Add a `tasteFiles` entry to the installation's overlay (`lib/_ext/edva-context.cjs`; contract in `lib/edva-context.js`).
3. Every harvester that cares can read `context.tastes.books`.

## Per-installation config, hooks and overlays

Kernel code carries generic defaults only; an installation's own values and behaviour live in tracked private files that the kernel reads:

- **Identity** — `agent/local/instance.json` via `lib/instance.cjs` (`instance()`, `instanceValue(key)`, `supabaseUrl()`, `supabaseAnonKey()`, `claudeMemoryDir()`; env `EDVA_*` overrides; shell: `agent/scripts/lib/instance.sh`). Keys: `owner_name` ("the user" by default), `owner_id`, `owner_email`, `agent_email`, `domain`, `tz` (the host's zone when unset), `host`, `host_label` / `host_title` (how alerts and replies name the machine: "the host" / "Host" by default), `supabase_project`, `gcp_project`, `github_owner`.
- **Owner-named identifiers** — names that are stored or cross a boundary and embed the owner are built from `owner_id` (derived from `owner_name`, `user` by default; set explicitly in `instance.json` to pin it): the email-triage Jev question key `needs_<owner_id>` (`lib/jev-email-triage.mjs` `NEEDS_KEY`, also the field in its verdict and pending rows), the hum idea scope `manual_<owner_id>` (`lib/hum-ideas.mjs` `manualScope()`), the Jev state key `<owner_id>_said` (claim-check, outbound-precheck), and the claim-freshness rewrite-check kinds `corrected_from_<owner_id>` / `closed_by_<owner_id>` / `contradicts_<owner_id>`. An installation whose data and Jev questions already use its own name keeps them unchanged.
- **Renamed fields and env vars** — a kernel field or env var that was renamed generically reads the old name only where an installation lists it: the ideation lens is `idea_lens` (`lib/hum-ideas-scorecard.mjs` `lensOf`; older stored ideas via `hum-ideas.json` `extend_lens_fields`), the user's own WhatsApp number is `WHATSAPP_OWNER_NUMBER` (`bin/whatsapp-send`; an older env name via `whatsapp-send.json` `extend_owner_number_env`). The self-improvement critic's defer verdict is `DEFER_TO_OPERATOR` (free text; only `SAFE` is parsed).
- **Values** — `agent/local/config/<name>.json` via `localConfig(name, defaults)`, one file per concern, named after the module that reads it (`agents`, `api-fallback`, `apns`, `ci-signing`, `claim-facts`, `claim-freshness`, `claude-binaries`, `context-sync`, `cost-efficiency-review`, `cost-report`, `cron-slots`, `email-inbound`, `fork-connectors`, `fork-skills`, `gmail-auth`, `gmail-intake`, `hum-calendar`, `hum-ideas`, `hum-lanes`, `hum-resolve-first`, `location-lanes`, `memory-write-precheck`, `money-quantity`, `outbound-precheck`, `self-improve-landing`, `self-improve-rails`, `send-intents`, `sms-send`, `suggestion-backfill`, `suggestion-classify`, `suggestion-key`, `supabase`, `tools-mcp`, `triage-decide`, `triage-labels`, `turn-watchdog`, `whatsapp-send`, `wiki` — e.g. `wiki.json` `default_pins` is the `wiki pin-defaults` list; `hum-lanes.json` `protected_lanes` names the Rule #1 hum lanes that only an explicit user revocation may suppress (none by default: `hum-vetoes`, `jev-gates`, the outbound-precheck prompt and `edva-send-curl`'s suppress-override belt read it) and `protected_revocation` that belt's revocation vocabulary; `email-inbound.json` `draft_tags` / `draft_apply_job` the marketing-draft hand-off of the email responder's `mkt_apply` tool, and `draft_id_prefixes` / `draft_apply_task` the draft ids it accepts and the task it dispatches (`email-inbound-oneshot.mjs` `mktApplyTask`; default `draft-` ids and `OUTREACH APPLY`); `agents.json` `disallowed_tools: { <agent>: [...] }` is merged into each agent's disallowed tools at spawn (the supervisors' `loadAgentConfig`); `fork-connectors.json` `deny` names the MCP servers `scripts/lib/fork-connector-deny.sh` withholds from forks; `gmail-intake.json` `pre_applied_label` is the Gmail label intake treats as already applied by the installation's own filters (`gmail-source.mjs`); `cost-efficiency-review.json` `seed_baseline` seeds that review's first state file (`trigger-cost-efficiency-review.sh`; unmeasured without it); `hum-ideas.json` `airlines` replaces the ideas harvester's generic carrier list; `outbound-precheck.json` `prompt` and `claim-freshness.json` `examples` hold the installation's wording for the example slots in those prompts); `extend_<key>` appends to a default list. A fresh install has none and runs on the generic defaults.
- **Registries** — kernel file + `agent/local/<name>.json`, merged by `lib/registry.cjs` (§ Scheduled Tasks).
- **Behaviour** — `_ext/` modules next to the calling kernel code, loaded by `lib/ext-hooks.mjs` (`loadHook` / `runHook`; a missing or failing hook falls back to the generic path). Each `_ext/` dir's `.gitkeep` documents its contract. The hook points:
  - `lib/_ext/choice-handlers.mjs` — choice-card and checklist tap handlers for the installation's own card kinds (location cards included; `lib/choice-reply.mjs` `loadExtHandlers`);
  - `lib/_ext/watches.mjs` — the watch engine `hum-sense` offers every fresh event to (`spoolEvents(events)`); without it, and without `bin/watch`, hum runs with no watches;
  - `lib/_ext/context-sources/*.mjs` — extra `context-sync` sources (`export default { name, describe, async sync({ cm, wiki, run, BIN, DATA }) }`; run by `context-sync <name>` and after the kernel sources by `all`; kernel names win);
  - `lib/_ext/edva-context.cjs` — extra context sources (`lib/edva-context.js`);
  - `lib/_ext/claim-freshness-timeline.mjs` — the travel timeline CLI for claim-freshness Stage 2b;
  - `lib/_ext/self-improve-landing.mjs` — extra landing refusals for a self-improvement (`landingRefusals({files, before})`, `lib/self-improve-landing.mjs`; § Kernel boundary and its enforcement);
  - `lib/_ext/presence.mjs` — the presence provider (`provider()`: travel timeline + metro table) for `lib/claim-facts.mjs`, `hum-idea-locality.mjs` and `hum-ideas-append`, plus optional `listSegmentsSync()` (the timeline read `loadTimelineSync` makes) and `AUTHORITY` (the source a presence fact cites; default `timeline`); without it there is no timeline and every presence check fails open;
  - `lib/_ext/venue.mjs` — the map lookup behind `bin/hum-ideas-append`'s venue check (`lookupVenue({name, near})` → `{area: {lat, lon, span_km} | null, candidates: [{id, name, address, lat, lon, status}]}`, throwing when it cannot run, so the idea is held as `venue-unverified`); without it a named place is written unchecked and listed in `venue_unchecked`;
  - `lib/_ext/clock-jobs.cjs` — `plannedTz()`, the zone the installation's travel timeline puts the user in now, for `lib/clock-jobs.js` `resolveTz` (confirmed zone first, then planned, then the instance zone); without it there is no planned zone;
  - `lib/_ext/hum-offer-lanes.mjs` — the installation's ask-first offer lanes (`offerLanes = { <lane>: { windowMin, line(row, sentAgo) } }`): an un-reacted offer younger than its window gets its handling line in the chat prompt's `[Hum state]` block (`lib/hum-reply-target.mjs`);
  - `bin/_ext/edva-cli.cjs` — hooks for the `edva` CLI (CommonJS, every export optional): `sleepInfo()` (wake time today, last active yesterday, asleep now — the hum context's `time` fields) and `activityOverride()` (a device signal that beats the clock rules of `edva activity`);
  - `agent/supervisor/_ext/gmail-intake.mjs` — a Gmail intake step before the P1 stampers (`gmail-source.mjs` `runExtIntake`, both intake paths);
  - `agent/supervisor/_ext/routes.mjs` — extra POST routes and an inbound-email pre-route on the :9090 port (`http-server.mjs`);
  - `agent/scripts/_ext/watchdog-checks.sh` — extra watchdog checks and incident labels, sourced by `watchdog.sh`;
  - `agent/scripts/_ext/context-sync-tick.sh` — the installation's own work that rides each `context-sync` tick (`trigger-context-sync.sh`; capped at 2 min, never fatal);
  - `agent/scripts/hum-resolve-first-sources/_ext/` — extra evidence sources for resolve-first (`docs/hum-resolve-first.md`);
  - `agent/tools-mcp/_ext/` — the installation's own MCP tools; `agent/phone-channel/_ext/reply-hints.mjs` — typed-reply hints for its own card kinds.
- **Overlay drops** — directories where an installation's own pieces sit beside the kernel's and are found by name, the kernel's winning on a conflict:
  - `agent/ops-agent/jobs/_ext/<job>.md` — playbooks for webhook-dispatched jobs (`http-server.mjs` `resolveJobFile`: `jobs/<job>.md`, else `jobs/_ext/<job>.md`);
  - `agent/scripts/hum-harvesters/_ext/` — harvesters (`hum-harvest-all.mjs` `resolveHarvesterPath`, by the registry's `script` name);
  - `agent/scripts/hum-sensors/_ext/` — sensors (`hum-sense` `loadSensor`; `PATHS.sensorExtDir`);
  - `browsing-skills/skills/_ext/<site>/` — browsing skills (`run-action.js`, `validate-skill.js`);
  - `bin/_ext/<name>` — the installation's optional CLIs that kernel code calls when present: `optionalBin(binDir, name, envVar)` in `lib/ext-hooks.mjs` returns `$envVar`, else `bin/_ext/<name>`, else `bin/<name>` (first executable), else null. Used for the weather CLI (`EDVA_WEATHER_BIN`, hum-sensors `weather.mjs`) and the location-ask closers in `hum-ping`; `edva-send-curl` takes `EDVA_HEADLINER_BIN` / `EDVA_TRAVEL_BIN` for its event geo-gate, and the harvesters' `geoGate` (`hum-harvesters/_common.mjs`) finds the same two CLIs through `optionalBin` (no CLI → no gate, fail open); `wiki-serve.js` takes `WIKI_FAVICON_FILE`.
  - `bin/cli.d/<name>.mjs` — the installation's own `edva` subcommands (contract: `bin/cli.d/README.md`; built-ins win, `edva help` lists them under EXTENSIONS).
- **Prompts and rules** — `agent/local/prompts/*.md`, `agent/local/{shared,chat,ops}.md`, `agent/local/jobs/<job>.md`.
- **Deploy configs** — e.g. `agent/local/wiki-worker/wrangler.toml` (the filled-in copy of the kernel template; deployed from `wiki-worker/` with `wrangler deploy --config ../agent/local/wiki-worker/wrangler.toml`). The worker imports its site icon as `"wiki-favicon"`: the kernel template aliases it to `src/favicon-none.js` (no icon, `/favicon.*` is a 404), an installation's copy to its own module that re-exports its PNG.
- **LaunchAgents** — plist templates rendered per installation by `agent/scripts/lib/launchd-render.sh` (installed by `agent/launch-agents/install.sh`).

## Where the kernel lives — `lib/root.cjs`

The kernel sits under `<repo>/tools/` here and at the repo root in the published copy, so no kernel file finds the repo by counting `..` from its own location, and none spells that position. `lib/root.cjs` exports two roots:

- `REPO_ROOT` / `TOOLS_DIR` (+ `toolsPath(...p)`) — the checkout the code runs from (a worktree, a CI clone, the live install), fixed at load. `TOOLS_DIR` is the kernel tree.
- `installRoot()` / `installTools(...p)` — the installation under the operator's HOME (`~/Dev/edva`, `~/Dev/edva/tools`), read per call so a test that points HOME at a sandbox sees it. This is what the supervisors, bins and libs that used `path.join(HOME, "Dev/edva")` now call.

`EDVA_HOME`, when set, is both. Paths below the kernel tree are joined onto `TOOLS_DIR` / `installTools()` with their kernel-relative spelling (`"agent/logs"`), never a leading `"tools/"`; a relative path between two kernel files is fine as it is. Shell scripts source `agent/scripts/lib/root.sh`, which sets `EDVA_ROOT` / `EDVA_TOOLS` (the checkout; an exported `EDVA_ROOT` wins, then `EDVA_HOME`), `EDVA_INSTALL` / `EDVA_INSTALL_TOOLS` (the installation) and `EDVA_KERNEL_SUBDIR`; scripts write `"$EDVA_TOOLS/bin/x"`, never `"$ROOT/tools/bin/x"`. LaunchAgent templates write `__EDVA_TOOLS__/...` (rendered by `launchd-render.sh`) for paths below the kernel. The layout is one line in `root.cjs`, `const KERNEL_SUBDIR = "tools";`; `root.sh` reads it from there. `tests/kernel-layout.test.mjs` runs both helpers in both layouts.

## Kernel boundary and its enforcement

The kernel is exactly the files in `system/kernel-manifest.json` `files` (path here → path in the published copy). They hold generic code, rules and defaults only — no names, places, accounts, routines, dated events, quotes or real IDs of the installation's user. Everything personal lives in the installation's own files: history and incident narrative in `system/changelog.md` or the commit message (never in a code comment), rules in `agent/local/`, values in `agent/local/config/`, behaviour in `_ext/` hooks (§ Per-installation config, hooks and overlays), real-data tests in `*-local.test.mjs`. The manifest's `personal_globs` names the installation's own files that sit in kernel directories (its jobs, harvesters, bins, libs, `_ext/`, `agent/local/**`). A kernel directory is one that holds manifest files, plus everything below it (the repo root: only its own files); every tracked file there must be in one list or the other. A third list, `edva_owned` (path here → path there), names the files both repos have but must differ by nature — `.gitignore` (this repo tracks `agent/local/` and the `_ext/` dirs, the published copy ignores them), `.gitleaks.toml` / `.gitleaksignore` (each repo's own allowlist and commit fingerprints), `.pre-commit-config.yaml`, the root `package.json` / `package-lock.json` (this installation's own dependencies) and the agents' MCP sets (`agent/ops-light-agent/.mcp.json`, `agent/ops-haiku-agent/.mcp.json`, `agent/supervisor/chat-mcp-config.json`, which name this installation's servers). They count as classified and as part of the kernel areas, are not scanned for personal data, and are never copied: the published copy keeps its own.

**Closure.** The published copy is the kernel files alone, so a kernel file may only lean on kernel files: every static import / require / `source` of a repo file resolves to a kernel file (node built-ins and npm packages are fine; an `_ext/` hook is optional by contract), and every other repo path kernel code names — a bin run by path, a data or config file, a script a plist launches — is a kernel file, an owned file, a path under the manifest's `closure_runtime_paths` (state the installation writes or keeps for itself: `data/**`, `agent/local/**`, logs, secrets, `_ext/` dirs, a channel's auth state, its own browsing skills), or guarded where it is used (an exists check, `[ -x ]`, `command -v`, try/catch, `optionalBin`). Personal behaviour that kernel code used to call directly goes behind a hook instead (§ Per-installation config, hooks and overlays); a test of personal code moves to a `*-local.test.mjs`. `kernel-closure-ok: <reason>` on the line, or the line above, exempts a reference that is fine as it is (advice text naming a tool, a deploy-time asset).

**Portability.** Kernel code finds the installation and node through one helper each, never by spelling them: `lib/root.cjs` (`installTools(...)`, `installRoot()`, `TOOLS_DIR`; `nodeBin()` — `$EDVA_NODE`, else a stable Homebrew / `/usr/local` node, else `process.execPath`) and `scripts/lib/root.sh` (`$EDVA_INSTALL_TOOLS`, `$EDVA_TOOLS`; `$EDVA_NODE` — `command -v node`, else the Homebrew / `/usr/local` paths). A node script that cron runs directly starts with a two-line sh launcher that is also valid JavaScript (`#!/bin/sh` + `':' //; for n in … do [ -x "$n" ] && exec "$n" "$0" "$@"; done`), since cron's bare PATH has no node and `#!/usr/bin/env node` exits 127. `kernel-guard --closure` enforces it as a ratchet: a code line (comments and doc files are not code) that spells `~/Dev/edva` / `"Dev/edva/…"` or `/opt/homebrew/bin/node` counts against the file's entry in the manifest's `install_path_allowance`, and a file over its count (a new file: over zero) is a violation; `kernel-guard --closure --write-install-allowance` records the counts after lines are converted, so they only go down. The machine itself is named in alerts and replies by the instance's `host_label` / `host_title` (`lib/instance.cjs`; "the host" / "Host" by default).

**Edva sync.** The published copy is made mechanically from the manifest by `bin/edva-sync --edva <clone> [--dry-run] [--verify]` (this installation's tool, not part of the kernel), run against a local clone of the published repo; it never commits or pushes. Each `files` entry is copied to its published path with the text rules, in order: install paths (`~/dev/<name>/tools/` → `~/Dev/<published name>/`, `dev/<name>/tools/` → `Dev/<published name>/`, `dev/<name>` → `Dev/<published name>`, where `<name>` is this installation's name); the layout map `tools/<x>` → `<x>` for every kernel-tree entry `<x>` (the first segment of the manifest paths below `tools/`, of the `tools/` entries in `closure_runtime_paths`, and of the repo's `tools/` directory) when `tools/` is not itself the tail of a longer path; `"tools", "<x>"` path segments dropped; the brand: this installation's name → the published name, in each of its three casings (upper, title, lower); and one layout rule: in `lib/root.cjs` the line `const KERNEL_SUBDIR = "tools";` becomes `const KERNEL_SUBDIR = "";` (it must appear exactly once). Binary files are copied byte for byte, symlinks keep their target, modes are kept. `edva_owned` entries are never written, and files in the published repo that the manifest does not produce (its README, examples, apps, `bin/cli.d/*.mjs`, its owned files) are left alone. The synced set is recorded in `<clone>/.kernel-sync.json` (`{format, files}`: nothing about the source repository, no commit or working-tree state); a path listed there that the manifest no longer produces is deleted on the next sync, and only such a path. The tool refuses to run unless `kernel-guard`, `--closure` and `--unclassified` are clean, scans the transformed files with kernel-guard's full detector set (the static pattern list plus the shape and derived detectors, `kernel-guard-ok` honoured) before writing (any hard hit: nothing written) and the written files again after. `--verify` runs every kernel test file in a scratch copy of the clone (a git repo with everything added, HOME pointing at a temp dir whose `Dev/edva` is that copy) and prints the failing ones. Procedure: clone the published repo, `edva-sync --edva <clone> --verify`, review `git -C <clone> diff`, commit there. Test: `tests/edva-sync-local.test.mjs`. Scheduled: `bin/edva-sync-pr` (this installation's, not part of the kernel) runs that procedure monthly from cron and, when anything changed, pushes branch `kernel-sync` to the published repo and opens or updates one pull request; it never merges.

**Kernel tests run in both layouts.** A kernel test never depends on this installation's identity, config or data: one that needs an owner, addresses or a time zone imports `tests/synthetic-instance.mjs` first (a made-up `EDVA_LOCAL_DIR`, owner "the user", UTC), one that needs a Jev question uses the kernel definition in `agent/config/jev-questions/` (or a temp dir), one that needs the installation's data brings its own file through the module's override (e.g. `LOCAL_TRIAGE_RULES_FILE`), and a path rail or a regex over repo-relative paths is built from `KERNEL_SUBDIR` (`rail()` in `lib/self-improve-landing.mjs`). What this installation plugs in is pinned in its `*-local.test.mjs` files instead.

Held mechanically, because most code here is written by unattended pipelines:

- **`bin/kernel-guard`** (logic in `lib/kernel-guard.cjs`) scans kernel files with the private pattern list `system/personal-patterns.json` plus the derived and shape detectors below; a hard hit is personal data. A line carrying `kernel-guard-ok: <reason>` is exempt from every detector — static, shape and derived alike — and its hits count as allowed; it is for content that is generic despite matching (a public brand or product, a typeface, a well-known acronym), and the reason says why. `--staged` judges a commit as it will land: the staged copies of staged kernel files, scanned with the pattern list and the derived detectors built from the index copies of the registries and config. `--unclassified` lists files in kernel directories that are in no list. `--closure` (logic in `lib/kernel-closure.cjs`) checks the closure and portability rules above over every kernel code file, or with `--staged` over the staged copies of staged kernel files.
- **Derived and shape detectors** (also in `lib/kernel-guard.cjs`) — a static list only holds what someone thought to write down, so the scan adds patterns built per run from the installation's own registries and config: every personal task, job, service, bin / lib / script and browsing-site name (the local registries, playbooks and the files `personal_globs` matches), the identity values in `agent/local/instance.json`, and the proper nouns, emails, domains, street addresses, ids and wiki page ids in `agent/local/config/*.json`. Registering something personal makes it a pattern, with no list to keep. Matching is whole-token and identifier-aware (`-`, `_` and camelCase humps separate words; a kernel identifier that merely contains a token is not a hit; a personal file named by path in kernel code is left to `--closure`). Common English words, public product names and the kernel's own identifiers never become tokens; a compound name is one only when a word in it is one no vocabulary explains, or a life-area word (money, home, travel, health, family, tastes, plus the personal module families `personal_globs` names); a token that is still generic in kernel text goes in the pattern file's `derived_allow` with its reason. Shape detectors catch what has no list: hex ids next to approval / decision / disagreement / cluster words, dated incident ids, commit SHAs in docs and comments, real-looking mailboxes, tenant subdomains, the home time zone and its abbreviations (hard outside tests; a line about market hours or one listing other zones is exempt), coordinates and street addresses. Placeholders (example.com, `abc123def456`, `12 Main St`, `<team>`) never hit. `kernel-guard --explain` prints which registry or rule produced each hit; `--list-patterns --explain` lists every derived token and allow entry.
- **Commit gate** — gate 5 of `githooks/pre-commit`: on every commit (interactive included; merges and rebases exempt) it runs `kernel-guard --staged` (the staged copies of staged kernel files), `kernel-guard --unclassified --staged` (files the commit adds, against the staged manifest) and `kernel-guard --closure --staged` (staged kernel code files). Any finding blocks the commit and prints where the content belongs. Override: `EDVA_ALLOW_KERNEL_GUARD_SKIP=1`. The hook runs where `core.hooksPath` is `githooks`: `edva-sync` sets it on any clone that has none (and leaves a different value alone), and `edva-commit` runs the hook itself on a clone that is not wired.
- **CI** — `.github/workflows/kernel-guard.yml` runs the full scan, `--unclassified`, `--closure` and the guard's tests on every push to main and every PR.
- **Self-improvement landing** — `lib/self-improve-landing.mjs` asks the installation's hook (`lib/_ext/self-improve-landing.mjs` `landingRefusals`) about every change; personal data added to a kernel file, or a new file left unclassified, is refused with `redraft: true` (`self-improve-auto-apply` exit 8, `self-improve-request` exit 65), never carded: a signature cannot make the content belong there, and the commit gate would refuse it after the signature. The author moves the content and resubmits. Clean changes are judged as before.
- **Scratch trees** — a critic or job that runs tests against a change does it in `bin/scratch-tree make` (a local clone: tracked files plus the change under review, from the working tree or a `--bundle`; nothing gitignored, so no `.env` or `data`), runs commands with `scratch-tree run <dir> -- <cmd>` (`EDVA_HOME` at the copy; every variable the installation's `.env` or its backups assign, and any `*_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD`/`*_PASS` name, removed from the command's environment; `--keep-env NAME` passes one through deliberately, logged by name to `agent/logs/scratch-tree.log`; HOME still passes, so a tool that reads the installation's `.env` by fixed path is not covered) and deletes it with `scratch-tree remove`. `rotate-agent-logs.sh` runs `scratch-tree sweep` nightly: scratch trees older than 6 hours, and any file under `/tmp` / the temp dir whose bytes equal one of the installation's `.env*` files, are deleted (log `agent/logs/scratch-tree-sweep.log`). The rule is in `agent/ops-agent/CLAUDE.md` and the critic contract in `jobs/self-improvement-executor.md`. Test: `tests/scratch-tree.test.mjs`.
- **Test runs never reach the real chat** — keyed on `NODE_TEST_CONTEXT`, which `node --test` sets in every test process and whatever it spawns: `lib/load-env.js` withholds `SUPABASE_SERVICE_ROLE_KEY` inside a test run (never loaded from the file; an inherited one dropped when it is a live credential by shape, `sb_secret_…` or a service_role JWT; a test's own stand-in kept); `edva-send-curl` runs its gates, then exits 9 before the P1 fold, insert, push and email fallback unless the test names a stand-in transport (`EDVA_SEND_TEST_CURL`; even then no push, outbound stamp, spool row or email); `edva-send.mjs` exits 9; the chat supervisor's safety-net poster holds no key; `apns-push.mjs` `sendOne` rejects before connecting. Not covered: tests outside `node --test` (Python, shell-run, a file run directly or with `--test-isolation=none`), and the writers that take the key from the environment or read `.env` themselves (`choice`, `findme`, `system-channel-spool-flush`, the tools MCP server); scratch trees are their protection. Test: `tests/test-run-send-guard.test.mjs`.
- **Self-improvement content check** — `lib/self-improve-content-check.mjs` runs at every door a change can land through: `self-improve-bundle` (when the bundle is built), `self-improve-request` (exit 65, before a card is filed), `self-improve-auto-apply` (exit 8) and `self-improve-approval-poll` (before a signed card is written; the failure is posted to Improvements). It refuses a file whose new content is itself a bundle (`{"files": …}`), and a text file losing at least 80% of its lines and at least 200, unless the change declares the path in `allow_shrink` (inside `item_json`, so the signature covers it); a declared large removal is printed on the card. Both checks are structural (a JSON shape, line counts). Bundles are built with `bin/self-improve-bundle --out <file outside the repo> --base-rev <commit> <paths…>`, which reads the files from the working tree and records `base_sha256`; playbooks that edit the tree and then file a change use it instead of a hand-written command. Test: `tests/self-improve-content-check.test.mjs`.
- **Writers' rules** — `agent/CLAUDE.md` § Kernel boundary (the rule, pointing at this section for the detail), and every playbook that edits repo files (improvement-plan, self-improvement-executor, system-issue-review, skill-repair, nightly-review, cost-efficiency-review, and the installation's own that do), say: run `kernel-guard` before committing, narrative to the changelog or the commit message, personal values to `agent/local/`, personal behaviour to `_ext/`.

## Changelog

The dated history of changes lives in `system/changelog.md` (private, not part of the kernel); add each change's entry there, at the top of its **Recent changes** section (Rule #1).
