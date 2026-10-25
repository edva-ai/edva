HUM EXPLORE — at most twice a week, hum sends the best item it held back, while it is still actionable, as an ordinary ping tagged *"Borderline pick:"*. The user's reaction (👍 / reply / 👎 / ignore) calibrates that lane through `hum-engagement`. It asks the user nothing.

> **This instance's own specifics** for this job (its people, places and decisions) are recorded in `agent/local/jobs/hum-explore.md`.

## Why this replaced the canary (2026-10-07)

The weekly canary (Wed 12:00, retired the same day) asked the user, about three held-back items at once, whether they would have wanted those pings; the user found the questions useless and hard to answer, and questioned asking about all of them at once. Three problems no rewording fixes: by Wednesday the items were stale (a lecture that had happened the day before), a numbered-verdict batch is a survey that pays the user nothing, and hum already learns from every ping it sends. The only thing it cannot see is what it did *not* send, and a real send of a borderline item fills that gap without asking anything. (Also found: every canary answer since April had been ignored by the weighting, because canary rows carried no `lane` / `reaction`.)

## How it runs — code, no agent turn

Cron keeps the clock: `agent/scripts/trigger-hum-explore.sh` runs at **12:30 and 17:30 local** (`data/clock-jobs.json`, labels `trigger-hum-explore-midday` / `-evening`; `cron-tz-sync` keeps them on the user's local clock). It only kicks the on-demand launchd agent **`ai.claude.hum-explore`** (`agent/launch-agents/ai.claude.hum-explore.plist`), whose `run-hum-explore.sh` checks the Max login (`lib/max-auth-guard.sh`) and then calls **`bin/hum-explore-run`** (logic in `lib/hum-explore.mjs`, tests in `tests/hum-explore.test.mjs` and `hum-scheduled-senders-launchd.test.mjs`).

**Why launchd (2026-10-15).** A pick goes out through `hum-ping` → `edva-send-curl`, whose resolve-first gate (Opus) and outbound precheck (Sonnet) are `claude -p` calls on the Max login, and cron cannot reach that login. Both gates fail open, so the 17:30 pick that day logged `model unavailable: not_logged_in` and went out unchecked. Under launchd both gates run. With no verified Max login the run is **held** (`[hum-explore] held: …` in `watchdog.log`), never sent unchecked; nobody is paged (watchdog.sh owns Max-outage alerts). If the agent is not installed, `launchd_kick` logs it and posts the install line to the System tab, and nothing is sent. Install once on the host:

```bash
cp ~/Dev/edva/agent/launch-agents/ai.claude.hum-explore.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.claude.hum-explore.plist
```

Most runs decide "skip". In order:

1. **Cadence** (from `explore: true` rows in `hum-feedback.jsonl`): at most **2 sends a week**, at least **48h apart**, and a lane explored in the last 7 days is not explored again.
2. **Moment** (the latest hum tick): there must be a tick in the last 60 min (none means hum is paused or in quiet hours), and it must not be holding for `protected_event` or `pending_question_active`.
3. **Lane is still uncertain:** `DISCRETIONARY_LANES` only (the lanes `hum-engagement` re-weights). A lane is *settled*, and skipped, once ≥ 3.0 of decayed evidence (`laneEvidence()`) points ≥ 60% one way.
4. **Pool:** discretionary harvest candidates from ticks in the **last 3h** (still actionable). It excludes structurally silenced ticks (`cross_send_dedup`, `novelty_duplicate`, `recent_runs_dedup`, `history_blocked`, `wiki_settled`, `pre_rank_vetoed`, `pending_question_active`, `protected_event`), anything that went out as a ping in the last 8 days (by `dedup_key`; an item with **no** `dedup_key` is never sent, because its identity cannot be checked: older traces omitted the key, and signal wording drifts between ticks), the lane that fired on that tick, and items the ranker scored < 0.40. Score = the ranker's near-miss score when it scored that item, else harvest urgency. Ranker-scored items come first. Identity is structural, never word overlap (Rule #0b).
5. **Send** the top item through **`hum-ping`** with `--intent hum:explore:<lane>`. The message (`buildMessage`) has up to three lines, because a bare headline gave the user no context and no link (2026-10-15):
   - `Borderline pick: <the item>`: the harvester signal's first line; a signal cut by the run log's 240-character limit ends at the last whole word with "…";
   - one line on what it is and why it was sent: a source clause for lanes whose item doesn't say it (`LANE_SOURCE`: news "It was the top story on <the feed's publisher> when I checked." (past tense: a pick can be three hours old), talks, art, music; none for dining, watchlist or the installation's own venue lanes), then one of three `WHY_SENT` phrasings (picked by the item's key, so an item always reads the same), e.g. "I almost held it back, so your reaction tells me whether this kind of thing is worth a ping.";
   - the item's own link, which the app shows as a preview card: the `url` the run log keeps for each candidate (`traceCandidate` in `lib/hum-tick-core.mjs`, from the harvester's structured fields: `supporting_data.top.link` for news, `.url` for talks, `.candidate.url` for art/music/new dining, `.maps_url` for the dining harvesters and the user's tagged dining spots), or for older news ticks the `news:<link>` key. No link, no third line.

   `hum-ping` tags the feedback row `explore: true`, and every normal refusal still applies: daily budget and 45-min spacing (exit 11), already-rejected subject (7), cross-send dup (8), semantic dup (9), and the records already answering it (12, the resolve-first gate every hum send passes). A refusal is logged as `EXPLORE_REFUSED` and means "not now". A send is logged as `EXPLORE_SENT` (`mode: "explore"` in the run log).

`hum-explore-run --dry-run` prints the decision without sending; `--json` returns it structured. Run by hand outside the GUI session (SSH, an agent's sandbox) a real send fails both gates open, so to try a real run use `launchctl kickstart gui/$(id -u)/ai.claude.hum-explore`. Failures land in `watchdog.log` as `[hum-explore] FAILED`.

## Replies

Nothing special. A "Borderline pick:" ping is an ordinary ping: chat-agent files its reaction or reply like any other (`chat-agent/CLAUDE.md` § Hum Inbound, Step 3), and `hum-engagement` counts it.

## Safety invariants

- Never bypasses the daily ping budget: `hum:explore:*` is not a protected intent.
- Read-only except through `hum-ping` and the append-only run log.
- Never more than one item per send and two per week. No question, no batch, no explanation of the score (the "why" line says why it was sent, never the number).
- The scheduled run never sends without a verified Max login (`run-hum-explore.sh` holds instead), so the resolve-first gate and the precheck can always run on a pick.
