# Wiki — DB-as-truth long-term context memory

Authoritative reference for the wiki layer that holds the user's long-term context (user profile, feedback rules, projects, references). Status: live as of 2026-05-02. Co-exists with the file-based auto-memory until the migration completes (see § Migration phases).

## What the wiki is

A queryable knowledge graph of ~98 markdown pages, stored as SQLite rows in `data/memory-index.db`. Each page is a memory in the existing sense (frontmatter + markdown body). The wiki:

- Treats each page as a row in `pages` with parsed frontmatter promoted to columns.
- Tracks the `[[wikilink]]` graph, supersession edges, and related-page edges in `page_links`.
- Archives every save in `page_revisions` so edit history is queryable.
- Renders pages back to disk for backwards compatibility — until the migration flips, the .md files Claude Code's auto-memory loads are derived from `pages.raw_md`.

This sits on top of the existing `memory_chunks` index (FTS5 + nomic-embed-text embeddings, used by the legacy `memory` CLI). The wiki layer is additive; nothing in `memory_chunks` / `file_meta` / `entities` was changed.

## Three-tier load

The agent reaches memory through three distinct surfaces, ordered by latency-vs-reach:

1. **Session-start bundle — bounded, mostly on-demand** (`bin/wiki-session-context`, emitted as `hookSpecificOutput.additionalContext`, wired into `~/.claude/settings.json` SessionStart hook). **Push→pull rebalance (2026-07-19):** the bundle no longer injects the full body of every pinned page — that "push" cost grew with the pinned set and forced the compaction treadmill as the corpus scaled. It now has four parts, and only the first is full-body:
   - **Identity core (full body).** Pages the pin auditor `pin_locked`'d — who the user is, their routine, where they live, the load-bearing feedback rules. Genuinely needed every turn. The default locked set is the user's identity pages plus a routine page, a home page and a few load-bearing `feedback_*` pages (the installation keeps its own list locally).
   - **Pinned menu (one line each).** Pages the auditor auto-pinned by access frequency (`pinned=1, pin_locked=0`, e.g. `user_preferences`, `user_reading_list`, `project_<name>`) render as `title + description + `wiki_read <id>` pointer` — NOT full bodies. The agent pulls the body on demand (cheap + accurate now that hybrid recall exists). Menu size is O(titles), not O(bodies).
   - **Recent days.** The last 3 `day_*` wiki pages summarized as `title + description + first 2 narrative paragraphs (~400 chars) + wiki_read pointer` (unchanged, added 2026-05-11). Keyed off `type=day` so it self-tunes.
   - **Memory map (constant).** Active page counts by type + the recall affordances (`wiki_search` hybrid, `wiki_read`, `recall_events`, `episode_search`). This footer is what keeps a 100× corpus reachable without injecting more.

   Net effect: the always-on footprint is bounded by the (fixed) locked core + an O(titles) menu + a constant map — it stops scaling with the corpus, which is what takes the pressure off consolidation/compaction. Guard: if nothing is `pin_locked` (fresh/misconfigured DB) or `WIKI_SESSION_FULL_PINNED=1`, every pinned page stays full-body so the core is never silently stripped. Adjust the set with `wiki pin <id> [--lock]` / `wiki unpin <id>`.

2. **Searchable pages — fetched on demand**. The MCP tools (in `agent/tools-mcp/index.mjs`) call `wiki-store` in-process — no per-call `node bin/wiki ...` fork — so each tool invocation is ~5 ms warm vs the previous ~55 ms:
   - `wiki_search(query, k=10, mode=fts|hybrid|page, type?)` — paraphrase-tolerant retrieval. `fts` mode runs BM25 over `pages_fts` (title + description + body_md) with type-weighted ranking (`feedback`/`user`/`project` outrank `reference` at equal text match) and a small pinned-page boost; snippets come from FTS5's `snippet()` function so the result actually shows the matched span. `hybrid` mode additionally fuses a semantic KNN ranking with the BM25 one via RRF — see § Semantic + hybrid recall below. `type` restricts to one page type — big speedup + cleaner results when the category is known. `page` mode is a LIKE on title/description.
   - `wiki_read(id)` — full body + outgoing/incoming links + frontmatter for one page.
   - `wiki_list({type, status, pinned})` — relational filter.
   - `wiki_backlinks(id)` — what links to <id>.

3. **Auto-pull on link → associative recall.** *During retrieval*: the 2026-08-09 one-hop expansion (hub-cut, cosine-floored, forward-only) measured zero gain and was **retired 2026-10-24** for fan-normalized spreading activation / personalized PageRank over the whole association graph (wikilinks both ways, related/supersedes, typed facts, co-retrieval weights, day contiguity) — see § Associative recall. It is a third fused list in `wiki_search` hybrid behind `WIKI_ASSOC=sa|ppr` (default **off** until the associative eval has run on the live corpus), always on in the dedicated `wiki_associate` tool and in `episode_search associate:true`. *In agent output*, still manual: when a reply references `[[page_id]]`, fetch via `wiki_read`.

## Schema (in `data/memory-index.db`)

```sql
pages
  id              TEXT PK         -- "user_preferences" (basename minus .md)
  basename        TEXT UNIQUE     -- "user_preferences.md" (cross-table joins)
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

- **`bin/wiki-session-context`** — outputs the SessionStart hook payload (`hookSpecificOutput.additionalContext`) as JSON. Wired via `~/.claude/settings.json` → `hooks.SessionStart` (alongside any existing SessionStart hooks, not replacing them).

## Write path semantics

All mutating CLI / library calls follow the same shape:

0. `savePage` refuses a body copied from the `wiki read` view (2026-10-24): one carrying the view's `=== <id> (<basename>) ===` header block or its `=== links ===` footer, or one with no frontmatter for a page that has some. Save the bytes from `wiki render <id>` instead.
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

Three layers, only one of which leaves the host:

- **Off-box — Supabase mirror (2026-10-04).** `bin/wiki-cloud-sync push` (cron `wiki-cloud-sync`, every 5 min) mirrors `pages` / `page_links` / `page_revisions` into `wiki_pages` / `wiki_page_links` / `wiki_page_revisions` in the edva Supabase project (migration `data/migrations/20261004_wiki_cloud.sql`; RLS on, service-role only). Pages+links diff by a `row_hash` over every mirrored column plus the page's outgoing links, so pin/status/link-only changes sync too; revisions are append-only past a rowid cursor in `data/wiki-cloud-sync.json`. Stateless, so a failed run heals next tick; 3 straight failures page via `edva-notify --channel system`. Push refuses to delete cloud rows if the local DB has under half the cloud's pages. `wiki-cloud-sync verify` compares counts + hashes. Embeddings / cues are NOT mirrored — they're derived; `wiki-embed` rebuilds them. `wiki_pages.search` is a weighted tsvector and `wiki_search(q, lim)` is the ranked-search RPC the wiki site's Worker uses. `wiki_config.share_scopes` mirrors `data/wiki-share-scopes.json`.
- **Same disk — hourly DB snapshot.** `wiki-db-snapshot` (`VACUUM INTO`, last 24) under `data/memory-db-snapshots/`. Fast rollback from corruption; useless if the disk dies.
- **Markdown render → GitHub.** `memory-snapshot` (30 min) runs `wiki render-all` and pushes the `.md` dir to a private memory repo (the installation's own, named in its local notes). Current pages only, no revision history.

## Web access — the wiki site (and who sees what)

- **Hostname:** `<wiki hostname>`, behind Cloudflare Access (Google sign-in). The origin ALSO verifies the `Cf-Access-Jwt-Assertion` itself (signature, aud, iss, exp) — Access is a second lock, never the only one. The installation's hostname and Access team are kept in its local notes.
- **Who sees what:** `data/wiki-share-scopes.json` (`WIKI_SHARE_SCOPES_FILE` overrides — tests point it at a synthetic config), default deny, applied by the pure `lib/wiki-scope.js` (`scopeFromConfig`). The owner is unrestricted; every other identity gets a list of allowed areas. `"inherits"` (one level) lets an identity reuse another's rules. `email_qa` / `email_deny_ids` govern what the installation's email Q&A tool may draw on by email (what the site shows them minus password/code pages). Out-of-scope pages render as 404 and are filtered from listings, search, outgoing links and backlinks. Adding a person = an entry here AND the email on the Access application's policy (Access rejects anyone not on it before the origin runs). Who has which scope, and the Access app/policy names, are kept in the installation's local notes.
- **Two origins, one renderer.** `lib/wiki-render.js` (Markdown, shell, CSS — no Node deps) is shared by:
  - the host: `wiki serve --port 9097` (`WIKI_PUBLIC=1`, `lib/wiki-access.js`) behind the Cloudflare tunnel — the FALLBACK origin since 2026-10-04 (it only receives traffic if the Worker route is removed); `:9096` is the unauthenticated Tailscale/LAN instance;
  - the cloud — **the live origin since 2026-10-04**: Cloudflare Worker `edva-wiki` (`wiki-worker/`) reading the Supabase mirror (§ Backups) + `wiki_config.share_scopes`, which `wiki-cloud-sync` pushes whenever the scopes file changes. Read-only; no access-log "hot pages". Data lag ≤5 min. Secrets: `SUPABASE_SERVICE_ROLE_KEY`, `CF_ACCESS_AUD` (`wrangler secret put`). `wiki-worker/wrangler.toml` is a template with placeholder route and `[vars]`; the installation's filled-in copy is `agent/local/wiki-worker/wrangler.toml` (its `main` points back at `wiki-worker/src/index.js`), so every `wrangler` command takes `--config ../agent/local/wiki-worker/wrangler.toml` from `wiki-worker/`. Cutover = set both secrets, then `wrangler deploy`: `wrangler.toml` carries a `<wiki hostname>/*` **route** (not a custom domain — the tunnel CNAME stays as the DNS record, the Worker just answers before it). Rollback = delete the route; traffic falls back to the tunnel.

### The website (redesigned 2026-10-24)

The wiki site's search should go through the model and the memory retrieval mechanism rather than a string search, and the home page should be a well-curated portal that allows easy navigation by topic.

- **One design, two origins.** `lib/wiki-render.js` holds the design system (tokens for light and dark, Apple-native type: New York for titles and the system sans for reading, so nothing is fetched from a font host) and the page shell; `lib/wiki-portal.js` (pure, no Node deps) builds every view — portal, topic shelf, timeline, listings, reading view, search page — from page rows, so the host and the Worker render identical pages. <!-- kernel-guard-ok: "New York" is Apple's serif typeface -->
- **Home = a portal.** An ask box as the front door; **curated topics** as cards (name, blurb, page count, pages to start from); **Days remembered**, a strip per month with one cell per calendar day, filled and linked where a day page exists (`/timeline` has every month); "Always in mind" (pinned) and "Recently changed" in a side rail. Topic shelves live at `/t/<slug>`, grouped by type and, for large groups, by id prefix.
- **Topics are curated by a model**, because deciding what a page is about is language (Rule #0b). `bin/wiki-portal build` has Sonnet (tool-less, Max-only) read every non-episodic page's id/type/title/description and design 6–12 topics with blurbs, membership (ids, or id prefixes for uniform families) and featured pages; `wiki-portal.js checkPortalConfig` validates it (real ids, live prefixes, featured inside its topic, ≥85% of pages covered, ≤10% made-up ids) before `data/wiki-portal.json` is written. Re-curated weekly (or when the page count moves >10%) from the nightly `run-wiki-assoc-llm.sh`; the local rung is skipped because the input is several times gemma3:1b's context. Without the file, topics fall back to page types. `wiki-cloud-sync` pushes it to the Worker as `wiki_config.portal`.
- **Search goes through memory and a model.** `/search` runs Edva's own retrieval — `searchPagesHybrid` (BM25 + local embeddings + cue anchors + whatever association/trigger/fact tiers are on) fused by RRF with day-page FTS (not `searchDaysAssociative`: on the 2026-10-24 live eval, context reinstatement lost 3 of 14 episodic hits, hit@10 79% → 57%) — then lists the pages with *how* each was found (words, meaning, connected via a page) and an **"Also connected"** list from `associatePages` over the top hits. The **answer panel** loads `/api/ask`: Sonnet reads the top 10 in-scope pages (title, description, 1,400-char excerpt) and answers in one to four sentences with `[n]` citations; the text is escaped and only markers naming a real source become links. A fresh tool-less `claude -p` per question, **never the shared warm child**, so a scoped viewer's answer is never written in a context that has seen pages outside their scope. Cached 15 min per viewer+question, 30 questions per viewer per 10 minutes. While Max is unavailable (the fork reports `not_logged_in` or `usage_limit`) the answer, like portal curation, facts and trigger cues, goes to the same Sonnet on the Anthropic API under a $25/month breaker (`lib/api-fallback.mjs`; the one Auth Model carve-out, `docs/agent-auth-model.md` § The wiki's API fallback); the `/api/ask` JSON then carries `via: "api"`. Reading views load **"Connected in memory"** from `/api/related` (association over the graph).
- **The Worker passes `/search` and `/api/*` through to the host** (`fetch(req)` from a route Worker goes to the zone's origin: the tunnel to `wiki serve :9097`, which re-verifies the Access JWT and applies the viewer's scope itself). If the host does not answer, `/search` falls back to the mirror's full-text search with a plain notice and no answer panel; `/api/*` returns 503 and the panels stay hidden.
- **Scope**: every builder receives rows already filtered to the viewer; topics with nothing visible disappear; topic blurbs are shown only in the owner's full view (they are written for the owner and may mention pages outside a shared scope).
- **Deploying**: the host picks up `wiki-serve.js` when `stale-code-watch` restarts `wiki-server`/`wiki-server-public`; the Worker needs `wrangler deploy --config ../agent/local/wiki-worker/wrangler.toml` from `wiki-worker/`.
- Tests: `tests/wiki-portal.test.mjs` (curated/structural topics, scoped view, config validation, the day strip, answer escaping and citations, every route, memory search, and that a scoped viewer's model prompt holds only their pages).

## Migration phases

1. **Step 1 — DONE 2026-05-02.** `pages` / `page_links` / `page_revisions` added; `wiki backfill` ingests the existing 98 .md files; `wiki verify` confirms 98/98 byte-equal round-trip.
2. **Step 2 — DONE 2026-05-02.** `wiki_search` / `wiki_read` / `wiki_list` / `wiki_backlinks` MCP tools shipped (in `agent/tools-mcp/index.mjs`).
3. **Step 3 — DONE 2026-05-02.** `wiki pin-defaults` pinned 10 pages; `wiki-session-context` SessionStart hook wired in `~/.claude/settings.json` alongside the existing SessionStart hooks.
4. **Step 4 — DONE 2026-05-02.** `autoMemoryEnabled: false` set in `Dev/edva/.claude/settings.local.json` so Claude Code stops auto-loading the memory dir; the SessionStart hook is now the only memory injection at session start. **Self-contained FTS5** added: `pages_fts` virtual table + `refreshFtsForPage` / `deleteFtsForPage` helpers wired into save / delete / backfill so wiki saves are immediately searchable. `wiki_search` no longer depends on `memory_chunks` (the file-driven legacy index). End-to-end save → search → delete round-trip verified live. The .md files remain on disk as a backwards-compatible mirror of `pages.raw_md` (savePage default still renders to disk; opt out with `MEMORY_DB_AUTHORITATIVE=1`) so the existing `memory-snapshot` cron + `memory reindex` continue to work unchanged.
5. **Step 5 — DONE 2026-05-02.**
   - **(5a) DONE 2026-05-02.** `hum-answer` migrated to `wiki savePage`. Every routed answer now produces a `page_revisions` row tagged `edited_by=hum-answer`, FTS index refreshes in the same transaction (so the new line is searchable instantly), and the .md file is still rendered to disk by savePage's default mode (existing consumers like `memory reindex` and the file-based snapshot keep working). 4-case test in `tests/hum-answer-wiki.test.mjs` covers create, append, revisions, and FTS freshness.
   - **(5b) DONE 2026-05-02.** Hourly DB snapshot via `bin/wiki-db-snapshot` (SQLite `VACUUM INTO` — hot-safe, no live-DB locking) into `data/memory-db-snapshots/`, rotated to last 24. Triggered by `agent/scripts/trigger-wiki-db-snapshot.sh` and registered in `system/tasks.json` as `wiki-db-snapshot` (cron `7 * * * *`). Restore = `cp data/memory-db-snapshots/memory-index-<ts>.db data/memory-index.db`. This is defense-in-depth alongside the existing file-based `memory-snapshot` 30-min cron — covers the failure mode where the DB itself goes bad (e.g. the FTS5 corruption transiently triggered earlier today during the schema experiment).
   - **(5c) DONE 2026-05-02.** `memory new` and `memory supersede` rewritten to route through `wiki-store.savePage()` / `wiki-store.supersedePage()`. External CLI surface unchanged; underneath, every `memory new` creates a `page_revisions` row tagged `edited_by=memory:new`, and `memory supersede` is now an atomic transaction with edge insertion + status flip. `pages_fts` refreshes in the same transaction so the new page is searchable instantly. Live test confirmed: `memory new reference test_memory_new_live` → rev 1 visible via `wiki history` → `wiki delete` cleans up.
   - **(5d) DONE 2026-05-02.** `dbAuthoritative()` default flipped: env unset → DB-only writes (no file render). `lib/edva-context.js` (the only direct memory-file reader outside Claude Code itself) migrated to read from the wiki DB by deriving the page id from the file path. `bin/memory-snapshot` runs `wiki render-all <MEMORY_DIR>` before its `git status` check so the file backup repo continues to capture every page's current content even though saves no longer touch disk. Tests updated: existing tests opt back into legacy file-render mode with `MEMORY_DB_AUTHORITATIVE=0` (so they can still assert "file appeared on disk"); two new tests cover the new default (no file render with env unset) and the legacy opt-in (env=0). 30/30 wiki-store + 4/4 hum-answer-wiki + 44/44 memory-store all green.
   - **(5e) DONE 2026-05-02.** `memory-reindex` cron disabled (`schedule: null` in `system/tasks.json`; entry removed from the live crontab). `memory_chunks` is now frozen at its last reindex; `wiki_search` (using `pages_fts`, refreshed in-transaction by every save) is the canonical search path. The legacy `memory search` CLI still works against the frozen index but prints a deprecation hint to stderr pointing callers at `wiki search`. Tables (`memory_chunks`, `memory_chunks_fts`, `chunk_entities`, etc.) are kept in the DB for now — dropping them is a future cleanup once we're confident nothing depends on them.

6. **Step 6 — Recall speedup + synced-page hygiene — DONE 2026-05-03.** After the instance's page-sync tools grew the wiki to several hundred pages (most of them one family of synced reference pages), recall quality and token cost regressed. Five changes:
   - **(6a) FTS ranking + snippet.** `searchPages` in `lib/wiki-store.js` now ORDERs by `bm25 + per-type penalty − pinned bonus` (penalty: `reference` 1.5, `day` 0.5, `feedback`/`user`/`project` 0; pinned bonus 0.5) so user/feedback/project pages outrank verbose reference pages on near-equal text matches. Snippet was a 200-char head-of-body slice; now uses FTS5's native `snippet(pages_fts, -1, '«', '»', '…', 24)` which returns the matched span with surrounding context. Same query latency, far better signal — confirmed on a "<person> preferences" probe (the preference pages now top, previously index pages).
   - **(6b) `type` filter on `wiki_search`.** Added a `type` arg to both the MCP tool and the CLI (`wiki search "<q>" --type feedback`). Lets the agent skip the hundreds of synced reference pages when it knows the category. Plumbed through `searchPages({ type })` in wiki-store.
   - **(6c) In-process MCP wiki tools.** `agent/tools-mcp/index.mjs` now `require`s `wiki-store` directly via `createRequire` and calls `searchPages` / `getPage` / `listPages` / `getBacklinks` in-process. Previously every wiki_* MCP call spawned `node bin/wiki ...` (~55 ms cold). In-process is ~5 ms warm. `caller="mcp"` is now passed explicitly to `logAccess` (replaces the `WIKI_LOG_CALLER=mcp` env hack) so the nightly pin auditor's signal is unchanged.
   - **(6d) Synced-page hardening.** The instance's page-sync tools had three classes of bug: (1) unguarded slug paths produced doubled-prefix zombie ids like `<prefix>_<prefix>_<slug>` when a wikilink leaked into the parsed key; (2) the place parser accepted `Title:` / `Location:` / `Display name:` prefixes when the leading regex didn't catch the whole line, generating place pages with ids like `<prefix>_<place>_title`; (3) the parser accepted dates ("Feb 10 - 22"), region codes followed by date ranges, and postal codes as places, producing ids like `<prefix>_<year>_<mon>_<day>`. Three guards added: the page-id builder throws on doubled-prefix ids; `isPlausiblePlace` rejects any token that's a digit, month abbrev, postal-code shape, or structural-prose stop ("title", "location", "display", "unknown", "tbd", etc.); `collectPlacesFromText` runs the same guard on existing wikilink displays so a stale bad link in a page body can't reseed the directory. All the sync tools also stopped passing `renderToDisk: true` / `removeFile: true` — they now respect the post-step-5d DB-authoritative default, with `memory-snapshot` rendering to disk on its own cadence.
   - **(6e) One-shot cleanup of accumulated debt.** Two helper scripts under `/tmp/claude/` deleted **218 junk pages** (54 prose-name junk + 141 date/postal junk + zombie residue + 23 more across iterations) and unwrapped **236 dangling/nested wikilinks** in synced page bodies. Final state: **0 dangling links** (down from 95), 0 zombie pages, idempotent across re-runs of all sync tools. The pinned hub page for that family was rewritten — it had 5 duplicate copies of its directory link from a marker-mismatch bug; the marker check now looks for the link itself instead of a different sentinel.

## Episodic memory (unified into the wiki, 2026-05-11)

The wiki is the single mechanism for both permanent memories (`user_*`, `feedback_*`, `project_*`, `reference_*`) and episodic memories (chronological "what happened on …" pages). Episodic memory used to live in a parallel store (`data/episodes/YYYY-MM/<date>.md` files, written by the nightly `episode-archive` job from `daily_summaries` in Supabase). As of 2026-05-11 the episode/week/month pages are first-class wiki pages — same `pages` table, same FTS5 index (`pages_fts`), same `[[wikilink]]` graph, same `page_revisions` history, same hourly `VACUUM INTO` snapshot.

**Types and id shapes:**

| `type` | Id shape | Source row | Writer |
|---|---|---|---|
| `day` | `day_YYYY-MM-DD` | `daily_summaries.narrative` (HTML) | `bin/wiki-day-write` |
| `week` | `week_YYYY-MM-DD` (Monday) | `weekly_summaries.narrative` (prose) | `bin/wiki-week-write` |
| `month` | `month_YYYY-MM` | `monthly_summaries.narrative` (HTML doc) | `bin/wiki-month-write` |

**Conversion pipeline:** `lib/episode-html-to-md.js` converts the styled HTML narrative (visit cards, inline images, lists, the full-document `<!DOCTYPE html>` wrapper the monthly job emits) to clean markdown. Body shape after conversion: a paragraph subtitle, alternating muted travel-narration italics and `### HH:MM–HH:MM · **Place** · duration` visit headings, inline `![](thumb_url)` images, and bottom `## Day's other anchors` / `## Events not matched to a location` / `## Corrections & follow-ups` sections. Each save chains an in-process `wiki-linker.applySuggestions({id})` call so canonical concepts (people, pets, places, trips) become real edges. The day page's `places`/`photos`/`wake_at`/`sleep_at` frontmatter is promoted to `pages` columns. Week + month pages append a `## Daily pages` / `## Weekly pages` link list so Mon–Sun and the month's weeks are one click away.

**Source of truth.** The wiki page is editable (`wiki edit day_<YYYY-MM-DD>`) and survives a re-ingest: `wiki-day-write` is skip-on-unchanged by body hash, so manual edits stick unless `--refresh` is passed explicitly. `daily_summaries.narrative` remains the upstream raw fact (like Apple Photos is upstream of the `photos` table) but no consumer reads it directly anymore — the agent and the HTTP browser both read from the wiki.

**Episode CLI** (`bin/episode`) is now a thin facade over the wiki: `episode <date>` reads the wiki page, `episode search` runs `pages_fts` scoped to `type=day` (same path `wiki_search` uses, identical hits), `episode write/refresh` calls `wiki-day-write` under the hood, `episode week-of` calls `wiki-week-write`, `episode month` calls `wiki-month-write`. The MCP tools (`episode_get`, `episode_search`, `episode_list`) inherit transparently because they shell out to the CLI.

**Files on disk** in `data/episodes/YYYY-MM/*.md` are now **legacy historical artifacts** — pre-unification HTML-bodied snapshots preserved in git history. They are NOT auto-regenerated; new ingest writes only to the wiki DB. The day/week/month pages are part of the regular `wiki render-all` output to `MEMORY_DIR` (as `day_YYYY-MM-DD.md` etc., flat), which the `memory-snapshot` cron pushes to the private personal-memory repo every 30 min — that's the only authoritative backup channel. Direct reads of the legacy `data/episodes/` files are deprecated — go through `episode` / `wiki` / `wiki_*` MCP tools.

**Search ranking.** `searchPages` already applies a `0.5` BM25 penalty to `type=day` (set in the 2026-05-03 step 6a) so the verbose narrative pages don't outrank user/feedback when text matches. `week` and `month` inherit the default-zero penalty for now — they're rare (4 weeks + 1 month at ingest time) and useful as direct hits.

**HTTP browser** (`:9096`). Top-nav adds `day` / `week` / `month` chips; the dashboard's "Browse by type" lists them after `project` and before `reference`. Day pages render with the wiki's standard markdown renderer — inline `![]()` images become a tile grid per the existing `p:has(> img + img)` CSS rule, so the page view has a built-in photo grid for days with multiple stops.

## Pin auditor (self-tuning subset)

The `pinned` column is no longer a static curation. As of 2026-05-02 the wiki self-tunes its always-loaded subset based on observed agent access:

- **Access log.** Every `wiki_search` / `wiki_read` / `wiki_backlinks` call appends one JSONL row to `data/wiki-access.jsonl` via `wiki-store.logAccess()`. CLI calls are tagged `caller=cli`; MCP-originated calls pass `caller="mcp"` explicitly (the in-process MCP refactor in step 6c retired the older `WIKI_LOG_CALLER=mcp` env-var path). The auditor only counts `caller=mcp` so ad-hoc CLI use doesn't pollute the signal.
- **Two new columns on `pages`:**
  - `pinned_at TEXT` — when the page was last pinned (NULL when unpinned). Set by `setPinned()`. Used to enforce the tenure rule before auto-unpin.
  - `pin_locked INTEGER NOT NULL DEFAULT 0` — when 1, the auditor will never auto-unpin this page regardless of access count. Used for identity / cross-cutting style pages whose value can't be measured by tool-call frequency (the SessionStart hook already injects them, so agents never explicitly fetch them, so they'd always show 0 hits).
- **Auditor `bin/wiki-audit`** runs nightly via cron (`30 3 * * *` — daily at 3:30 AM local time):
  - **Pin** any unpinned active page with `mcp` hits ≥ 5 in the last 7 days (PIN_THRESHOLD).
  - **Unpin** any pinned page where `pinned_at` is older than 7 days (TENURE_DAYS), `pin_locked = 0`, and the hit count is exactly 0.
  - **Skip** `pin_locked = 1` pages from auto-unpin entirely.
  - **Apply** changes via `wiki-store.setPinned()` (which writes a revision and refreshes FTS).
  - **Log** the moves to the app's Improvements channel IF anything changed (silent on no-op nights): one low-risk, `applied` (green-check) row via `self-improve-feed-log`, summary `Wiki pinned set retuned: N pinned, M unpinned`, rationale listing each page id with its hit count. No email (retired — handled like other improvements, automatically via the Improvements channel). Full still-pinned / locked / too-fresh lists remain available from `wiki-audit --dry-run`.
- **Initial state (2026-05-02):** 7 of the 10 currently-pinned pages were `pin_locked=1`'d (the identity core above). The other 3 (taste/preference and project pages) are unlocked — they're candidates for auto-de-pinning if they don't get hit in a week.
- **CLI surface.** `wiki pin <id> [--lock]` to pin and optionally lock in one shot. `wiki lock-pin <id>` / `wiki unlock-pin <id>` to toggle the lock. `wiki-audit --dry-run` to preview without applying.

## Concept-link auditor (ongoing graph hygiene)

The wiki graph should stay useful as memories grow: when a page mentions a canonical concept (a person, a project, a place, a tool such as "Chrome DevTools", etc.), the first meaningful mention should usually be a wikilink to that concept's page.

- **Lexicon:** `data/wiki-link-concepts.json` maps canonical page ids to safe aliases. Keep this curated and specific; avoid broad aliases like "hotel" or "Photos" that create weak edges.
- **Read-only review:** `wiki link-audit` (or `bin/wiki-link-audit`) reports plain-text concept mentions that are not linked yet. It exits non-zero when suggestions exist so it can be used in review jobs.
- **Safe apply:** `wiki link-audit --apply` links the first plain-text mention per concept per page. It skips code blocks, inline code, existing wikilinks, and normal markdown links, and it never links a page to itself.
- **New memory workflow:** after `wiki save`, `wiki edit`, `memory new`, or a routed `hum-answer` creates/updates a page, run `wiki link-audit --id <page_id>`. Apply safe suggestions, then manually review any awkward wording or ambiguous aliases before expanding the lexicon.
- **Periodic review:** the nightly `wiki-link-audit` cron (`agent/scripts/trigger-wiki-link-audit.sh`, 3:45 AM local time) runs `wiki-link-audit --apply --json` and auto-applies — at the user's explicit instruction after reviewing a manual-apply digest. New concepts added to the lexicon still start conservative — spot-check with a manual `wiki link-audit --id <page_id>` (read-only, no `--apply`) before trusting a newly-added alias to the nightly auto-apply pass, since a bad alias would now link unattended instead of surfacing for review first.
- **Silent.** The job auto-applies but no longer emails a "what I linked" report — the user turned the notification off entirely. Controlled by `data/wiki-link-audit-config.json` (`{"silent": true, ...}`, read via `jq` in the trigger script); when absent or `silent: false`, the job falls back to its original behavior of emailing a report only on nights something changed. Applied changes are still fully recoverable via `wiki history <page_id>` regardless of the silent flag — only the email notification is suppressed, not the audit trail.

- **Ambiguous aliases (2026-10-23).** A concept entry may carry `ambiguous_aliases`: names that might mean this concept or something else (a first name shared by two relatives that is also an English word). The nightly linker never auto-links them, and an alias two concepts both claim is demoted to ambiguous on both (`loadConcepts`), so a collision can't be settled by list order. Those mentions are linked from context by `wiki-link-weave` (below).

## People pages (2026-10-23)

**Every person the user knows has their own page** (content builds over time). A person page is an active page with `entity: person` in its frontmatter, id `user_<first>_<last>`, with a qualifier when two people share a name, and a "Not to be confused with" line on both pages. A **hub** (`entity: people-hub`: e.g. `user_family`, `user_colleagues`, couple pages) is a directory: one line per person, linking to their page, plus shared events. Thin person pages are intended. Consolidation never merges or retires one for being thin.

- **`bin/wiki-people`** (`lib/wiki-people.js`) is the graph geometry: `audit` (one-way person↔person links, person pages missing from the concept map, alias collisions, pages nothing links to), `concept-add` (idempotent concept-map upsert, `--ambiguous` for model-only names) and `retarget` (exact `[[from|Display]]` → `[[to|Display]]` rewrites when someone gets their own page). It never decides who a mention means.
- **`wiki-link-weave`** (weekly, Mondays 03:01, `jobs/wiki-link-weave.md`) does the reading. It splits people out of hubs (≤15 a run; facts are moved, never dropped), grows the concept map, links relational phrases ("<name>'s sons") and ambiguous first names in this week's changed pages plus a rotating eighth of the wiki, makes relations two-way, and links or flags orphans. It sends one short chat message when something changed.
- **`people-email`** (nightly, 02:56, `jobs/people-email.md`) creates and updates person pages from Gmail correspondence (below), newest correspondence first, and (Part B, since 2026-10-27) adds a `## Texts` block from iMessage and WhatsApp for people who already have a page. It emails the user a per-run summary of who was covered and what was learned.
- **`people-watch`** (`jobs/people-watch.md`, nightly 03:05 research + hourly 09–21 answers and drafts; `bin/people-watch`, `lib/people-watch.js`, `data/people-watch.db`) keeps relationships alive, **always asked first, one person at a time**. Code reads the contact dates the email and texts ledgers hold (dates only, no text), measures each person's rhythm between active months, and finds who is slipping away (quiet for 3× their usual gap, bounded 60–365 days, within 5 years) and who is overdue the nudge cadence the user chose. Its questions are hum decision cards (`lib/decision-queue.mjs` source `people`, its own daily slot, more when the question backlog is long) with code-owned options whose exact pick takes effect in code; an answer in the user's words is read by the turn. For people the user follows (and, asked singly, the people they work with: pages whose `scope` is in `people-watch.json` `work_scopes`), the turn researches LinkedIn (search snippets only, never a login), X and the news monthly, records a snapshot only when the profile agrees with the page's anchors, and writes a `## Background` block between `<!-- people-watch:start/end -->` markers: a code-written facts line (current role, links to the Google Contacts card and the profiles, the research date) and a short public-background summary. Code diffs snapshots: a new company or role, a move or a newly announced life event becomes a question ("Want to reach out?"), and "Draft a note I could send" gets a draft in chat. It never contacts anyone, and never records health, family matters beyond a person's own announcement, or contact details.
- **Relations are typed (2026-10-26).** Every person page carries a `## Relations` section of one line per related person: `<rel> [[their_page|Name]] — <plain words>`, where `<rel>` is a fact token (`REL_VOCAB` in `lib/wiki-facts.mjs`: `child_of`, `parent_of`, `spouse_of`, `partner_of`, `sibling_of`, `friend_of`, `works_with`, …). The nightly fact extractor reads these lines into `page_facts` (typed edges that `wiki_associate` follows and `wiki_read` lists under `=== facts ===`); the token spelled out is what keeps that exact. Stated evidence only (a shared surname or thread is not a relation), the person's own page rather than a hub, and the inverse line on the other page (`wiki-link-weave` Step 4 catches the ones a writer missed). Procedure: `jobs/people-email.md` Step 3.
- **Writers** (`chat-consolidate`, `hum-consolidate`, the dream) put a fact about one person on that person's page, not on a hub, and create the page when it is missing.
- **An installation's own writers** (a meeting call log, for instance) add one dated line per contact to the page of each participant a model matched to an existing person page, inside their own marked block (text outside the markers is never touched). They never create a page; a participant they could not match stays unlinked.
- **People met in person.** The nightly dream (`jobs/dream.md` Step 4.6) goes through everyone the user or their household spent time with that day (stop companions, photo people, calendar names, the user's chat), children included, gives each one a page if they have none, and adds a dated meeting line. Unknown surnames get a provisional id (a child takes the parent's recorded surname, an in-law a describing id such as `user_<first>_husband_of_<first>_<last>`) and an `## Open` line.

## Email correspondence ledger (2026-10-23)

The user asked for people context built from email: what they communicated with each person about and when, kept current automatically as new mail arrives.

- **`data/email-people.db`** (gitignored) holds a header-only ledger: From/To/Cc, date, subject, a ≤280-char snippet and a list flag, for every thread the user wrote in plus threads the user's qualified correspondents started. Bodies are never fetched. Written only by **`bin/email-people`** (`lib/email-people.js`).
- **Who qualifies is code** (address geometry plus counts): an individual address, not a role/relay/list address, in **2+ threads the user wrote in, or 1 if it's in the user's Google Contacts** (the user's choice). The user's own addresses come from Gmail's send-as list. The agent's own address is never a person.
- **Kept current automatically.** The `people-email` trigger runs `email-people sync` nightly (Gmail history API from the stored `history_id`, with a date-query fallback if it expired) and refreshes the Contacts cache on Sundays. A thread is kept when the user wrote in it or a known correspondent is on it.
- **The wiki block.** `email-people write-section` writes a `## Email` block between `<!-- email-people:start/end -->` markers. Code writes the facts line (threads, first/last contact, updated date); the model writes the summary of what they talk about and when. A newer thread makes the person stale and they come back in a future batch. Health/financial specifics, contact details and verbatim email text never reach the page; the snippets stay in the local DB.
- **Backfill:** `email-people backfill` (every sent thread, resumable) then `backfill-inbound` (threads qualified people started), run once on 2026-10-23. Ask a person's timeline with `email-people person <email>`.
- **Texts (iMessage and WhatsApp), `jobs/people-email.md` Part B.** The same pages, a second channel, for people who already have a person page (nobody gets a page from a text alone). **`bin/chat-people`** (`lib/chat-people.js`) resolves each person to phone numbers and emails through the Mac's Contacts (AddressBook): a card carrying one of their known email addresses is a strong match, a card with the same first and last name a medium one the model checks against the conversation (`chat-people reject` removes a wrong number for good); a number two people claim is dropped for both. It then counts messages per person, channel and chat from `~/Library/Messages/chat.db` and `data/whatsapp-inbox.jsonl` into `data/chat-people.db` (gitignored; handles, counts and dates only, **no message text**), recomputed whole on each `sync` (about a second). **Coverage is stated, not implied:** iMessage is both directions and the whole history; WhatsApp is only what the gateway logged, i.e. messages *to* the user since it started, and group chats are presence only (which groups, how many of the person's own messages, when). Since spring 2026 macOS leaves `message.text` NULL for nearly every message and keeps the body only in `attributedBody` (an NSArchiver typedstream); `chat-people` decodes it (`imsg` and `quote-scan` read `text` only and so see almost no recent messages). `chat-people person <wiki_id>` reads a bounded live sample of the 1:1 messages (60, newest 20 plus an even spread, cut to 200 characters) for the summarising turn; `write-section` writes a `## Texts` block between `<!-- chat-people:start/end -->` markers (code writes the facts line, the model the summary) and refuses a `pin_locked` page. A very active texter is re-summarised only after 14 days and 10 new messages. Reading `chat.db` and Contacts needs Full Disk Access for the node binary, per versioned path; an unreadable source exits 3 and the run says so. Health and financial specifics, numbers and verbatim messages never reach a page.
- Contact details still come only from Google Contacts (`gog contacts`). The ledgers are not a contact source.

## Content-consolidation auditor (weekly merge/supersede/retire)

The three writers (day pages, `hum-consolidate`, `chat-consolidate`) add content broadly; the **`memory-consolidation` job** (Sundays 10:00 local time, `jobs/memory-consolidation.md`) is the weekly pass that prunes it — merging duplicate pages, superseding stale facts, retiring expired ones, expanding thin ones. **Repointed to the DB 2026-07-19:** it used to edit the rendered `.md` mirror (a no-op — `render-all` clobbered those edits within 30 min under DB-as-truth), and now operates on the `pages` table via the `wiki` CLI. Diff-mode: `wiki recent --days 7` (active pages changed this week) + hybrid-recall duplication neighbors; applies via `wiki save`/`supersede`/`delete` (tracked revisions → `wiki history` revert); auto-applies with a conservative bar and emails a report. Never touches `day|week|month` episodic pages, health/financial-derived pages, or `pin_locked` identity-core pages. This content-level pass is distinct from `wiki-audit` (pin/unpin by access frequency) and the concept-link auditor (wikilink hygiene) above — three different auditors, three different axes.

## Semantic + hybrid recall (2026-07-19)

FTS/BM25 only matches on shared *terms*. As the corpus grows (10×/100×), that becomes the dominant recall failure: the agent can't guess the exact vocabulary of a page it's never read, so a paraphrased query ("where does the user like to eat?") misses a page titled "restaurant preferences". This is the same gap the event stream closed on 2026-07-08; on 2026-07-19 the identical hybrid layer was extended to the curated wiki so recall quality stops degrading as the wiki scales.

- **`page_embeddings` table** (in the same `memory-index.db`): one row per active page, `page_id` PK, `nomic-embed-text` 768-dim Float32 BLOB via local Ollama, plus a `body_hash` column that mirrors `pages.body_hash`. Because pages are **mutable** (unlike the append-only event log), freshness is hash-tracked: the backfill re-embeds a page whenever its `body_hash` changes, and prunes embeddings for deleted pages.
- **`lib/wiki-embed.mjs`** — the semantic layer. `embedPendingPages({embedFn, limit})` (re)embeds new/changed active pages; `searchPagesHybrid(query, {limit, type, embedQuery})` reuses `wiki-store.searchPages` for the authoritative BM25 half (so the type-weighting + pinned boost is preserved), runs a KNN over `page_embeddings` for the semantic half, and fuses the two by page id via `lib/hybrid-recall.mjs`'s `rrfFuse` (RRF k=60, the shared primitive the events path also uses). **The KNN reads a packed matrix, not the rows (2026-08-08):** `hybrid-recall.cachedVectorIndex` unpacks every active page's vector once into one contiguous L2-normalized `Float32Array` (so cosine is a dot product) and reuses it until the corpus version changes — `PRAGMA data_version` + `COUNT(*)` + `MAX(rowid)`, plus an explicit `clearVectorIndexCache` from `embedPendingPages` because same-handle writes do not move `data_version`. It used to SELECT and unpack all ~889 BLOBs per query (2.81 ms and ~1,800 allocations; now 0.85 ms and none). The `type` filter is applied per query via `allow`, so one matrix serves every scoping. Its own `DatabaseSync` handle to the shared DB — WAL makes co-existence with wiki-store's handle safe (the MCP server already holds a wiki-store + an event-fts handle at once).
- **Fail-soft + off the hot path.** Embeddings are populated OUT of band by the `wiki-embed` CLI / nightly `wiki-embed` cron (`45 2 * * *` local time, `agent/scripts/trigger-wiki-embed.sh`), NEVER on the `savePage` write path (Ollama is far too slow to sit in a save). If Ollama is down or nothing is embedded yet, `searchPagesHybrid` silently returns exactly what `wiki_search` returns today (pure FTS, `via:"fts"`); when embeddings exist and the query embeds, rows are tagged `via:"hybrid"`.
- **Surfaces.** Agent: `wiki_search(mode:"hybrid")` MCP tool (embeds the query via `localLlmEmbed`). Terminal: `wiki-embed search "<q>" [--fts] [--type T]`, `wiki-embed embed [--limit N]`, `wiki-embed stats`, `wiki-recall-eval`. The plain `wiki` CLI is unchanged — hybrid lives in its own binary, exactly as `recall-events` is separate from `wiki`. As of 2026-08-09 `wiki-embed embed` also writes cue anchors (its output carries a `cued` count alongside `embedded`), `stats` reports `cues` / `cued_pages` / `cues_by_kind`, and `search` prints `↳ cue (kind)` and `↳ linked from` provenance under each hit.

## Cue anchors — several entry points per page (2026-08-09)

Hybrid recall above fixed *vocabulary* mismatch. It left a second, quieter failure in place: **one vector per page means one entry point per page.** A page is retrievable only in proportion to how much of it the query is about, so a page covering several subjects is diluted out of reach of a query about any one of them. A busy person page is the worked example — its single embedding is smeared across their work, their hobbies and their food preferences, so *"who handles the supplier emails"* has nothing sharp to match even though the page says exactly that.

Adapted from **Memora** (Microsoft Research, ICML 2026, [arXiv 2602.03315](https://arxiv.org/abs/2602.03315), MIT). Two of its three pieces we already had, independently: a *primary abstraction* that indexes the full memory value (our `description` — the live corpus averages 72 chars, right at Memora's 6–8 words) and *cue-to-cue connections* (our `[[wikilink]]` graph). The missing piece was indexing each page through **several** cues. We took the representation, not the package — theirs is Python + ChromaDB + OpenAI/Azure, a strict downgrade from Node + SQLite + local Ollama.

- **`page_cues` table** (same `memory-index.db`): PK `(page_id, cue_idx)`, plus `kind`, `cue_text`, `embedding`, and a `body_hash` mirroring `pages.body_hash` — identical hash-tracked freshness to `page_embeddings`, so a body edit re-cues the page. Max 8 cues/page, each ≤200 chars.
- **`cuesForPage(row)`** extracts the structural tier with no model at all: the `description`, then the `##`–`####` markdown headings (h1 is skipped — it restates the title). Deduped case-insensitively, and it **always returns at least one cue** (falling back to title, then page id). That last part is load-bearing: the presence of a cue row carrying the current `body_hash` *is* the cued marker, so a page yielding nothing extractable must still leave one or it would be reconsidered on every pass forever.
- **Heading cues carry the page title, and that is a correctness fix, not formatting.** The first live eval regressed MRR (0.889 → 0.852) because a bare 2-word heading embeds to a short, high-magnitude vector that scores well against any short query sharing one word: `project_thermostat_control` took #1 for *"how do I ship a new version of the iphone app"* on a heading reading **"Client app"**, and `reference_<company>_contract` placed on **"Compensation"**. A diluted whole-page vector is robust; a tiny cue is sharp but *promiscuous*. Cues are now `"<title> — <heading>"`, which keeps the aspect signal while carrying enough page identity to lose honestly. Dedupe compares the **unqualified** heading, so the prefix cannot smuggle a restatement of the description back in.
- **Day pages get almost nothing out of the structural tier, and eval v2 showed why.** A `day_*` page's headings are timestamped stop markers — `### 19:13-19:42 · **<place name>** · 28 min`. Three problems compound: `MAX_CUES_PER_PAGE`=8 truncates a 17-stop day to its earliest 8, so every evening stop is unindexed (three evening stops in the eval set — all cut); junk headings (`unlabeled`, `walking, not a stop`) consume 4–5 of those 8 slots; and the title qualifier that fixed the curated tier makes it *worse* here, because every cue then opens with the same `<Weekday, Month D, YYYY> — HH:MM-HH:MM ·` prefix, so all eight embed to near-identical "a timestamp on a date" vectors. Fixing this means day-specific extraction (strip the time prefix, drop unlabeled stops, raise the cap for long pages) — the day-summary builder emits that heading shape deterministically, so it is structure parsing, not language.
- **`cue_ver` + `CUE_LOGIC_VERSION`.** Cue freshness keyed on `body_hash` alone means a page whose body never changes keeps cues built by the old extraction logic forever — which is exactly what the qualifier change hit. Bumping `CUE_LOGIC_VERSION` invalidates every row built by older logic and they re-cue on the next pass, no manual reindex. Additive column with an on-open migration.
- **`kind`** records the source — `description` | `heading` | `aspect`. The table is indifferent to which, which is what let the free tiers ship first and the LLM-generated `aspect` tier land later without a migration.
- **Retrieval.** The KNN matrix now unions `page_embeddings` (as `cue_kind='page'`) with every cue row, so the KNN ranks **cues**; `searchPagesHybrid` collapses back to pages via `hybrid-recall.collapseByKey`, keeping the best cue per page. The winning cue comes back on the row as `cue` / `cue_kind`, and stands in as the `snippet` for a hit the lexical half didn't match. Candidates are pulled at `CANDIDATES * 4` before collapsing, since several cues of one page can occupy consecutive slots.
- **Cost.** ~905 → ~5,000 matrix rows (~15 MB); KNN 0.85 ms → ~4 ms, against the 600 ms `unified-recall` deadline.
- **Purely additive.** With `page_cues` empty the results are byte-identical to the pre-2026-08-09 stack. Rollback is `DELETE FROM page_cues`, or `WIKI_USE_CUES=0`.

## Associative recall (2026-10-24)

The user asked for memory where *recall brings up all associated memories*. Research write-up (existing systems, papers, cognitive mechanisms, evaluation): `system/associative-memory-research.md`. Code: `lib/wiki-assoc.mjs` (the graph and the propagation, pure and tested without SQLite), wired into `lib/wiki-embed.mjs`.

**Why the 2026-08-09 one-hop expansion measured zero, and what replaced each cause:**

| Cause | Fix |
|---|---|
| A **hard 0.62 cosine floor** re-gated every neighbour by resemblance to the query, removing exactly what association adds (pages tied to the cue but not like it) and blocking every day page (they sit at 0.46–0.60). | A **soft gate** `σ(κ·(cos − c0))`, c0 = 0.5, κ = 12, on the page's best *cue* cosine: it scales activation, never zeroes it (a 0.46 day keeps ~40%). `WIKI_ASSOC_GATE_C0` / `_K`. |
| **Forward-only wikilinks** and a **hard in-degree cutoff** (>60 → nothing). "Everything about <person>" lives on the day pages that link *to* that page. | Both directions walked (backlink weight 0.5 vs forward 0.8). Hubs tamed by ACT-R's **fan effect**: each node's contribution scales with its specificity `ln(N/fan)/ln(N)`, applied on both the sending and receiving side — a big topic hub ≈ 0.02, a much-linked person's page ≈ 0.13, a typical person page ≈ 0.5. No step function. |
| **No convergence** — the best seed per neighbour was kept. | Activation **adds up**: a page reached from several seeds outranks one reached from one (pattern completion). |
| A **single-answer eval** cannot see association. | The associative eval set and set metrics, § Measuring association. |

**The graph** (`buildAssocGraph`, cached per corpus version like the vector matrix, ~46 ms to build at 1k nodes / 17k directed edges): nodes are active pages; edges and base weights (`EDGE_W`) are `related` 1.0 and `fact:<rel>` 1.0 (both ways), `supersedes` 0.6 (both ways), `wikilink` 0.8 forward / `backlink` 0.5, `next_day` 0.6 / `prev_day` 0.4 between consecutive day pages (computed from the ids, never stored; gaps are not bridged; forward stronger, the lag-CRP asymmetry), and `hebbian` co-retrieval weight multiplying an existing edge by `(1 + h)` or adding a weak edge (0.5·h) where none exists. Fan counts distinct neighbours, not link rows.

**Propagation** — two schemes, both available, because the literature does not settle which wins on a corpus shaped like this one:
- **`sa` — spreading activation** (ACT-R; SYNAPSE, ACL Findings 2026; Query-Aware SA, arXiv 2606.30133): seeds' RRF scores normalized to 1, two steps, contribution `a_j · w_ji · spec_j · spec_i · gate_i`, retention 0.5, top-40 lateral inhibition per step, no echo back to the originating seed; a seed's own starting mass is not counted (a seed ranks only when other seeds converge on it). ~1.4 ms.
- **`ppr` — personalized PageRank** (HippoRAG): restart 0.5, 20 iterations, transition ∝ `w · spec · gate` of the target, final score ÷ fan^0.5 (a walk's stationary mass otherwise pools in high-degree nodes); seeds excluded from its list. ~9 ms.
Both return `{id, activation, from, via, hops}` — the seed the strongest path started at and the kind of its last edge.

**Where it runs:**
- **`wiki_search` hybrid / `searchPagesHybrid` / `recall`** — a third RRF list (weight `WIKI_ASSOC_WEIGHT`, default 1.0) seeded from the top 10 of the lexical+semantic fusion, behind **`WIKI_ASSOC=sa|ppr`, default off**. A page both direct lists found scores ~2/61 in RRF and an association-only page at most w/61, so the direct retrievers stay dominant by construction; the weight only decides where association-only pages land among single-list hits (at 0.6 they could never reach a top 10 against 60-long direct lists — found by the first end-to-end smoke run). Rows carry `matched:"linked"`, `expanded_from`, `assoc_via`, `activation`. Works with Ollama down (seeds from FTS, ungated). Per-call override `assoc:` for the eval and tools. `WIKI_EXPAND_LINKS=1` now means `sa`.
- **`wiki_associate` MCP tool / `associatePages()` / `wiki-assoc associate`** — "recall this and bring up what's tied to it": seeds = page ids (equal weight) and/or a query's top hits (then gated). Always on — it is opt-in by nature.
- **`episode_search associate:true` / `searchDaysAssociative()`** — day-page FTS (the measured-best episodic retriever) as both seeds and the first list, plus activation scoped to day pages as the second: **context reinstatement** — the matched days pass activation through the people, places and trips they link to, on to the other days those link to, and to the day before and after. **First live measurement (2026-10-24, single-answer set, k=10): it loses** — `episode+assoc` 57% hit@10 / MRR 0.050 against plain `episode` 79% / 0.335 (lost: three episodic cases). On pages, `+assoc` matched `+cues` on hit@10 (74%) but cut MRR 0.578 → 0.405, and `+assoc-ppr` lost one case. So both stay opt-in, and nothing defaults to them; the associative set (`--set assoc`) is the remaining test, since the single-answer set does not reward bringing up connected pages.
- **Date windows** — `after`/`before` (YYYY-MM-DD) on all three scope `day`/`week`/`month` pages by span overlap and leave every other page alone. Turning "last spring" into dates is language and stays with the calling agent (Rule #0b).

**Cost** at production size (measured on a synthetic 973-node, 16.8k-edge graph with a 5,000 × 768 matrix): the gate's full-matrix sweep 8.5 ms + SA 1.4 ms (PPR 9 ms), against `unified-recall`'s 600 ms per-source deadline.

## Trigger cues — the generated cue tier, shippable (2026-10-24)

The slot that held **aspect** cues (2026-08-09, built and never enabled because `gemma3:1b` wrote meta-questions and invented tasks no shape check could catch) now holds **trigger** cues (`page_cues.kind = 'trigger'`), after T-Mem (Tencent, arXiv 2606.15405): the **future situations** in which a page should be recalled, phrased as they would come up ("booking a restaurant for dinner" for a page recording a food allergy). It targets the dominant open failure in 2026's benchmarks — the missing cue: Keep It InMind (arXiv 2607.24368) measured six vector, graph and agentic memories answering at most 14.4% of indirect-cue queries, and no query-time traversal helps because the query holds nothing to traverse from.

- **Grounding makes it shippable.** Every trigger carries `evidence`, the words on the page that make it relevant, and code checks the quote is **verbatim** on the page (case- and whitespace-insensitive, `lib/quote-check.mjs`). An invented task has nothing to quote. A reply where more triggers fail than pass fails validation and climbs the ladder; a mostly-good reply keeps only its grounded triggers. Question-shaped triggers are still rejected.
- **Ladder**: local first, Sonnet (`models.env`, tool-less Max-only `claude -p`) on validation failure, **every** Sonnet call counted against `WIKI_TRIGGER_ESCALATION_CAP` (25/run; the 2026-08-09 code counted only pages where both rungs failed, so a failing local rung forked Sonnet uncapped — fixed and tested).
- **Types**: `user`, `feedback`, `project`, `reference` (`WIKI_TRIGGER_TYPES`). Day pages record what happened; "when should this come up" is about who someone is and what they want. Non-target types are excluded from the freshness predicate so they are never re-selected forever.
- **Runs** nightly from `wiki-assoc nightly --llm` (60 pages a run, `WIKI_TRIGGER_PAGES_PER_RUN`) in the launchd agent; ad hoc `wiki-embed embed --triggers [--no-sonnet]`.
- **Written nightly, read only behind `WIKI_USE_TRIGGERS=1` (default off).** A trigger joins the shared KNN matrix and so re-ranks every consumer; a short situation-shaped string is the "sharp but promiscuous" vector the 2026-08-09 eval caught a bare heading being. It earns the default on `wiki-recall-eval` config `+triggers`. Query cost when on: unchanged (more matrix rows). Rollback: unset the flag, or `DELETE FROM page_cues WHERE kind='trigger'`.

## Typed facts with validity (2026-10-24)

A wikilink says two pages are connected, not how. `page_facts` (`lib/wiki-facts.mjs`) brings Graphiti's fact-edge schema (Zep, arXiv 2501.13956) onto this SQLite, extracted per page in a nightly batch only when the page changed (`page_fact_runs` holds the body_hash each page was last read at), not per write.

- **Row**: `src_id → rel → dst_id` (object page, or NULL for "allergic to <food>"), `fact_text` (one sentence), `evidence` (verbatim quote, checked), `source_page` + `source_hash`, **event time** `valid_at`/`invalid_at` when the page states it, **system time** `created_at`/`expired_at`, `superseded_by`. Relations come from a fixed 21-word vocabulary (`REL_VOCAB`: spouse_of, parent_of, works_at, lives_in, likes, avoids, handles, …); subject and object must be the page itself, a page it links to or is linked from, or the owner's page (`WIKI_OWNER_PAGE`; the owner is the other party to most relations whether or not the page links the owner), so a fact edge never dangles.
- **Latest wins, nothing deleted**: a fact the source page no longer states is expired; a new fact for a one-valued relation (`works_at`, `lives_in`, `spouse_of`, `partner_of`) supersedes the subject's other current one, from any page. Current = `CURRENT_FACT_SQL` (`expired_at IS NULL` and not past `invalid_at`) — one definition every reader shares.
- **Read by**: the association graph (`via: "fact:spouse_of"`), `wiki_read` (a `=== facts ===` block), and — behind **`WIKI_USE_FACTS=1`, default off** for the same reason as triggers, eval config `+facts` — the KNN matrix, where each current fact sentence is an entry point into its subject page (`cue_kind:'fact'`). `wiki-assoc facts list <id> [--all]` shows expired ones too.
- **Ladder + validation**: local → Sonnet (budget `WIKI_FACTS_SONNET_BUDGET`, 30/run) on schema failure or more failing facts than passing; types `user`, `project`, `feedback` by default, 40 pages a run. A page no rung could ground is not marked done and is retried. Both rungs are Edva's own models, so health and finance pages are in scope — and the extractor never puts a value the page does not state into a fact.

## Hebbian co-retrieval (2026-10-24)

Pages the auto-recall **judge kept together** for the same message (`data/auto-recall-judge.jsonl`, already written for every judged chat message) were useful together. `lib/wiki-hebbian.mjs` turns that into `page_coactivation(a, b, w, n, last_ts)`: `w ← w·λ^Δdays + η` per co-use (η = 0.1, λ = 0.985/day, a ~46-day half-life; HeLa-Mem, ACL 2026, uses the same shape). Rows keeping more than 6 pages are skipped (a broad message wires noise); a cursor in `assoc_meta` makes the fold idempotent; decayed pairs below 0.01 are pruned.

- **Only judge-kept pages count** — never raw search hits, which would make the most-retrieved pages retrieved more with nothing checking it (`memory-db.keptWikiIds`).
- **Used in recall** through the graph (above), and **proposed as links**: strong pairs (≥ 0.3) with no link either way go to `data/wiki-link-candidates.json`, which `wiki-link-weave` Step 5.5 reads and decides on — co-use proposes, the model reading both pages disposes.

## Base-level activation prior (2026-10-24)

`lib/wiki-activation.mjs` writes `page_activation(page_id, base_level, n_refs, last_ref)`: ACT-R's `B = ln Σ t_k^(−0.5)` over every **use** of a page in the last year (judge-kept recalls and `caller=mcp` `wiki_read`/`episode_get` reads; never search hits or CLI reads), with Petrov's closed-form tail beyond the 10 most recent so cost is bounded (within 0.05 of the exact sum on a 200-use test). Rebuilt nightly from the logs. In `searchPagesHybrid` it is a fourth RRF list at weight 0.2 that may only **reorder** pages the direct lists already found — a tie-breaker between near-duplicates, never a gate or a source of candidates — behind **`WIKI_PRIOR=1`, default off**.

## Reconsolidation (2026-10-24)

Recall makes a memory open to revision (Nader 2000). `dream-prefetch` now adds `recalled_pages` to the dream bundle — the curated pages kept by the judge (with up to five of the messages that brought each up) or read on purpose that day — and `jobs/dream.md` Step 4.7 checks each against the whole day: contradicted → corrected or superseded, extended → appended, confirmed → nothing. Episodic and `pin_locked` pages excluded as everywhere else; the run log records `reconsolidated: {checked, corrected, extended}`.

## The nightly writers

`agent/scripts/trigger-wiki-assoc.sh` (cron, daily 04:20 local time, after `wiki-embed`; tasks.json `wiki-assoc`) runs `wiki-assoc nightly` — the no-model writers: Hebbian fold, link-candidates file, activation rebuild — then `launchd_kick ai.claude.wiki-assoc-llm`, whose `run-wiki-assoc-llm.sh` passes `max-auth-guard` and runs `wiki-assoc nightly --llm` — facts, then trigger cues. Without a verified Max login the model half runs on the wiki's API fallback when `EDVA_WIKI_API_KEY` is set (`--api-fallback`, $25/month cap, `lib/api-fallback.mjs`), and is otherwise held (no local-only fallback writes), paging nobody. Silent; log `agent/logs/wiki-assoc.log`. Everything is additive tables in `memory-index.db` (`page_facts`, `page_fact_runs`, `page_coactivation`, `page_activation`, `assoc_meta`), covered by the hourly `VACUUM INTO` snapshot; none is in the Supabase cloud copy, and every one is rebuildable (facts and triggers by re-running the writers, the other two from the logs).

## Aspect cues — retired 2026-10-24

Superseded by trigger cues (above). The 2026-08-09 finding stands as the reason the grounding check exists: a 13-page sample had `gemma3:1b` produce good cues on long many-topic pages and, elsewhere, meta-questions and invented tasks — the second kind well-formed and simply false. `--aspects` and the `aspect*` option names are still accepted as aliases for the trigger tier.

## Measuring recall — `wiki-recall-eval` (2026-08-09)

Unit tests prove the plumbing; they cannot prove recall improved, because a fixture corpus has none of the properties that make recall hard (no hubs, no many-topic pages, no unfamiliar vocabulary). `bin/wiki-recall-eval` runs a hand-keyed query set (`data/wiki-recall-eval.json`, ~27 deliberately paraphrased queries) against the **live** corpus and reports hit@k + MRR for four configurations — `fts` / `hybrid` / `+cues` / `+links` — each a fresh module import with different env. It prints which queries each tier recovered and *how* (which cue, or which seed linked it).

**First live run (2026-08-09, 27 queries, k=5), and it changed two decisions:**

| | fts | hybrid | +cues | +links |
|---|---|---|---|---|
| hit@5 | 89% | 89% | **93%** | 93% |
| MRR | 0.772 | **0.889** | 0.859 | 0.859 |

Cues ship on: they recovered a page (*"how does the user want suggestions given to them"*) that no other configuration could reach at all. The MRR dip is two queries moving #1→#2 inside a top-5 the agent reads in full, which is the right trade for reach. **Expansion ships off:** it moved nothing.

The first run of this harness (before the title qualifier) was more useful still — it caught the cue tier making things actively *worse*, and named the mechanism: `project_thermostat_control` at #1 for an iPhone-build query on a heading cue reading "Client app". No unit test on a fixture corpus would ever have surfaced that.

**Eval set v2 (2026-08-09) — rebuilt, because v1 was constructed backwards.** v1's queries were written by reading page descriptions and working back to a question, which biases toward what is already findable; that is why baseline scored 89% and left nothing to measure. v2's 27 cases come from **actual questions in `edva_messages` and actual stop reports the user sent**, with every answer key verified by direct substring over `body_md` rather than by running the retriever under test. Three classes, reported separately: `episodic` (14, the long `day_*` pages v1 had zero coverage of), `curated` (9, carried from v1 as the regression guard), `asked` (4, verbatim questions).

**Final state after the two fixes v2 prompted** (adaptive `match:"auto"`, day-page stop cues), hit@5 / MRR over all 27:

| config | overall | MRR | episodic (14) | curated (9) | asked (4) |
|---|---|---|---|---|---|
| `fts` | 70% | 0.430 | **71%** | 67% | 75% |
| `hybrid` (the pre-2026-08-09 stack) | 59% | 0.485 | 50% | 67% | 75% |
| `+cues` | **70%** | **0.532** | 64% | **78%** | 75% |

Against the stack that existed before this work: **+11pp hit@5, +0.047 MRR, +14pp episodic.** `+cues` matches pure FTS on recall while ranking substantially better (MRR 0.532 vs 0.430), and beats it on curated. Pure FTS still edges it on episodic hit@5 (71% vs 64%) — see the open item at the end of this section.

**The measurements that got there**, hit@5 by class, at both match settings (before the fixes):

| config | episodic (14) | curated (9) | asked (4) |
|---|---|---|---|
| `fts`, match=or | **71%** | 67% | 75% |
| `hybrid`, or | 50% | 67% | 75% |
| `+cues`, or | 50% | 78% | 75% |
| `fts`, **and** (production default) | **0%** | 0% | 0% |
| `hybrid`, and | 21% | **89%** | 50% |
| `+cues`, and | **36%** | **89%** | 50% |

Three conclusions, none of which was visible before:

1. **`match:"and"` — the production default — annihilates the lexical half on any sentence-shaped query.** Seven content words ANDed together match no page, so `fts` scores a flat 0% and `wiki_search` is *effectively semantic-only* for natural-language questions. `wiki-embed.mjs` already carried a comment noting this; what was missing was the magnitude. It is the single biggest lever in the stack — far larger than cues or expansion.
2. **No single configuration wins both classes.** Episodic recall is best at `fts`+or (71%); curated is best at hybrid+and (89%). The right retrieval genuinely depends on what is being asked for.
3. **Cues help where it matters and never hurt**: episodic 21% → 36% at the production setting, curated 67% → 78% at the other. **Link expansion regressed a curated query** ("where they like to stay when away", found → missing), which independently confirms the default-off call.

**Still open — the semantic layer cannot discriminate episodic queries, and no tuning fixes that.** Pure FTS still leads on episodic hit@5 (71% vs 64%). Inspecting the cosines shows why, and rules out the obvious remedy: for *"which <event> did we decide to skip"* the whole candidate field sits between **0.46 and 0.60**, and the correct page (`day_<date>`) is at **0.463 — below all of the noise**. A relevance floor would delete the answer and keep the distractors. `nomic-embed-text` simply has no signal separating one day-on-a-trip narrative from the other 105, so RRF is fusing a genuinely uninformative ranking and it costs correct FTS hits their slots.

**Resolved by routing, not by tuning.** Of the four candidate fixes — weight the lexical list higher, gate the semantic half on an absolute cosine bar, exclude `day`/`week`/`month` from the KNN, or send episodic lookups somewhere else — the last one turned out to need no new code at all. `episode_search` already runs FTS scoped to `type=day`, and measured on the same 14 episodic questions it scores **79% hit@5 / MRR 0.643**, against `wiki_search` hybrid's 64%. It also inherited the `match:"auto"` fix for free. Scoping is doing the work: taking ~800 non-day pages out of the competition beats anything available by re-weighting a fusion over all of them.

So the fix shipped is a **routing** change — `wiki-session-context`'s memory-map footer, both MCP tool descriptions, and `agent/CLAUDE.md` now send "where/when did we…" to `episode_search` and keep `wiki_search` for what the user IS, PREFERS or DECIDED. Zero ranking risk, no third change to fusion semantics in one day, and it uses a tool that already existed. The three tuning options are recorded here as deliberately **not taken**: each would have altered ranking for every consumer (hum, triage, auto-recall) to solve a problem that scoping solves outright.

**Also still open (2026-08-09; addressed 2026-10-24 by § Trigger cues):** aspect cues were then a stronger candidate than they had been. The remaining episodic misses — *"which <place> did we dislike"*, *"which outing did <friend> come along to"* — are exactly the shape a written cue captures and a stop name cannot, and the sample showed the model doing that well on long pages.

## Measuring association — the associative eval set (2026-10-24)

The 27-case set above has one gold page per question, so it scores "brought up the associated pages too" the same as not — the fourth reason expansion measured zero. Two additions:

- **`bin/wiki-recall-eval-gen`** builds `data/wiki-recall-eval-assoc.json` from the live graph, MuSiQue-style: sample a 2–3-page path weighted by specificity (no hub hops, not three day pages), have the ladder write one natural question whose answer is on the last page and that names only the first page's subject, with a verbatim evidence quote from **every** page on the path; keep it only if every quote is on its page, the question does not name the final page, and plain BM25 does not put the final page in its top 3. Each case records its **split** — `links` (wikilinks only, the friendliest to association, report it separately), `temporal` (a day-contiguity hop), `facts`, `hebbian` — and `reviewed: false`. Hand-labelled real questions: `wiki-recall-eval-gen add "<question>" --gold a,b,c --final c` (`split: "asked"`).
- **`wiki-recall-eval --set assoc`** adds the set metrics LongMemEval defines — **recall_all@k** (every gold page in the top k), **coverage@k**, **nDCG@k** — plus **final-hop@k** (the page the words do not reach), latency p50/p95, and configs `+triggers`, `+facts`, `+assoc`, `+assoc-ppr`, `+assoc+prior`, `+all`, `episode`, `episode+assoc`, with a per-pair recovered/lost list against `+cues` (or `episode`). `+links` is gone.

**The decision this gates:** `WIKI_ASSOC`, `WIKI_USE_TRIGGERS`, `WIKI_USE_FACTS` and `WIKI_PRIOR` stay off for every consumer until their config (`+assoc` / `+assoc-ppr`, `+triggers`, `+facts`, `+assoc+prior`; `+all` together) beats `+cues` on recall_all / final-hop on the associative set **without** losing hit@5 on the original set. Not yet run — the live corpus is only on the host. The literature's expectation (§ 3 of the research doc): gains on the bridge / aggregation / "what else happened" templates, flat on single-hop; if even the non-`links` splits show nothing, the edges lack the information and the next investment is link-weave, Hebbian and fact edges, not propagation tuning.

## Map / navigation tier (2026-07-19)

Pull-only recall has one blind spot: the agent won't search for what it can't name. As the corpus grows that gets worse — a 100× wiki has whole regions the agent has never seen and has no vocabulary for. `wiki_search` answers "find pages about X"; the **map** answers "what IS in memory, so I know what I can even ask for?"

- **`wiki-store.pageMap({ type, prefix })`** — a live-computed table of contents, never a persisted `index_*` page (so it can't go stale and adds no clutter). Three levels: `pageMap()` → overview (every type + count + a few sample titles); `pageMap({type})` → that type's pages as `id · title — description`, OR, when the type exceeds 40 pages and its ids share structured prefixes (e.g. `<family>_*`, `<family>_<sub>_*`), a **prefix histogram** so the agent drills instead of drowning; `pageMap({type, prefix})` → the pages under that id prefix (LIKE with `_` escaped literal). Cheap aggregate SQL over `pages`.
- **Surfaces.** Agent: `wiki_map` MCP tool (overview → type → prefix → `wiki_read`). Terminal: `wiki map [<type>] [--prefix P]`. The session-start **memory map** footer (see § Three-tier load, item 1) points at `wiki_map` as the entry point, so every session knows the navigation exists.

Together with hybrid recall and the push→pull bundle, this is what lets memory scale: the always-on footprint stays bounded (identity core + map), hybrid recall makes on-demand pulls accurate at any corpus size, and `wiki_map` keeps the corpus navigable when the agent doesn't yet know the vocabulary to search for.

## Tests

`tests/wiki-map.test.mjs` — 4 cases: overview counts + bounded samples, small-type page list, large-type prefix histogram (the drill path), prefix narrowing.

`tests/wiki-embed.test.mjs` — 24 cases (deterministic toy embedder, no Ollama): full backfill + idempotency, body-change re-embed of only the changed page, hybrid-tagged results that recall the relevant page, degrade-to-FTS when no `embedQuery`, `type` filter honored, orphan-embedding prune on delete, oversized-page truncated retry, per-page error not aborting the batch — plus the cue tier: extraction order (description then h2–h4), dedupe/cap/always-one-cue, cue counts + re-cue only on body change, recall of a page through a cue its whole-page vector would have missed, cue-as-snippet fallback on a lexically-unmatched hit, the `score`-is-BM25-only / `cosine`-is-0..1 invariant, orphan-cue prune, and the trigger tier: ladder climbing, an ungrounded (invented) trigger rejected, question-shaped triggers rejected, a mostly-good reply keeping only its grounded triggers, dedupe against structural cues, convergent re-selection, and the Sonnet cap counting successful escalations.

`tests/wiki-assoc.test.mjs` — 15 cases, the pure graph half: backlinks walked, hub specificity ≈ 0 with no step function, two-hop reach, convergence favouring the intersection, no seed self-ranking or echo, day contiguity (forward stronger, gaps not bridged), the soft gate scaling without zeroing, Hebbian amplify-or-add, typed fact edges, PPR reaching the same neighbourhood without pooling in the hub, dispatch/exclude/limit, empty inputs, date spans and windows, Hebbian decay.

`tests/wiki-recall-assoc.test.mjs` — 12 cases (replaces `wiki-recall-expand.test.mjs`), the integration in `searchPagesHybrid`/`associatePages`/date windows with a fixture pinned to `WIKI_RECALL_CANDIDATES=3`: a crowded-out forward link and a **backlinked** day recalled, hub not promoted, off-topic neighbour held down by the gate, direct hits never displaced, `assoc:"off"` per call, PPR selectable, date window, association with no query vector, `associatePages` from ids (provenance, two-hop contiguity), type/date scoping, query seeding.

`tests/wiki-assoc-writers.test.mjs` — 13 cases for the nightly writers: judge-kept extraction, the verbatim-quote check, the ladder (climbs only on validation failure, Sonnet budget), Hebbian fold + cursor idempotency + broad-message guard + link candidates + graph edge, base-level activation (ordering, Petrov tail accuracy, only real uses count), fact validation, extraction past an inventing local rung into typed graph edges, expiry and one-valued supersession, failed pages left pending.

`tests/wiki-store.test.mjs` — 27 cases covering:
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

Existing `tests/memory-store.test.mjs` (10/10) still green — the new schema is purely additive.

## Recovery cheatsheet

| Symptom | Action |
|---|---|
| A page's frontmatter looks reformatted but content is right | Expected after `wiki pin` / `wiki unpin` / any frontmatter mutation. The mini-YAML emitter normalizes formatting; verify still passes. |
| `wiki verify` reports `byte_diff` on a page | DB and disk diverged. `wiki render <id> --to-disk` writes the canonical (DB) version back, OR `wiki backfill` ingests the disk version into the DB — choose based on which side is correct. |
| Lost a page's history | `wiki history <id>` lists revisions; `wiki show-rev <id> <rev>` prints any prior raw_md. Restore via `wiki save <id> --body <( wiki show-rev <id> <rev> )`. |
| The host's disk / DB lost | `wiki-cloud-sync restore --db /tmp/restored.db` (refuses to overwrite an existing file) → stop process-manager → copy its `pages`, `page_links`, `page_revisions`, `pages_fts` into a fresh `memory-index.db` (if the whole DB is gone, the restored file can BE the new `memory-index.db` — but the event log, agent queues and other runtime tables in it start empty; they are not in the cloud copy) → `wiki-embed` to rebuild embeddings/cues → `wiki-cloud-sync verify`. Round-trip tested 2026-10-04: byte-equal raw_md, all 15,155 revisions. |
| Memory dir deleted | `wiki render-all <dir>` rebuilds every page from the DB. The DB itself is the source of truth. If the DB is also gone, restore from `~/.claude/projects/.../memory/.git` (until step 4 retires that repo) or `data/memory-snapshots/`. |
| Hook is failing silently | Run `bin/wiki-session-context` directly — it never crashes (failure → empty `additionalContext`). Check `data/memory-index.db` exists and `wiki stats` works. |

## When to use which tool

- **Read** for a known page id → `wiki_read` (one query, full body + links).
- **Search** for a topic / paraphrased query → `wiki_search` (chunked FTS5; pages with multiple matching sections rank higher).
- **Browse** by structural axis ("all active feedback rules in scope X") → `wiki_list` with filters.
- **Discover impact** of changing a page → `wiki_backlinks` (who depends on this).
- **Everything tied to something** ("what else happened when we were with <person>", the bridge between two people) → `wiki_associate` with the page ids (and/or a query); `type:"day"` for the days. For episodic questions whose words are not the day page's words → `episode_search` with `associate:true`; with dates, `after`/`before`.
- **Author / edit** memory → `wiki edit <id>` for interactive, `wiki save <id> --body @<file>` for programmatic.
- **Replace an old rule** → `wiki supersede <old> <new>`. Atomic; the new page's frontmatter gains a `supersedes:` list and the old page's `status` flips to `superseded`.

The legacy `memory` CLI is unchanged and continues to work — it's the canonical retrieval path until step 4 finishes.
