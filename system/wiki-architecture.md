# Wiki — DB-as-truth long-term context memory

Authoritative reference for the wiki layer that holds the agent's long-term context (user profile, feedback rules, projects, references). Co-exists with the file-based auto-memory until the migration completes (see § Migration phases).

## What the wiki is

A queryable knowledge graph of ~98 markdown pages, stored as SQLite rows in `data/memory-index.db`. Each page is a memory in the existing sense (frontmatter + markdown body). The wiki:

- Treats each page as a row in `pages` with parsed frontmatter promoted to columns.
- Tracks the `[[wikilink]]` graph, supersession edges, and related-page edges in `page_links`.
- Archives every save in `page_revisions` so edit history is queryable.
- Renders pages back to disk for backwards compatibility — until the migration flips, the .md files Claude Code's auto-memory loads are derived from `pages.raw_md`.

This sits on top of the existing `memory_chunks` index (FTS5 + nomic-embed-text embeddings, used by the legacy `memory` CLI). The wiki layer is additive; nothing in `memory_chunks` / `file_meta` / `entities` was changed.

## Three-tier load

The agent reaches memory through three distinct surfaces, ordered by latency-vs-reach:

1. **Pinned subset + recent days — always loaded** (~10 pinned pages + 3 most recent `day_*` summaries, ~17 KB total).
   `pages.pinned = 1` flag drives a curated "always-on" slice. The `bin/wiki-session-context` script emits the bundle as `hookSpecificOutput.additionalContext`, wired into `~/.claude/settings.json` SessionStart hook. The bundle also appends a "Recent days" section — the last 3 `day_*` wiki pages summarized as `title + description + first 2 narrative paragraphs (~400 chars) + pointer to wiki_read for the full body`. That gives the agent "what did the user do yesterday / day before?" without any tool call. Default pins are configurable (typical set: a `user_*` profile page, a few `feedback_*` rules, key `project_*` pages). Adjust with `wiki pin <id>` / `wiki unpin <id>`. The recent-days set is keyed off `type=day` so it self-tunes as new days are ingested.

2. **Searchable pages — fetched on demand**. The MCP tools (in `agent/tools-mcp/index.mjs`) call `wiki-store` in-process — no per-call `node bin/wiki ...` fork — so each tool invocation is ~5 ms warm vs the previous ~55 ms:
   - `wiki_search(query, k=10, mode=fts|page, type?)` — paraphrase-tolerant retrieval. `fts` mode runs BM25 over `pages_fts` (title + description + body_md) with type-weighted ranking (`feedback`/`user`/`project` outrank `reference` at equal text match) and a small pinned-page boost; snippets come from FTS5's `snippet()` function so the result actually shows the matched span. `type` restricts to one page type — big speedup + cleaner results when the category is known. `page` mode is a LIKE on title/description.
   - `wiki_read(id)` — full body + outgoing/incoming links + frontmatter for one page.
   - `wiki_list({type, status, pinned})` — relational filter.
   - `wiki_backlinks(id)` — what links to <id>.

3. **Auto-pull on link** (manual today). When agent output references `[[page_id]]`, fetch via `wiki_read`. Future: a post-tool hook can prefetch automatically.

## Schema (in `data/memory-index.db`)

```sql
pages
  id              TEXT PK         -- "user_food_taste" (basename minus .md)
  basename        TEXT UNIQUE     -- "user_food_taste.md" (cross-table joins)
  type            TEXT            -- user|feedback|project|reference
  title           TEXT
  description     TEXT
  status          TEXT NOT NULL DEFAULT 'active'   -- active|superseded|resolved|historical
  pinned          INTEGER NOT NULL DEFAULT 0       -- 1 = SessionStart bundle includes this page
  scope_json      TEXT
  confidence      TEXT
  last_verified_at TEXT
  expires_at      TEXT
  raw_md          TEXT NOT NULL   -- full file body (frontmatter + body, byte-equal to disk)
  body_md         TEXT NOT NULL   -- body without frontmatter (derived)
  frontmatter_json TEXT NOT NULL  -- parsed frontmatter (all fields, even ones we don't promote)
  body_hash       TEXT NOT NULL   -- sha256(raw_md), drives skip-on-unchanged
  source_mtime    INTEGER
  created_at, updated_at TEXT

page_links
  src_id, dst_id TEXT
  link_type      TEXT NOT NULL   -- wikilink | supersedes | related
  display        TEXT            -- "[[target|display]]" alias
  section        TEXT NOT NULL DEFAULT ''
  PRIMARY KEY (src_id, dst_id, link_type, section)

page_revisions
  page_id  TEXT
  rev      INTEGER             -- monotonic per page
  raw_md   TEXT NOT NULL       -- full snapshot at save time
  edited_by TEXT               -- 'cli:edit' | 'cli:pin' | 'hum-answer' | ...
  edited_at TEXT
  PRIMARY KEY (page_id, rev)

pages_fts (FTS5 virtual table — internal-storage variant)
  page_id UNINDEXED, title, description, body_md
  -- Refreshed in-transaction by refreshFtsForPage() on every save / backfill,
  -- and by deleteFtsForPage() on delete. Self-contained — no dependency on
  -- memory_chunks or the file system.
```

Existing tables (`memory_chunks`, `memory_chunks_fts`, `file_meta`, `memory_links`, `supersession`, `chunk_entities`, `entities`) are untouched.

## Library + CLI

- **`lib/wiki-store.js`** — programmatic API. Public exports: `db()`, `closeDb()`, `splitFrontmatter()`, `parseFrontmatterText()`, `extractWikilinks()`, `basenameToId()`, `buildPageRow()`, `renderPage()`, `backfill()`, `getPage()`, `listPages()`, `recentlyUpdated()`, `listPageFiles()`, `renderAllToDir()`, `verify()`, `stats()`, `getForwardLinks()`, `getBacklinks()`, `searchPages()`, `savePage()`, `patchFrontmatter()`, `supersedePage()`, `setPinned()`, `deletePage()`, `getRevisions()`, `getRevision()`, `renderFrontmatter()`, `dbAuthoritative()`. Reuses `lib/yaml-mini.js` for frontmatter parsing.

- **`lib/wiki-serve.js`** — read-only HTTP browser at `0.0.0.0:9096`. Routes: `/` (dashboard — pinned + recently updated + hot-7d + browse-by-type chips), `/?type=<t>` (compact per-type listing; for types >50 with structured id-prefixes a sub-filter chip row appears), `/?type=<t>&prefix=<p>` (prefix-filtered listing), `/?pinned=1` (full pinned set with descriptions), `/p/<id>` (page view with backlinks + outgoing + revisions), `/search?q=…` (FTS), `/style.css`, `/favicon.{png,ico}`. Hot-pages section reads `data/wiki-access.jsonl` via `ws.readAccessLog`. The home dashboard exists because the prior "dump every active page" index was 200 KB / ~8 s render, which both made the page unscannable and tripped the watchdog's 3 s probe (see 2026-05-05 entry in `system/architecture.md`).

- **`bin/wiki`** — operator CLI:

  ```
  wiki backfill [--dry-run]                # ingest all .md → pages
  wiki verify [--json]                      # round-trip every row vs disk
  wiki list [--type T] [--status S] [--pinned]
  wiki read <id>                            # full page + links
  wiki render <id> [--to-disk]              # raw_md to stdout, or write to canonical file path
  wiki render-all <dir>                     # dump every page to <dir>/ (backup target)
  wiki stats
  wiki search "<q>" [--k N] [--mode fts|page] [--json]
  wiki links <id> [--json]                  # outgoing
  wiki backlinks <id> [--json]              # incoming
  wiki edit <id>                            # $EDITOR on raw_md, save on close (revisions tracked)
  wiki save <id> --body @<file|->          # programmatic save
  wiki pin <id> | unpin <id>                # toggle pinned-subset membership
  wiki pin-defaults [--dry-run]             # seed the curated 10-page default subset
  wiki supersede <old_id> <new_id>          # atomic: old → status=superseded, edge added
  wiki delete <id>                          # soft-delete (revision archived first)
  wiki history <id> [--json]                # revision list
  wiki show-rev <id> <rev>                  # print a specific revision
  wiki pinned [--ids]                       # render pinned subset
  ```

- **`bin/wiki-session-context`** — outputs the SessionStart hook payload (`hookSpecificOutput.additionalContext`) as JSON. Wired via `~/.claude/settings.json` → `hooks.SessionStart` (alongside the existing moshi-hooks entry, not replacing it).

## Write path semantics

All mutating CLI / library calls follow the same shape:

1. `BEGIN IMMEDIATE` SQL transaction.
2. Upsert into `pages` (recomputes `body_hash`, `frontmatter_json`, `body_md`).
3. Replace edges in `page_links` for this page.
4. If body changed (or page is new), append a row to `page_revisions` with monotonic `rev = max(rev) + 1`.
5. `COMMIT`.
6. If body changed AND not in `MEMORY_DB_AUTHORITATIVE` mode: render `raw_md` back to disk at the canonical path. (File render is **outside** the transaction so a transient FS error can't roll back the DB write.)

`MEMORY_DB_AUTHORITATIVE` env var controls the file-render side-effect (default flipped 2026-05-02 in step 5d):

| Value | Behavior |
|---|---|
| unset / `1` (default since 5d) | DB-only writes. The .md files are NOT touched on save. `wiki render-all <dir>` produces a fresh on-disk dump on demand (used by `memory-snapshot` cron before each git push). |
| `0` | Legacy mode: DB write + render file. Used only if a regression forces a fallback, or by the wiki-store unit tests that want to exercise the file-render path. |

## Backups

Today (transitional):
- The Claude-Code-managed `~/.claude/projects/<your-project-slug>/memory/.git` repo + 30-min `memory-snapshot` cron continue to push the .md files to private `${MERLIN_BACKUP_REPO}`. The project-slug is computed by Claude Code from your absolute `${MERLIN_HOME}` path. While files are still rendered from DB, they remain a valid backup target.
- Pre-reindex tarballs in `data/memory-snapshots/` (last 14) — unchanged, defense in depth.

End state (after step 4 — not yet flipped):
- **Primary:** `wiki snapshot` runs `VACUUM INTO` on memory-index.db, commits + pushes the binary to `${MERLIN_BACKUP_REPO}` every 30 min. Restore = `git pull` + replace.
- **Diff target:** `wiki render-all <dir>` writes every page to `pages-rendered/` for human-readable review and emergency markdown recovery. Same git push.

## Migration phases

1. **Step 1 — DONE 2026-05-02.** `pages` / `page_links` / `page_revisions` added; `wiki backfill` ingests the existing 98 .md files; `wiki verify` confirms 98/98 byte-equal round-trip.
2. **Step 2 — DONE 2026-05-02.** `wiki_search` / `wiki_read` / `wiki_list` / `wiki_backlinks` MCP tools shipped (in `agent/tools-mcp/index.mjs`).
3. **Step 3 — DONE 2026-05-02.** `wiki pin-defaults` pinned 10 pages; `wiki-session-context` SessionStart hook wired in `~/.claude/settings.json` alongside moshi-hooks.
4. **Step 4 — DONE 2026-05-02.** `autoMemoryEnabled: false` set in `Dev/merlin/.claude/settings.local.json` so Claude Code stops auto-loading the memory dir; the SessionStart hook is now the only memory injection at session start. **Self-contained FTS5** added: `pages_fts` virtual table + `refreshFtsForPage` / `deleteFtsForPage` helpers wired into save / delete / backfill so wiki saves are immediately searchable. `wiki_search` no longer depends on `memory_chunks` (the file-driven legacy index). End-to-end save → search → delete round-trip verified live. The .md files remain on disk as a backwards-compatible mirror of `pages.raw_md` (savePage default still renders to disk; opt out with `MEMORY_DB_AUTHORITATIVE=1`) so the existing `memory-snapshot` cron + `memory reindex` continue to work unchanged.
5. **Step 5 — DONE 2026-05-02.**
   - **(5a) DONE 2026-05-02.** `hum-answer` migrated to `wiki savePage`. Every routed answer now produces a `page_revisions` row tagged `edited_by=hum-answer`, FTS index refreshes in the same transaction (so the new line is searchable instantly), and the .md file is still rendered to disk by savePage's default mode (existing consumers like `memory reindex` and the file-based snapshot keep working). 4-case test in `tools/tests/hum-answer-wiki.test.mjs` covers create, append, revisions, and FTS freshness.
   - **(5b) DONE 2026-05-02.** Hourly DB snapshot via `bin/wiki-db-snapshot` (SQLite `VACUUM INTO` — hot-safe, no live-DB locking) into `data/memory-db-snapshots/`, rotated to last 24. Triggered by `agent/scripts/trigger-wiki-db-snapshot.sh` and registered in `system/tasks.json` as `wiki-db-snapshot` (cron `7 * * * *`). Restore = `cp data/memory-db-snapshots/memory-index-<ts>.db data/memory-index.db`. This is defense-in-depth alongside the existing file-based `memory-snapshot` 30-min cron — covers the failure mode where the DB itself goes bad (e.g. the FTS5 corruption transiently triggered earlier today during the schema experiment).
   - **(5c) DONE 2026-05-02.** `memory new` and `memory supersede` rewritten to route through `wiki-store.savePage()` / `wiki-store.supersedePage()`. External CLI surface unchanged; underneath, every `memory new` creates a `page_revisions` row tagged `edited_by=memory:new`, and `memory supersede` is now an atomic transaction with edge insertion + status flip. `pages_fts` refreshes in the same transaction so the new page is searchable instantly. Live test confirmed: `memory new reference test_memory_new_live` → rev 1 visible via `wiki history` → `wiki delete` cleans up.
   - **(5d) DONE 2026-05-02.** `dbAuthoritative()` default flipped: env unset → DB-only writes (no file render). `lib/merlin-context.js` (the only direct memory-file reader outside Claude Code itself) migrated to read from the wiki DB by deriving the page id from the file path. `bin/memory-snapshot` runs `wiki render-all <MEMORY_DIR>` before its `git status` check so the file backup repo continues to capture every page's current content even though saves no longer touch disk. Tests updated: existing tests opt back into legacy file-render mode with `MEMORY_DB_AUTHORITATIVE=0` (so they can still assert "file appeared on disk"); two new tests cover the new default (no file render with env unset) and the legacy opt-in (env=0). 30/30 wiki-store + 4/4 hum-answer-wiki + 44/44 memory-store all green.
   - **(5e) DONE 2026-05-02.** `memory-reindex` cron disabled (`schedule: null` in `system/tasks.json`; entry removed from the live crontab). `memory_chunks` is now frozen at its last reindex; `wiki_search` (using `pages_fts`, refreshed in-transaction by every save) is the canonical search path. The legacy `memory search` CLI still works against the frozen index but prints a deprecation hint to stderr pointing callers at `wiki search`. Tables (`memory_chunks`, `memory_chunks_fts`, `chunk_entities`, etc.) are kept in the DB for now — dropping them is a future cleanup once we're confident nothing depends on them.

6. **Step 6 — Recall speedup + travel-page hygiene — DONE 2026-05-03.** After the travel-* sync push grew the wiki to 552 pages (408 of them `travel_*`), recall quality and token cost regressed. Five changes:
   - **(6a) FTS ranking + snippet.** `searchPages` in `lib/wiki-store.js` ORDERs by `bm25 + per-type penalty − pinned bonus` (penalty: `reference` 1.5, `day` 0.5, `feedback`/`user`/`project` 0; pinned bonus 0.5) so user/feedback/project pages outrank verbose reference pages on near-equal text matches. Snippet uses FTS5's native `snippet(pages_fts, -1, '«', '»', '…', 24)` which returns the matched span with surrounding context.
   - **(6b) `type` filter on `wiki_search`.** Added a `type` arg to both the MCP tool and the CLI (`wiki search "<q>" --type feedback`). Lets the agent skip the 400+ travel reference pages when it knows the category. Plumbed through `searchPages({ type })` in wiki-store.
   - **(6c) In-process MCP wiki tools.** `agent/tools-mcp/index.mjs` now `require`s `wiki-store` directly via `createRequire` and calls `searchPages` / `getPage` / `listPages` / `getBacklinks` in-process. Previously every wiki_* MCP call spawned `node bin/wiki ...` (~55 ms cold). In-process is ~5 ms warm. `caller="mcp"` is now passed explicitly to `logAccess` (replaces the `WIKI_LOG_CALLER=mcp` env hack) so the nightly pin auditor's signal is unchanged.
   - **(6d) Travel-page sync hardening.** The travel-* sync tools (`travel-airbnb-sync`, `travel-place-mention-sync`, `travel-place-directory-sync`, `travel-airlines-sync`) had three classes of bug: (1) unguarded slug paths produced doubled-prefix zombie ids like `travel_airbnb_travel_airbnb_xxx_xxx` when a wikilink leaked into the parsed key; (2) `parsePlace` accepted `Title:` / `Location:` / `Display name:` prefixes when the leading regex didn't catch the whole line, generating "city" pages with names like `travel_city_brazil_title`; (3) `parsePlace` accepted dates ("Feb 10 - 22"), US state codes followed by date ranges, and postal codes as countries, producing `travel_country_2011_jan_3` and `travel_city_ca_aug_12_13_san_francisco`. Three guards added: `pageIdFor` in airbnb-sync throws on doubled-prefix ids; `isPlausiblePlace` in directory-sync rejects any token that's a digit, month abbrev, postal-code shape, or structural-prose stop ("title", "location", "display", "unknown", "tbd", etc.); `collectPlacesFromText` runs the same guard on existing wikilink displays so a stale bad link in a trip body can't reseed the directory. All four sync tools also stopped passing `renderToDisk: true` / `removeFile: true` — they now respect the post-step-5d DB-authoritative default, with `memory-snapshot` rendering to disk on its own cadence.
   - **(6e) One-shot cleanup of accumulated debt.** Two helper scripts under `/tmp/claude/` deleted **218 junk pages** (54 prose-name junk + 141 date/postal junk + zombie residue + 23 more across iterations) and unwrapped **236 dangling/nested wikilinks** in trip-page bodies. Final state: 534 pages (down from 552 zombies-included), **0 dangling links** (down from 95), 0 zombie pages, idempotent across re-runs of all sync tools. The pinned `travel` page itself was rewritten — it had 5 duplicate `Use [[travel_places]]` lines from a `updateTravelPage` marker-mismatch bug; the marker check is now `body_md.includes("[[travel_places]]")` instead of a different sentinel.

## Episodic memory (unified into the wiki, 2026-05-11)

The wiki is the single mechanism for both permanent memories (`user_*`, `feedback_*`, `project_*`, `reference_*`) and episodic memories (chronological "what happened on …" pages). Episodic memory used to live in a parallel store (`data/episodes/YYYY-MM/<date>.md` files, written by the nightly `episode-archive` job from `daily_summaries` in Supabase). As of 2026-05-11 the episode/week/month pages are first-class wiki pages — same `pages` table, same FTS5 index (`pages_fts`), same `[[wikilink]]` graph, same `page_revisions` history, same hourly `VACUUM INTO` snapshot.

**Types and id shapes:**

| `type` | Id shape | Source row | Writer |
|---|---|---|---|
| `day` | `day_YYYY-MM-DD` | `daily_summaries.narrative` (HTML) | `bin/wiki-day-write` |
| `week` | `week_YYYY-MM-DD` (Monday) | `weekly_summaries.narrative` (prose) | `bin/wiki-week-write` |
| `month` | `month_YYYY-MM` | `monthly_summaries.narrative` (HTML doc) | `bin/wiki-month-write` |

**Conversion pipeline:** `lib/episode-html-to-md.js` (if present) converts a styled HTML day-summary into clean markdown. Each save chains an in-process `wiki-linker.applySuggestions({id})` call so canonical concepts (people, places, projects) become real `[[wikilink]]` edges. The day page's `places`/`photos`/`wake_at`/`sleep_at` frontmatter is promoted to `pages` columns. Week + month pages append a `## Daily pages` / `## Weekly pages` link list so Mon–Sun and the month's weeks are one click away.

**Source of truth.** The wiki page is editable (`wiki edit day_2026-05-09`) and survives a re-ingest: `wiki-day-write` is skip-on-unchanged by body hash, so manual edits stick unless `--refresh` is passed explicitly. `daily_summaries.narrative` remains the upstream raw fact (like Apple Photos is upstream of the `photos` table) but no consumer reads it directly anymore — the agent and the HTTP browser both read from the wiki.

**Episode CLI** (`bin/episode`) is now a thin facade over the wiki: `episode <date>` reads the wiki page, `episode search` runs `pages_fts` scoped to `type=day` (same path `wiki_search` uses, identical hits), `episode write/refresh` calls `wiki-day-write` under the hood, `episode week-of` calls `wiki-week-write`, `episode month` calls `wiki-month-write`. The MCP tools (`episode_get`, `episode_search`, `episode_list`) inherit transparently because they shell out to the CLI.

**Files on disk** in `data/episodes/YYYY-MM/*.md` are now **legacy historical artifacts** — pre-unification HTML-bodied snapshots preserved in git history. They are NOT auto-regenerated; new ingest writes only to the wiki DB. The day/week/month pages are part of the regular `wiki render-all` output to `MEMORY_DIR` (as `day_YYYY-MM-DD.md` etc., flat), which the `memory-snapshot` cron pushes to `${MERLIN_BACKUP_REPO}` every 30 min — that's the only authoritative backup channel. Direct reads of the legacy `data/episodes/` files are deprecated — go through `episode` / `wiki` / `wiki_*` MCP tools.

**Search ranking.** `searchPages` already applies a `0.5` BM25 penalty to `type=day` (set in the 2026-05-03 step 6a) so the verbose narrative pages don't outrank user/feedback when text matches. `week` and `month` inherit the default-zero penalty for now — they're rare (4 weeks + 1 month at ingest time) and useful as direct hits.

**HTTP browser** (`:9096`). Top-nav adds `day` / `week` / `month` chips; the dashboard's "Browse by type" lists them after `project` and before `reference`. Day pages render with the wiki's standard markdown renderer — inline `![]()` images become a tile grid per the existing `p:has(> img + img)` CSS rule, so the page view has a built-in photo grid for days with multiple stops.

## Pin auditor (self-tuning subset)

The `pinned` column is no longer a static curation. As of 2026-05-02 the wiki self-tunes its always-loaded subset based on observed agent access:

- **Access log.** Every `wiki_search` / `wiki_read` / `wiki_backlinks` call appends one JSONL row to `data/wiki-access.jsonl` via `wiki-store.logAccess()`. CLI calls are tagged `caller=cli`; MCP-originated calls pass `caller="mcp"` explicitly (the in-process MCP refactor in step 6c retired the older `WIKI_LOG_CALLER=mcp` env-var path). The auditor only counts `caller=mcp` so ad-hoc CLI use doesn't pollute the signal.
- **Two new columns on `pages`:**
  - `pinned_at TEXT` — when the page was last pinned (NULL when unpinned). Set by `setPinned()`. Used to enforce the tenure rule before auto-unpin.
  - `pin_locked INTEGER NOT NULL DEFAULT 0` — when 1, the auditor will never auto-unpin this page regardless of access count. Used for identity / cross-cutting style pages whose value can't be measured by tool-call frequency (the SessionStart hook already injects them, so agents never explicitly fetch them, so they'd always show 0 hits).
- **Auditor `bin/wiki-audit`** runs nightly via cron (`30 3 * * *` — daily at 3:30 AM ET):
  - **Pin** any unpinned active page with `mcp` hits ≥ 5 in the last 7 days (PIN_THRESHOLD).
  - **Unpin** any pinned page where `pinned_at` is older than 7 days (TENURE_DAYS), `pin_locked = 0`, and the hit count is exactly 0.
  - **Skip** `pin_locked = 1` pages from auto-unpin entirely.
  - **Apply** changes via `wiki-store.setPinned()` (which writes a revision and refreshes FTS).
  - **Email** the owner a digest IF anything changed (silent on no-op nights). Subject format: `Wiki pin audit — N↑ M↓ (YYYY-MM-DD)`. HTML body lists pin/unpin moves with hit counts + titles, plus collapsible sections for stay-pinned / locked / too-fresh.
- **Pin locking:** the `pin_locked=1` column marks pages that the auto-pin-audit should never unpin (typical use: the owner's profile page, key feedback rules, daily-schedule). Unlocked pinned pages are candidates for auto-de-pinning if they don't get hit in a week.
- **CLI surface.** `wiki pin <id> [--lock]` to pin and optionally lock in one shot. `wiki lock-pin <id>` / `wiki unlock-pin <id>` to toggle the lock. `wiki-audit --dry-run` to preview without applying.

## Concept-link auditor (ongoing graph hygiene)

The wiki graph should stay useful as memories grow: when a page mentions a canonical concept (a recurring person, a project name, a place, a tool, etc.), the first meaningful mention should usually be a wikilink to that concept's page.

- **Lexicon:** `data/wiki-link-concepts.json` maps canonical page ids to safe aliases. Keep this curated and specific; avoid broad aliases like "hotel" or "Photos" that create weak edges.
- **Read-only review:** `wiki link-audit` (or `bin/wiki-link-audit`) reports plain-text concept mentions that are not linked yet. It exits non-zero when suggestions exist so it can be used in review jobs.
- **Safe apply:** `wiki link-audit --apply` links the first plain-text mention per concept per page. It skips code blocks, inline code, existing wikilinks, and normal markdown links, and it never links a page to itself.
- **New memory workflow:** after `wiki save`, `wiki edit`, `memory new`, or a routed `hum-answer` creates/updates a page, run `wiki link-audit --id <page_id>`. Apply safe suggestions, then manually review any awkward wording or ambiguous aliases before expanding the lexicon.
- **Periodic review:** run `wiki link-audit --json` from a scheduled review or nightly self-improvement pass. If suggestions remain, email/list them as review items rather than silently applying newly-added aliases until the lexicon has proven safe.

## Tests

`tools/tests/wiki-store.test.mjs` — 27 cases covering:
- frontmatter `splitFrontmatter` byte-equal round-trip on five fixture pages
- `extractWikilinks` for `[[target]]` and `[[target|display]]` (with .md normalization)
- `buildPageRow` column promotion for v2 frontmatter
- `backfill` ingests, skips MEMORY.md / _entities.yaml, is idempotent, reflects edits, and removes pages whose source file disappears
- `verify` reports 5/5 match on fixture
- forward + backward link resolution including `resolved=false` for dangling
- `savePage` create + revision; unchanged-body skip; body-change rev increment; old-rev recoverable
- `setPinned` flips the column AND persists in frontmatter; round-trip stays clean
- `supersedePage` flips old status, adds the edge, lists supersedes on new
- `deletePage` removes row + edges; revision survives
- `MEMORY_DB_AUTHORITATIVE=1` blocks file render
- `searchPages` page-mode LIKE
- `renderAllToDir` byte-equal dump
- `wiki-session-context` emits the right hook JSON shape (with and without pinned pages)

Existing `tools/tests/memory-store.test.mjs` (10/10) still green — the new schema is purely additive.

## Recovery cheatsheet

| Symptom | Action |
|---|---|
| A page's frontmatter looks reformatted but content is right | Expected after `wiki pin` / `wiki unpin` / any frontmatter mutation. The mini-YAML emitter normalizes formatting; verify still passes. |
| `wiki verify` reports `byte_diff` on a page | DB and disk diverged. `wiki render <id> --to-disk` writes the canonical (DB) version back, OR `wiki backfill` ingests the disk version into the DB — choose based on which side is correct. |
| Lost a page's history | `wiki history <id>` lists revisions; `wiki show-rev <id> <rev>` prints any prior raw_md. Restore via `wiki save <id> --body <( wiki show-rev <id> <rev> )`. |
| Memory dir deleted | `wiki render-all <dir>` rebuilds every page from the DB. The DB itself is the source of truth. If the DB is also gone, restore from `~/.claude/projects/.../memory/.git` (until step 4 retires that repo) or `data/memory-snapshots/`. |
| Hook is failing silently | Run `bin/wiki-session-context` directly — it never crashes (failure → empty `additionalContext`). Check `data/memory-index.db` exists and `wiki stats` works. |

## When to use which tool

- **Read** for a known page id → `wiki_read` (one query, full body + links).
- **Search** for a topic / paraphrased query → `wiki_search` (chunked FTS5; pages with multiple matching sections rank higher).
- **Browse** by structural axis ("all active feedback rules in scope X") → `wiki_list` with filters.
- **Discover impact** of changing a page → `wiki_backlinks` (who depends on this).
- **Author / edit** memory → `wiki edit <id>` for interactive, `wiki save <id> --body @<file>` for programmatic.
- **Replace an old rule** → `wiki supersede <old> <new>`. Atomic; the new page's frontmatter gains a `supersedes:` list and the old page's `status` flips to `superseded`.

The legacy `memory` CLI is unchanged and continues to work — it's the canonical retrieval path until step 4 finishes.
