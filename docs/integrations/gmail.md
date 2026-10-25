# Integration: Gmail

Wire a Gmail inbox into Edva so the ops agent triages new mail as it arrives.

Four pieces:

1. **OAuth** — so Edva can read and label messages.
2. **Pub/Sub push** — Gmail tells Edva about new mail instead of Edva polling.
3. **Public ingress** — Pub/Sub only pushes to a public HTTPS endpoint; Edva expects a tunnel (the kernel's watchdog knows a Cloudflare Tunnel) from a hostname you own to the ops supervisor's port **9090**.
4. **The watch** — Gmail's `watch` subscription, renewed daily.

Outbound mail is a separate integration ([`smtp.md`](smtp.md)).

## 1. Google Cloud project + OAuth

```bash
gcloud projects create my-edva-agent --name="Edva"
gcloud config set project my-edva-agent
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

Create an **OAuth 2.0 client** (Console → APIs & Services → Credentials → OAuth client ID, type **Desktop**). Record the project in `agent/local/instance.json` (`"gcp_project": "my-edva-agent"`; or `EDVA_GCP_PROJECT` in `.env`) and the client in `.env`:

```
GMAIL_OAUTH_CLIENT_ID=...
GMAIL_OAUTH_CLIENT_SECRET=...
```

Authorize once on the host:

```bash
node agent/scripts/gmail-auth.mjs
```

It opens a browser for the Gmail scopes and writes the refresh token to `credentials/gmail-push-token.json`, which `bin/gmail-action`, the watch scripts and the supervisor read. Run it again whenever Google revokes the token (triage starts failing with auth errors).

If you keep the client in a password manager, the script can take the variables from it at run time; put the secret references it should print as a hint in `agent/local/config/gmail-auth.json` (`op_client_id_ref`, `op_client_secret_ref`).

## 2. Public ingress

Pick a hostname you control, by default `gmail-push.<domain>` (`domain` in `instance.json`, or `EDVA_PUSH_HOST`), and route it to `http://localhost:9090` on the host — for example with a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) running as a launchd agent. The port serves:

- `POST /` — Gmail Pub/Sub pushes, accepted only with a valid Google-signed OIDC token (audience + service account checked in `agent/supervisor/oidc-verify.mjs`);
- `POST /email-inbound` — optional inbound mail from an email worker, authenticated with the shared secret in `secrets/email-inbound-secret`.

Nothing else is exposed; the webhook and health ports stay on `127.0.0.1`.

## 3. Pub/Sub topic + OIDC push subscription

```bash
bash agent/scripts/setup-pubsub.sh            # defaults: gcp_project, gmail-push.<domain>
bash agent/scripts/setup-pubsub.sh PROJECT_ID PUSH_HOST
```

Idempotent. It creates the `gmail-new-messages` topic, lets Gmail publish to it, creates a `edva-pubsub` service account and lets Pub/Sub mint OIDC tokens as it, creates or repoints the `gmail-push-sub` push subscription to `https://<push host>`, and writes the expected audience and service account to `secrets/pubsub-oidc.json`. Restart the ops supervisor afterwards (`./bin/edva restart ops`) so it reads the new config.

## 4. Start and keep the watch

```bash
node agent/scripts/setup-gmail-watch.mjs
```

Gmail watches expire after 7 days. Schedule the renewal daily (through `bin/cron-run`, see [`../installer.md`](../installer.md)):

```cron
0 6 * * * $EDVA_HOME/bin/cron-run --label renew-gmail-watch -- $EDVA_HOME/agent/scripts/renew-gmail-watch.sh
```

Each run records `data/gmail-watch-last.json`; `agent/scripts/watchdog.sh` alerts when a renewal failed or the watch is close to expiring, and checks the tunnel.

## 5. Verify

Send yourself an email. Within seconds `./bin/edva tail ops` shows the push being accepted and a triage dispatch. If nothing happens:

- `./bin/edva status` — is the ops supervisor up, with its Gmail port?
- `agent/logs/ops-supervisor.log` — a `401` on `/` means the OIDC audience or service account in `secrets/pubsub-oidc.json` does not match the subscription;
- GCP console → Pub/Sub → the subscription's delivery metrics for push errors.

## What happens to inbound mail

1. The ops supervisor's Gmail source (`agent/supervisor/gmail-source.mjs`) receives the push, deduplicates history ids and fetches the new messages.
2. Cheap code paths run first: the spam filter, the installation's optional intake hook (`agent/supervisor/_ext/gmail-intake.mjs`), local classification and the P1 stampers.
3. What still needs judgment is dispatched to the ops agent, which follows `agent/ops-agent/email-triage-rules.md` plus your additions in `agent/local/email-triage-rules.md`.
4. The result: labels from your label set (`agent/local/config/triage-labels.json`, template in `examples/local/config/`), stars and read state by priority, tasks or calendar holds where the rules say so, and a phone ping only for mail that needs you (`edva-send-curl`).

`./bin/edva triage status | recent | pending | pause | resume` inspects and controls the pipeline.

## Costs

- **Gmail API** — free within the daily quota.
- **Pub/Sub** — the first 10 GB/month are free; an inbox uses a tiny fraction.
- **Tunnel** — a Cloudflare Tunnel on the free plan is enough.
