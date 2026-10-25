SELF IMPROVEMENT PLAN — act on every finding in the weekly review: apply what is safe, card what is complex, ask about what needs the user.

> **This instance's additions** to this playbook (its own people, places and decisions) are in `agent/local/jobs/improvement-plan.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (an ephemeral or by-hand run), `Read` that file before you start.

Runs immediately after the weekly Self Improvement Review (`nightly-review`, Tuesdays 05:00 local), chained by its trigger once the memo has been emailed. Reads the review's own output and gives **every** action item a disposition: built and **applied automatically**, built and **filed as a Face-ID card**, **handed to the user as a question**, or **dropped with a recorded reason**. It is the only job that implements the review's findings — the review itself only classifies (`nightly-review.md` Step 4).

**What changed on 2026-09-29 (rubric schema v4).** The user, replying to that week's review: Improvements cards are reserved for complex, high-blast-radius items and everything else is applied automatically; cards are written in plain language (the problem being solved, its current implications, the proposed solution and any side effects); and everything in the weekly review is acted on, automatically or via Improvements. The review had just counted 304 cards signed since July and none declined, 15 of them in two minutes, so the card queue had stopped working as a decision. Three consequences here: most changes now land on their own through `self-improve-auto-apply`; the 5-item weekly cap applies to **cards**, not to the week's work; and every item leaves this run with a disposition, so nothing silently ages out.

**Why this job exists (2026-07-28).** The review produced a prioritized ACTION ITEMS list every Tuesday and then stopped. Acting on it required the user to read the email, decide, and ask for each fix by hand — so in practice the good findings aged out of the 30-day suggestion window unimplemented. The user asked for the weekly process to generate improvement cards on its own: after the report, a separate process reviews it and makes a plan that triggers the improvements. This is that process. The review still analyses and still emails; this job is what converts its conclusions into work they can approve with a thumb.

**The email still goes out.** This job does not replace, edit, or suppress the review's Step 5 email — that memo is the analysis of record and the user reads it. This job runs *after* it and adds a second, separate output: the cards.

## CRITICAL RULES

1. **The boundary is code, not your judgment.** Every verified change goes to `bin/self-improve-auto-apply` first. It applies the change itself when `lib/self-improve-landing.mjs` says it may — low or moderate risk, at most 5 files and 300 changed lines, no high-blast-radius path (money, outbound messages, calendar, triage, the supervisor, the enforcement hooks), not a new capability, critic `SAFE` — and **exits 3 with the reasons when the change belongs on a card**. Only then do you file it with `self-improve-request`. Never file a card for something auto-apply would have taken, and never try to get something past auto-apply by relabelling it; the rails are judged from the real file set.
2. **Never re-propose something they skipped.** `bin/self-improve-skip list` is the do-not-repropose roster and Step 2 is not optional. A skip that comes back next Tuesday is not a skip, it's a snooze, and it teaches them the button doesn't work. Same for items already `pending` (unsigned) or `applied`.
3. **This job cannot rewrite its own controls.** `data/self-improvement-risk-rubric.md` is the source of truth. FORBIDDEN paths are a hard refusal. The recursion-guard paths (rubric §2.2: this playbook, `nightly-review.md`, `system-issue-review.md`, `self-improvement-executor.md`, the rubric, `self-improve-landing.mjs`, the `self-improve-*` CLIs, the approval core, the agent `CLAUDE.md` files) are out of scope entirely: an improvement to the improvement machinery goes to the user as a question (Step 6c), never into a draft. `self-improve-auto-apply` refuses them too. **Exception, card-only (rubric §2.2, schema v5, 2026-10-22):** the daily-summary repair loop's own files (`bin/daily-summary-fix`, `jobs/daily-summary-fix.md`, `trigger-daily-summary-fix.sh`, `tests/daily-summary-fix.test.mjs`) may be drafted and filed as a Face-ID card; auto-apply exits 3 on them whatever their size.
4. **Every item gets a disposition; only cards are capped.** Automatic changes are not capped — that is the point of them. **Cards are capped at 5 unsigned at any time**, because a card is a decision and five is what a person gets through. **Count them with `~/Dev/edva/bin/self-improve-queue count --json` (`unsigned_live`, `room`) — never by reading `status = pending` off the table.** A card expires 24 hours after it is filed; an expired card can never be signed, so it does not count. Until 2026-10-06 this job counted raw `pending` rows, seven of which were 2 to 55 days past expiry, and filed nothing at all for that reason. The CLI uses `isApprovalRowPending` (`lib/apns-push.mjs`), the same test as the app's badge. A card-worthy item over the cap is carried to next week (`carried: "card-cap"`), not dropped, and the review email lists it.
5. **Nothing lands unverified.** See Step 5. An automatic change has no signature behind it, so its verification is the only thing between the review and the repo: tests, `edva doctor`, and a critic that says `SAFE`. If you cannot exercise a change, shrink it until you can, or turn it into a question.
6. **Plain language, four parts, every time.** Automatic or carded, a change is explained as *What's wrong / Why it matters now / The fix / Side effects*, for a reader without the background. Both CLIs refuse to run without `--problem`, `--impact`, `--fix` and `--side-effects`. Write them as you would to a smart friend who has not seen the code: no file names in the first three parts unless they are the point, no jargon, the evidence in numbers they would recognise.
7. **Budget the turn: ~3 hours** (the trigger caps it at 180 minutes). Per-item durability (Step 6d) makes a truncated run survivable: an item applied or filed and recorded is banked, and the next run carries on from the rest.
8. **Silent by default.** No email, no phone ping, no chat message. An automatic change shows as a green check in the Improvements channel; a card is its own notification; the review email already told them the week's story, and next week's review reports what landed.
9. **Kernel files stay generic** (`agent/CLAUDE.md` § Kernel boundary). A change to a file listed in `system/kernel-manifest.json` carries no personal data: the why and the history go in `system/changelog.md` or the commit message (never a code comment), this installation's rules in `agent/local/` (`jobs/<job>.md` for a playbook's additions), its values in `agent/local/config/<module>.json`, its behaviour in an `_ext/` hook. A new file is classified in the same change (`files` or `personal_globs` in the manifest). Run `bin/kernel-guard` on the result before landing it. `self-improve-auto-apply` exits **8** (`self-improve-request` exits 65) when a change adds personal data to a kernel file or leaves a new file unclassified: move the content as its reasons say and resubmit once — it may not go on a card.

## Pipeline

```
trigger (runs after nightly-review's memo is sent)
  → Step 1  load the review's findings + this job's own state
  → Step 2  subtract what's already decided (skipped / pending / applied / in flight)
  → Step 3  WRITE THE PLAN — a disposition for EVERY pending item, ranked and sequenced
  → Step 4  per item: research the actual code
  → Step 5  per item: author the change + verify it in a throwaway worktree
  → Step 6  per item: land it (auto-apply, or card if auto-apply says so), or ask; record immediately
  → Step 7  persist the plan, sync the review's own tracker, prune
```

## Step 1 — Load inputs

Read, in one parallel batch:

1. `~/Dev/edva/data/nightly-review-state.json` — the review that just ran. The material is:
   - `suggestions[]` where `status: "pending"` — this week's action items, each already carrying the review's own classification (`risk`, `risk_before_rails`, `category`, `rails_hits`, `auto_actionable`, `classifier_rationale`).
   - `auto_apply.last_night_classifications` — the full Step 4a array, including items that did not make the top-5 email cut.
   - `context_gaps[]` / `skill_proposals[]` with `status: "open"` / `"pending"` — lower priority than action items, but eligible when the action items are thin.
2. `~/Dev/edva/data/improvement-plan-state.json` — this job's own state (see § State file). If missing, initialize:
   ```json
   {"schema_version": 1, "last_run": null, "planned": [], "declined": []}
   ```
3. `~/Dev/edva/data/self-improvement-risk-rubric.md` — read it before classifying anything. **If it is unreadable, stop the run and exit**: a missing rubric means missing rails, and this job's entire output is changes to Edva's own source.
4. `~/Dev/edva/data/system-issue-review-state.json` — clusters in `verifying` / `awaiting_approval` / `escalated`. Those are another job's work in flight; do not plan against them.

**Freshness check.** If `nightly-review-state.json.last_run` is more than 24h old, the review did not run (or died before Step 4d). Do not plan from a stale week: log it, write `last_run` with `outcome: "skipped-stale-review"`, and exit. Planning off a week-old analysis produces cards for problems that have already been fixed.

## Step 2 — Subtract what is already decided

Build the exclusion set BEFORE ranking anything, and match on substance (same file + same defect), not on wording — the review re-phrases a recurring finding differently every week.

```bash
~/Dev/edva/bin/self-improve-skip list          # skipped: NEVER re-propose (Critical Rule 2)
```

Exclude an item when any of these is true:

| Signal | Where | Why |
|---|---|---|
| Skipped | `self-improve-skip list` | The user decided against it. Permanent. |
| Card already `pending` and live | `self-improve-queue count --json` → `live[]` | It is on their phone right now, awaiting the same decision. An expired pending card is not on their phone; treat its finding as rejected-by-silence (Step 7), not as in flight. |
| Already `applied` | `self_improve_approvals`, status `applied` | Done. Re-filing re-applies a change already on disk. |
| `apply_failed` | `self_improve_approvals` | Belongs to Retry, not to a fresh card — a new card would double-apply on top of a partial write. |
| Owned by system-issue-review | its state, `verifying` / `awaiting_approval` | Another job is mid-flight on it. |
| Filed by a previous run of this job and still open | `improvement-plan-state.json.planned[]` | Same as pending. |
| Touches a FORBIDDEN rail | the rubric | Hard refusal, not an escalation (Critical Rule 3). |
| Is a change to the improvement machinery itself | Critical Rule 3 | Out of scope; goes to the review email instead. |

Query the card table directly rather than trusting state alone — state can lag a run that was cut short:

```bash
source ~/Dev/edva/.env
curl -s "$SUPABASE_URL/rest/v1/self_improve_approvals?select=id,summary,status,skipped,created_at&order=created_at.desc&limit=60" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

## Step 3 — Write the plan

This is the step the job is named for, and it happens **before** any code is written. Produce an explicit, ordered plan covering **every** pending action item and every open context gap or skill proposal the review marked actionable. Each gets one planned disposition — `build` (to be implemented and landed), `ask` (needs the user's preference or a design choice — Step 6c), or `drop` (already fixed, or research will show the premise is wrong — with the evidence). For each `build`:

```json
{
  "id": "plan-<YYYY-MM-DD>-<n>",
  "source": "<suggestion id / classification id / context-gap id from the review>",
  "title": "<what changes, one line, plain language>",
  "problem": "<what is wrong TODAY — the observable symptom, with evidence>",
  "change": "<the specific edit: which files, what mechanism>",
  "risk": "low | moderate | high",
  "rails_hits": ["<any FORCE-HIGH paths touched>"],
  "blast_radius": "<what else could this break>",
  "verification": "<the exact command that proves it works>",
  "revert": "<how to undo it>",
  "why_now": "<why this week, ahead of the ones you dropped>"
}
```

Ranking, in order of weight:

1. **Recurrence** — a finding the review has now made 2+ weeks running outranks a fresh one. Re-surfacing is the strongest evidence a system has that something genuinely hurts.
2. **Correctness over polish** — a wrong answer Edva gives the user outranks a slow one. Silent wrongness (a mis-filed reply, a missed calendar event, a hallucinated status) outranks a loud failure, which at least announces itself.
3. **Cost of the failure to them** — a missed flight change beats a suboptimal restaurant pick.
4. **Size** — prefer several small, independently-approvable changes over one sprawling refactor. Each card is an atomic approve/skip decision, so a card they can only partly agree with is a card they skip whole.

Then **re-plan anything that does not survive** rather than letting it vanish: an item whose fix you cannot describe concretely becomes an `ask` with the question that would unblock it; an item whose verification you cannot name gets shrunk to the part you can verify (a test first, as its own change), with the rest carried. Record every `drop` in `declined[]` with the evidence so next week's run doesn't re-litigate it. **An item may not leave this step without a disposition** — that is the user's instruction (everything in the review is acted on), and the review email counts dispositions against items.

**Sequencing.** If two items touch the same file, either merge them into one card or file only the first this week — two staged payloads for one file will overwrite each other on apply, and whichever is approved second silently reverts the first. This is the one ordering constraint that actually matters; note it in the plan.

## Step 4 — Research each item

Per planned item, in priority order. Read the real code before writing any of it: the file(s) named in the plan, their tests, their callers, and the git history of the specific lines (`git log -L` or `git log -S`) — a line that has been changed three times is load-bearing in a way its current form does not show.

If research contradicts the plan — the bug isn't where the review said, the fix would be far larger, the behavior is already correct — **amend or drop the item**. The plan was written from the review's summary; the code is ground truth. Record the correction in `declined[]` (with `reason: "research-contradicted-plan"`) so the finding does not simply reappear next week unexamined.

## Step 5 — Author and verify

Write the change as a **staged payload**, never into the working tree:

```json
{"files": {"<repo-relative-path>": "<the complete new content of that file>", "...": "..."}}
```

`files` values are whole files, not diffs — the applier writes them verbatim. So the base you edited must be current: re-read each file immediately before composing the payload, and if it changed since Step 4, redo the edit. A payload built on a stale read silently reverts whatever landed in between.

**Verify in a throwaway worktree.** Staged files aren't on disk, so verification needs somewhere real to run:

```bash
WT=$(mktemp -d -t improvement-plan)
git -C ~/Dev/edva worktree add --detach "$WT" HEAD
# write the payload's files into $WT at their repo-relative paths, then:
cd "$WT" && node --check <each changed .mjs/.js>
cd "$WT" && node --test <the tests covering the touched directories>
git -C ~/Dev/edva worktree remove --force "$WT"
```

The worktree is disposable and isolated — it cannot dirty the host's working tree or trip the pre-commit hook. Clean it up even when verification fails (`worktree remove --force`); an abandoned worktree wedges the next run's `worktree add`.

**Then a critic subagent**, using the same critic contract as `self-improvement-executor.md` § Step 4b. Give it the payload, the plan entry, and the verification output, and ask for the case *against* filing. `SAFE` files the card; anything else drops the item to `declined[]` with the critic's reason.

**Unverifiable ⇒ not filed** (Critical Rule 5). If the change cannot be exercised — no test covers it, the behavior only shows up against live Gmail, it needs a supervisor restart to take effect — you have two honest options: shrink it to a piece you *can* verify (add the test first, as its own card), or drop it and write the finding into the review email's action items next week. Do not file it with "unverified" in the rationale and let the signature carry the risk.

## Step 6 — Land it, card it, or ask

Per surviving `build` item, after Step 5 verified it and the critic said `SAFE` (a critic that said anything else sends the item straight to 6b with its concern in the side-effects part):

**6a. Try to land it automatically — always first.**

```bash
cat > /tmp/plan-<id>-files.json <<'JSON'
{"files": {"<path>": "<complete new content>"}}
JSON
~/Dev/edva/bin/self-improve-auto-apply \
  --summary "<what changes, one line, plain language>" \
  --problem "<what is wrong, as they would notice it>" \
  --impact "<what it costs today, with the evidence>" \
  --fix "<what the change does, not how>" \
  --side-effects "<what else it could affect, or 'none expected' and why>" \
  --details "<how it was verified; how to revert>" \
  --files-json /tmp/plan-<id>-files.json \
  --risk <low|moderate> --category <rubric category> --critic SAFE --source <review item id> \
  --base-rev "$BASE_REV"
```

`BASE_REV` is `git -C ~/Dev/edva rev-parse HEAD`, taken **right before you read the files for THIS item**, not once at the start of the run: an earlier item you landed this run may have changed a file this one also touches (`system/changelog.md` almost always), and its content must be re-read, not reused.

Exit codes decide the next move — do not second-guess them:

| exit | meaning | do |
|---|---|---|
| 0 | applied, committed, pushed, green check posted | record `status: "applied_auto"` with the commit |
| 3 | belongs on a card (the JSON names why) | 6b |
| 4 | a target file carries someone else's uncommitted edits | record `carried: "dirty-file"`; next run retries |
| 5 | the finding looks resolved already | record `status: "dropped-stale"` |
| 6 | syntax error | back to Step 5; it should never get here |
| 7 | a target file changed after you read it (another change landed) — nothing written | re-read the named files, rewrite this item's change against them **once**, re-verify, and resubmit with a fresh `BASE_REV` and `--redo`. A 7 on the `--redo` run: record `carried: "base-moved"`; next run retries. Never merge by hand and never resubmit the old content (the user's rule, 2026-10-22: refuse, then redo) |
| 8 | the change must be redrafted — it adds personal data to a kernel file, or leaves a new file out of `system/kernel-manifest.json` (Critical Rule 9) | move the content where the reasons say (changelog / commit message, `agent/local/`, an `_ext/` hook) or classify the file, re-verify, resubmit **once**. A second 8: record `carried: "kernel-guard"` with the reasons. Never a card |

**6b. File a Face-ID card** — only for exit 3, or a critic that was not `SAFE`, and only while `self-improve-queue count --json` reports `room > 0` (Critical Rule 4). Re-run the count before each card, not once per run:

```bash
~/Dev/edva/bin/self-improve-request --type code-fix \
  --summary "<one line, plain language — the card's title>" \
  --problem "..." --impact "..." --fix "..." --side-effects "..." \
  --details "<the auto-apply refusal reasons; how it was verified; how to revert>" \
  --files-json /tmp/plan-<id>-files.json
```

The side-effects part carries the weight on a card: it is a card precisely because the change reaches something that matters, so say plainly what could go wrong and how they would notice. **If the change would not take effect until a restart**, say so — the CLI adds a notice for boot-loaded paths, but say it in words too.

**6c. Ask** — for `ask` items, and anything that touches the pipeline's own controls. These do not become cards (there is nothing to sign). Write each as one plain-language question with the options, in `improvement-plan-state.json.questions[]` (`{source, rank, question, options[], recommended, recommendation, why_it_matters, asked_at, status: "open"}` — `rank` 1 = most important, `recommended` the 0-based index of the option you recommend, `recommendation` one line on why; `time_sensitive: true` when waiting costs something). **They reach the user one a day in chat** (since 2026-10-22, their choice): the hum `decisions` lane asks the most important open one as a tappable multiple-choice card with your recommended option first, and their answer is written back onto the entry as `status: "answered"`, `answer` (the chosen option's text or their own words), `answer_kind` (`option` / `own_words`), `answered_at`, `answered_via: "chat-decision"`. **At the start of every run, act on every entry answered since the last run** — plan the item their answer unblocks, exactly as if they had replied in the review thread. Next week's review still lists the ones left open, and a reply in the review thread still answers them. Keep each question's text stable once written: the lane keys a decision on its `asked_at` + opening text.

**6d. Record immediately** — before the next item. Append to `improvement-plan-state.json.planned[]`:

```json
{"id": "plan-<date>-<n>", "source": "<review item id>", "disposition": "applied_auto|card|ask|dropped|carried",
 "commit": "<sha if applied>", "approval_id": "<id if carded>", "summary": "<one line>",
 "files": ["<paths>"], "risk": "<rubric risk>", "reason": "<why, for ask/dropped/carried>", "at": "<ISO>"}
```

A run cut off mid-loop still owns every item it landed. An unrecorded one gets re-done next week.

## Step 7 — Persist and prune

Write `improvement-plan-state.json`:

- `last_run` = now (ISO).
- `plan` = the full Step 3 plan, including items dropped later, each with its final disposition.
- `planned[]` = re-affirm every dispositioned item (idempotent with Step 6d).
- `declined[]` = items dropped at Step 3, 4 or 5, each `{source, title, reason, declined_at}`. Consulted by Step 2 next week so the same dead end is not re-explored — but NOT permanent: a decline is this job's judgment, unlike a skip, which is the user's. Prune declines after 60 days; recurrence in the review re-opens one early.
- Advance the status of previously-filed cards by re-reading them: `applied` → `applied` (terminal), `skipped` → `skipped` (terminal, and add it to the never-repropose reasoning), `expired` (or still `pending` past its 24-hour window) → `stale` (it was not approved while it could be; next week's ranking should treat that finding as rejected-by-silence rather than re-filing it). `self-improve-approval-poll` marks an unsigned, unskipped card `expired` on its first tick after the 24 hours run out; skipped cards stay `pending` + skipped, because unskip re-arms them.
- **Sync the review's own tracker.** For every item with a disposition, set its entry in `nightly-review-state.json.suggestions[]` (match on `source` = the suggestion `id`): `status` → `applied` (auto or signed card), `awaiting_approval` (card pending), `asked`, `declined`, or `carried`, plus `resolved_by` (commit or approval id). Until 2026-09-29 nothing wrote this back, so shipped fixes stayed `pending` there forever — the review then counted them as backlog and could re-plan them. Also sweep every older `pending` suggestion whose fix is visibly applied (a card for it `applied` in `self_improve_approvals`, or an `[auto-impl]` commit citing it) and close it the same way.

## State file

`~/Dev/edva/data/improvement-plan-state.json` — written only by this job.

| field | meaning |
|---|---|
| `last_run` | ISO of the last completed run |
| `plan` | the most recent Step 3 plan, with per-item disposition |
| `planned[]` | every item this job dispositioned: applied automatically (commit), carded (`approval_id`), asked, dropped, carried |
| `questions[]` | the plain-language questions waiting on the user (Step 6c) |
| `declined[]` | items considered and dropped, with the reason (60-day retention) |

Card status is authoritative in Supabase, never here — this file records what this job did, and re-reads the table for what became of it.

## Guardrails

- **Never `git add` / `git commit` / edit the working tree yourself.** Changes land only through `self-improve-auto-apply` (which commits file-scoped, pushes, and logs) or `self-improve-request` (which commits only on the user's signature). The exceptions are this job's own state file and the tracker sync in `nightly-review-state.json` (Step 7), which are data, not code.
- **Never send outbound** — no email, no `edva-send-curl`, no `edva-notify`. Cards are the channel.
- **Never approve or sign a card.** A card lands only on a verified Enclave signature from the user's device; the only path from this job to a change landing on its own is `self-improve-auto-apply`, which decides from code what it may take.
- **Clean up worktrees and temp payloads** on every exit path, including failures.
- **Rubric unreadable → exit** (Step 1.3). Rails missing means no run.

## Edge cases

- **The review didn't run this week** → stale-input guard in Step 1; exit without planning.
- **Everything is excluded by Step 2** → a legitimate outcome. Write `last_run` with `outcome: "nothing-new"` and exit silently. A week with no new cards means the queue is current, not that the job failed.
- **A previous run's cards are all still pending** → do not add five more on top. Cap the total *live unsigned* card count (`self-improve-queue count`) at 5: if 4 are already waiting, file at most 1, and carry the rest (`carried: "card-cap"`). Automatic changes are unaffected by the card cap.
- **`self-improve-request` prints "Dropped … duplicate of card <id>"** → the exact same change (same content hash) is already a live, skipped, in-flight or applied card. Nothing was filed. Record the item against that card (`approval_id`) rather than re-filing; if the twin is skipped, treat the item as skipped (Critical Rule 2).
- **Turn budget exhausted mid-item** → stop before Step 6 on the item in flight. An item landed or filed is banked (Step 6d); one half-authored is nothing, and the item stays in the review's suggestion list for next week.
