# Edva — Browsing Skills

Central registry of browser actions used by Edva's cron jobs, hum, and ad-hoc agent work. Pattern lifted from the upstream public [browsing-skills/browsing-skills](https://github.com/browsing-skills/browsing-skills) project: one file per action, structured JSON output, validated and benchmark-able.

## Why

Before this registry, every cron that scraped a website had its own inline `page.evaluate(...)` block. When a site shipped a UI tweak — a composer change, a redesigned reservation slot picker, a moved form field — the same selector logic broke in 3–5 different playbooks. Maintenance burden was real and recovery time was hours.

Each action now lives in **exactly one file**. When a selector breaks, you update one file. All consumers pick up the fix automatically next run.

## Layout

```
browsing-skills/
├── SKILL.md            # umbrella — lists supported sites + routes agents
├── README.md           # this file
├── skills/             # edva-private skills (site-specific actions)
├── external/           # auto-synced from the configured fork of browsing-skills
├── fixtures/           # saved HTML + expected JSON for snapshot tests
└── tools/
    ├── parse-skill.js     # YAML frontmatter + ```js block parser
    ├── validate-skill.js  # schema/link/code validator
    ├── run-action.js      # CLI: run any skill action against a live URL
    └── skill-health.js    # daily cron: flag actions with rising error rates
```

## Daily workflow

The runtime sync is automatic. The host's crontab runs:

```cron
0 10 * * * $HOME/Dev/edva/bin/browsing-skills-sync >> $HOME/Dev/edva/data/logs/browsing-skills-sync.log 2>&1
0 23 * * * $HOME/Dev/edva/browsing-skills/tools/skill-health.js >> $HOME/Dev/edva/data/logs/skill-health.log 2>&1
```

- `browsing-skills-sync` pulls fresh upstream + fork content into `external/` (10am local).
- `skill-health` scans the previous 24h of cron output for skill-attributed errors and pings the user via hum if any single action has ≥3 consecutive failures (11pm local).

## Manual commands

```bash
# Validate the whole registry (run in pre-commit hook)
browsing-skills/tools/validate-skill.js

# Run a specific action one-shot — useful when authoring/debugging
browsing-skills/tools/run-action.js <site>/<action> --params '{...}'

# Run against a saved fixture (no live browser)
browsing-skills/tools/run-action.js <site>/<action> --fixture fixtures/<site>__<action>.test.html
```

## Writing a new skill

See the umbrella `SKILL.md` § "Adding a new skill" for the seven-step checklist. The shortest path:

1. Copy an existing site's `SKILL.md` + one `references/*.md` as a template.
2. Replace selectors, action name, returns shape.
3. `validate-skill.js` and `run-action.js --params '{}'` until it works.
4. Add a fixture, add to umbrella index, update architecture.md.

## Write actions

Every action that mutates external state (posts a comment, books a table, submits a form, casts a vote) MUST:

- Take explicit input for the target + payload (never infer from context).
- Verify the write succeeded via DOM observation, not button-click success.
- Return structured `{ ok: false, error: "<code>" }` on every known failure mode.
- Document a cooldown.

See `external/skills/reddit.com/references/submit-comment.md` for the reference implementation.

## See also

- Upstream: https://github.com/browsing-skills/browsing-skills
- Our fork (Reddit write actions): the fork repo configured in `bin/browsing-skills-sync`
- Architecture: `system/architecture.md` § "Browsing skills"
