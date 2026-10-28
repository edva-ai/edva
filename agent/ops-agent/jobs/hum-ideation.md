HUM IDEATION — Refill the proactive-idea reservoir.

> **This instance's additions** to this playbook (its own people, places and decisions) are in `agent/local/jobs/hum-ideation.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (an ephemeral or by-hand run), `Read` that file before you start.

Runs in up to four slots daily (06:00, 11:00, 14:00, 19:00 local) via cron. **Since 2026-10-04 the trigger skips a slot when the reservoir is healthy (≥25 live ideas across ≥5 categories with 2+ each) AND nothing new arrived since the last dispatched run** (`bin/hum-ideation-prefetch`; since 2026-10-20 "new" means a one-off calendar event or a new time for one, a P1 thread that is new or got a reply, a changed task, flights, trip history or a reply-closed task, not timestamps, read state, recurring instances or Edva's own unanswered emails) — if you are running, either inventory is thin or something new came in. Also runnable on-demand. Reads the current reservoir, recent reactions, live data sources, generates 8-15 new proactive ideas, and appends them to `data/hum-ideas.jsonl`. (Cron rate bumped from 2x → 4x on 2026-04-30 to keep reservoir fresh enough that hum always has something valuable to surface.)

Full design context: `system/hum-ideas-reservoir.md`. Read it before anything else.

## Generative framework — SCAMPER (added 2026-04-30) <!-- kernel-guard-ok: SCAMPER is the creative-thinking acronym, not a business -->

Every generation cycle MUST work through SCAMPER as a creative-thinking discipline, not just walk the topic lenses. SCAMPER is what turns "what's in the user's data" into "what's actually worth saying." Each new idea is tagged with both a topic `category` (the 12 lenses below) AND an `idea_lens` (one of the 7 below) so the scorecard can track which combinations produce reactions. <!-- kernel-guard-ok: SCAMPER is the creative-thinking acronym, not a business -->

| SCAMPER lens | Prompt for ideation | <!-- kernel-guard-ok: SCAMPER is the creative-thinking acronym, not a business -->
|---|---|
| **Substitute** | What can be swapped for something better? Replace a habit, route, restaurant, tool, or workflow with an alternative. ("Swap the generic reminder text for a short checklist tailored to the occasion.") |
| **Combine** | What two unrelated signals merge into a stronger move? A free afternoon + a gallery closing + good weather = one Saturday plan. Two stale P1s on the same vendor = one consolidated reply. |
| **Adapt** | What pattern from one domain ports to another? Apply the food-taste authenticity-first heuristic to art shows. Apply one job's recon-then-fan-out shape to a different Edva job. |
| **Modify / Magnify** | What existing thing is too small? Expand a one-off habit into a tracked metric (a step count → a weekly activity trend), grow a working pattern's frequency (a weekly walk → daily neighborhood loop discovery). |
| **Put to other use** | What infrastructure could serve a new purpose? Location history → arrival detection for an expected visitor. Photo metadata → automatic companions backfill (already shipped — keep finding more). |
| **Eliminate** | What can be cut? A stale recurring task, a dead automation, a never-used watchlist row, a contact pattern that no longer fires. Subtraction creates space. |
| **Reverse / Rearrange** | What if you flipped a pattern? Instead of recommending what's NEW, surface what's been MISSED. Instead of asking "what to watch tonight" → "what did we abandon and forget?" Time-reverse: same date last year, what stuck? |

Mix target: each generation cycle should produce ideas across ≥4 of the 7 SCAMPER lenses, not 8 ideas all from the same lens. The category × idea_lens scorecard (Step 2) shows which combinations have produced reactions; under-explored combinations are explore-budget candidates. <!-- kernel-guard-ok: SCAMPER is the creative-thinking acronym, not a business -->

(Why SCAMPER, why now: hum was producing zero pings/day across multiple recent days because candidates kept bottoming out below the 0.45 threshold. Walking the topic lenses without an explicit creative discipline produced "true and relevant but not surprising" ideas. SCAMPER forces the generator to find angles, not just facts.) <!-- kernel-guard-ok: SCAMPER is the creative-thinking acronym, not a business -->

## The goal

**Every idea should be one the user would ❤️ or 👍 react to.** Not one that's merely true or relevant — one that genuinely helps them. Utility is the substance; the reaction is the signal. Anti-sycophancy: ideas earn hearts because they open a new angle, unblock a stuck thing, time-prep a near-term event, or surface a taste-match discovery. Not because they flatter.

## Critical rules

1. **Read-only on external systems.** Calendar, Gmail, Tasks, Slack, Drive, web: read. Never send, label, create, modify.
2. **Only write through `bin/hum-ideas-append`** (Step 7) — never `>>` into `data/hum-ideas.jsonl` yourself. The scorecard is no longer yours to write either (Step 2). The one other file you write is the Step 8 run row.
3. **Never ping Edva, never email, never touch any other hum state file.**
4. **Silent on zero-new-ideas.** If nothing worth adding this cycle, exit 0 with a single `console.log` line — no email, no ping.
5. **Fact-verify every claim before writing.** Never write an idea that asserts a date, fact, or status from LLM training knowledge alone. Any factual assertion in `subject`, `rationale`, or `why_now` must be grounded in one of the live data sources fetched in Step 4 (calendar, tasks, Gmail, trip history, context index, WebSearch). Examples of claims that must be verified — not assumed:
   - Holiday/event dates (religious or secular)
   - Whether something is "still open", "closing soon", "sold out"
   - Whether a P1 email has been replied to or resolved
   - Whether a product, feature, or service has been released
   - Any specific date, price, address, or person claim
   If you can't verify a claim from live data, either verify it with WebSearch or drop the idea. A wrong ping is worse than no ping.

6. **Never derive a flight departure date from a task's due date, and never compute an arrival time by relabeling a calendar timestamp's offset.** Task due dates are administrative reminders, not flight departure times. If you're generating an idea about a specific airline and need the departure OR arrival time, read `data/flights.json` and match on the airline name or confirmation code — its `depart` and `arrive` fields are BOTH authoritative and BOTH already correctly converted; use them verbatim rather than reasoning about a calendar event's raw `dateTime`. Wrong departure pattern: a task "Confirm seat selection on the flight" due Jun 22 does **not** set `time_sensitive_until` to Jun 22 or justify "you're in the 48h window" — the task date is when the user planned to act; the flight may be weeks away. Wrong arrival pattern: the calendar tool returns `dateTime` in whatever offset the calendar was displaying when the event was captured; copying those digits and relabeling them with the destination's offset, instead of converting the underlying instant, is wrong by exactly the gap between the two offsets. Both incidents happened (2026-06-21 and 2026-07-28 → 08-11; details in the local additions). This applies to ANY idea in ANY category, not just `travel-prep`.

7. **Time-to-event arithmetic must use the user's local time (their home timezone) — never UTC hours.** When computing how far away a calendar event is, work entirely in local time. The current local time is available from `situation.time.local_hour` + `situation.time.tz`, or compute it with `toLocaleString` in that zone. The safe method for any event: subtract `Date.now()` from `new Date(event.start.dateTime).getTime()` — both are UTC milliseconds and the subtraction is timezone-agnostic. **Never subtract a UTC clock hour from a local event hour** — that mixing caused a real incident on 2026-05-26 (an event 5.5h away written as "in 2h"). For `event-prep` idea subjects: always use the absolute local time ("Planning call at 5pm — bring one screenshot"), never relative time ("in 2h"), because ideas surface minutes to hours after they are written and the relative time will be stale.

   **This generalizes to calendar-DAY references in EVERY field (`subject`, `rationale`, `why_now`) of EVERY lane — not just clock time in `event-prep` subjects.** Reservoir ideas can surface hours-to-DAYS after authoring, so never bake a relative day word ("today", "tonight", "tomorrow", "this Tuesday", "her day is Tuesday") into the prose — it goes stale. Write the **absolute date** ("Alice's birthday is June 23") AND store the machine-readable date in `supporting_data` (e.g. `alice_birthday: "2026-06-23"`) so the surfacing renderer can recompute "today / was 3 days ago / in 5 days" fresh at ping time. (2026-06-26 incident: a birthday idea authored on the day with "Today's … birthday" in `why_now` surfaced three days later and asserted a false "today". Companion deterministic backstop on the surfacing side: `jobs/hum.md` rule 0a RELATIVE-DATE RE-RESOLUTION.)

   **Day-of-week verification (mandatory, not optional).** Whenever you write a named weekday + date in any field ("Sat Jun 28", "Monday July 1"), you MUST verify the DOW is correct before writing — `new Date("2026-06-28").toLocaleDateString("en-US", {weekday:"long", timeZone: <the home zone>})` → "Sunday", so "Sat Jun 28" is wrong. This is a deterministic check, not a judgment call. Incorrect DOW claims are caught by `ideas.mjs`'s `dowValid()` gate and silently dropped, but it is better to write them correctly than to have ideas dropped silently. (2026-06-27 incident: a "Sat Jun 28 is your last window" idea — June 28 was a Sunday. The context now carries `today_date` and `today_dow` fields — use them as your anchor.)

8. **A failure of Edva's OWN tooling observed from inside your sandbox is NEVER a user-facing idea.** You run with a restricted Bash sandbox that denies the macOS keychain, so `gog` calls fail with `tls: failed to verify certificate: x509: OSStatus -26276` — but `gog` works perfectly in the real cron context (verified: `cron-run -- gog calendar list` returns live data). The same applies to an absent claude.ai MCP connector (Calendar/Gmail can be unavailable in a headless run), a Supabase timeout, a missing `GOG_KEYRING_PASSWORD`, or any "tool X didn't work for me" condition. These are **self-diagnostic / environment signals about your sandbox, not production outages** — you cannot distinguish "broken for the user" from "denied to me" from inside the sandbox, so you must assume the latter. **NEVER write an idea (stuck-task, ops, or any lane) asserting that gog / calendar / tasks / a connector is "broken", "offline", "blind", "failing every tick", or needs an "OAuth reset" / "keychain repair" based on a tool failure you observed.** This is a hard no, even when the failure looks urgent or repeats across runs. (2026-06-22→29 incident: this exact false alarm — "gog x509 TLS / Tasks + Calendar blind in every hum tick" — regenerated for a week and pinged the user repeatedly while gog was actually healthy in production.) If you genuinely suspect a real infra problem, that belongs on the **system channel** via Edva's self-monitoring path — never the user-facing ideas reservoir. For task data, read the pre-fetched file (Step 4); do not call `gog` yourself.

9. **Behavioral-fit memory check — every lens, not just `event-prep` dining (2026-08-16).** Step 6.5's `claim-check` only catches a candidate that a *fact* contradicts (an authority) or that the user has *strongly, recently talked about* (a searchable utterance overlap) — it is a contradiction/settlement gate, not a "does this fit their taste and habits" gate. It cannot catch a candidate that is merely off-pattern with no prior conversation to contradict (one shipped exactly that way, because nothing on file had ever named it; the case is in the local additions). Before drafting a candidate in ANY lens, read the taste/behavioral memory file(s) for the domain it touches and let their rules constrain or disqualify the candidate — not as a post-hoc rejection lookup, but before you pick the specific thing to propose:

   | Domain | Memory file(s) to read first |
   |---|---|
   | Food / dining / pre-show meals | the food taste page (behavioral rules, not just cuisine likes) |
   | Art / photography / galleries | taste profile pages found via `wiki_search "art taste"` |
   | TV / movies / watchlist | the TV taste profile page |
   | Music / concerts | taste profile pages found via `wiki_search "music taste"` |
   | Travel / trip-prep | `index_travel_preferences` and any current-trip page |
   | Gifts / family occasions | `wiki_search "<person> gift"` / `wiki_search "<person> preferences"` |
   | Health / caregiving | relevant person's health memory pages |
   | Anything else with no obvious file | `wiki_search`/`context_search` on the domain before assuming there's nothing to check |

   `context.tastes` (already fetched in Step 4 via `edva context --json`) is a shortcut into some of these, but it is a summary — read the underlying page when the candidate is specific enough that a behavioral rule (not just a like/dislike) could apply. If a domain genuinely has no memory on file, that's fine — proceed — but the check itself (the search) must actually happen, not be assumed away. This generalizes the `event-prep` rule 0 in Step 5's lens table (which stays as the worked example) to every one of the 12 lenses.

## Step 1 — Read state

Parallel:
1. **`data/hum-ideas-digest.json` — read this, not the raw reservoir.** Written nightly (and after every prune) by `bin/hum-reservoir-prune`, it holds the collapsed list of *live* unconsumed ideas plus every dedup block set Step 1.5 used to build by hand — pre-computed deterministically, for free. `hum-ideas.jsonl` itself is a 2.7 MB append-only log with several thousand dead records in it; parsing it by hand is what left this job with 9 turns of budget and 0 ideas to show for them on 2026-08-06. Fall back to the raw log only if the digest is missing or its `generated_at` is more than 36h old — and say so in the Step 8 summary.
2. `data/hum-feedback.jsonl` — last 30 days of reactions
3. `data/hum-runs.jsonl` — last 48 hours of ticks (what was pinged, what was rejected and why)
4. `data/hum-ideas-scorecard.json` — the scorecard (Step 2), already computed

## Step 1.5 — Build the recently-resolved / recently-consumed index

**Every set below is already computed for you in `hum-ideas-digest.json`** (`unconsumed`, `task_ids_blocked`, `thread_ids_blocked`, `consumed_recent`, `unconsumed_thread_ids`). Read them; do not re-derive them. The definitions are kept here because they explain *why* each set exists, and because you still build them by hand in the fallback case where the digest is stale.

**They are also now much smaller, and that is the point.** These sets suppress generation: Rule 1 refuses any idea too close in meaning to an unconsumed subject. On 2026-08-06 the reservoir held 492 "unconsumed" ideas of which **415 were already dead** — 349 past their own `time_sensitive_until`, 51 stale and undated, the rest geo-stale or premise-dead. The surfacing harvester filtered those out and never showed them to the user, but nothing filtered them out *here*, so a graveyard of expired subjects was vetoing new ideas about the same topics. That is the mechanism behind this job producing 3 ideas on a day it ran four times. `hum-reservoir-prune` retires them nightly; the digest reflects only live inventory. If the digest's `unconsumed_live` count is back above ~200, something is wrong with the prune — flag it in the Step 8 summary.

From the already-loaded state (Step 1), the suppression sets are:

- **`task_ids_blocked`** — set of all `supporting_data.task_id` values from ideas where `consumed_at` is within the last 48h. An idea consumed 10h ago means its underlying task was already surfaced; a sibling idea about the same task would look like a repeat to the user.
- **`consumed_recent`** — `{id, subject}` of ideas consumed in the last 48h. Rule 11 compares a new subject against these by embedding.
- **`unconsumed`** — every currently-unconsumed idea's `{id, subject, category, task_id, thread_id}` in the reservoir (`consumed == false` or `consumed` field absent). This catches the case where a previous ideation run already wrote an idea on the same topic that is still waiting to be surfaced — generating a second idea about the same thing fills the reservoir with duplicates that both eventually fire as pings. (2026-06-22: a birthday reminder fired twice because two ideas derived from the same calendar event under different ids.)
- **`unconsumed_thread_ids`** / **`thread_ids_blocked`** — the same two indexes as `task_ids_blocked` but keyed on `supporting_data.thread_id ?? supporting_data.gmail_thread_id` instead of `task_id`. `unconsumed_thread_ids` is every thread id referenced by a currently-unconsumed idea; `thread_ids_blocked` is thread ids from ideas `consumed_at` within the last 48h. A Gmail thread id is the strongest identity signal a `stale-p1` idea can carry — stronger than any subject comparison, because escalating framing ("9 days pending" → "12 days elapsed") changes enough words to dodge keyword dedup while still being the same email. (2026-07-17→27: four ideas about one unanswered email all carried the same thread id but only one had a `task_id`, so Rule 9 never matched; all four sat unconsumed at once.)

Also read `data/hum-resolved-topics.jsonl` (may not exist on first run — treat as empty if absent). This file is appended by the chat-agent whenever the user gives a verbal reply to an ideas ping:

- **`resolved_task_ids`** — set of `task_id` values where `suppress_until > now`
- **`resolved topics`** — rows where `suppress_until > now`; Rule 10 compares against each row's `topic` phrase (legacy rows: their `keywords`, joined)

These sets feed Step 6 (dedup) as Rules 9–12. Do not skip this step even when the reservoir is large — the block sets are cheap to build and prevent the most common class of duplicate-idea surfacing.

## Step 2 — Read the scorecard (computed in code)

`data/hum-ideas-scorecard.json` is rebuilt nightly by `hum-reservoir-prune` (`lib/hum-ideas-scorecard.mjs`, since 2026-10-04): reactions from the last 30 days of `hum-feedback.jsonl` joined to the ideas whose consumed record carries the same `ping_id`, tallied per category (`by_category`) and per category × SCAMPER lens (`by_category_lens`), with `score = (heart*1.0 + up*0.6 + more*1.2 − skip*0.8 − down*1.0) / (sent + 1)`, `silent` = no reaction 6h+ after send, `top` / `bottom`, and `rejected_patterns` (a category with silent/sent > 0.7 at sent ≥ 5 — surfaced, never auto-demoted). **Read it; do not recompute it.** If it is missing, plan as if it were empty. <!-- kernel-guard-ok: SCAMPER is the creative-thinking acronym, not a business -->

## Step 3 — Plan the generation mix

Based on the scorecard:

- **Top-2 categories by score → 50% of new ideas (exploit).** If top-2 are tied with low samples, treat all ≥0.5-score categories as the winning pool.
- **Untested or <3-sample categories → 30% (explore).**
- **Bottom-scoring categories → 20% (retry with variation).** Only include a bottom category this cycle if you can articulate a specific reason-to-retry — e.g., "stale-p1 always failed as a reminder; try escalation-path-only variant." Otherwise skip it this cycle.
- **Avoid `rejected_patterns`** — no new idea whose subject or rationale near-matches a pattern flagged there.

On first run with empty scorecard, generation is uniform across all 12 category lenses.

## Step 4 — Gather live context

**Read `data/hum-ideation-context.json` first** — the trigger wrote it seconds before dispatch (`hum-ideation-prefetch`): `calendar_14d`, `p1_threads` (starred P1, 30d), `flights`, `trip_history`, `context` (`edva context --json`) and `reply_closed_tasks` (see item 2). A source recorded as `{error}` or `null` is unavailable this run — use the MCP fallback below for calendar/Gmail, and never write an idea about the failure (Critical rule 8). Fetch yourself only when the file is missing or its `generated_at` is over 6h old (e.g. a silent-streak refill dispatched outside the trigger).

1. **Calendar** — `calendar_14d` from the context file; fallback `mcp__claude_ai_Google_Calendar__list_events` (primary, next 14 days)
2. **Google Tasks** — read the pre-fetched file `data/hum-ideation-tasks.txt` (written by `trigger-hum-ideation.sh`, which runs unsandboxed via `cron-run` where `gog` works). Parse overdue + open items. **Do NOT call `gog` yourself** — it fails inside this agent's sandbox with `OSStatus -26276` (see Critical rule 8). If the file is missing or empty, treat tasks as unavailable for this run and move on — do NOT fall back to calling `gog`, and do NOT write an idea claiming tasks are broken.
   **A task with STATUS `closed-by-reply` was not done (2026-10-12).** The P1 reply sweep closes a P1's task as soon as the user replies on its email thread, and that reply is often a question back or a partial answer. `hum-ideation-prefetch` marks those rows and lists them in the context file's `reply_closed_tasks` (closure time, thread subject, sender). Its closure proves only that the user wrote back. Never infer anything beyond that: not that documents were sent, went in or were received, not that the matter is finished, and never ask whether it can be treated as done. If you write about it, what is true is that the user replied on that date and the other side has the next move. A sibling task (a follow-up, a later step) does not change this. (2026-10-11 incident in the local additions.)
3. **Gmail** — `p1_threads` from the context file; fallback `mcp__claude_ai_Gmail__search_threads` for `label:p1 is:starred newer_than:30d`
4. **Trip history** — `trip_history` from the context file (`data/trip-history.json`) — upcoming trips
5. **Flights** (`data/flights.json`) — confirmed flights with actual departure AND arrival times, already converted to the correct local offset. **REQUIRED for any idea that mentions an airline and states a departure or arrival/landing time, in ANY category** — not just `travel-prep`. Match the airline/confirmation against this file to get the real `depart`/`arrive` timestamps verbatim before writing `time_sensitive_until` or a clock time into `subject`/`rationale`/`supporting_data`. Never derive an arrival time by relabeling a calendar event's raw offset (see Critical rule 6).
5. **Context index** — `context` from the context file (`edva context --json`) for live project state
6. **WebSearch** for any of these lenses that need it: art/photo shows closing in the next 14 days where the user is, concert announcements matching music-profile, limited-run dining pop-ups, a household member's interests when there is a calendar signal

   **Hard cap: ≤ 5 WebSearch calls per ideation run.** WebSearch is the dominant token/latency line in this job (a self-improvement finding: hum was the biggest cost line in the fleet). Spend the budget on the lenses with a genuine time-sensitive discovery need (closing soon, just-announced); for everything else, lean on the curated editorial sources below and the already-fetched calendar/tasks/context rather than burning a search. If more than 5 lenses look search-worthy in one run, pick the 5 most time-sensitive and defer the rest to the next slot — they'll still be discoverable then.

### Trusted editorial sources to prefer

When WebSearch is open-ended, prefer to verify candidates against — or seed candidates from — the curated editorial sources in the local additions before falling back to general web results.

Respect privacy: don't expand into content the user wouldn't want surfaced on a phone ping (private medical details, etc.).

## Step 5 — Generate ideas (12 category lenses)

Work the lenses in order. Skip a lens if the mix plan says so or if nothing fits.

| Category | Look for |
|---|---|
| `event-prep` | Calendar events in 1-5 days needing context, prep, a decision, research. **Pre-show dining enrichment (required when the event is a show/theater/concert/performance and a pre-event meal is the natural move):** (0) **Read the food taste page first, before any candidate search** — it holds behavioral rules, not just place-level likes/dislikes. A candidate that fails a behavioral rule is disqualified regardless of cuisine or rating; if every candidate near the venue fails it, say so in `rationale` and offer light-bite framing instead of silently picking the least-bad option. (1) Check the trusted-restaurants page next — known-good picks near the venue take priority over WebSearch; (2) Run WebSearch for `"best dinner restaurants walking distance <venue address>"` using the specific address from the calendar event's `location` field; (3) Filter for the user's food taste (cuisines and price band in the local additions); (4) Extract top 2–3 results with name, rating, Google Maps URL; (5) Store as `supporting_data.nearby_restaurants = [{"name": "...", "rating": 4.8, "approx_distance": "3 min walk", "maps_url": "https://maps.google.com/..."}]`; (6) Include restaurant names in the `subject` so the ping is immediately actionable — e.g. `"<Show> 7:30pm — dinner by 6:30: <Place A> (4.8★) or <Place B> (4.9★)"`. Subject ≤80 chars. If fewer than 2 qualifying options are found, include what exists or leave `nearby_restaurants: null` and note the gap in `rationale`. Also see Step 6 rule 6, which extends the memory check below to this lens. |
| `stale-p1` | P1 emails pending >5d — propose **escalation path** (draft reply, call, delegate, close-as-dead). Not a reminder. |
| `weekend-planning` | Sat+Sun openings + time together + the household's constraints (local additions) + art/photo/food lens |
| `travel-prep` | Trip in <14d → pre-flight prep, destination food research, art-show alignment |
| `family` | The household's own occasions and visits (local additions), upcoming birthdays. **Never surface an occasion the user does not observe** (Step 6 rule 7). |
| `<project lenses>` | The instance's own project lenses (their rows are in the local additions) — stuck items needing an unblock, an escalation or a decision. |
| `taste-match` | New galleries, shows, releases matching the user's taste profile (art, photography, music, food) |
| `cross-topic` | Two weak signals → one strong idea (e.g., a free afternoon + a gallery closing + good weather) |
| `stuck-task` | Tasks open >14d — propose an unblock, not a reminder |
| `seasonal-closing` | Exhibits/events ending <7d matching taste |
| `health-care` | Health patterns, upcoming medical appointments, anything actionable from health-data trends |

### Write for where the user will actually BE

A place-bound idea — `dining`, `taste-match`, `weekend-planning`, `seasonal-closing`, `event-prep` — must be actionable from somewhere on the travel timeline. Check `travel list --json` (or the trip data already loaded in Step 4) before writing one, and anchor the subject to a place the user is in or heading to. An idea about a restaurant in a city the user has left is not a near-miss, it is dead on arrival: `hum-idea-locality.mjs` retires the ones it can prove, the ranker deboosts the rest to ~0.28, and either way it has burned the surfacing lane's one nomination for that tick.

This cuts both ways: while the user is away for weeks, **their current city is where the place-bound ideas should be**. Do not keep generating home-city dining and gallery ideas for someone who lands back in a month — they will sit unconsumed, poison the dedup vocabulary against ideas about where the user actually is, and expire before they can be used. Non-place-bound lenses (`stuck-task`, the instance's project lenses, `family`, `stale-p1`, `health-care`) are location-free and should carry the load when the user is somewhere the local lenses can't reach.

### Yield floor — a thin cycle is a bug, not a quiet day

Target is **8–15 ideas per cycle**. If you are about to finish with **fewer than 6**, do not exit yet: that has been the failure mode, not a signal that there was nothing to say. Four cycles a day yielding 0–3 ideas total is what left the reservoir with no fresh local inventory while the `ideas` lane published nothing for two days straight.

Before finishing thin, spend the remaining turns on:
1. **The under-explored SCAMPER × category cells** the scorecard shows have never been tried — the mix plan in Step 3 names them. <!-- kernel-guard-ok: SCAMPER is the creative-thinking acronym, not a business -->
2. **The lenses that don't depend on location or on a live web search** — `stuck-task`, the instance's project lenses, `family`, `health-care`, `edva-systems`. These are always available and never blocked by a trip.
3. **Re-reading what dedup rejected.** If Rule 1 blocked an idea as too close to an unconsumed sibling, the right move is often a *different angle on the same subject* that the sibling doesn't cover — not silence.

If after all that the honest answer is still fewer than 6, write what you have and record `thin_cycle: true` in the Step 8 summary **with the specific reason** (e.g. "calendar empty next 14d, 3 lenses blocked by dedup"). A logged thin cycle is diagnosable; a silent one looks identical to a healthy day and is why this went unnoticed for a week.

## Step 6 — Dedup

**Rules 1, 9 and 12 are enforced by `hum-ideas-append` in code (2026-10-04)** — you will see them come back as refusals in Step 7, so don't spend turns re-deriving them. The rest stay yours.

Never write an idea that:
1. Is a near-duplicate of an **unconsumed idea already in the reservoir** — *enforced in code:* `hum-ideas-append` embeds the subject and refuses it when it is too close (cosine ≥ 0.86) to a live unconsumed idea, reporting the nearest one. This replaced "≥3 shared keywords", which was word-overlap arithmetic on language (Rule #0b) and missed paraphrases ("Alice's birthday is Tuesday" vs "…tomorrow") while blocking unrelated ideas that shared common words. If the new idea genuinely supersedes the old one (new date, escalated stakes, materially different angle), say what changed in `supporting_data.supersedes_reason` — that is the only override.
2. Was **pinged in the last 48h** (check `hum-runs.jsonl` `sonnet.subject` + `sent:true` rows)
3. Was **snoozed / skipped / 👎 in last 7d** (check `hum-feedback.jsonl`)
4. Matches a `rejected_patterns` entry in the scorecard
5. **Was already acknowledged (any reaction or conversational reply) — regardless of how long ago.** Check `hum-feedback.jsonl` (all time, not just 7d) and `context_search` for the idea's subject/topic. An acknowledged ping does not repeat unless: (a) the underlying situation has materially changed (e.g., new dates, new availability, new stakes) AND (b) the time-sensitivity is higher than when it was first sent. Flag the re-surface reason explicitly in `rationale`.
6. **For any idea proposing a specific restaurant, meal, or venue — `dining` and `event-prep` pre-show dining alike, not `dining` only:** run `context_search "<restaurant name>"` — if the restaurant has been mentioned in any prior phone-channel message or memory file AND the user gave negative feedback (too expensive, won't go, "we'll never go", etc.), treat it as permanently rejected. Do not re-surface it. The trusted-restaurants page + the food taste page are the primary rejection signals; the phone-channel transcript context index catches in-conversation rejections. **This is a rejection check on the named place, not a fit check on the occasion — read the food taste page in full for behavioral rules too**, not just as a lookup table for previously-rejected restaurant names. A restaurant with no history and a good rating can still be wrong for the moment it's being proposed into (the incident is in the local additions; fix: rule 0 of the `event-prep` pre-show dining recipe requires reading the food taste page before candidate search).
7. **Never surface an occasion the user does not observe** (the list is in the local additions). This is a hard permanent exclusion — not snoozable, not retryable.
8. **For any idea touching Google Tasks or a project memory file:** read the full task notes AND the relevant memory file before generating a suggestion. If either source contains a "done", "resolved", or "completed" annotation for a sub-item (e.g., "Slides: done", "Booking: done", "**Slides:** done", "HARD STOP — DO NOT SUGGEST"), do NOT surface that sub-item as a prep action — regardless of category (`event-prep`, `stuck-task`, a project lens, `cross-topic`, etc.). The rule once covered only `event-prep`/`stuck-task` and one sub-item suggestion repeated 3+ times despite a "done" note on file; it now applies to ALL categories. A project the user has closed is kept only for historical context — never surface prep actions for it.

9. *(Enforced in code by `hum-ideas-append`.)* **Task-ID block (consumed-sibling dedup)**: if the idea derives from a Google Task (`supporting_data.task_id` present) AND that `task_id` appears in `task_ids_blocked` (consumed ideas in last 48h, Step 1.5) OR in `resolved_task_ids` (from `hum-resolved-topics.jsonl`), skip. Two different ideas about the same underlying task both surface eventually otherwise — and the second always looks like a repeat (2026-06-21: a double-ping from two ideas on one Google Task).

10. *(Enforced in code by `hum-ideas-append`.)* **Resolved-topic block**: an idea whose subject is about the same topic as an unexpired `hum-resolved-topics.jsonl` row is refused — judged by embedding similarity to the row's `topic` (≥ 0.80, `lib/hum-topic-match.mjs`), not by shared words (the old "≥2 content words" rule was word arithmetic on language, Rule #0b). The user explicitly acknowledged this topic; re-ask only after the 48h window, or when the situation materially changed (new deadline, new actors, escalated stakes) — say what changed in `supporting_data.supersedes_reason`, the only override.

11. *(Enforced in code by `hum-ideas-append`.)* **Near-duplicate of recently-consumed**: an idea too close in meaning to one consumed in the last 48h (`consumed_recent`, embedding similarity ≥ 0.86 — replaced "≥4 shared content words") is refused unless `supporting_data.supersedes_reason` says what changed since (new date, escalated urgency, different angle). Near-duplicate subjects with no new angle are noise.

12. *(Enforced in code by `hum-ideas-append`.)* **Thread-ID block (unconsumed + consumed-sibling dedup)**: if the idea references a Gmail thread (`supporting_data.thread_id` or `supporting_data.gmail_thread_id` present) AND that id appears in `unconsumed_thread_ids` (an idea about this exact thread is already sitting unconsumed in the reservoir, Step 1.5), OR in `thread_ids_blocked` (consumed in the last 48h), OR in `resolved_task_ids` via a matching `hum-resolved-topics.jsonl` entry — skip. **Unlike Rule 1, there is no `why_now`-documents-a-change exception here**: a shared Gmail thread id means it's the same email conversation, full stop, and an escalating urgency framing ("9 days" → "12 days elapsed") is not a materially different situation, it's the same situation getting older. If the thread genuinely needs a fresh idea (a new message landed, the deadline changed), that's a new fact to fold into the *existing* unconsumed idea's rationale next time it's read — not grounds to write a fifth entry about it.

## Step 6.5 — Claim-check every surviving idea against memory (MANDATORY, run by Step 7)

Step 6's dedup compares an idea against **other ideas**; claim-check compares it against **what the user actually told us** and what the live authorities say (`bin/claim-check`: Stage 1 authorities — places and dates against the travel timeline; Stage 1.5 freshness; Stage 2 memory — their own dated replies + chat + wiki). **`hum-ideas-append` runs it on every idea that survives the structural rules**, so there is nothing to call by hand. Act on what comes back in Step 7:

| refusal rule | do |
|---|---|
| `claim-check-rewrite` | fix the stale premise using `detail` / `corrected_text` and resubmit the corrected idea. Never resubmit the original wording. |
| `claim-check-drop` | do not resubmit. Count it as `claim_check_dropped` in Step 8. |

It is fail-open (an unreachable authority passes), so it can never block a cycle. **Run `hum-ideas-append` from inside this turn, not from a script** — Stage 2 forks `claude -p`, which needs the turn's keychain (§ Auth Model).

## Step 7 — Write (through `hum-ideas-append`, never `>>`)

Pipe all of this cycle's ideas — JSONL or one JSON array — to the writer in one call:

```bash
printf '%s\n' '<idea 1 JSON>' '<idea 2 JSON>' ... | ~/Dev/edva/bin/hum-ideas-append
```

It validates the schema below (required fields, enums, `task_id` when `draws_on` has `tasks`, `verify_question` when `confidence` is `low`), refuses an id already in the reservoir, enforces Rules 1 / 9 / 12, looks up every `venue` on the map, runs claim-check, appends the survivors with `consumed:false`, and prints `{written:[…], rejected:[{id, rule, detail}]}`. A stored idea never says `evidence_as_of: "live"` (Rule #2): the writer stores the idea's `created_at` there instead. That is housekeeping for whoever reads the stored row; the send-time truth check does not see it today, so it does nothing against a made-up place — only the venue lookup below does. Rejections are data, not errors: fix and resubmit `schema`, `venue-near-too-broad` and `claim-check-rewrite` refusals once; leave the rest. `--dry-run` checks without writing. Each idea's shape:

```json
{
  "id": "idea-<yyyymmdd>-<slug>",
  "created_at": "<ISO8601>",
  "source": "hum-ideation-agent",
  "category": "<one of the 12 topic lenses above>",
  "idea_lens": "<substitute|combine|adapt|modify|put-to-other-use|eliminate|reverse>",
  "subject": "<phone-ping-ready, <60 chars>",
  "rationale": "<1-2 sentences — why useful>",
  "why_now": "<time-sensitivity>",
  "urgency": <0.3-0.9>,
  "time_sensitive_until": "<ISO8601 or null>",
  "draws_on": ["calendar","tasks","email-mem","..."],
  "supporting_data": {
    "task_id": "<Google Tasks task ID — REQUIRED when draws_on includes 'tasks'; enables sibling dedup in Rules 9–11>",
    "thread_id": "<Gmail thread ID — REQUIRED when draws_on includes 'gmail' and the idea is about a specific email; enables the thread-ID dedup in Rule 12. Use this field name (gmail_thread_id is also accepted for backward compat with older ideas).>",
    "wiki_scope": "<wiki page id if project-scoped, e.g. 'reference_<project>' — precheck reads this page to detect if action is already documented/delegated>",
    "location_claim": {"city": "<city>", "on": "<YYYY-MM-DD>"},
    "nearby_restaurants": [{"name": "...", "rating": 4.8, "approx_distance": "3 min walk", "maps_url": "https://maps.google.com/..."}],
    "...": "other fields as needed"
  },
  "confidence": "high|medium|low",
  "verify_question": "<optional — pre-crafted question text when confidence=low>",
  "venue": {"name": "<the place's own name>", "near": "<neighbourhood or town>, <city>"},
  "consumed": false,
  "consumed_at": null,
  "ping_id": null
}
```

### `location_claim` — never freeze where the user is into prose

**If an idea's premise depends on where the user will be, it MUST carry `supporting_data.location_claim` — and the prose must not be the only place that claim lives.**

Reservoir ideas surface hours-to-**days** after they are written, and the itinerary changes underneath them. `location_claim` is the machine-readable version of the premise, so two things can happen that prose makes impossible: `claim-check` re-validates it against the live travel timeline at surface time, and the renderer re-derives the sentence from what is true *then* rather than what was true at authoring.

This is the location-shaped instance of the same rule as Step 7 rule 7 (never bake a relative day word into prose) and `jobs/hum.md` rule 0a. Same failure, different field: **anything derivable should be stored as a reference and re-derived at surface time, never asserted from authoring-time state.**

(2026-07-29 incident: an idea authored with "you're in <city> till <date>" in its subject kept re-dispatching that wording for days after the trip leg changed, while `travel where` returned the new city the whole time. With `location_claim: {city, on}`, the deterministic gate would have dropped it the moment the leg changed.)

**`city` is a travel-timeline metro — never a country, a region or a day-trip town (2026-10-06).** Write the metro `travel where <on>` names for that date ("Springfield", "Shelbyville"), not a country, and not the town a day trip visits: a day trip is anchored at the base. claim-check compares this field by metro key, so a place the timeline cannot resolve can never match and reads as a contradiction. `hum-ideas-append` returns that case as a `schema` refusal naming the base metro — fix the field (and any "you're in …" wording) and resubmit once. A real metro the user will not be in stays a final `claim-check-drop`. (2026-09-26 → 10-05: 10 of 12 location drops at ideation time were a country or day-trip town against the base metro.)

### `venue` — every idea that names a specific place

**An idea that proposes or depends on one specific restaurant, shop, venue, gallery or site MUST carry a top-level `venue: {name, near}`** — `name` as the place calls itself, `near` the neighbourhood or town it is in, written with its city ("<neighbourhood>, <city>"), so a name shared by several places resolves to the right one (a name a map would know; never a country or region). One place per idea; an idea about no particular place leaves `venue` out. (Not `supporting_data.venue`, which older ideas use as free text.) A written idea's `venue` gains the listing it matched.

`hum-ideas-append` looks the place up on the map near `near` before it writes anything. A web page or a memory that mentions a place is not proof it exists or is still open: a place invented by a search summary once went out as a suggestion and the user went looking for it. A low `confidence` and a `verify_question` do not cover this — the question names the same place. What comes back:

| refusal rule | do |
|---|---|
| `venue-not-found` | no such place near there, or it is permanently closed. Do not resubmit it, and do not swap in a name you have not checked. |
| `venue-unverified` | the map lookup could not run (budget stop, network). The idea is held, not written. Do not resubmit it this run; a later run can propose it again once the map answers. |
| `venue-near-too-broad` | `near` is a country or region, too wide to check one place in. Set it to the town or neighbourhood and resubmit once. |
| `schema` naming `venue.near` | the map does not know `near`. Restate it as the neighbourhood or town and resubmit once. |

### `confidence` field — required on every idea

| Level | When to use |
|---|---|
| `"high"` | Fact verified from an authoritative live source: calendar event body read, `flights.json` `depart`/`arrive` fields, Gmail body parsed (not just subject), WebSearch confirmed date/status, `trips.json` confirmed booking |
| `"medium"` | Inferred from one reliable signal, not cross-checked: calendar title matches but body unread, task title clearly implies an action with a real deadline, trip in `trip-history.json` but no flight cross-check |
| `"low"` | Inferred from indirect signals: **task due date used as a proxy for an event date**, email subject only (body not read), LLM training knowledge, guessed from naming patterns, "it's probably X" reasoning |

**Hard rule:** when `confidence: "low"`, always write `verify_question` — a short phone-friendly question that would let the user confirm or correct the premise before any action is taken. The ranker uses this question directly when it converts the idea to a `question` ping. Example: `"Got a task to confirm seat selection by Jun 22 — is the flight actually around then, or is Jun 22 just your reminder date?"`

**Never write `confidence: "high"` for an idea whose urgency timing comes from a task due date.** Task due dates are administrative reminders set by the user at scheduling time — they reflect when they wanted to take action, not when the underlying event (flight, reservation, appointment) actually occurs. Use `"medium"` at best, `"low"` if the timing inference is the whole substance of the idea.

Target: 8-15 new ideas per run. Acceptable range 3-20. Fewer than 3 → prefer writing zero and exiting silent.

## Step 8 — Report

Print to stdout a one-line summary: `wrote N ideas across K categories; claim_check_dropped=D; scorecard: top=<cat>(<score>), bottom=<cat>(<score>)`. Nothing else. No Edva ping. No email.

`claim_check_dropped` is the number of `claim-check-drop` refusals `hum-ideas-append` returned. It is the metric that shows the memory gate is doing work rather than silently passing everything — `hum-review` reads it. `venue_refused` is the number of `venue-not-found` and `venue-unverified` refusals.

**Then append the same numbers to `data/hum-ideation-runs.jsonl`** — stdout dies with the dispatch, and a yield that exists only in a supervisor log is a yield nobody measures. Four cycles a day produced 0–3 ideas for a week before the user noticed from the outside that the `ideas` lane had gone quiet; there was no series anyone could have looked at. One line per run:

```bash
echo '{"ts":"<ISO now>","wrote":<N>,"categories":<K>,"idea_lenses":<L>,"claim_check_dropped":<D>,"venue_refused":<V>,"dedup_blocked":<B>,"thin_cycle":<true|false>,"thin_reason":"<why, or null>","digest_unconsumed_live":<from the digest>,"digest_stale":<true|false>}' \
  >> ~/Dev/edva/data/hum-ideation-runs.jsonl
```

`dedup_blocked` is how many generated ideas Step 6 rejected (your own rules plus `hum-ideas-append`'s `rule-1` / `rule-9` / `rule-12` refusals) — the number that distinguishes "nothing to say" from "everything I had to say was vetoed", which are opposite problems with opposite fixes. Write the row on **every** run, including thin and zero-idea ones; those are the rows worth having.

## On-demand trigger

If a future hum tick calls into this job because the reservoir dropped below 5 unconsumed items (not yet wired — future work), the same playbook applies but with "quick mode": generate 5 ideas, targeting the exploit pool only.
