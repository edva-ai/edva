SELF-IMPROVEMENT EXECUTOR — the classifier, implementer and critic contracts for self-improvement action items.

> **This instance's additions** to this playbook (its own people, places and decisions) are in `agent/local/jobs/self-improvement-executor.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (an ephemeral or by-hand run), `Read` that file before you start.

> **Schema v4 (2026-09-29) — read this first.** The user: Improvements cards are reserved for complex, high-blast-radius items; everything else is applied automatically. Two things changed, and they override the 2026-08-24 text below wherever it disagrees:
>
> 1. **Who runs it.** The weekly review (`nightly-review.md`) now only runs the Step 4a **classifier** in this file. The implementer and critic contracts (Step 4b) are used by `improvement-plan.md`, which implements every classified item. The review's own Step 4b is retired, because two implementers produced two cards per finding.
> 2. **How a change lands.** A verified change goes to `bin/self-improve-auto-apply` first. It lands on its own — committed, pushed, a green check in the Improvements channel — when `lib/self-improve-landing.mjs` allows: low or moderate risk, at most 5 files and 300 changed lines, no high-blast-radius path, not a new capability, critic `SAFE`. Otherwise it exits 3 and the change goes to `self-improve-request` as a Face-ID card. Both CLIs require the four plain-language parts (`--problem`, `--impact`, `--fix`, `--side-effects`). See rubric §1.0 and §1.4.
>
> 3. **Kernel files stay generic.** `self-improve-auto-apply` exits 8 (`self-improve-request` exits 65) when a change adds personal data to a file in `system/kernel-manifest.json` or leaves a new file unclassified. Neither a card nor a signature lands it: move the content where the reasons say (`system/changelog.md` or the commit message, `agent/local/`, an `_ext/` hook), re-verify, resubmit once. The implementer preamble below carries the rule.
>
> Everything below about "stage, never commit" describes the card path, which is still exactly right for card-worthy changes.

**2026-08-24 text (card path):** Nothing landed without the user's Face-ID signature.

Invoked as Step 4 of `nightly-review.md`, AFTER Step 3.5 (second-critic blindspots) and BEFORE Step 5 (email). This file defines the classifier, implementer, and critic subagent contracts. The rubric + path rails live in `data/self-improvement-risk-rubric.md` — read that file FIRST, it's the source of truth.

## Every item stages for Face-ID approval (2026-08-24) — retires auto-apply entirely

**The user (2026-08-24): no autonomous action — everything the implementer would have done on its own appears in the Improvements channel for an approved run.** Said in reply to a talks-lane auto-quiesce fix that got auto-reverted by the post-implementer gate for a sandboxed `hum-answer` call — but the instruction is general, not about that one incident: the low/moderate silent-commit branch that existed since 2026-04-19 (Phase 1/2, below) is retired outright. It was already the odd one out — `improvement-plan.md`, `system-issue-review.md` §6b, and `hum-action-executor` (redesigned 2026-08-23 for the identical reason) all stage every change through `self-improve-request` and let nothing land without their thumb. This brings the nightly executor in line with its own siblings.

**What changes:** the classifier still scores `low`/`moderate`/`high` (§1 of the rubric) and the path rails still apply (§2) — that machinery is unchanged and still drives prioritization, the card's rationale, and the two hard carve-outs below. What's gone is the distinction that used to matter for whether something could land silently. Now **every** action item that isn't hard-excluded (see below) is investigated and implemented by Step 4b exactly as before, then — on a clean critic verdict — **staged** via `self-improve-request` instead of committed, exactly the same shared entry point HIGH-risk items already used:

```
bin/self-improve-request --type code-fix --summary "<what+why, one line>" \
  --rationale "<detail>" --files-json <path-to-the-staged-map.json>
```

This creates ONE `self_improve_approvals` row + posts the suggestion to the user's app **Improvements channel**; it is applied ONLY after their **Face-ID/Enclave signature** verifies (the deterministic `self-improve-approval-poll` writes the files + commits). The agent can NEVER self-approve. Same mechanism WP11 `propose_module` uses for new capabilities (`--type new-capability`, item `{name, files}`). Verifier core `agent/core/app-approval.mjs`.

**Two things still never get an implementer dispatched at all — this is unchanged and is NOT what "auto-apply" meant:**
1. **FORBIDDEN-path hits** (§2.1 — secrets, credentials, `.env`, `.p8` keys) — hard refusal, no draft is ever produced.
2. **The recursion-guard FORCE-HIGH paths** — `nightly-review.md`, `self-improvement-executor.md`, `self-improvement-risk-rubric.md`, and the agent `CLAUDE.md` files. "This playbook cannot rewrite itself" means the implementer must not even *draft* a change to its own controls, Face-ID or not — a human edits these directly (as this exact change was made). Every other FORCE-HIGH path (outbound CLIs, calendar, financial, auth, supervisor) is now implemented + staged like anything else, since a human signature gates the landing either way.

`architectural_options.length > 1` items also still skip implementation — there's no single fix to draft when the choice of approach is itself the user's to make — and stay in the classic ACTION ITEMS text block (see Step 4c).

## Phase state (2026-04-19, retired 2026-08-24)

**Historical — the phase ladder existed to gate a graduated *auto-apply* rollout that no longer exists.** `nightly-review-state.json.auto_apply.phase` is inert; do not branch on it. The only remaining toggle is `auto_apply.enabled` as a kill switch: `false` skips Step 4b entirely (classification-only, calibration email, same shape as the old "Phase 0"); `true` (current default) runs Step 4b every night. `include_moderate` is likewise inert — every risk tier is treated the same now except the two hard exclusions above.

## Data contracts

### Read (at Step 4 entry)

- `nightly-review-state.json.auto_apply` — toggles (`enabled`, `include_moderate`, `per_night_cap`, `staleness_days`).
- `data/self-improvement-risk-rubric.md` — rubric + rails (mandatory read before classification).
- The Step 3 / Step 3.5 draft — action items the review produced this cycle.

### Write (at Step 4 exit)

- `nightly-review-state.json.suggestions[]` — per-item additions: `risk`, `risk_before_rails`, `category`, `classifier_rationale`, `rails_hits`, `auto_actionable`, and `status` (`awaiting_approval` | `blocked` | `deferred_needs_human`), `self_improve_request_id`, `critic_verdict`, `reverted_reason`.
- `nightly-review-state.json.auto_apply.last_night_*` — `staged_ids[]`, `blocked_ids[]`, `deferred_ids[]`.
- `data/self-improvement-classifier-feedback.jsonl` — append per classification + per the user revert.

## Step 4a — Classifier subagent (runs every night, even when the kill switch is off)

Spawn **one** `Agent` subagent with `subagent_type: "general-purpose"`. It is a pure-reasoning call — no tool use needed.

Prompt template (fill in the action items from Step 3 draft):

> You are the Self-Improvement Review classifier. You score action items as `low` / `moderate` / `high` risk against the rubric below. You also enumerate `architectural_options` — viable alternative approaches the user would care to weigh in on (NOT cosmetic alternatives). If the action item has only one obvious approach, return `architectural_options: []` or a single-element array; if there are 2+ genuine choices (e.g. JSON file vs Supabase column; receiver-side fix vs upstream fix), list them all and add `"architectural_choice"` to `blocking_factors`.
>
> The rubric + path rails are in `data/self-improvement-risk-rubric.md`. READ THAT FILE BEFORE CLASSIFYING. The rubric dictates exact risk categories, hallmarks, and examples. The rails dictate which paths force an escalation regardless of your verdict.
>
> For each action item below, output ONE JSON object matching the schema in the rubric's §3. Classifier prompt contract. Be concrete about `probable_paths` — list the files you'd expect the implementer to touch. If any are rails hits, populate `rails_hits` accurately and set `risk = "high"` (recording your pre-rails assessment in `risk_before_rails`).
>
> Output ONLY a JSON array, no prose, no markdown, no code fences. Each element is one classification.
>
> ACTION ITEMS TO CLASSIFY:
>
> <paste the Step 3 action items here, in their email order, one per numbered entry, including id + text + note>

Parse the returned JSON array. For each entry:

1. Cross-check `rails_hits` against `self-improvement-risk-rubric.md` §2.2 FORCE-HIGH and §2.3 FORCE-MODERATE. If the classifier missed a rail hit, apply it yourself.
2. **Architectural-ambiguity check (schema v2):** if `architectural_options.length > 1`, set `auto_actionable = false` and add `"architectural_choice"` to `blocking_factors` if not already present. The deferral renders in the email's standard ACTION ITEMS block with the options listed inline so the user can pick one.
3. `auto_actionable` no longer means "may land without approval" — everything requires Face-ID now. It means "the implementer may draft this and stage it for approval." Set `auto_actionable = (no FORBIDDEN rails_hits) AND (no recursion-guard rails_hits — nightly-review.md / self-improvement-executor.md / self-improvement-risk-rubric.md / any agent CLAUDE.md) AND (architectural_options.length <= 1)`. **Risk tier no longer gates this — a `high`-risk item is drafted and staged exactly like a `low` one**; risk only drives the card's labeling and the classifier-feedback log. Staleness (`item age < auto_apply.staleness_days`) is no longer a gate either — note it in the item's rationale instead of skipping implementation, since a stale-but-still-correct draft costs the user nothing to decline.
4. Append to `self-improvement-classifier-feedback.jsonl`: `{ts, id, risk, risk_before_rails, rails_hits, architectural_options, auto_actionable, phase}`.

## Step 4b — Implementer subagent

**Skipped only when the kill switch is off** (`auto_apply.enabled = false` — classification-only, calibration email, nothing drafted).

Otherwise, iterate over `auto_actionable` items in priority order (P1 before P2 before P3) up to `auto_apply.per_night_cap` (default 3). For each:

### Snapshot pre-state

A dirty working tree is **expected and safe** — the host almost always carries
unrelated runtime/state drift, and earlier the executor self-held ("held-dirty-tree")
because its revert path was scorched-earth (`git checkout -- . && git clean -fd`)
and would have destroyed that drift. As of 2026-06-23 every git
op the executor performs is **file-scoped to the implementer's own changes**, so a
dirty tree no longer blocks anything. Do NOT skip an auto-apply run because the
tree is dirty.

Snapshot the pre-existing drift so we can later isolate exactly what the
implementer touched:

```bash
PRE_SHA=$(git rev-parse HEAD)
git status --porcelain | sed 's/^...//' | sort -u > /tmp/dirty-pre-<id>.txt  # paths already dirty
edva doctor --json > /tmp/doctor-pre-<id>.json
```

### Dispatch the implementer

Spawn `Agent` with `subagent_type: "general-purpose"`. Tools the subagent may use: `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash` (scoped).

**Mandatory preamble** (paste verbatim into the prompt):

> You are the Self-Improvement Executor IMPLEMENTER. You are drafting a fix for a self-reviewed action item — **you do not commit it and nobody wakes up because of it; it lands only if the user later approves it with Face ID.** Your turn is heavily constrained:
>
> FORBIDDEN (any call to these tools means immediate revert + policy-violation record):
>   - `edva-send-curl`, `edva-notify`, `email-send`, `gmail-action send`,
>     `imsg send`, `hum-answer`, `hum-ping`, `edva hum feedback`,
>     direct curl/wget to `localhost:9092`, `:9093`, `:9090`, or any external host.
>
> ALLOWED: Read, Edit, Write, Glob, Grep, Bash (local filesystem + `node --test`).
>
> WRITE RADIUS: only paths under `~/Dev/edva/` (case-insensitive `dev`/`Dev`). Never `~/.claude/`, never `/Library/`, never `secrets/`, never `credentials/`, never any `.env*`.
>
> GIT: **you do not commit.** Edit files in the working tree as normal (the executor captures your final file contents and reverts the tree after you finish — see Post-implementer gate). You may NOT `git add`, `git commit`, `git push`, `git reset --hard`, `git rebase`, `git checkout --`, `git clean -f`, `git stash`, `git branch`, or any destructive command. At the end of your turn, report every file you created or modified in `files_edited` (exact repo-relative paths) — the gate reads and reverts by that list.
>
> EFFORT: finish the task; write tests if the area has tests; run `node --test` on any test file you touch; run `edva doctor` before you finish.
>
> KERNEL FILES STAY GENERIC (`agent/CLAUDE.md` § Kernel boundary): a file listed in `system/kernel-manifest.json` gets no personal data — no names, places, accounts, routines, dated events, quotes or real IDs; write "the user". The why and the history of the fix go in the `rationale` (it becomes the commit message and the `system/changelog.md` entry), never in a code comment. This installation's rules go in `agent/local/` (`jobs/<job>.md` for a playbook's additions), its values in `agent/local/config/<module>.json` (read with `localConfig`), its behaviour in an `_ext/` hook, real-data tests in a `*-local.test.mjs` file. A new file is added to the manifest (`files` or `personal_globs`) in the same change. Run `bin/kernel-guard` before you finish; it must exit 0.
>
> FINAL OUTPUT (exactly one JSON object, no prose wrapper):
>   {"files_edited": [...], "tests_run": [...], "doctor_after": {"passing": N, "failing": M}, "outbound_calls_made": [], "rationale": "..." }
>
> ACTION ITEM:
> <paste full action item text + classifier rationale>

### Post-implementer gate

```bash
# 0. Isolate the implementer's OWN files = everything changed/added now, MINUS
#    whatever was already dirty before the implementer ran. This is the only set
#    the gate is ever allowed to commit or revert.
git status --porcelain | sed 's/^...//' | sort -u > /tmp/dirty-post-<id>.txt
OWN_FILES=$(comm -13 /tmp/dirty-pre-<id>.txt /tmp/dirty-post-<id>.txt)

# 0b. Collision guard: if the implementer modified a file that was ALREADY dirty
#     pre-run, we cannot safely revert it (doing so would also wipe the unrelated
#     drift on that file). Abort this item, revert only its non-colliding OWN
#     files, record blocked_dirty_collision, and move on.
COLLISIONS=$(comm -12 /tmp/dirty-pre-<id>.txt <(git diff --name-only HEAD | sort -u))
[ -n "$COLLISIONS" ] && DIRTY_COLLISION=1

# 1. Scan the subagent's turn for forbidden tool use. Must mirror the FORBIDDEN
#    list in the preamble verbatim — this regex silently omitted hum-answer,
#    hum-ping, and edva hum feedback until 2026-08-24 (only caught by luck,
#    because the orchestrating agent read the fuller prose list instead of
#    running this literal command).
grep -q -E "edva-send-curl|edva-notify|email-send|gmail-action send|imsg send|hum-answer|hum-ping|edva hum feedback" <turn-transcript> && POLICY_VIOLATION=1

# 2. Run the test files that live in the directories the implementer touched.
TOUCHED_DIRS=$(printf '%s\n' "$OWN_FILES" | xargs -n1 dirname 2>/dev/null | sort -u)
for dir in $TOUCHED_DIRS; do
  ls "$dir"/*.test.mjs >/dev/null 2>&1 && { node --test "$dir"/*.test.mjs || TEST_FAIL=1; }
done

# 3. Doctor check.
edva doctor --json > /tmp/doctor-post-<id>.json
```

If `POLICY_VIOLATION`, `TEST_FAIL`, `DIRTY_COLLISION`, or `doctor` regressed (any
check that was passing in pre-snapshot now fails): revert **only `$OWN_FILES`** —
never the whole tree.

```bash
# Scoped revert — unstage, restore tracked files to PRE_SHA, delete files the
# implementer newly created. NEVER `git checkout -- .` or `git clean -fd` (both
# would destroy unrelated drift; the latter is also blocked by Claude Code
# auto-mode). Iterate the OWN_FILES list explicitly.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  git restore --staged -- "$f" 2>/dev/null
  if git cat-file -e "$PRE_SHA:$f" 2>/dev/null; then
    git checkout "$PRE_SHA" -- "$f"        # existed at PRE_SHA → restore that version
  else
    rm -f -- "$f"                          # implementer-created → remove
  fi
done <<< "$OWN_FILES"
```

### Critic subagent

Only if no prior failure. Spawn another `Agent` with the git diff and the implementer's rationale:

> You are the Self-Improvement Executor CRITIC. Your role is to read the diff with fresh eyes and veto anything that looks wrong.
>
> Read the DIFF first. Then read the RATIONALE. Ask: does the diff do what the item says? Are there regressions? Is any untouched guardrail weakened?
>
> If you need to run tests against the change, use a scratch tree: Make it with `bin/scratch-tree make [--label <name>] [--bundle <files.json>]` (tracked files plus the change, nothing gitignored: no `.env`, no `data`), run in it with `scratch-tree run <dir> -- <command>` (sets `EDVA_HOME` to the copy), and delete it with `scratch-tree remove <dir>` when done. Never copy the tree by hand: a hand copy carries `.env` and its backups into `/tmp`.
>
> Output EXACTLY ONE of these three lines, nothing else:
>   SAFE
>   REVERT: <one-sentence reason>
>   DEFER_TO_OPERATOR: <one-sentence reason>
>
> DIFF (unified, first 400 lines):
> <paste>
>
> RATIONALE: <paste implementer's rationale>
>
> ACTION ITEM: <paste item text>

- `SAFE` **or** `DEFER_TO_OPERATOR` → **stage for approval, never commit.** (The two verdicts now take the same path — with everything gated on their signature already, `DEFER_TO_OPERATOR`'s only remaining effect is that its stated concern gets folded into the card's rationale so the user knows what to weigh.)
  1. Build the bundle from every file in `$OWN_FILES`: `~/Dev/edva/bin/self-improve-bundle --out /tmp/si-<id>-files.json --base-rev "$PRE_SHA" <each file>`. Never assemble the bundle with a hand-written command: on 2026-10-25 one wrote it over the changelog, and a signed card shipped that.
  2. **Scoped-revert `$OWN_FILES` back to `$PRE_SHA`** — the same loop the block path uses (`git restore --staged`, `git checkout "$PRE_SHA" -- <path>` for pre-existing files, `rm -f` for implementer-created ones). The working tree must be clean of this item's diff once this step finishes; the diff lives in the files-json payload, not on disk.
  3. Stage the bundle:
     ```bash
     # schema v4: try self-improve-auto-apply first (same four parts, plus
     # --risk/--category/--critic, and since v5 --base-rev "$PRE_SHA" — exit 7
     # means a file moved on: re-read, regenerate once, resubmit with --redo);
     # only on its exit 3 file the card:
     ~/Dev/edva/bin/self-improve-request --type code-fix \
       --summary "[<item-id>] <what changed, one line, plain language>" \
       --problem "<what is wrong>" --impact "<why it matters now>" \
       --fix "<what the change does>" --side-effects "<what else it could affect; the critic's concern if DEFER_TO_OPERATOR>" \
       --details "<classifier rationale> — <risk>/<category>" \
       --files-json /tmp/si-<id>-files.json
     ```
     This writes a `self_improve_approvals` row and posts the Face-ID card — no separate notify call needed.
  4. If `<item-id>` starts with `hum-i-`, append one row to `data/hum-interventions.jsonl`: `{"id":"<item-id>","applied_at":null,"approval_id":"<id from the tool's output>","commit":null,"lane":"<lane>","hypothesis":"<from idea>","predicted_effect":<from idea>,"status":"awaiting_approval"}`. **Known gap, not solved here (matches `hum-action-executor.md`'s identical note):** `self-improve-approval-poll`'s `applyItem()` writes a fixed commit message with no way to inject the `[hum-intervention id=...]` trailer, so this row's `commit`/`applied_at` stay null until something backfills them from `self_improve_approvals` by `approval_id` — filed as a follow-on item rather than solved inline here.
- `REVERT` → run the **scoped `$OWN_FILES` revert loop** from the post-implementer gate (unstage → `git checkout "$PRE_SHA" -- <f>` for tracked, `rm -f` for new) + record block reason. Never `git checkout -- .` / `git clean -fd`. **No card is filed** — a diff the critic vetoed shouldn't cost the user a decision.

### Record result

Update the item in `nightly-review-state.json.suggestions[]`:

```json
{
  "id": "s-...",
  "status": "awaiting_approval" | "blocked" | "deferred_needs_human",
  "risk": "...",
  "self_improve_request_id": "<id>",
  "critic_verdict": "SAFE" | "REVERT: ..." | "DEFER_TO_OPERATOR: ...",
  "doctor_before": {"passing": N, "failing": M},
  "doctor_after":  {"passing": N, "failing": M},
  "reverted_reason": null | "policy_violation" | "test_failure" | "doctor_regression" | "critic_revert" | "dirty_collision"
}
```

`deferred_needs_human` is for the two hard exclusions (FORBIDDEN / recursion-guard rails, or `architectural_options.length > 1`) — items that never reach an implementer at all and stay in the classic ACTION ITEMS text block. `blocked` and `awaiting_approval` both went through the implementer; `blocked` means the gate or critic caught a problem and nothing was staged.

## Step 4c — Collate for email

Three buckets:

- **STAGED FOR YOUR APPROVAL** — `status: awaiting_approval`, list with `[category · risk]`, one line pointing at the Improvements channel card (no inline diff — the card is the review surface).
- **BLOCKED** — `status: blocked`, reason, item text (so the user can retry manually, or ask for it again next run).
- **NEEDS YOUR INPUT** — `status: deferred_needs_human`, rendered in the classic ACTION ITEMS block: either a design choice (`architectural_options` listed inline) or a change to the review/executor's own controls that only a human can make.

## Email section template

```
STAGED FOR YOUR APPROVAL TONIGHT (N) — cards posted to the Improvements channel
1. [bug-fix · low] <short title>
   tests: <N> passed · doctor: M/T → M/T · approval id <id>
2. ...

BLOCKED (M)
1. <title>
   Reason: <policy_violation | test_failure | doctor_regression | critic_revert>
   Item text: <…>

NEEDS YOUR INPUT (K) — reply "N: YES / N: NO / N: LATER"
1. [HIGH · <category>] <title>
   Why: touches self-improvement's own controls — a human has to make this edit
2. [LOW · <category>] <title>
   Why: architectural_choice — pick an approach
   Options:
     a) <option name> — <one-line summary>
     b) <option name> — <one-line summary>
3. ...

Nothing above is applied yet. Approve or decline each staged item from its
Improvements-channel card (Face ID) — this email is a pointer, not a ledger.
```

## Kill-switch email template (`auto_apply.enabled = false`)

```
AUTO-APPLY CLASSIFICATION (staging disabled — nothing drafted tonight)
Total items classified: N
  low      : X
  moderate : Y
  high     : Z (includes <R> escalated by path rails)

Would stage for approval if enabled: <list of IDs>
Would need your input regardless: <list of IDs>

This is classifier output only. Nothing was drafted or changed tonight.
Flip auto_apply.enabled = true in the state file to resume staging.
```

## Safety invariants (never relaxed)

- **Never commits directly, regardless of critic verdict.** The executor's write access to the working tree ends at capture-and-revert. Every landed change is the user's Face-ID signature applying a `self_improve_approvals` row — never this job's own `git commit`.
- **Max K per night.** `auto_apply.per_night_cap` is a hard cap. Additional auto-actionable items roll over to the next night with status `rolled_over`. Kept even though nothing lands without approval — a burst of 10+ Face-ID cards in one run is its own kind of bad UX, and the implementer/critic pass per item is real work worth pacing.
- **Recursion guard.** Patches touching `nightly-review.md`, `self-improvement-executor.md`, `self-improvement-risk-rubric.md`, or any agent `CLAUDE.md` never reach an implementer at all — not even to draft a staged card. This playbook cannot rewrite itself, Face-ID or not; a human edits these files directly.
- **File-scoped git, always.** Every `git restore` / `git checkout` / `rm` the executor runs targets ONLY `$OWN_FILES` — the files this run's implementer created or modified (changed-set MINUS pre-existing drift). NEVER `git add -A`, `git add .`, `git checkout -- .`, `git clean -fd`, or `git stash`. This is what makes a dirty working tree safe to run against, so the executor must NOT self-hold on "dirty tree" (the 3-week idle stretch through 2026-06-23). If the implementer's edits collide with a pre-existing dirty path, abort that item with `reverted_reason: dirty_collision` and continue. **The scoped-revert loop now runs on every path, not just failures** — a `SAFE`/`DEFER_TO_OPERATOR` verdict reverts the working tree too, right after capturing the files-json payload.
- **Serial execution.** One item at a time. A blocked item doesn't stop the next one, but a revert must finish before the next pick.
- **The kill switch is dry-run.** Under no circumstance does classification-only (`auto_apply.enabled = false`) touch files, dispatch an implementer, or stage a card.
- **All state writes happen AFTER all items are processed.** If Step 4 errors mid-run, revert the in-memory state changes and surface "Executor aborted" in the email.

## Related documents

- `data/self-improvement-risk-rubric.md` — rubric + path rails (authoritative).
- `data/reviews/self-improvement-autonomous-plan-2026-04-19.md` — design memo (superseded 2026-08-24 by the retirement of auto-apply; kept for history).
- `agent/ops-agent/jobs/nightly-review.md` — Step 4 dispatch site (top-level playbook).
- `agent/ops-agent/jobs/hum-action-executor.md` — a sibling job that already used this exact stage-not-commit pattern (2026-08-23) for a different data source; this change brings the nightly executor in line with it.
- `tests/auto-impl-policy.test.mjs` — pins rails regex + sample-case classifications against regressions.
