# Hum's situational trigger framework (`hum-sense`)

**Status:** live as of 2026-08-02. Replaces the flat 20-minute cron as hum's primary driver.

## Why it exists

The principle: hum used to check for available slots, and that is backwards. Situational awareness (location, time of day, the user's current activity) should drive the hum; the cadence mechanism for pushing messages should be active only when the user is completely idle and there is no additional information.

Before this, hum ran on a cadence. Every 20 minutes a cron asked "is there anything worth saying?", ran a 30-lane harvest, and usually decided no. Reactive signals (a location arrival) existed, but they were only ever "a reason to tick sooner" on top of a clock that would have fired regardless. The cadence was the product; situational awareness was decoration.

This inverts it. Hum now fires because *something happened*. The clock survives as one sensor among many — the lowest-salience one — and only speaks when nothing else has.

## The shape

```
    sensors                events              gate                 dispatch
 ┌───────────────┐      ┌──────────┐      ┌────────────┐      ┌───────────────┐
 │ poll: daypart │─────▶│          │      │ expiry     │      │ POST {job:hum,│
 │       location│      │ normalize│─────▶│ dedup      │─────▶│  trigger:event│
 │       calendar│      │  {type,  │      │ quiet hrs  │      │  events:[…],  │
 │       desk …  │      │ salience,│      │ meeting    │      │  lanes:[…]}   │
 ├───────────────┤      │  lanes,  │      │ refractory │      └───────┬───────┘
 │ push: phone-  │─────▶│  dedup}  │      │ coalesce   │              │
 │  channel, CLI │      └──────────┘      │ threshold  │              ▼
 └───────────────┘                        └────────────┘        hum playbook
                                                                (focused harvest)
```

Three files carry the whole design:

| | |
|---|---|
| `lib/hum-events.mjs` | Event schema + **the gate**. `evaluate()` is a pure function — events, state, config, situational gates in; a verdict out. No clock, no I/O, no network. That is what makes it testable and what makes it fast enough to run every 10 seconds. |
| `bin/hum-sense` | The daemon and CLI. The impure shell around the gate: runs sensors, drains the spool, gathers gates, dispatches, keeps state. |
| `data/hum-sensors.json` | The registry. Which sensors exist, how often they poll, and every tuning knob for the gate. Re-read every tick — **no restart needed to enable, disable or retune a sensor.** |

Sensors live in `agent/scripts/hum-sensors/`, one file each.

**Watches ride on the same events (2026-10-23).** Every pass also appends its fresh events to `data/watch-spool.jsonl` and kicks a detached `watch tick`, which checks them against the user's standing "when X, do Y" instructions. That is the only coupling: hum's gate, ledger and dispatch are unchanged, and a slow or broken watch can't stall a tick. See `system/watch.md`.

## Sensor vs. harvester

These are easy to confuse and do genuinely different jobs.

| | harvester (`hum-harvesters/`) | sensor (`hum-sensors/`) |
|---|---|---|
| Question | "Is there something worth *saying* about X?" | "Did X just *change*?" |
| Runs | inside the agent turn, after the gate | in the always-on daemon, before the gate |
| May cost | an LLM call, a web search, 150s | one subprocess, well under a second (one exception, the calendar sensor's background model read of long events, below) |
| Produces | a ranked candidate | an event |
| Failure mode | a quiet lane | a blind sensor (never a dead daemon) |

A sensor must never reason about whether the user *should* be pinged. It reports that the world moved; the gate decides whether that is worth an agent turn; the playbook decides what, if anything, to say. Keeping those three separate is the whole reason this is cheap.

## The event

```jsonc
{
  "type": "location.arrival",       // <sensor>.<edge>; cooldowns and telemetry key off it
  "sensor": "location",
  "subject": "Home",
  "summary": "Arrived at Home",
  "salience": 0.62,                 // 0-1 — how much this moment warrants attention
  "lanes": ["location_context", "dining", "nearby"],  // harvest lanes it makes relevant
  "dedup_key": "location:visit:8812:arrival",
  "ttl_min": 25,                    // after this it is history, not a moment
  "cooldown_min": 30,               // per dedup_key
  "override_quiet": false,          // rare: may cross the quiet-hours gate
  "data": { }                       // anything the playbook might want
}
```

### The salience scale

Salience is the only field worth agonizing over. It is "how much does this moment warrant attention", not "how interesting is the topic" — the topic's interest is the harvester's and the ranker's job.

| | |
|---|---|
| **0.85 – 1.0** | The world materially changed. City change, leaving for an event in 20 minutes. Crosses the refractory window and the soft gates. |
| **0.55 – 0.75** | A real decision point. Arrival somewhere, a meeting ending, rain starting, a workout finishing. |
| **0.40 – 0.55** | A context shift worth noticing. Lunch window opening, back at the desk, motion starting. |
| **0.30 – 0.40** | Ambient. The idle fallback lives here, at 0.36, deliberately the floor. |

### `lanes` is load-bearing

An event declares which harvest lanes it makes relevant. The dispatch passes them through as `lanes`, and the playbook forwards them to `hum-harvest-all.mjs` as `HUM_FOCUS_LANES` — those lanes run immediately regardless of cadence, everything else runs on its normal cadence. That is what makes an event tick fast: react to what actually happened without going blind to whatever else was due.

An **empty** `lanes` list is meaningful, not lazy: it means "no situational hint, harvest everything that's due". Only the `idle` sensor emits that.

**How the lanes actually reach the harvest.** The dispatcher writes them to `data/hum-dispatch-context.json` before it POSTs, and `hum-harvest-all.mjs` reads that file as its **default** source of focus (freshness-gated at 10 minutes, so a stale file can never focus an unrelated later tick). `HUM_FOCUS_LANES` remains as an explicit override, and `meta.focus_source` records which path supplied them (`env` / `dispatch-context` / `none`).

That file is a **list** as of 2026-08-03, not a single record (`schema: 2`, newest fields also mirrored at the top level so an older reader still works). A perishable dispatch can now be folded into a turn that was already queued, so one turn legitimately represents several dispatches: each turn consumes **every** unconsumed entry within the freshness window, unions their lanes, and stamps `consumed_at` so the next turn doesn't re-react to the same moment. With a single slot the older turn harvested against the *newer* moment's lanes and the newer moment was stranded.

Each entry now also carries the events' `data` — an arrival's `lat`/`lon` is the entire input to the `nearby` lane, and re-deriving it inside the harvest would race against the user walking on.

**Beyond lanes, the harvest envelope now carries two more things** (`{situation, context, moment, intent}`):

| | |
|---|---|
| `moment` | What this turn was woken for: the events, their data, `age_min`, and `perishable_age_min`. This is how a lane knows whether it is early enough to be useful. |
| `intent` | What the user is trying to *do* — today's `trip_day_plans` stops plus the user's own recent chat messages, **verbatim and uninterpreted**. Per Rule #0b the reading is done by whichever harvester's model is already looking at it; extracting intent with string matching here is exactly the failure that rule exists to prevent. Built by `lib/hum-intent.mjs`; fail-open, so a missing block just restores the old behaviour. |

This is deliberately not left to the playbook. On day one live the agent was *told* to pass the lanes through and simply didn't: a `location.started_moving` dispatch carrying seven lanes produced a harvest that attempted two unrelated lanes, with every implicated lane sitting in `skipped_cadence`. The trigger fired and the harvest ignored what triggered it. Prose was not load-bearing enough for the one mechanism the whole design depends on.

## The gate

In order. The distinction between **drop** and **hold** is the important part.

| Rule | Effect | Why |
|---|---|---|
| Expiry (`ttl_min`) | drop | A stale edge is not a moment. |
| `dedup_key` cooldown | drop | Keyed on the last *accepted* time, so a suppressed event doesn't extend its own cooldown. |
| Paused / quiet hours / sleeping | drop | The user is asleep. A shop opening at 03:00 is not worth resurfacing at 09:00 — the sensor will re-detect whatever still matters. `override_quiet` is the deliberate exception. Quiet hours are two bands, not one — see below. |
| In a meeting | **hold** | The moment isn't wrong, the timing is. "In a meeting" is the calendar sensor's `hold_id`, not anything on the calendar — see below. |
| Mid-conversation with the chat agent | **hold** | An ambient ping on top of a live exchange is interruption, not ambience. |
| An outstanding hum question | **hold** | One open question at a time. |
| Global refractory (10 min) | **hold** | However interesting the world is, don't ping twice in a row. |
| Coalescing window (25s) | **hold** | Let correlated events join, so an arrival and the calendar event it belongs to ship as one tick. |
| Dynamic salience threshold | **hold** | See below. |

Held events are carried in `state.pending` and re-evaluated every tick until they expire. This is what makes the framework feel attentive rather than twitchy: signals that land during a meeting are still there when it ends, and they arrive together.

Salience ≥ `urgent_salience` (0.9) bypasses every **hold** rule. Nothing bypasses a **drop**.

### What counts as "in a meeting" (changed 2026-10-20)

The calendar sensor's memo carries `current_id` (whatever is on the calendar now; it drives `meeting_ended` / `free_window`, unchanged) and `hold_id` (the event that should hold hum). The `in_meeting` gate in `hum-sense`, and `trigger-hum.sh`'s fallback tick, read only the latter; a memo from before the change has no `hold_id` key and keeps the old reading for one sensor interval.

- All-day, marked free, or declined: no hold.
- Busy and 3 hours or less: holds, exactly as before.
- Busy and longer than 3 hours: whether it is something the user is **attending** (a flight, wedding, conference, concert) or a **container** for the day ("<city>" 09:00–19:00, "Trip day with <friends>", a festival) is language, so a model reads it (Rule #0b) — Jev site `calendar-hold` and a tool-less Sonnet (Opus if Sonnet's answer is unusable). Only both saying `container` releases the hold; a confident Jev attending/unclear, any disagreement, an error or no answer yet all hold. The read runs in the background, never inside the sensor's 20 s budget, once per (event id, `updated`), up to an hour before the event starts, cached in the memo's `verdicts`, retried after 30 min on failure, at most 3 per run.

Overlapping events are each judged, so a call inside a day block still holds. `departure_window` fires for any place: a location counts as one unless it is nothing but call links (a Zoom/Meet/Teams/Webex URL); a venue name followed by a maps link is a place. Why: on a trip, a whole-day "<city>" block held most of a day's hum events; a week's replay with a stand-in model cut `in a meeting` holds by more than a third, while flights and conferences stayed held.

### Self-throttling instead of a daily cap

```
threshold = min(0.9,  0.35 + 0.08 × dispatches_in_last_2h)
```

A quiet day stays fully responsive at 0.35. Four dispatches in two hours and the bar is 0.67 — only real moments get through. It is a slope, not a cliff: hum never hard-refuses something important because it already spoke five times, it just gets progressively harder to impress. `hum-sense status` prints the current threshold.

### Quiet hours have a shoulder (changed 2026-08-03)

`quiet_hours` used to be one blanket window, `00:00–09:00` local, and it cost exactly the hour worth the most: it dropped location edges from the user heading out for the morning just because they landed a few minutes before 9. A morning arrival is the single best moment hum has for saying something locally useful, and it was structurally unreachable.

So the window is now two bands:

| band | hours | behaviour |
|---|---|---|
| **asleep** | `start` → `wake_floor` (00:00–07:00) | Unconditional drop. 03:00 is 03:00. |
| **shoulder** | `wake_floor` → `end` (07:00–09:00) | Quiet **unless something proves the user is up**. |

Two things count as proof, and both are free:

* the activity model reports anything other than `sleeping` / `winding_down`, or
* **the events themselves** — a `location.*` edge, the desk waking, a workout. Someone walking down the street shortly before the window ends is awake, and the event that says so should not be dropped for being early.

With no evidence either way the shoulder stays quiet, so the failure mode is the old behaviour rather than a 07:15 ping on a morning the user slept in. An explicit `activity_state: "sleeping"` still wins inside the shoulder — the user slept in, and the arrival was someone else's.

Implemented as `applyQuietHours()` in `hum-events.mjs`, pure like the rest of the gate, and it reports which band it landed in (`asleep` / `shoulder:awake` / `shoulder:no-evidence` / `day`).

### The excursion model: a state, not an edge (added 2026-08-03)

Every location trigger before this waited for a **confirmed visit at an identified place**, and that premise is wrong in three ways at once. A `visit` row is only written once `location_history` confirms a dwell — 8+ minutes after the user physically arrives, already past useful. Walking a neighbourhood produces transit rows and frequently no visit at all. And it needs a *place*, so it can say nothing until it knows where the user is.

All three can land on one short outing: the visit row is written minutes after arrival, transit rows immediately outrank it, and hum says nothing for the entire outing. An exact identification of the destination is not needed — leaving the base and walking around a neighbourhood should be trigger enough to ask or suggest something.

`hum-sensors/excursion.mjs` tracks the state instead:

* **anchor** — the last place the user sat still for ≥30 min. Overnight that resolves to wherever the user slept; after lunch it becomes the restaurant. Self-calibrating, so it needs no notion of "home" while travelling.
* **out** — more than 250m from the anchor, so a short errand on foot counts.
* **re-survey** — only after 150m of new ground and 12 minutes. This is a **cache key, not a rate limit**: standing still cannot change what is around the user, so re-querying the same circle would return the same places.
* **moving** — inferred from displacement, not the `activity` column, which can read `unknown` on half the rows of a walk.

**The feed underneath it had to be fixed too (client build 163).** None of this works if the phone doesn't report position while the user is out, and it didn't: a walk there and back could produce no rows at all, leaving the feed silent for over an hour. `client/Edva/LocationTracker.swift` now drops a **120m geofence** on the base at every `CLVisit` arrival — iOS wakes the app on region exit reliably, even after termination, so *leaving* is an event rather than an inference. While out it runs `HundredMeters` accuracy, 60s pings regardless of the motion classifier, and no stationary skip (that skip alone could hold GPS off for 20 minutes). Re-entering restores the cheap profile, so the battery cost is bounded to time out of the house.

The sensor also **throws when the newest fix is older than 25 minutes**, rather than doing geometry on a stale position and reporting success — which is how an unclosed visit accrued 85 minutes of phantom dwell and became "base" while the user was back at base.

**Why a sensor is allowed to look up places — and since 2026-10-20, only free ones.** The contract says a sensor reports that the world moved and never reasons about whether the user should be pinged. This holds to it: "there is a subject within 300 m the user has not been told about" is a fact about the world, not a decision to speak. The decision stays in `nearby`'s model call. Until 2026-10-20 the check was two Google Places searches per survey (`--lean --lane hum-excursion` since 10-13); it is now `lib/local-lore.mjs` — Wikipedia geosearch + OpenStreetMap history features via the shared Overpass mirrors, cell-cached, with already-told subjects removed by the identity ledger — so the sensor makes no Google call (`tests/hum-no-places.test.mjs`), re-surveys every 100 m / 6 min instead of 150 m / 12 min, and wakes `nearby, location_context, situation` (the dining lanes are retired; venue picks are ask-first). See `docs/hum-detail.md § nearby`.

The reason to do it there is cost, and it is the point of the design. Checking every GPS ping is right and cheap; waking an agent turn every GPS ping is not. Doing the geometry and the raw-material check in the sensor means the expensive half only runs when there is something to judge — and a walk with nothing worth saying costs **no turn, no tokens, no ping**.

### Relevance is the bar — not frequency

What matters is not the number of pings but whether there is anything relevant and interesting to suggest: an interesting factoid about the location, a question, or a suggestion — and, so as not to overwhelm, only with a high relevance score, especially while walking.

Two consequences, both mechanical rather than advisory:

1. **A perishable moment does not ramp.** The dynamic threshold (`base + 0.08 × recent dispatches`) is a chattiness control, and chattiness is the wrong thing to control. Ramped, a few earlier dispatches push the bar high enough that a walk is held — not for lack of anything to say, but because hum answered an unrelated question an hour earlier. Perishable bundles are now judged at the base threshold. The global refractory still stops two pings landing on top of each other.
2. **The bar moved downstream, where it can see the content.** `nearby` may return a **factoid**, a **question**, or a **suggestion**, and must score its own line 0–1. The floor is enforced in code (0.55 since 2026-10-20, when the lane became local-history only and the user asked for it more often; it was 0.75/0.6 walking/stopped). Anything under the floor is discarded and the user sees nothing, which is a perfectly good outcome.

### Questions waiting: the `questions` sensor (added 2026-10-27)

The question lanes (`dream_asks`, `hum_asks`, `decisions`, `open_questions`) can only reach the user on a hum turn, and turns only happen when something happens. A quiet stretch at one place produces few, so a long queue sat still while the question pool (`lib/question-pacing.mjs`, up to 18 a day at a full backlog) went unused. The `questions` sensor turns the queue into ticks: when the lanes' backlog reports are non-zero, the pending-question slot is free and `checkQuestionBudget` says a question could go now, it emits `questions.waiting` (salience 0.45, `lanes` = the lanes with something waiting). Code-owned counts only.

* The event is **`no_ramp`**: the dynamic threshold treats it like a perishable bundle (base bar), because the question pool is already its rate limiter. Refractory, meetings, the pending slot and quiet hours still apply. `no_ramp` does not make it perishable: no priority source, no locality weighting.
* A questions-only bundle skips Jev and takes the **preview gate** like an idle bundle (`exclusionReason` → `idle-bundle`), previewing its own lanes focused (`HUM_FOCUS_LANES`), so a tick whose lanes are all at their own caps is skipped in code instead of paying for a turn.
* **Every 5 minutes until the queue is empty** (the user's rule, 2026-10-27). A questions-only bundle uses `question_refractory_min` (5) instead of the 10-minute global refractory, and the question pool's spacing is 5 minutes at every backlog. Nothing fires before the quiet-hours `end`. (A first version backed off 20→120 min after ticks that sent nothing; dropped the same day.)

### Perishable events (added 2026-08-03)

An event may declare `perishable: true`: **worth nothing if it arrives late.** An arrival is the canonical case — what is around the user is useful for the few minutes before they pick somewhere and worthless after. Today the `location` sensor and phone-channel's realtime path both set it on arrivals and departures, and `location-enrich-compose` sets it on `location.ask_ready`.

It changes three things downstream:

1. **Dispatch priority.** `buildPayload` sends a perishable bundle with `source: "hum:moment"` instead of `"hum"`, and the supervisor's dispatcher treats `hum:*` as high-priority — it jumps the cron backlog exactly like live email triage. An ordinary cadence tick has already waited 75 minutes and can wait its turn; an arrival cannot.
2. **A freshness kill.** The harvest records `perishable_age_min`, and the `nearby` lane declines past ~15 minutes (8 before 2026-10-20) — and hum-ping refuses, or ping-flush withdraws, a local explanation once the user is more than 300 m from its subject.
3. **Locality weighting.** On a perishable tick, `hum-harvest-all` scales down every candidate with no tie to where the user is standing (0.55×, place-bound and operational lanes exempt). See `jobs/hum.md` Step 3.

### Delivery: fold, don't drop (fixed 2026-08-03)

The supervisor used to **discard** any hum dispatch that arrived while another hum item was queued or in flight — a cadence-era rule whose reasoning ("the 20-min tick re-fetches situation anyway, so stacking is duplicate work") stopped being true the moment hum became event-driven. A `location.arrival` is not interchangeable with a queued `daypart.lunch` tick, and the rule kept the generic one while throwing away the specific one.

It also lied about it: the drop answered HTTP 200, and `dispatch()` treats any 2xx as delivered, so the ledger recorded `delivered: true` and then `no run appeared within 20m` for the same dispatch — which reads as a mysterious agent failure rather than the deliberate discard it was. On 2026-08-03 this swallowed three of eleven dispatches, **all of them arrivals**.

Now:

* the newer moment is **folded** into the hum turn already waiting (its context is in the list, and the harvest consumes every unconsumed entry), so nothing is lost;
* if the incoming moment is perishable and the waiting item is ordinary cadence work, the queued item is **promoted** into the priority region of the queue — urgency can arrive after the item does;
* the supervisor answers **202 `FOLDED`** / `FOLDED+PROMOTED`, the ledger records it as `delivery: "folded"`, and the reconciler stops expecting a run of its own for it.

Queue depth still cannot run away — at most one in-flight plus one queued hum item, which was the original concern.

### After the gate: Jev, the preview, and what the turn may skip (2026-10-04)

Three code-owned steps now sit between "the gate says dispatch" and "a model is paid":

1. **Jev** (`lib/jev-hum-gate.mjs`, since 2026-09-23) may skip an event bundle it is confident offers nothing. Idle-only, health, exercise, finance and stocks bundles never go to Jev.
2. **The preview gate** handles the idle-only (and questions-only) bundles Jev never sees. `hum-harvest-all --preview` is side-effect free (dispatch context left unconsumed; every harvester write under `data` a no-op via `_common.mjs`; model-forking lanes not run, only reported in `meta.preview_skipped_model_lanes`). If it finds **no eligible candidate**, no lane errored and **no model lane was due**, the bundle is skipped in code — ledger kind `preview-skip`, consumed like a Jev skip. Anything else dispatches unchanged. Budget 30s (idle bundles are never perishable); `HUM_PREVIEW_GATE=0` disables it.
3. **Inside the turn**, the harvest applies hum-ping's send-time refusals pre-rank (`lib/hum-vetoes.mjs`) and flags `meta.no_eligible` / `meta.perishable_no_local`; either one means the turn writes a silent trace with no ranking call (`jobs/hum.md` § Pre-rank vetoes).

The hum agent turn is the only ranker. (A code tick runner shadowed it from 2026-10-04 and was retired on 2026-10-22 — decision D16; `jobs/hum.md` § hum-tick.)

## Adding a trigger

Two steps, no restart.

**1.** `agent/scripts/hum-sensors/<name>.mjs`:

```js
import { event, shJson, BIN } from "./_common.mjs";
import path from "node:path";

export const meta = { name: "thermostat", lanes: ["situation"] };

export default async function detect(ctx) {
  const status = await shJson(path.join(BIN, "thermostat"), ["status", "--json"]);
  if (!status) return [];                      // blind, not broken — return nothing

  const out = [];
  // The standard pattern: compare against what you saw last time.
  if (ctx.memo?.heater !== undefined && ctx.memo.heater !== status.heater_on) {
    out.push(event("thermostat", status.heater_on ? "heater_on" : "heater_off", {
      subject: "Home thermostat",
      summary: `Heating ${status.heater_on ? "on" : "off"}`,
      salience: 0.5,
      lanes: ["situation"],
      dedup_key: `thermostat:heater:${status.heater_on}`,
      cooldown_min: 120,
    }));
  }
  ctx.setMemo({ heater: status.heater_on });   // never write your own files
  return out;
}
```

**2.** One entry in `data/hum-sensors.json`:

```json
{ "name": "thermostat", "enabled": true, "script": "thermostat.mjs", "interval_sec": 300,
  "detects": "the heating changed state", "cost": "1 thermostat call" }
```

`tests/hum-sensors.test.mjs` fails if a file exists without a registry entry, or vice versa — the classic way a trigger ends up silently never running.

### Registry overrides (tune without touching code)

| key | effect |
|---|---|
| `enabled: false` | stop running it |
| `interval_sec` | how often it polls |
| `salience_scale` | dial the whole sensor up or down (`0.5` halves everything it emits) |
| `cooldown_min` / `ttl_min` | defaults for events that don't set their own |
| `lanes` | lanes for events that didn't declare any |
| `timeout_sec` | per-run kill (default 20s) |

### Push sources

Anything that already knows something happened can skip the polling entirely: append one JSON line to `data/hum-events-inbox.jsonl` and the daemon drains it within a tick.

```bash
hum-sense emit --type "door.unlocked" --summary "Front door unlocked" --salience 0.7 --lanes situation
```

```js
import { spoolEvent } from "../../lib/hum-events.mjs";
spoolEvent({ type: "door.unlocked", summary: "…", salience: 0.7 }, "homectl");
```

A file rather than a socket on purpose: no port to allocate or authenticate, it survives a daemon restart (events queue and drain), and any process or shell script can write to it in one line. `phone-channel/index.mjs` uses this for realtime location edges. `location-enrich-compose` uses it for `location.ask_ready` (2026-10-06): one perishable event per newly composed location question, lanes `["location_context"]`, so the question goes out within minutes of being composed instead of waiting for an unrelated tick — the location-ask priority lane (`jobs/location-enrich.md` § Timing).

## Operating it

```bash
hum-sense status              # daemon health, current threshold, per-sensor liveness
hum-sense log --since 12      # the joined timeline: events → dispatch → what hum DID
hum-sense once                # one full pass, dry run — prints the verdict and why
hum-sense once --sensor desk  # run one sensor and see exactly what it detects
hum-sense once --dispatch     # …and actually ping
hum-sense tail -n 30          # raw ledger rows
edva hum sense log         # same thing, from the hum CLI
```

### The ledger (`data/hum-events.jsonl`)

Three record kinds, appended in order, so the whole causal chain is on disk:

| `kind` | written when | carries |
|---|---|---|
| `event` | a sensor emits, or the spool is drained | type, salience, lanes, and **the verdict it met** — `dispatched` / `held` / `dropped:<reason>` |
| `jev-skip` / `preview-skip` | the gate said dispatch but Jev (event bundles) or the preview harvest (idle bundles) found nothing worth a turn | `dispatch_id`, event ids/types, lanes, score, and the reason |
| `dispatch` | the gate lets a bundle through | `dispatch_id`, the event ids and types, lanes, score vs. threshold, the port, and whether delivery actually succeeded |
| `outcome` | reconciled afterwards | what the hum turn decided — silent or sent, the ping id, the lane, the ranker's rationale, the `focus_source` the harvest really used, and the lag |

`dispatch_id` is minted at dispatch and threaded through the payload, the dispatch-context file, and the harvest trace (`meta.dispatch_id`), so a harvest can always be tied back to the event that caused it.

**Outcomes are a time join, and say so.** The run trace is authored by the agent turn, and this framework has already learned once not to depend on an agent threading a field through. So the daemon reconciles on its own passes by taking the earliest run following a dispatch within 20 minutes, and every row records `match` to mark it an inference. A dispatch with **no** run in the window is written as `match: "no-run"` rather than quietly forgotten — an agent turn that never happened is exactly the failure this log exists to surface.

When the user asks "why didn't you say anything all afternoon?", this answers precisely — *held: in a meeting*, *dropped: cooldown*, *held: below threshold (0.41 < 0.67)*, *dispatched → stayed silent because the ranker found it already settled* — where the old model could only ever say "the tick found nothing."

### Failure behaviour

* **A sensor throws, hangs, or returns garbage** → recorded in `state.sensors[name].last_error`, surfaced by `hum-sense status`, every other sensor still runs. A blind sensor must never take the engine down.
* **`hum-sense.log` records sensor errors as transitions, not once per poll** (2026-10-13). `last_error` is still set on every failing run; the log gets the first occurrence, a reminder once an hour while the same error persists (`… still failing since T; N repeat(s) not logged`), and `sensor X recovered after Nm` when it clears (`sensorErrorLog` in `lib/hum-events.mjs`, bookkeeping in `error_key` / `error_since` / `error_logged_at` / `error_repeats`). "The same error" is the thrown error's `repeat_key` when the sensor sets one, else the message; a sensor whose message embeds a changing number must set it (excursion's stale-feed throw uses `location_feed_stale`). Before this, the excursion sensor's once-a-minute "location feed stale" while the phone had nothing new to report (asleep, sitting in a cafe) was 96% of the log on 2026-10-10..13.
* **A sensor whose data source is unreachable must THROW, not return `[]`.** This is the one rule that reads as pedantic and isn't. `[]` means "nothing happened", which is indistinguishable from "I can't see" — so a broken sensor looks perfectly healthy in `hum-sense status` precisely because it is doing nothing. Three of the original ten shipped this way and sat blind for hours reporting no errors (`gog` had no `GOG_KEYRING_PASSWORD` under launchd; a personal tool's `--json` output had a shape the sensor never matched). If a quiet source still returns *something* on a quiet day — `gog` prints valid JSON for an empty calendar — then empty output means the probe failed. Throw. Where a genuinely empty result is legitimate, record a `probed_at` in the memo so an idle sensor can still be told from a broken one.
* **The daemon loads `.env` at startup**, because `gog` needs `GOG_KEYRING_PASSWORD` to read its OAuth token from the file-backed keyring and there is no TTY under launchd. Cron-launched triggers get this injected by `cron-run`; a launchd daemon has to do it itself. Any sensor shelling out to a tool that needs a secret depends on this.
* **The supervisor is unhealthy at dispatch time** → the events are *held*, not burned, and retried next tick.
* **The daemon dies** → `trigger-hum.sh` sees a heartbeat older than 5 minutes and reverts to the plain 20-minute cron tick it used to be (`trigger: "watchdog-fallback"`). Hum degrades to quieter and dumber, never to silent. `hum-sense status` says `daemon DOWN`; `edva status` reports the launchagent.

## State

| file | contents |
|---|---|
| `data/hum-sensors.json` | registry + gate config (**checked in** — this is configuration) |
| `data/hum-sense-state.json` | dispatch history, dedup stamps, held events, per-sensor memos (runtime, gitignored) |
| `data/hum-events.jsonl` | the ledger — `event` / `dispatch` / `outcome` rows, the full causal chain (runtime, bounded to 4000 rows) |
| `data/hum-events-inbox.jsonl` | the push spool; normally empty, drained every tick |
| `data/hum-sense-heartbeat.json` | the daemon's liveness stamp, read by `trigger-hum.sh` |
| `data/hum-dispatch-context.json` | `{ts, trigger, lanes, focus, events}` written at every dispatch and read by `hum-harvest-all.mjs` as the default source of focus lanes (runtime) |

Losing any of the runtime files is safe: the engine rebuilds them. The only consequence is that every sensor's first pass re-establishes its baseline — which is exactly why every sensor treats an empty memo as "record what you see, emit nothing."

## What is deliberately NOT here

* **No LLM in the gate.** The gate is arithmetic. Two model reads sit beside it, never inside it: the calendar sensor's background read of busy events over three hours (attending vs. day container, once per event, cached; see the gate section), and Jev's `hum-ping-gate`, which runs after the gate says a moment is eligible (`lib/jev-hum-gate.mjs`). Everything else that reasons starts on the far side of a dispatch, where it is paid for once per real moment instead of once per 20 minutes.
* **No hard daily cap.** The rising threshold does that job without ever refusing something important.
* **`location-ambient` is still independent.** It computes its own proximity trigger for restaurant recs. Coupling two independently-tuned products to one GPS delta risks double-pinging; if that changes it needs its own dedup design against `location-ambient-last.json`.
