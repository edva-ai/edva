# Jev — decision model for Edva's classification calls

**Status (2026-09-23): live on the production host at all ten original sites (`p1-resolution` retired 2026-10-04 with the dispatch it gated; `hum-reply-attribute` added 2026-10-04). Jev is primary at every site, with the pre-existing mechanism running as shadow for one week.** The brief: run Jev as primary for all the recommended use cases, with the current mechanism as shadow for one week; log all results; on disagreement between the two, investigate more deeply and suggest fixes to the Jev implementation through the Improvements channel.

## What Jev is

A "System One" decision model from TypeSafe AI (released 2026-09-15). It never writes text. You send a `state` (a string, object or array) plus typed questions, and it returns probabilities:
- `boolean`: returns a probability.
- `choice`: returns the winning option plus a distribution over the options you declared.
- `score`: returns an interpolated value over the levels you declared.

It answers in about 70–500 ms. Input costs $0.042 per million tokens and output is free, so a decision costs about $0.0004. The context limit is 32k tokens for the state plus the longest question.

Known weak spots are numbers, dates and adversarial content. Its confidence is calibrated, which is not the same as correct.

## Transport

- **TypeSafe direct, ONLY** (by the user's decision, not via a gateway). `lib/jev.mjs` calls `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest` (overrides: `JEV_ENDPOINT`, `JEV_MODEL`), `Bearer TYPESAFE_API_KEY` from the production host's `.env` (canonical copy in the password manager). There is no Vercel AI Gateway path any more: the gateway 403'd every call from 2026-09-27 ("Free tier users do not have access to this model") and Jev silently ran 0% for nine days.
- **Native types:** the boolean question type is **`noul`** (`boolean` → 400); `toNative()` maps it, and answers come back as `{type:"noul", noul:p}` (parsed by `answerConfidence`/`boolOf`). `choice`/`score` require `criteria`.
- **Cost:** TypeSafe returns usage, not cost; each call is priced from `usage.input_tokens` at $0.042/MTok (~$0.00001 per decision).
- **Budget:** a prepaid TypeSafe balance, tracked by `bin/jev-budget-check` (daily 9:15 local; config `jev-config.json` `budget`): pages the system channel once at 50/80/95% with the projected run-out date. After a top-up, raise `budget.usd`.
- **Failures:** a permanent error (401/402/403 — bad key, out of credit) opens the breaker and pages once; transient ones (429/5xx/timeouts) fall back to the site's legacy mechanism for that call.
- **Privacy:** TypeSafe states it does not train on inputs; `privacy_exclusions` in `jev-config.json` is the user's call (currently `false`).
- **Client:** `lib/jev.mjs`. This is not an Anthropic call, so the Max-only auth invariant in `agent/CLAUDE.md` is untouched.

## The harness: `lib/jev-shadow.mjs` `decide()`

At every site:
1. **Jev is asked first.** If it answers at or above the site's threshold, its answer is the one acted on (`used: "jev"`).
2. **Otherwise the legacy mechanism's answer is acted on** (`used: "legacy"`). That covers an error, low confidence, a missing key, `touch data/.jev-off`, a site set to `enabled:false`, or a per-call `skipJev` reason such as health exclusion.
3. **During the shadow window the legacy mechanism also runs on every call**, in parallel and in its side-effect-free form, and the two answers are compared.
   - A `same()` of `null` means the comparison is deferred to a late `recordLateComparison` row (email triage).
   - The window starts at Jev's **first successful call** (`shadow_days: 7` in `data/jev-config.json`) and is stamped into `data/jev-shadow/window.json`. That file is gitignored, because a runtime write to a tracked file would block the production host's ff-merge deploys. `shadow_until` in `jev-config.json` is a manual override. After the window closes, legacy runs only as the fallback.
4. **Everything is logged** to `data/jev-shadow/YYYY-MM-DD.jsonl`. That directory is gitignored because it holds mail subjects and chat text. Disagreements also go to `disagreements.jsonl`.
5. **A disagreement is logged, not posted (since 2026-10-11).** Until then each one paged the system channel as `🔀 Jev disagreement [site] …` (capped at 6 an hour). The system channel is only for things the user can or should act on. A single disagreement gives the user nothing to act on, so it now goes only to `disagreements.jsonl`. What the user can act on, a proposed fix, still reaches them as a card from step 6. `jev-shadow-report` counts them from the daily logs on demand. `system-issue-review` still skips `🔀 Jev` rows, for the ones already in its 14-day window.
6. **`jev-disagreement-review`** (checked hourly at :37, ephemeral Opus 5 via launchd `ai.claude.jev-disagreement-review`) does the deeper investigation.
   - Since 2026-10-07 it runs in batches: at 5 pending rows, when the oldest has waited 6 hours, at once for any `email-triage` row, or when the final report is due.
   - It decides who was right; legacy is not ground truth.
   - It clusters Jev's errors by mechanism.
   - It **suggests** fixes as Face-ID cards in the Improvements channel and never applies them itself.
   - Its one allowed remediation is re-starring an email that Jev wrongly silenced.
   - When the week ends it files one final report. Playbook: `agent/ops-agent/jobs/jev-disagreement-review.md`.

**Every Claude call made by the Jev machinery goes through `lib/jev-claude.mjs` `runToolless()`.** That covers every legacy judgment and every shadow.
- **No tools:** it passes `--tools ""`, `--strict-mcp-config` with an empty MCP config, and `--setting-sources project` from a temp cwd, so no tools, MCP servers, user settings or hooks apply. A shadow can't act, even when its prompt describes how the real job would.
- **Max-only billing:** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are stripped from the env.
- **The review job depends on this.** `--allowedTools ""` alone was not enough; it only grants no extra tools.

The question wording, criteria and thresholds live in data, `data/jev-questions/<site>.json`, so most fixes are JSON edits. A kernel site with no file there falls back to the kernel's generic definition, `agent/config/jev-questions/<site>.json` (`jevSiteDef` in `lib/jev.mjs`; an explicit `JEV_QUESTIONS_DIR` is the only source). `{{owner_id}}` / `{{owner_name}}` anywhere in a definition, a question key included (`needs_{{owner_id}}`), become the installation's values. `jev-config.json` `sites.<site>` overrides `enabled` and `threshold`.

**Scoreboard:** `bin/jev-shadow-report [--days N] [--site X] [--json]`.

## Sites

| Site | Where | Jev question(s) | Threshold | Acts alone on | Legacy (shadow + fallback) |
|---|---|---|---|---|---|
| `email-triage` | `lib/jev-email-triage.mjs`, `bin/jev-email-classify`; wired into `gmail-source.mjs` `intakeClassifyP3` on BOTH the live-push and catchup paths. It is async (`execFile`), so it never blocks the supervisor's event loop, and a CLI timeout dispatches rather than stacking local-classify on top | label (7-way choice), priority P1/P2/P3, `needs_<owner_id>` (does the user have to act; the key is built from `instance.cjs` owner_id, `needs_user` by default, so an installation keeps the key its question file uses) | 0.9 | a P3 that doesn't need the user: label + mark read, **no dispatch** — unless `local-triage`'s rules mark the message `escalate: true`, which vetoes the auto-handle at any confidence (2026-09-25: those rules exist because triaging the message has a SIDE EFFECT only the agent performs — the calendar event for a restaurant booking, the P1 stamp on a lab result — and Jev is answering "must the user act", not "can this be filed with no agent turn"). The veto can only withhold an auto-handle, never create one; the pending row records `withheld_by`. A first-contact sender on a consumer mailbox (gmail.com, outlook.com, icloud.com and the like, `FREE_MAIL_DOMAINS` in `local-triage.mjs`, when no email-mem record and no agent-decided `triage_decisions` row names the exact address) is withheld the same way (2026-10-08, `withheld_by: first-contact-free-mail`): Jev reads a free-mail address with a human display name as a person, and filler spam and hijacked-account invites from such addresses came back personal or vendor with spam at 0.16 or less on every instance in the shadow window, so that class goes to the ops agent. On those domains the sender-history anchor matches the full address only, never the domain, because the user's own gmail address is in most triage records. One class is settled before Jev is asked at all (2026-10-06): a curated spam fingerprint, i.e. a `local-triage-rules.json` rule whose verdict is `spam` with escalate false, for a sender not on the P1 list, goes straight to Gmail's Spam folder. Scam mail is built to look urgent, so Jev's needs-the-user answer on it is unreliable, and its sub-threshold veto had been overriding the fingerprint. Below the bar, a Jev answer of P1/P2, needs-the-user, or (2026-10-07) a LABEL different from the legacy label withholds a legacy auto-P3 and dispatches; the label clause took over from the needs-the-user answer when the question learned that a promo call-to-action is not an ask, because a sender-domain consensus can carry two relationships (a business account and consumer promos from the same company) | local-classify; when local would have escalated, a detached tool-less Sonnet classification (`--shadow-sonnet`). Jev P1/P2 → normal ops dispatch; `bin/jev-email-reconcile` (*/15) compares against the ops agent's recorded verdict |
| `message-alert` | `lib/message-alert.mjs` `judgeMessage`, queued (2 at a time) by the iMessage, WhatsApp and Slack runners for every inbound message their own push rules did not already push (a Slack channel message with no @-mention of the user goes to `message-alert-channel` instead) | `level` choice: urgent / important / normal, with the chat's last 10 messages as context (`RECENT_N`); for WhatsApp groups this is the only importance check, the keyword rules are gone (2026-10-27) | 0.8 | urgent/important → a chat ping (`--intent message-alert`, precheck-gated) | a toolless Sonnet judgment with the same rubric |
| `message-alert-channel` | `lib/message-alert.mjs` `judgeMessage` with `rubric: "channel"`: ordinary channel traffic not addressed to the user (today the Slack runner, for a channel message with no @-mention of them, while slack-channel config `channel_alerts` is `named-or-major`, the default). Same queue and log as `message-alert` (log rows carry `rubric: "channel"`) | `level` choice: urgent / important / normal on a stricter rubric: urgent = a really major issue (outage, breach, major-customer or large-money or legal crisis, safety emergency) or a time-critical ask that calls the user by name; important = calls the user by name (the state's `owner_names`) and asks, needs a decision or affects them; everything addressed to someone else (`@Name`) or to the team is normal. Same last-10-message context | 0.8 | urgent/important → the same chat ping | a toolless Sonnet judgment built from this site's question file (`rubricPrompt`), so both rungs read one wording. No shadow week of its own |
| `auto-recall` | `lib/auto-recall.mjs` `judgeRowsPrimary` | one boolean per candidate note | 0.75 | the kept-notes set | the Sonnet judge; the keyword gate if both fail |
| `memory-write-precheck` | `bin/memory-write-precheck.mjs` | `contradiction` boolean | 0.85 | "save" | the Sonnet check, which also supplies the conflict detail when Jev says conflict |
| `suggestion-classify` | `bin/suggestion-classify` `classifyReply` | is_reaction, disposition, reason, strength | 0.8 | the reaction classification | the old regex rules + Gemma (this also takes regex off the user's words, per Rule #0b) |
| `hum-reply-attribute` | `lib/hum-reply-segments.mjs` `modelPick`, called by `suggestion-classify` (`splitMultiAnswer` / `soleTarget`) | one choice per reply segment over the open hum items (`i0..iN`) + `none`; questions built per call | 0.8 on the least certain segment | which open item each segment of a reply answers | the local model's JSON pick; **no keyword fallback** (Rule #0b — this replaced keyword-overlap attribution on 2026-10-04). Health/exercise items stay off Jev |
| *(installation sites)* | the installation's own sites, configured and documented locally | — | — | — | — |
| `hum-place-repeat` | `lib/hum-vetoes.mjs` `findSamePlacePitch`, in the hum pre-rank filter (`preRankFilter`, commit harvests only, never `--preview`). Candidates and comparison rows are restaurant / place recommendations only: the dining lane and ideas in the `dining` / `taste-match` categories (never reminders, logistics, warnings or closings); rows = those headlines from the last 21 days minus any the user deferred (snooze, or a reply classified snoozed / deferred). A tick's checks (at most a dining and an ideas candidate) run in parallel under one 20 s deadline (`HUM_PLACE_REPEAT_DEADLINE_MS`); Jev and Sonnet get only the time left, and past it the check is skipped: no veto, nothing cached, a stderr line. Verdicts cached per (candidate, rows, question) in `data/.cache/hum-place-repeat.json` (3 days) | `same_place`: choice over the earlier recommendations (p0..pN, from `same_place_template`) + `none`: "is the new suggestion re-recommending a place Edva already recommended?" (reminders, follow-ups about a planned visit, warnings, last-chance or closing nudges, a different event at a place mentioned before and mere mentions answer none) | 0.85 | vetoing the candidate (`cross_send_dedup`) and retiring a vetoed idea via `hum-reservoir-prune --expire` (motivated by a restaurant recommended twice, nine days apart, under a second idea id) | a tool-less Sonnet read with the same instructions; no answer from either vetoes nothing. Own shadow week (`shadow_until` 2026-10-20 in the question file, via `alwaysShadow`) |
| `hum-venue-match` | `bin/hum-ideas-append` `judgeVenue`, the venue check on a hum idea that names a place (`venue: {name, near}`), asked only when no map listing near `near` has the same name or listing id. Questions built per call from `venue_template` in the question file (a choice over the listings c0..cN + `none`) | `venue`: is one of these listings the named place, under any spelling, script or translation? (the market, street or building it is said to be in, a similar but different name, or not sure answer none) | 0.85 | which listing the place is; `none` refuses the idea (`venue-not-found`). Nothing during its shadow week | a tool-less Sonnet read with the same rule, then Opus when Sonnet's answer is not a listed id; no answer holds the idea (`venue-unverified`). Own shadow week (`shadow_until` in the question file, via `alwaysShadow`), during which the Sonnet/Opus answer is the verdict and Jev's is only compared: the costly error is a false match letting an invented place through |
| `outbound-precheck` | `bin/outbound-precheck.mjs` via `lib/jev-gates.mjs` `decideGate` | send / suppress / modify | 0.92 | send or suppress (a modify takes Sonnet's rewrite) | the Sonnet precheck. During the week, a Sonnet suppress beats a Jev send. `p1-email` and `hum:exercise`/`hum:health` intents stay off Jev |
| `claim-check` | `bin/claim-check` stage 2 via `decideGate` | pass / rewrite / drop | 0.9 | pass or drop (a rewrite takes Sonnet's text) | the Sonnet stage-2 check; during the week a Sonnet drop beats a Jev pass |
| `claim-freshness` | `lib/claim-freshness.mjs` stage 3 `adjudicate()` | pass / rewrite / drop | 0.9 | pass or drop; on a solicited message a drop needs Sonnet's text (a solicited message can't be dropped) | the Sonnet adjudicator. Stage 1 (claim extraction) stays on Sonnet. Runs inside phone-channel, so it needs a `/restart` to load |
| `claim-freshness-rewrite-check` | `lib/claim-freshness.mjs` stage 3b `checkRewrite()`, run on every rewrite stage 3 produces (2026-10-20, from a weekly review) | accept / reject: did the rewrite only date or remove a claim, replace a value from the travel timeline or a dated row no later reply of the user's contradicts, or drop a question the user answered or dismissed — or did it add a claim or question, close a question the user did not answer, or overrule the user? | 0.9 | accept (the rewrite ships) or reject (the original ships) | the Sonnet `REWRITE_CHECK_PROMPT`; no answer from either sends the original. **Proactive messages only:** a chat reply's check reads the exchange (the user's own words), which never goes to Jev whatever `privacy_exclusions` says, so it stays on Sonnet (`solicited-exchange-excluded`). Own shadow week (`shadow_until` 2026-11-03 in the question file, via `alwaysShadow`), during which a Sonnet reject beats a Jev accept. The Jev path runs in the short-lived proactive callers (`outbound-precheck`, `claim-check`) and is live as soon as it lands; the Sonnet check on chat replies runs inside phone-channel and needs a chat `/restart` to load |
| `hum-ping-gate` | `bin/hum-sense` → `lib/jev-hum-gate.mjs` | worth pinging now? (boolean) | 0.9 | skipping the hum Sonnet turn | the hum turn itself. When Jev skips, a detached tool-less Sonnet check (`bin/jev-gate-shadow`) stands in for it; this is an approximation, since the real turn harvests lanes first. When Jev dispatches, whether the turn actually pinged is recorded as CALIBRATION, not as a comparison, and never pages: the turn is silent on most runs by design and can also be silenced by a downstream gate, so a mismatch there says nothing about either mechanism. Health, exercise, finance and stocks lanes, workout events and idle-only bundles stay off Jev |
| `calendar-hold` | `agent/scripts/hum-sensors/calendar.mjs` `classifyLongEvent`, run by the hum-sense daemon in the background (the sensor never waits on it), once per (event id, `updated`), cached in the calendar sensor's memo `verdicts` and also read by `trigger-hum.sh`'s fallback tick. Asked only about a busy timed event over 3 hours that is on now or starts within the hour (added 2026-10-20: a "<city>" 09:00–19:00 day block held most of a day's hum events) | `kind`: attending / container / unclear, over the title, the length in words, and whether it has a place, a call link, other invitees, an outside organiser | 0.85 | nothing alone: `container` releases hum's in-a-meeting hold only when the Claude ladder also says container and Jev's top answer at any confidence is container (Jev unreachable → the ladder alone); a confident attending/unclear holds without a Claude call; any disagreement holds, during and after the shadow week | a tool-less Sonnet read of the same question, then Opus when Sonnet's answer is not one of the three; no answer holds (the behaviour before). `privacyScreen` is requested but does nothing while `privacy_exclusions` is false; if the guard is switched back on, a title the on-device screen flags stays off Jev (Claude alone answers, input withheld from the log). Own shadow week (`shadow_until` 2026-10-27 in the question file, via `alwaysShadow`) |
| `p1-resolution` | **retired 2026-10-04** | — | — | — | Nothing: the unstar scan became pure code (`bin/p1-unstar-sweep`, Gmail-history STARRED-removed events), so there is no turn left to gate. `bin/jev-p1-gate` is no longer called. See `ops-agent/jobs/p1-resolve.md § Unstar scan` |

**Late comparisons:** for sites where the old mechanism is a job that acts (hum; P1 until 2026-10-04), `lib/jev-pending.mjs` stores a "compare this later" row. It is resolved once and compacted the same way as the email reconciler.

## Health and financial data

**Current setting: everything goes to Jev** (`privacy_exclusions: false` in `data/jev-config.json`). The user chose to pass everything to Jev, after being told Jev is external and runs without zero data retention. This is a named exception to the health rule and financial rule 5 in `agent/CLAUDE.md`, and it covers Jev decision calls only.

The guard is still built, and every site checks `privacyOn()` in `jev-shadow.mjs`. Setting `privacy_exclusions` to `true` (or removing it) restores both layers:
1. **Deterministic exclusion (`skipJev`).** The call runs legacy only, and the input and legacy verdict are withheld from the log. It triggers on:
   - health and financial sender lists (`data/jev-exclude-senders.json`) and local-triage's medical-subject rule;
   - health, exercise, finance and stocks lanes and intents;
   - solicited phone-channel replies;
   - workout events;
   - medical place types.
2. **Content screen (`privacyScreen`).** A fail-closed on-device Gemma yes/no check over exactly the state that would be sent, in 6,000-char chunks.

Unaffected by the switch:
- Bank-alert intents still skip outbound precheck entirely, a separate rule about what precheck may see.
- `p1-email` and idle-bundle skips are logic rules, not privacy ones.
- **So is the protected-lane skip at outbound-precheck** (`hum:<lane>` for the lanes in `agent/local/config/hum-lanes.json` `protected_lanes`). Those lanes stay off Jev because the playbook has already decided the ping fires and the bar is "only an explicit user revocation suppresses" — a rule a confidence threshold cannot encode — not because their content is sensitive. Until 2026-09-24 that skip was implemented inside `privateIntent()`, so turning this switch off un-protected the lanes as a side effect and two protected-lane pings reached Jev the same day. It now lives in `protectedIntent()` in `jev-gates.mjs`, which is never privacy-gated, and `tests/jev-outbound-precheck.test.mjs` pins it with `privacy_exclusions: false` — the configuration that actually runs.

## Cost during and after the week

**During the week:** everything costs what it did before, plus Jev (cents a day) and the Sonnet shadow on email that Jev auto-handles where local would have escalated.

**After the week:** each confident Jev decision replaces a Sonnet `claude -p` or a Gemma call, and every email Jev auto-handles is an ops dispatch avoided, against a context floor of about 150k tokens.

## Gateway health

A Jev call that 403s, 429s or times out falls back to the legacy mechanism and logs
`reason: "jev-error"`. That is correct and silent — which is why a total outage used to look
like a quiet week: no Jev answer means no comparison, so no disagreement, so no
`jev-disagreement-review` run. The signal was suppressed by the thing it should have
reported. It happened for real: the gateway returned 403 "Free tier users do not have access
to this model" on every call from 2026-09-27T06:50Z — 569 consecutive failures over 5 days by
2026-10-01, zero successes — and nothing said so until the end-of-window review went looking.

`decide()` counts consecutive failures across all sites in `jev-shadow/health-state.json`, and
what happens next depends on **which kind of failure it is**. `jev.mjs` decides that at the
source and carries it as data on the thrown error (`status`, `permanent`) — nothing reads the
message text to classify it (Rule #0b).

| Failure | Meaning | Behaviour |
|---|---|---|
| **401 / 402 / 403**, or no API key | A refusal. Retrying cannot clear it; a human changes the plan, the model or the key. | Pages on the **first** one, opens the breaker, **re-pages weekly** while it stands. |
| 429, 5xx, timeout, abort | A wobble. Worth retrying. | Pages once per episode after **4 consecutive errors spanning at least an hour** — both arms, so a capacity burst stays quiet. |

**The breaker** (`breaker_until`, 1 hour) is why a refusal stops costing anything: while it is
open `decide()` skips the gateway entirely, logs the cached refusal with `jev.breaker: true`,
and goes straight to legacy — the same outcome a call would have produced, without the
round-trip. It is a **window, not a latch**: it expires, so the next call after it is a live
probe and a cleared entitlement is picked up within the hour. A latch would recreate the exact
bug this section exists to describe. `reason` stays `"jev-error"` on these rows so
`jev-shadow-report`'s counter keeps seeing them.

A success clears everything and sends the matching `✅ Jev answering again`. Fail-open is
unchanged, and extends to the breaker itself: an unreadable or missing health file means the
call is attempted, never suppressed. The bookkeeping never throws into the decision path.

An alert never claims a last-good time it did not observe — it says `last good call <ts>` only
from a recorded success, otherwise `no successful call on record`. The first version of this
monitor reported "no successful call since" the moment its own state file was created, so a
five-day outage paged as 1.9 hours old. `ok_at` is stamped on **every** successful call (an
atomic temp-file + rename, so the breaker never reads a torn file), not only on recovery: until
2026-10-13 it froze during healthy running, and that day's 12:51Z refusal page said "last good
call 2026-10-11T13:30Z" for a refusal only 16 minutes old.

A 403 of this kind is a billing/entitlement state, not a Edva bug. Edva no longer calls
the Vercel AI Gateway, so a 403 whose text names Vercel is relayed from TypeSafe's upstream.
Edva's own TypeSafe spend is tracked by `jev-budget-check` (`budget.usd` in
`jev-config.json`); the human step is on the TypeSafe account (console.typesafe.ai) or with
TypeSafe. `JEV_NO_ALERT=1` silences both pages (tests set it).
Contract pinned by `tests/jev-shadow.test.mjs`.

## Operating it

- Everything off: `touch ~/Dev/edva/data/.jev-off`.
- One site off: `"sites": {"<site>": {"enabled": false}}` in `jev-config.json`.
- Extend the week: set `shadow_until` in `jev-config.json` (it overrides `jev-shadow/window.json`).
- `suggestion-classify --dry-run` never calls Jev unless `JEV_DRY_RUN=1` is set.
- Production host crontab (not in the repo):
  `*/15 * * * * /opt/homebrew/bin/node $HOME/Dev/edva/bin/cron-run --label jev-email-reconcile -- /opt/homebrew/bin/node $HOME/Dev/edva/bin/jev-email-reconcile >> $HOME/Dev/edva/agent/logs/jev-email-reconcile.log 2>&1`
- launchd: `ai.claude.jev-disagreement-review.plist` → `~/Library/LaunchAgents/`, then `launchctl load` it.
