# Resolve-first — work the answer out before hum floats anything

**Added 2026-10-15.** Every hum question and every hum comment is checked against Edva's own records before it reaches the user's phone. If the records already answer what it asks or leaves open, the question is not asked.

## Why

Working out the answer before asking applies to EVERY question and hum comment before it is floated, regardless of type or context — not to hide anything from the user, but because floating something Edva should already know is unhelpful. It uses the best available model.

The trigger was a hum question whose answer was already on file: the booking records and the user's own travel on the timeline together settled it, so asking only made the user do the lookup Edva could have done.

Every gate in front of a hum send already asked something: is it relevant now (outbound precheck), is it new (dedup, novelty), is it still true (claim-freshness), can the user read it now (motion gate). None asked **does Edva already know the answer?**

## Where it runs: the one point every hum send passes

`bin/edva-send-curl`, for every **chat-channel** message whose `--intent` starts with `hum:`. Every hum sender guarantees one:

| sender | what it sends | intent |
|---|---|---|
| `bin/hum-ping` | every info ping, every lane (the ranker's winner, explore picks, location asks) | the caller's `hum:<lane>:<branch>`; a missing one becomes `hum:<lane>`, a non-hum label is nested under the lane |
| `bin/hum-ask` (new) | every tick question (the agent's `jobs/hum.md` § question, `hum-tick`) | `hum:<lane>:question` |
| `bin/hum-deliver-qual` | queued lane-diagnosis questions | `hum:<lane>:lane-diagnosis` |

It runs **before** the outbound precheck (so a rewritten message is still checked for relevance and freshness) and **regardless of `--skip-precheck`** (so the finance/stocks lanes, which skip the precheck to keep bank rows out of it, are still resolved).

Not covered, by design: `hum-debug` (a system-channel diagnostic, not hum content), and jobs that are not hum (`location-ambient`, location-confirm, digests).

## What it does

`bin/hum-resolve-first` → `lib/hum-resolve-first.mjs`:

1. **Code reads a bounded bundle**, in parallel, 12 s per source, each stamped with when it was read. The kernel's own sources: `calendar` (all calendars, −2/+35 days), `tasks` (Google Tasks), `recent_chat` (24 h of the chat channel), `recall` (wiki, inbox, the user's dated replies, chat — retrieved by the message itself), `email_memory` (`context-search`), `resolved_before` (this gate's own answers, 14 days). An installation adds its own sources as overlay modules in `agent/scripts/hum-resolve-first-sources/_ext/` (one `.mjs` per source, default-exporting `{ id, live?, read() }`; contract in that dir's `.gitkeep`; a kernel id always wins over an overlay one) — for example a travel timeline, a flights file, a reservations store, location history. `agent/local/config/hum-resolve-first.json` sets the bundle's section order (`source_order`; unlisted sources follow, kernel first) and the live sources of record the prompt names (`live_sources`; default the kernel's `calendar` and `tasks` plus any overlay source marked `live`).
   It never reads bank, brokerage or health rows: no source reads them, and an overlay source must not.
2. **One Opus call** (`EDVA_MODEL_OPUS` from `agent/config/models.env`, effort `medium`, tool-less, Max session only via `lib/jev-claude.mjs` — no API key) reads the message, the finding it came from, and the bundle, and returns a verdict: `resolved` / `partial` / `unresolved` / `nothing_to_resolve`, the answer, the sections it relied on, one plain line on what it checked, and the replacement text.
3. **Code checks it**: a resolution must cite at least one section that was actually in the bundle (a citation of a section that failed to load does not count), must carry an answer, and its text must be under 600 characters. A failed check is retried once with the errors; a second failure sends the message unchanged.
4. **Code owns the action table:**

| verdict | action | what the user gets |
|---|---|---|
| `resolved`, worth knowing | `rewrite` | a short FYI: the fact + one line on what was checked |
| `resolved`, adds nothing | `drop` | nothing |
| `partial` | `rewrite` | only the remaining gap, asked specifically, + what was checked |
| `unresolved`, and it asks the user something | `rewrite` | the same question, phrased as the specific unknown, + one line on what was checked and not found; sent as written if the model offers no rewrite |
| `nothing_to_resolve`, any error | `send` | the message as written |

Tappable answer choices survive a rewrite only when the model says they still answer the new question.

### Rules the model is given

- Draw the conclusion the user would from booked facts (a car booked to the airport ahead of the user's own flight = the ride is covered), but no stretching: no reasonable alternative may remain.
- **Rule #2 (freshness):** a status that can change (booking, flight, lease, task, payment, a third party's action) counts only from a live source of record in the bundle (`calendar`, `tasks`, and the installation's live overlay sources, e.g. a travel timeline or bookings file) or from the user's own words. A status found only in an older secondary record may be used only with its date said out loud, never as a current fact. A file-backed source is shown with its last-write time.
- The user's own words outrank everything, including the gate's earlier conclusions.
- **Rule #0 (voice):** warm, specific, plain, under 300 characters, no jargon, no ids, no menus, no mention that anything was held back.
- Every lane: add no money amount, balance, account number or health figure that was not already in the message (the bundle's email and chat can carry figures, and a rewrite goes on to the outbound precheck).

## What the senders do with the outcome

The gate tells the sender through the `--capture-id` file `edva-send-curl` already uses:

- **drop** → the same `{"suppressed": true}` sentinel the precheck writes, tagged `"by": "hum-resolve-first"`, plus a sidecar `<capture>.resolve.json`.
- **rewrite** → a sidecar `{action, verdict, still_question, text, decision_id}`; the id is written as usual once the message posts.

| sender | drop | rewrite to FYI | rewrite to gap |
|---|---|---|---|
| `hum-ping` | exit **12**, no feedback row; retires a reservoir idea (`hum-reservoir-prune --expire`), drops a queued location ask (the pending row stays `asked:false` so the daily summary can still confirm the stop) | exit 0, normal row + `resolve` | exit 0, normal row + `resolve` |
| `hum-ask` | exit **12**, no slot; retires an idea | exit **13**, no slot (nothing to answer) | exit 0, slot holds the gap text the user saw |
| `hum-deliver-qual` | queue dropped, no slot | queue dropped, no slot | slot holds the gap text |

`hum-ask` also fixes an older bug: a precheck hold used to write the pending slot with the sentinel JSON as its message id; it is now exit **14**, no slot. `hum-deliver-qual` had the same bug and the same fix.

`silent_root_cause: "resolved_first"` covers exit 12 in the tick trace (`jobs/hum.md`, `lib/hum-tick-core.mjs`), and `hum-explore` treats it as a structural silence.

## Not re-asking

Settled answers go to `data/hum-resolve-first.jsonl` (`lib/hum-resolve-first-store.mjs`):

- the pre-rank filter (`lib/hum-vetoes.mjs`) vetoes a candidate whose `dedup_key` was **fully** resolved in the last 7 days (`HUM_RESOLVED_WINDOW_D`) as `resolved_first` — a key match, cheap, before the ranker. Same carve-outs as dedup: a protected lane or urgency ≥ 0.9 passes, because a key can stay the same while the situation changes (`travel:<flight>:<depart>`), and the send-time gate re-judges it against fresh records anyway;
- the gate shows its last 14 days of answers to the model, which catches a reworded re-ask.

These are Edva's conclusions, so they are deliberately **not** written to `hum-responses.jsonl`, whose rows are rendered as *"<user> said: …"* (`lib/utterance-store.mjs`). When the user says one is wrong, the chat agent records the correction as usual and runs `hum-resolve-first forget <decision_id|dedup_key>` (`jobs/hum-operations.md` § Step 0c).

## Privacy

Bank and health data are edva-model-only. The gate never reads those rows into its bundle. A finance/stocks/health-lane message and its finding reach Edva's own model here (the Max-session Opus fork; no API key, no connector). Downstream nothing changes: finance/stocks intents still skip the outbound precheck, and `hum:health` still goes through it (deliberately, for its protected-lane treatment there; see `edva-send-curl`). For those three lanes the gate's log row keeps a hash and length instead of any text, and the stored answer keeps only the key and verdict.

## Failure modes

Fail-open everywhere: a missing binary, the kill switch, an unreadable bundle, a model timeout or `not_logged_in`, an answer that fails validation twice, or the 90 s deadline (`HUM_RESOLVE_FIRST_DEADLINE_MS`) all send the message as written and log `verdict: "error"` with the reason. It may make hum quieter or sharper; it may never make hum silent by breaking.

**Scheduled senders run under launchd, not cron.** Cron cannot unlock the Max login (`agent/CLAUDE.md` § Effort Policy): from there the Opus call returns `not_logged_in` and the message goes out as written (an explore pick on 2026-10-15; the outbound precheck failed the same way on an earlier pick). So the two senders the scheduler starts send from the GUI session: cron's `trigger-hum-explore.sh` kicks the on-demand agent `ai.claude.hum-explore` (`run-hum-explore.sh` → `hum-explore-run`), and `trigger-hum.sh`'s fallback tick kicks `ai.claude.hum-deliver-qual` (`run-hum-deliver-qual.sh` → `hum-deliver-qual`) when a lane-diagnosis question is queued. Each runner checks the Max login first (`lib/max-auth-guard.sh`); without it the pick is held and the question stays queued, so neither is sent unchecked. Until a plist is installed (`agent/launch-agents/`), its sender does not run and `launchd_kick` posts the install line to the System tab. Every send from the hum turn itself (the ops agent) was already gated.

Latency: the bundle takes ~5 s (the calendar read is the slowest); the Opus call 5–20 s. Measured on the motivating question: 11.6 s end to end. Callers allow 300 s for `hum-ping` / `hum-ask` (`hum-tick` spawn timeouts; `jobs/hum.md` tells the agent to pass a Bash `timeout` of 300000).

## Operating it

- `hum-resolve-first stats [--since 7d] [--json]` — decisions by verdict, action, lane; errors; median latency.
- `hum-resolve-first tail [-n 10]` — recent decisions with what was sent instead.
- `printf '{"message":"…","intent":"hum:ideas:x"}' | hum-resolve-first --dry-run` — run the whole pass on a message by hand, writing nothing; prints the answer, sources and what was read.
- `hum-resolve-first forget <decision_id|dedup_key>` — withdraw an answer.
- Off switch: `touch data/.hum-resolve-first-off` (or `HUM_RESOLVE_FIRST_OFF=1`).
- Tests: `tests/hum-resolve-first.test.mjs`, `tests/hum-resolve-first-senders.test.mjs`, `tests/hum-qual-delivery.test.mjs`.

## Not done here

- The rule files are outside what the self-improvement pipeline may edit, so these need a human edit: a one-line pointer to this gate in `agent/CLAUDE.md` § Outbound Precheck; a pointer to `jobs/hum-operations.md` § Step 0c (`hum-resolve-first forget`) in `chat-agent/CLAUDE.md` § Hum Inbound Handling; and a line in `docs/agent-effort-policy.md` recording this per-send Opus call (its "never burn Opus on a frequent job" guidance predates it; the user asked for the best model here, ~10–20 calls a day). The policy itself lives in `jobs/hum.md`, `jobs/hum-operations.md`, this doc and `system/architecture.md`.
- A resolved location ask is dropped from the live queue, but the answer is not written to the location record, so the daily summary's Corrections block can still list the stop.
- Non-hum proactive senders (`location-ambient`, digests, watcher pings) are not gated. The same gate could serve them by giving their sends a `hum:`-style intent, but that is a separate decision.
