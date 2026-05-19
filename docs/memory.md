# Memory — going from empty to useful

Merlin's memory layer is the substrate the agents reach for to answer "what do I know about X?" Two stores, both backed by SQLite, both empty on first run:

- **Wiki pages** — first-class long-term context. User profile, feedback rules, projects, references, day/week/month rollups. The canonical surface for "facts and preferences the agent should know." Lives in `data/memory-index.db` table `pages`.
- **Auto-memory chunks** — Claude Code's built-in per-project memory (`.claude/projects/<slug>/memory/*.md`). Smaller chunks, FTS5 + embeddings, used by the legacy `memory search` CLI.

The two coexist during the migration to DB-as-truth. New work should land in the wiki (`wiki edit / save / pin`). Read [`system/wiki-architecture.md`](../system/wiki-architecture.md) for the deep design.

## Ground state

Right after `merlin init`:

| Surface | State |
|---|---|
| `data/memory-index.db` | doesn't exist; auto-created on first `wiki save` or `memory reindex` |
| `~/.claude/projects/<slug>/memory/` | doesn't exist; Claude Code creates it on first auto-memory write |
| Wiki pages | zero |
| Pinned subset | empty (the SessionStart hook emits a 0-page bundle) |
| Auto-memory chunks | zero |
| Suggestion history | empty (gets populated as hum surfaces things) |

The agent has no long-term context until you write some.

## What to seed first

If you want the agent to be useful on day 1, write a handful of pages. The minimum surface that makes a difference:

### 1. A `user_owner.md` page — who you are

The closest thing to a "system identity" for the agent. What name to use for you, your timezone, your work hours, your communication style preferences (terse vs. verbose, technical vs. plain language, format conventions). 50–200 lines is plenty.

```bash
./bin/wiki edit user_owner
# Your editor opens. Write the page. Save + exit.
./bin/wiki pin user_owner   # so it lands in every session's initial context
```

Suggested frontmatter:

```yaml
---
type: user
title: <Your name>
description: Owner profile — name, location, work pattern, preferences.
status: active
pinned: true
pin_locked: true
---
```

### 2. A `user_daily_schedule.md` page — when you're available

Affects hum's quiet windows, the calendar harvester's "is this event during work hours" classification, the morning-digest's section ordering. Keep it short — a few bullet points per day-of-week pattern.

### 3. A `feedback_*` page per durable preference

Things you've decided you want the agent to honor without explaining each time. Examples:

- `feedback_no_em_dashes.md` — agent-originated text avoids em/en dashes (it's an LLM tell).
- `feedback_short_replies.md` — keep phone-channel replies to ≤3 sentences unless asked otherwise.
- `feedback_explain_then_act.md` — for non-trivial actions, lead with one line on what you're about to do, then do it.

Frontmatter:

```yaml
---
type: feedback
title: <short rule statement>
description: <why this exists — usually a past incident or strong preference>
status: active
pinned: true
---
```

The wiki layer's pinned subset is what's injected into the agent's context at session start. Feedback rules are the highest-leverage thing to pin.

### 4. Per-project `project_*.md` pages

For anything you'll iterate on with the agent over weeks. Goals, current state, what's stuck, what's done. Saves you re-explaining context every time.

### 5. `reference_*.md` pages for stable facts

People (`reference_contact_alice.md`), places (`reference_office_floor_plan.md`), tools you use (`reference_my_dev_setup.md`), domain knowledge worth saving once. These don't get pinned — they're fetched on demand via `wiki_search`.

## The four memory tools

The agent reaches memory via four MCP tools defined in `agent/tools-mcp/index.mjs`:

```
wiki_search(query, k=10, mode=fts|page, type?)   paraphrase-tolerant FTS
wiki_read(id)                                     full body + outgoing/incoming links
wiki_list(type?, pinned?)                         browse by type or pinned flag
wiki_backlinks(id)                                which pages link here
```

The CLI surface mirrors these (`wiki search/read/list/backlinks`) plus authoring:

```
wiki edit <id>           # open in $EDITOR
wiki save <id> < body    # write from stdin
wiki pin <id>            # mark for always-on-load
wiki unpin <id>
wiki supersede <new-id> <old-id>   # link supersession edge
wiki delete <id>
wiki history <id>        # revision log
```

## Frontmatter conventions

The agent treats these frontmatter fields as load-bearing:

| Field | Purpose |
|---|---|
| `type` | One of `user`, `feedback`, `project`, `reference`, `day`, `week`, `month`. Drives ranking + filtering. |
| `title` | Display title. Falls back to the page id if missing. |
| `description` | One-line summary shown in search results. |
| `status` | `active` (default), `superseded`, `resolved`, `historical`. Non-active de-ranks. |
| `pinned` | `true` puts the page in the always-loaded subset. |
| `pin_locked` | `true` prevents the auto-pin-audit from unpinning. |
| `supersedes` | Array of page ids this replaces. Old pages are silently dropped from results when this is also retrieved. |
| `related` | Array of cross-references. |
| `last_verified_at` | YYYY-MM-DD. Drives staleness flags. |
| `expires_at` | YYYY-MM-DD. Auto-archives. |
| `confidence` | `authoritative` / `corroborating` / `weak`. Affects ranking. |
| `scope` | Array of entity ids that constrain the page. Empty = global. |

Wikilinks: write `[[other-page-id]]` in the body. The auto-linker promotes them to graph edges on save; `wiki backlinks <id>` queries the reverse direction.

## The pinned subset

A SessionStart hook runs `bin/wiki-session-context` and injects the pinned subset as `additionalContext` into every fresh Claude Code session. Default config: ~10 pinned pages + the 3 most recent `type=day` pages.

The wiki-audit job (daily 3:30 AM) self-tunes this:

- Promotes any page hit ≥ 5 times in the last 7 days
- Demotes pinned-and-idle pages with 0 hits over 7 days (unless `pin_locked: true`)

You don't have to curate the pinned set by hand — write content, hit it via search, and the audit will pin what you actually use.

## Where memory writes come from

In normal operation:

- **You author directly** via `wiki edit`.
- **The agent writes** when you ask it to remember something (`"remember that I prefer terse replies"` → agent calls `wiki_save` on a `feedback_*` page).
- **Jobs write** — `hum-answer` writes to `hum-learnings.jsonl` AND can route to a wiki page; `daily-summary` produces a `day_YYYY-MM-DD` page each night.
- **The memory-write precheck** (`bin/memory-write-precheck.mjs`) sits in front of agent-initiated writes; it searches existing memory for direct contradictions before letting the write land. Fail-open: if the precheck breaks, writes proceed. See `bin/memory-write-precheck.mjs` for the contract.

## Backup

The auto-memory dir is a git repo. The `memory-snapshot` job (every 30 min) auto-commits + pushes to a private backup repo:

```
MERLIN_BACKUP_REPO=git@github.com:<your-user>/merlin-personal-backup.git
```

Set this in `.env` once. The remote needs to exist (private repo, you create it). Without it, snapshotting silently skips the push and you have local-only backups under `data/memory-snapshots/`.

The wiki DB (`data/memory-index.db`) has its own hourly hot-snapshot via `wiki-db-snapshot` job — rotates to 24 in `data/memory-db-snapshots/`. Defense in depth against FTS5 corruption.

## Smoke test

After seeding a couple pages:

```bash
./bin/wiki list                                  # see what's there
./bin/wiki search "owner"                        # FTS test
./bin/wiki read user_owner                       # full read
./bin/wiki backlinks user_owner                  # what links here

# verify the agent sees the pinned subset
./bin/wiki-session-context | head -50            # the same bundle the SessionStart hook emits
```

If `wiki search` returns no results when you know a page exists, the FTS index might be out of sync. Force a rebuild:

```bash
./bin/memory reindex
```

This re-tokenizes everything from disk + re-embeds with `nomic-embed-text`. Takes a few seconds for a small corpus, a few minutes once you have ~100 pages.

## Going further

Read [`system/wiki-architecture.md`](../system/wiki-architecture.md) for the DB schema, the entity/scope system (`_entities.yaml`), the supersession graph, and the migration phases. The architecture doc has more depth than this quickstart.

For the legacy `memory` CLI (chunk-level FTS + embeddings, used by older jobs during the wiki migration): `./bin/memory --help`. The two systems coexist; new work goes to the wiki, old jobs eventually get migrated.
