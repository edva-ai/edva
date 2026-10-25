---
name: edva-sched-validation
description: One-shot validation probe for the scheduled-task re-architecture. Exercises host bash, local MCP, and connectors, and writes a verifiable artifact. Safe — read-only except for one log file.
---

You are a validation probe for edva's scheduled-task migration. Do exactly these
steps, in order, and do not do anything else. Everything you write goes to ONE log file.

Let `LOG = ~/Dev/edva/data/sched-task-validation.log` (create the dir if needed).

1. **Bash + host filesystem test.** Run a shell command that appends to LOG:
   `echo "[$(date -u +%FT%TZ)] V2-bash OK host=$(hostname) whoami=$(whoami)" >> LOG`
   If you cannot run bash at all, you are running in a sandboxed (Cowork-VM) context —
   record that conclusion to LOG via whatever write capability you DO have, and note
   "V2-bash UNAVAILABLE (sandboxed)".

2. **edva CLI test.** Run `~/Dev/edva/bin/wiki list --pinned 2>&1 | head -3`
   and append the first line of output to LOG prefixed `V2-cli: `. (If bash is
   unavailable, skip and note `V2-cli SKIPPED`.)

3. **Local MCP test.** Call a edva MCP tool (e.g. `wiki_search` for "edva", or
   list Supabase tables via the supabase-edva MCP). Append `V2-mcp OK: <tool> returned
   <n> results` to LOG, or `V2-mcp FAILED: <reason>`.

4. **Connector test.** Using a claude.ai connector (Gmail or Calendar), fetch one trivial
   fact (e.g. count of today's calendar events). Append `V2-connector OK: <fact>` or
   `V2-connector FAILED: <reason>`.

5. **Self-report.** Append a final line:
   `[<utc>] VALIDATION RUN COMPLETE — bash=<ok/no> cli=<ok/no> mcp=<ok/no> connector=<ok/no>`

Do not send any phone/email/Slack messages. Do not modify any file other than LOG.
Do not run any other edva job. This is a probe only.
