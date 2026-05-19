# Integration: Gmail

Wire your Gmail inbox into Merlin so the ops-agent can triage incoming mail in real time.

Three pieces:
1. **OAuth credentials** — so Merlin can read + label messages.
2. **Pub/Sub push** — so Gmail tells Merlin about new mail (instead of Merlin polling).
3. **Tunnel** — Pub/Sub push only delivers to public HTTPS endpoints; you need something like Hookdeck or ngrok to expose the local supervisor.

This guide is the minimum to get inbound email triage running. Outbound mail goes through SMTP2Go (see `bin/email-send`) and is a separate integration.

## 1. Google Cloud project + OAuth

If you don't have one:

```bash
# Create or pick a project
gcloud projects create merlin-agent --name="Merlin Agent"
gcloud config set project merlin-agent

# Enable the Gmail + Pub/Sub APIs
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

Then create an **OAuth 2.0 desktop client**:

1. Console → APIs & Services → Credentials → Create credentials → OAuth client ID.
2. Application type: **Desktop**. Name: `merlin-gmail`.
3. Download the JSON.

Add to `.env`:

```
MERLIN_GCP_PROJECT=merlin-agent
GMAIL_OAUTH_CLIENT_ID=...        # from the downloaded JSON
GMAIL_OAUTH_CLIENT_SECRET=...    # from the downloaded JSON
```

First-time auth (run once on the host):

```bash
node ./agent/scripts/gmail-auth.mjs
```

This opens a browser, you grant Gmail readonly + modify scopes, and the script writes a refresh token to `secrets/gmail-token.json`.

## 2. Pub/Sub topic + subscription

Create a Pub/Sub topic Gmail will publish to when new mail arrives:

```bash
gcloud pubsub topics create merlin-gmail-watch
```

Grant Gmail's system account permission to publish:

```bash
gcloud pubsub topics add-iam-policy-binding merlin-gmail-watch \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

Create a push subscription pointed at your tunnel URL (you'll fill this in after step 3):

```bash
# Placeholder — set the URL after Hookdeck is configured
gcloud pubsub subscriptions create merlin-gmail-push \
  --topic=merlin-gmail-watch \
  --push-endpoint=https://YOUR_TUNNEL/gmail-pubsub
```

## 3. Tunnel (Hookdeck recommended)

Gmail Pub/Sub push needs a public HTTPS URL. Options:

- **[Hookdeck](https://hookdeck.com)** — managed, free tier sufficient, queues during downtime
- **ngrok / Cloudflare Tunnel** — free, ephemeral, simpler
- **Your own reverse proxy** — if you're already hosting

### Hookdeck path

```bash
# Install
brew install hookdeck/hookdeck/hookdeck-cli

# Sign in
hookdeck login

# Listen — exposes the local supervisor on :9090 (gmail port) to a public URL
hookdeck listen 9090
```

That prints a URL like `https://hkdk.events/<your-connection-id>`. Add to `.env`:

```
MERLIN_HOOKDECK_URL=https://hkdk.events/<your-connection-id>
```

Then update the Pub/Sub subscription from step 2 to point at that URL.

The `process-manager` keeps Hookdeck alive as a child process — see `system/services.json`. On macOS launchd / Linux systemd installs, Hookdeck runs as part of the merlin service.

## 4. Start the watch

Tell Gmail to start publishing to your topic:

```bash
node ./agent/scripts/setup-gmail-watch.mjs
```

This calls Gmail's `watch` API which returns an expiration timestamp (usually 7 days out). A periodic renew job (`agent/scripts/renew-gmail-watch.sh`, runs daily) re-extends the watch before it expires.

## 5. Verify

Send yourself an email. Within seconds you should see in `merlin tail ops`:

```
[gmail-source] received Pub/Sub notification, history_id=12345
[ops-supervisor] dispatching EMAIL_INBOUND task
[claude-p] starting triage…
```

If nothing happens:

- `merlin status` — supervisor alive?
- `hookdeck listen 9090` — getting hits in the dashboard?
- Pub/Sub subscription — check the "Push delivery" tab in GCP console for delivery errors.

## What the ops-agent does with inbound mail

When a Pub/Sub message arrives:

1. The gmail-channel (`agent/gmail-channel/index.mjs`) handles the Pub/Sub push.
2. It fetches the new message(s) from Gmail using the OAuth credential.
3. POSTs to the ops-supervisor as a dispatched task with the message content + metadata.
4. The ops-agent runs the triage playbook (`agent/ops-agent/CLAUDE.md` § Email Triage Rules).
5. Based on classification: applies labels, stars, marks read, optionally creates Google Tasks, optionally notifies via `merlin-send-curl`.

The triage rules are deliberate: P1 emails ping; P2 are labeled/starred silently; P3 are labeled and marked read. See `agent/ops-agent/CLAUDE.md` for the full ruleset and the per-vendor fast-path patterns.

## Rotating the OAuth token

Google rotates refresh tokens for inactive accounts. If triage stops working with auth errors:

```bash
node ./agent/scripts/gmail-auth.mjs --force-reauth
```

Re-grants the scopes and writes a fresh `secrets/gmail-token.json`.

## Costs

- **Gmail API** — free under the daily quota (1B units/day, where label/get/list each cost 5–10 units; you'd need hundreds of K emails/day to even approach this).
- **Pub/Sub** — first 10GB/month free. A typical inbox: << 100MB/month.
- **Hookdeck** — free tier covers 100K events/month.

Total realistic cost for an active inbox: $0.
