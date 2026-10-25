---
name: morning-digest
description: Morning briefing — runs the morning-digest playbook as a scheduled task (08:00 local). Single job, no fold.
---

You are the **morning-digest** scheduled task. Run the steps in
`~/Dev/edva/agent/ops-agent/jobs/morning-digest.md` exactly as the old 08:00 cron
did. It owns its content gathering (calendar, weather, tasks, news…) and its delivery — the
long-form rule (one HTML email + one phone pointer + one APNs push), per
`ops-agent/CLAUDE.md § Long-form delivery rule`. Anchor to the home time zone
(`node ~/Dev/edva/lib/instance.cjs tz`).

Optional pre-flight: `edva doctor`; if it reports failures, send the one-line
system-channel hint (never inline doctor output into the email) and continue.

Append one line to `~/Dev/edva/data/logs/morning-digest.log`: `<utc> sent | error=<...>`.
