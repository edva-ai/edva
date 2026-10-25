# Writing a job

A **job** in Edva is a markdown playbook the agent reads and executes when its trigger fires. Three pieces:

1. **A playbook** — Markdown, freeform. The kernel's live in `agent/ops-agent/jobs/<job>.md`; yours go in `agent/ops-agent/jobs/_ext/<job>.md` (gitignored, kept in your overlay repo).
2. **A registration** — an entry in `agent/local/tasks.json` (schedule, how it is triggered, what it delivers) and, to pick its model tier, one in `agent/local/job-routing.json`. `lib/registry.cjs` merges both with the kernel's `system/tasks.json` / `agent/config/job-routing.json`, so `edva tasks`, `edva doctor` and the router see one list.
3. **A trigger** — usually a cron line that dispatches the job to the supervisor webhook.

The supervisor reads the playbook at dispatch time, so **edits take effect on the next run** with no restart.

## The minimal job

Create `agent/ops-agent/jobs/_ext/weekly-report.md`:

```markdown
# Weekly report

Summarize last week for the user: the meetings they had, the tasks they closed, anything still overdue. Deliver it as one email.

## Steps

1. Read last week's calendar (Monday–Sunday, the user's time zone) and the tasks closed in that window.
2. Build a short HTML body: three sections (Meetings, Done, Still open), one line per item, no more than 15 lines in total.
3. Send it to the user:
   ```bash
   ~/Dev/edva/bin/email-send --to "$(node ~/Dev/edva/lib/instance.cjs owner_email)" \
     --subject "Week of $(date -v-7d '+%b %-d')" --body-file /tmp/weekly-report.html --html
   ```
4. Reply with one line: "Weekly report emailed."

If there is nothing in any section, send nothing and reply "Quiet week — no report."
```

That is the agent's whole instruction for the turn. `node lib/instance.cjs <key>` prints an identity value from `agent/local/instance.json`, so a playbook never hard-codes your address.

## Register and schedule it

`agent/local/tasks.json` (template: `examples/local/tasks.example.json`):

```json
{
  "tasks": [
    {
      "name": "weekly-report",
      "schedule": "30 8 * * 1",
      "schedule_human": "Mondays 08:30",
      "trigger_script": null,
      "webhook_url": "http://localhost:9082",
      "webhook_task": "WEEKLY REPORT",
      "job": "weekly-report",
      "delivers_to": "email",
      "phrases": ["weekly report"],
      "description": "Last week's meetings, closed tasks and overdue items, by email."
    }
  ]
}
```

`agent/local/job-routing.json` — which supervisor tier runs it (`haiku` → ops-haiku, `sonnet` → ops-light, `opus` → ops):

```json
{ "jobs": { "weekly-report": { "disposition": "scheduled", "model": "sonnet", "effort": "low", "rationale": "Summarization over a week of calendar and tasks." } } }
```

Then add the cron line (the crontab header with `PATH` and `EDVA_HOME` is in [`installer.md`](installer.md)):

```cron
30 8 * * 1 $EDVA_HOME/bin/cron-run --label weekly-report -- $EDVA_HOME/bin/edva dispatch weekly-report
```

`edva dispatch` posts `{"job": "weekly-report"}` to the job's tier, degrading to a higher tier when that one is down. Test it any time by hand:

```bash
./bin/edva dispatch weekly-report
./bin/edva tail ops-light
```

A trigger that needs logic first (a queue check, a pause file) is a small shell script that sources `agent/scripts/lib/webhook-auth.sh` and calls `dispatch_or_skip '{"job": "<job>"}' <job>` — the kernel's own `agent/scripts/trigger-*.sh` follow that pattern. Keep yours in your overlay repo; `agent/scripts/` is kernel territory.

## Extending a kernel job instead

To change what a kernel job does for you, don't edit its playbook: write `agent/local/jobs/<job>.md`. The supervisor appends it to the kernel playbook on every dispatch (`http-server.mjs`), and the same file is honoured by the launchers that run jobs as ephemeral `claude -p` forks (`agent/scripts/lib/local-rules.sh`). Template: `examples/local/jobs/morning-digest.example.md`. Standing rules that apply to every job belong in `agent/local/ops.md` or `shared.md`.

## Anatomy of a good playbook

**Lead with the goal.** One sentence: what is this job for? It is what the agent re-orients against when stuck.

**Concrete steps.** "1. do X. 2. do Y." The agent reads and acts in order.

**Show commands literally,** in code fences, with full paths under the installation (`~/Dev/edva/bin/...`) — the agent runs them as written.

**Say how it delivers.** Email, a phone ping (`bin/edva-send-curl`), or silence — and what to do when there is nothing worth delivering.

**Point at shared rules instead of restating them.** "Follow the Outbound Email Policy in `agent/CLAUDE.md`." The CLAUDE.md files and your local rules are already in the agent's context.

## Reference jobs

| Job | What it teaches |
|---|---|
| `agent/ops-agent/jobs/morning-digest.md` | Long-form delivery: email + phone pointer; multi-section composition. |
| `agent/ops-agent/jobs/hum.md` | The awareness pipeline (situation → harvest → rank → deliver) with a structured judgment step and quiet windows. |
| `agent/ops-agent/jobs/hum-review.md` | Read-only analysis that proposes tuning and never applies it — the pattern for any self-review job. |
| `agent/ops-agent/jobs/nightly-review.md` + `improvement-plan.md` | A weekly self-assessment that runs as an ephemeral Opus fork (`agent/scripts/lib/run-ephemeral-opus.sh`) and chains a follow-up job. |
| `agent/ops-agent/jobs/email-inbound.md` | Handling an inbound event dispatched by code, with an allowlist (`agent/local/config/email-inbound.json`). |

## Tips

- **Effort is set at spawn time**, not in a playbook: the tier's supervisor config (`agent/config/agents.json`) or the `claude -p --effort` of a sub-script decides it.
- **Messages to the user's phone pass the outbound precheck** (`bin/outbound-precheck.mjs`), which reads the recent conversation and calendar and may suppress or rewrite a ping. Only infrastructure-liveness alerts skip it.
- **Don't run GUI-dependent tools straight from cron on macOS** (AppleScript, Notes, Messages fail outside the GUI session) — dispatch to the supervisor, which runs in it.
- **Keep personal values out of the playbook.** Names, addresses and accounts come from `agent/local/instance.json`, `agent/local/config/*.json` and your local rules, so the playbook stays shareable.

## When something breaks

1. `./bin/edva tail <tier>` — find the dispatch and read what the agent did.
2. Edit the playbook (or its `agent/local/jobs/` companion). Save.
3. `./bin/edva dispatch <job>` — run it again.

Restarts are only needed for changes to `agent/config/agents.json`, the supervisor code, or the kernel `CLAUDE.md` files (`./bin/edva restart ops`).
