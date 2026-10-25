# Integration: Outbound email (SMTP)

`bin/email-send` is the agent's outbound mail tool. The shipped implementation talks to **SMTP2Go** — easy to swap to any other transactional SMTP provider (SendGrid, Postmark, Mailgun, Resend, etc.) since the API surface is similar.

This integration is needed for:

- Daily / weekly digest emails (morning-digest, weekly-summary, etc.)
- Email triage notifications (P1 alerts sent to a non-Gmail destination)
- Any custom job that ends in "send the user an email"

If you only want inbound triage + chat replies on the phone, you can skip this entirely.

## Option A — keep SMTP2Go (path of least resistance)

1. Sign up at [smtp2go.com](https://smtp2go.com). Free tier: 1,000 emails/month, plenty for personal use.
2. Verify the sending domain (or use their `smtp2go.com` subdomain initially).
3. Create an API key with **Send Email** permission.
4. Add the key to `.env`, and the addresses to `agent/local/instance.json` (`edva init` asks for them; `EDVA_AGENT_FROM_EMAIL` / `EDVA_OWNER_EMAIL` / `EDVA_DOMAIN` in `.env` override):
   ```
   # .env
   SMTP2GO_API_KEY=api-...
   ```
   ```json
   { "agent_email": "assistant@example.com", "owner_email": "someone@example.com", "domain": "example.com" }
   ```
   `agent_email` is the From: address; `owner_email` is where agent mail to you goes. `EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME` override the sender per process.
5. DNS records for your sending domain (in your registrar's DNS console):
   - SPF: `v=spf1 include:spf.smtp2go.com ~all`
   - DKIM + DMARC — SMTP2Go generates these in their console; copy into your DNS.
6. Test:
   ```bash
   "$EDVA_HOME/bin/email-send" \
     --to someone@example.com \
     --subject "Edva test" \
     --body "If you see this, outbound mail works."
   ```

If you get HTTP 200 + a UUID back, it's wired correctly. Without DKIM/DMARC, mail will land in Gmail's spam folder; add them before relying on it.

## Option B — swap to a different provider

The provider abstraction is one HTTP POST in `bin/email-send`. Look for the SMTP2Go endpoint reference and swap the request shape to your provider:

- **Postmark** — `https://api.postmarkapp.com/email`, header `X-Postmark-Server-Token`
- **Resend** — `https://api.resend.com/emails`, header `Authorization: Bearer re_...`
- **SendGrid** — `https://api.sendgrid.com/v3/mail/send`
- **Mailgun** — `https://api.mailgun.net/v3/<domain>/messages`
- **Amazon SES** — use the AWS SDK or `aws-sdk-v3-sesv2`; more setup but cheapest at scale

The contract `email-send` exposes upstream is just:

```
email-send --to <to> --subject <subj> [--body <text> | --body-file <path>] [--html] [--from <addr>] [--from-name <name>] [--reply-to <addr>] [--inline path:cid ...]
```

…so as long as the script reads those args and POSTs to your provider, the playbooks calling it don't change. Take an hour, swap the provider, you're done.

## Option C — use Gmail directly (on-behalf-of)

If you want some emails sent FROM the user's actual Gmail (not from a Edva sender), that's a separate path — see the `gmail-action send --from <your address> ...` pattern in `agent/CLAUDE.md` § Outbound Email Policy. Requires the same Gmail OAuth flow as inbound triage (`docs/integrations/gmail.md`). Strict rule: only used when the user explicitly asks the agent to email a third party as themselves.

## House style

`email-send` itself applies no style gate; style rules for agent-written mail live in the agent rules (`agent/CLAUDE.md` § Outbound Email Policy) and in your own `agent/local/` rules. Mail the agent sends to your own address is auto-labeled on arrival so triage does not treat it as new inbound mail.

## Receipts / bounce handling

The shipped `email-send` is fire-and-forget — POST → ignore the response body. For a production setup you'd want:

- Webhook for bounces/complaints (SMTP2Go and most providers offer this)
- A `data/email-sent-log.jsonl` that records every send attempt with the provider's message-id
- An ops-agent job that periodically reconciles bounces and pauses sending to addresses that hard-bounce

None of that ships. The minimum for personal use (you're the only recipient, you'd notice bounces in your inbox) is fine without it.

## Cost

- SMTP2Go free tier: 1,000 emails/month — covers any single-user agent
- Resend free tier: 100 emails/day, 3,000/month — fine, lower limit
- Postmark: paid only ($15/month for 10K)
- SES: $0.10 per 1,000 sent — cheapest at scale, more setup

For an agent that sends ~5 emails/day (morning digest + occasional notifications), any free tier is overkill.
