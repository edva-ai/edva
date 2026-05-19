# Writing a job

A **job** in Merlin is a markdown playbook the agent reads + executes when its trigger fires. Two pieces:

1. **A playbook** — `agent/ops-agent/jobs/<job>.md`. Plain markdown, freeform.
2. **A trigger** — typically a bash script at `agent/scripts/trigger-<job>.sh` that POSTs to the supervisor webhook on a cron schedule, plus an entry in `system/tasks.json` so `merlin tasks` knows about it.

The supervisor reads the playbook at dispatch time. **You can edit the playbook live**; the next firing picks up your edits with no agent restart needed. That's the whole point.

## The minimal job

Make a new playbook at `agent/ops-agent/jobs/headlines.md`:

```markdown
# Headlines

Fetch 3 top stories from a major news source and email them to the user.

## Steps

1. Use WebSearch with the query `top news today`. Pick the 3 most consequential items.

2. Build an HTML body:
   ```html
   <h2>Today's headlines</h2>
   <ul>
     <li><b>$TITLE</b> — $ONE_LINE_SUMMARY · <a href="$URL">link</a></li>
     <li>…</li>
   </ul>
   ```
   For each URL, render it through `${MERLIN_HOME}/bin/og-card "$URL"` if you've installed that helper; otherwise inline the link.

3. Ship it:
   ```bash
   ${MERLIN_HOME}/bin/email-send \
     --to "${MERLIN_OWNER_EMAIL}" \
     --subject "Headlines · $(date '+%Y-%m-%d')" \
     --body-file /tmp/headlines.html \
     --html
   ```

4. Notify with a one-line pointer:
   ```bash
   ${MERLIN_HOME}/bin/merlin-send-curl "headlines emailed — 3 stories"
   ```

5. Reply briefly: "Headlines emailed."
```

That's it. The agent sees this as its instructions for the turn.

## Register a trigger

Add to `system/tasks.json`:

```json
{
  "name": "headlines",
  "schedule": "0 9 * * *",
  "schedule_human": "Daily at 9:00 AM",
  "trigger_script": "agent/scripts/trigger-headlines.sh",
  "webhook_url": "http://localhost:9092",
  "webhook_task": "HEADLINES",
  "ops_playbook_section": "Headlines",
  "delivers_to": "email",
  "phrases": ["headlines", "today's news"],
  "description": "3 top news stories of the day, delivered as email.",
  "job": "headlines"
}
```

And the trigger script at `agent/scripts/trigger-headlines.sh`:

```bash
#!/usr/bin/env bash
: "${MERLIN_HOME:=${HOME}/Dev/merlin}"
TOKEN=$(cat "${MERLIN_HOME}/secrets/webhook-token")
curl -s -X POST http://localhost:9092 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task":"HEADLINES — follow the Headlines playbook","source":"cron"}'
```

Then either:

- Add it to crontab: `0 9 * * * $HOME/Dev/merlin/agent/scripts/trigger-headlines.sh`
- Test it ad-hoc: `./bin/merlin dispatch headlines`

## Anatomy of a good playbook

The agent reads your playbook as its FIRST user-turn instructions. Things that work well:

**Lead with the goal.** One sentence at the top: what is this job for? If the agent gets stuck mid-execution, this is what they re-orient against.

**Concrete steps.** "Step 1: do X. Step 2: do Y." Not "the agent should also remember to…". The agent reads in order and acts in order.

**Show commands literally.** Use code fences with the actual shell command. `${MERLIN_HOME}/bin/email-send --to ${MERLIN_OWNER_EMAIL} …` — the agent will run that verbatim.

**Be explicit about delivery.** "Email the user", "Push a phone-channel ping", "Just log and exit silently" — make the output channel and shape clear.

**Capture exit conditions.** "If WebSearch returns zero useful items, skip the email and ping the user with `no headlines today`."

**Reference shared rules by location.** Don't re-state outbound-email rules; say "follow Outbound Email Policy in `agent/ops-agent/CLAUDE.md`." The CLAUDE.md files are read by the supervisor when the session starts and stay in the agent's context.

**Don't be precious about wording.** This isn't a prompt-injection robust prompt — it's instructions for the agent you control. Write the way you'd write a Notion doc telling a junior engineer how to do a thing.

## Reference jobs (read these to learn the patterns)

| Job | What it teaches |
|---|---|
| `agent/ops-agent/jobs/morning-digest.md` | Long-form delivery rule: email + phone pointer + APNs push. Multi-section HTML composition. Tool routing. |
| `agent/ops-agent/jobs/hum.md` | The 4-step pipeline (situation → harvest → rank → execute), JSON output format for a sub-LLM judge, hard-rules + quiet windows. |
| `agent/ops-agent/jobs/hum-review.md` | Read-only analysis job. Proposes tuning, never applies it. Pattern for any "self-review" job. |
| `agent/ops-agent/jobs/hum-canary.md` | Eval-style canary: writes a structured pending file, waits for the user's reply, classifies it. |

## Tips that took us a while to learn

- **`ultrathink` at the top of a playbook works** — increases thinking-token budget for that turn. Use sparingly; most jobs don't need it.
- **`/effort` lines in a playbook DO NOT work** — `--effort` is a `claude -p` CLI flag, set at spawn time. To change effort for a per-job sub-call, write a sub-script that invokes `claude -p --effort low` directly (see `agent/scripts/hum-harvesters/_common.mjs` for the pattern).
- **`${MERLIN_HOME}` is always set in the child env** — `process-manager.mjs` loads `.env` before spawning supervisors, and `agents.json` declares which env vars propagate.
- **Outbound to the user phone-channel auto-routes through `outbound-precheck.mjs`** — a Sonnet `--effort low` reasoner sees the last 90 min of chat + active calendar and decides `send|suppress|modify`. Pass `--skip-precheck` ONLY for infrastructure-liveness alerts (process crashed, etc). See `agent/CLAUDE.md § Outbound Precheck`.
- **Never put tool commands directly in crontab on macOS.** AppleScript-based tools fail silently outside the user GUI session. Always go through the webhook (see `trigger-<job>.sh` pattern above).

## When something breaks

Most playbook bugs surface as the agent doing something close-but-wrong on the next firing. Workflow:

1. `./bin/merlin tail ops` — find the dispatch turn for your job; read what the agent did.
2. Edit the playbook. Save.
3. `./bin/merlin dispatch <job>` — re-fire ad-hoc and watch again.

No restart needed for playbook edits. Restart is only needed for changes to `agent/config/agents.json`, `agent/supervisor/*.mjs`, or anything in `CLAUDE.md`.
