HUM CONSOLIDATE — nightly fold of the day's replies-to-pings into the general wiki, so hum stops re-asking things the user already answered.

> **This instance's additions** to this playbook (its own people, places and decisions) are in `agent/local/jobs/hum-consolidate.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (an ephemeral or by-hand run), `Read` that file before you start.

## Purpose

Every reply the user makes to a hum ping is captured in realtime to `data/hum-responses.jsonl` (by `hum-answer` for question replies, by `suggestion-classify` for free-text / reaction replies to any lane). That log is dumb on purpose — capture must be robust, so it never tries to route a reply to the "right" memory page at reply time.

That log is now **directly searchable** as well, via `lib/utterance-store.mjs` → the `replies` source in `recall`. So this job is no longer the only path from a reply to memory, and it is no longer a bottleneck: a reply is retrievable in the user's own words, with its date, the moment it is captured. What consolidation adds is *placement* — putting a durable taste or decision on the page where future work will look for it.

This job is the judgment step: once a night, read the new replies and **fold the durable ones into the general wiki** — the same `pages` corpus `wiki_search` / the SessionStart pinned subset / every hum tick's `hum-wiki-recall` read from. After consolidation, a fact the user stated ("add that place for next time", "we skip the big parade", "my brother books the campsite") lives as durable, linked, deduped memory, and the settled-subject gate in `hum.md` Step 3 keeps hum from re-surfacing it.

This is the single Opus-quality writer to long-term memory from the hum loop. It replaced `hum-answer`'s old realtime routing into six fixed subsection pages (retired 2026-06-28) — that fired only for the question lane and scattered facts.

## Pipeline

```
trigger-hum-consolidate.sh (3:10 AM local; skips when nothing new since the watermark)
  → Step 1: read pending replies (hum-responses.jsonl rows newer than last_consolidated_at)
  → Step 2: per reply, judge durable-fact vs transient-resolution
  → Step 3: fold durable facts into the right wiki page (find / read / append / save)
  → Step 4: advance the watermark; stay silent
```

## Step 0 — Bash gate (pre-dispatch)

`trigger-hum-consolidate.sh` only dispatches when `hum-responses.jsonl` has rows newer than `hum-consolidate-state.json.last_consolidated_at`. If you were dispatched, there is at least one pending reply.

## Step 1 — Read pending replies

```bash
node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const D=path.join(os.homedir(),"Dev/edva/data");
let last=0; try{last=new Date(JSON.parse(fs.readFileSync(path.join(D,"hum-consolidate-state.json"),"utf8")).last_consolidated_at||0).getTime();}catch{}
const raw=fs.readFileSync(path.join(D,"hum-responses.jsonl"),"utf8");
const rows=raw.split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(r=>r&&new Date(r.ts||0).getTime()>last);
console.log(JSON.stringify(rows,null,2));
'
```

Each row: `{ts, ping_id, lane, subject, subject_key, ping_text, reply_text, disposition, source}`. The `lane` carries a hint about the KIND of fact — for question replies it is the original `memory_hook` (`show_preference`, `restaurant_preference`, `event_recap`, `general_preference`, `person`, or a hook the local additions name); for free-text replies it is the hum lane (`dining`, `exercise`, `ideas`, …).

## Step 2 — Classify each reply: durable fact vs transient resolution

For each pending reply decide what it is:

- **Durable preference / fact / decision** — something true beyond today that should shape future recommendations: a taste ("loved the second episode", "don't care for natural wine"), a standing decision ("add it for next time in that city", "we always bring dessert to game night"), a person/place fact, an event recap. → **fold into the wiki (Step 3).**
- **Transient resolution** — a one-time "handled / canceled / stale / not now" that carries no durable preference ("it's canceled", "the form already went in", "that ping is stale"). Do **not** manufacture a taste page from it; skip the wiki write (the watermark still moves past it).

  **This is no longer a memory loss.** Every reply — transient ones included — stays permanently searchable as a dated statement through `lib/utterance-store.mjs`, which reads `hum-responses.jsonl` directly and renders each row as `2026-07-28 · <the user> said: "…"`. `recall`, `claim-check`, and `outbound-precheck` all read that corpus, so "already handled, don't re-ask" keeps suppressing a re-ask forever without needing a wiki page to hold it.

  It used to be a loss, and it was the worst one in the pipeline: the class of reply the user is most annoyed to re-litigate ("already answered", "don't re-ask") was precisely the class this step dropped, surviving only in `hum-resolved-topics.jsonl` behind a 48h TTL that the hum tick never even read. (Fixed 2026-07-29.)

  **One exception where you should still write:** if the transient reply also *corrects a fact Edva has recorded wrong* (e.g. "that appointment is on Thursdays, not Tuesdays"), that correction is durable — fold it, or `wiki supersede` the wrong fact. The resolution is transient; the correction inside it is not.
- **Noise / non-reply** — captured by a misfire (a fresh command that slipped through). Skip.

When unsure, prefer folding a short, hedged fact over dropping it — the cost of a slightly-redundant wiki line is far lower than re-asking the user. But never invent specifics the reply didn't contain.

## Step 3 — Fold durable facts into the general wiki

For each durable reply:

1. **Find the right page.** `wiki search "<subject + key nouns>"` (and consult the `lane` hint). Prefer an existing page: a restaurant/taste reply → the matching `user_*_taste` / `reference_trusted_restaurants` / a person page; a project decision → the relevant `project_*` page. **A fact about one person goes on that person's own page** (`entity: person`), not on a hub; if they have none yet, create it the way `jobs/dream.md` Step 4.6 says and link it from their hub line (the user, 2026-10-24; this replaces the hub fallback still worded in `ops-agent/CLAUDE.md` § People Pages). Use `wiki read <id>` / `wiki render <id>` to see current content, but always save from `wiki render` (the `wiki read` view has no frontmatter).
2. **Dedupe.** If the page already states this fact, do nothing (idempotent — a re-run must not append duplicates). Only add genuinely new information.
3. **Append the fact, linked.** Add one dated, sourced line in the page's voice, using `[[wikilinks]]` for entities already in the corpus (a person page such as `[[user_<name>]]`, a restaurant page, a project). Keep raw_md a complete file (frontmatter + body). Write the new raw_md and save:
   ```bash
   wiki render <id> > "$TMPDIR/page.md"   # current bytes (or craft fresh frontmatter for a new page)
   # …edit $TMPDIR/page.md to append the fact…
   wiki save <id> --body @"$TMPDIR/page.md"
   ```
   `wiki save` routes through `wiki-store.savePage` — a tracked revision + FTS refresh, so the next hum tick's `hum-wiki-recall` sees it **lexically** immediately. Its **embedding** (and therefore semantic recall of a paraphrase) lands on the nightly `wiki-embed` run, which sits at **04:08 — deliberately after this job (03:10) and `chat-consolidate` (03:20)**. It used to run at 02:45, i.e. *before* both writers, so everything folded overnight missed that night's embedding and stayed semantically invisible for a further 24h. If you reschedule either job, keep it ahead of 04:08.
4. **Create a page only when none fits.** Give it the right `type` (`user` / `reference` / `project` / `feedback`), a `name`, a one-line `description`, and link it into the graph. New pages are the exception, not the rule — most replies extend an existing page.

Line shape (match the target page's existing style; this is the fallback):
```
- 2026-06-28 · Example Taqueria (Old Town, Oaxacan): add for next visit to Springfield — [[reference_trusted_restaurants]]
```

## Step 4 — Advance the watermark + stay silent

After processing all pending rows, write the newest processed row's `ts` as the watermark:

```bash
node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const p=path.join(os.homedir(),"Dev/edva/data/hum-consolidate-state.json");
fs.writeFileSync(p, JSON.stringify({last_consolidated_at: process.argv[1]}, null, 2)+"\n");
' "<newest-ts-processed>"
```

**Deliver nothing.** This is memory maintenance, not a ping — it runs at 3:10 AM. No email, no phone pointer, no push. The value shows up as hum *not* re-asking. The weekly `hum-review` already reports memory growth; consolidation stats surface there.

## State file

`data/hum-consolidate-state.json` — `{ "last_consolidated_at": "<ISO8601 | null>" }`. Single writer (this job). `null` on first run = consolidate the whole `hum-responses.jsonl` backlog. Always advance to the newest **processed** row's `ts` (not "now") so a row written mid-run isn't skipped.

## Guardrails

This job NEVER:
- Sends email, phone pings, APNs pushes, iMessage, or anything outbound. Silent, always.
- Touches money, calendar, tasks, or any external system.
- Writes anywhere except: the wiki (`pages` via `wiki save`), `hum-consolidate-state.json`, and (optionally) a suppression note in `hum-resolved-topics.jsonl`.
- Deletes or rewrites unrelated wiki content. Append facts; never restructure a page wholesale. Use `wiki supersede` only when a reply genuinely overturns a recorded fact.
- Invents detail beyond what the reply stated, or routes health/financial data into the wiki (those have their own stores + rules).
- Re-appends a fact already on the page (idempotent — dedupe before every write).

## Failure modes

- **Nothing durable in the batch** (all transient/noise): advance the watermark, exit silent. Normal.
- **Wiki save fails for one page:** log it, skip that reply (do NOT advance the watermark past an unprocessed durable reply — leave it for the next run rather than lose it), continue with the rest.
- **`hum-responses.jsonl` unreadable / empty:** exit silent; the trigger gate should have caught this.
- **Ambiguous reply:** prefer a short hedged fact over dropping it; if truly uncontentful, skip.
