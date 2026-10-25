# Email Triage Rules (ops-agent)

**Loaded on demand, not at session start (2026-08-06).** This ruleset is ~15k
tokens. It used to live inline in `ops-agent/CLAUDE.md`, which is symlinked into
all three ops agents (`ops`, `ops-light`, `ops-haiku`) and re-sent verbatim on
every single turn — so a 15-minute location-enrich tick was paying for the full
medical/shipping/booking/ticket ruleset it never reads. When measured (2026-08-06),
fewer than one dispatch in ten was email; the rest carried this file for nothing.

<!--
geo-gate-ok: this is the email-triage ruleset, not an event-recommendation job.
Its sends are P1 pointers about mail that has already arrived in the user's
inbox — a ticket confirmation, a venue reply, a showtime change — which are
relevant wherever they are, and are frequently the reason they are travelling
in the first place. It trips the event-word heuristic only because it names those email
CATEGORIES. It carried no gate for the whole time it lived inside
ops-agent/CLAUDE.md (which the lint exempts by path); extracting it on
2026-08-06 changed its filename, not its behavior. The jobs that genuinely
recommend dated events each gate at candidate selection.

calendar-write-ok: this file routes every calendar write through
bin/edva-calendar (see the § Meeting Invites step). The only remaining
mention of the raw `gog calendar create|update` path is the sentence FORBIDDING
it, which the linter's substring match cannot distinguish from an instruction to
use it. Extracting this file from ops-agent/CLAUDE.md on 2026-08-06 is what
first exposed the line to this lint — the CLAUDE.md path exemption had hidden a
genuinely stale instruction to call the raw path, now corrected.
-->

**If you are triaging email, read this ruleset FIRST — it is authoritative —
but read it by section, not whole (2026-10-04).** `~/Dev/edva/bin/triage-rules core`
prints the decision procedure every email needs (the P1 ping policy, Steps 0-6,
the due-date timezone rule, the draft/instruction/ack policies, tools) — about a
third of the file. Every other `### ` section is a per-category rule; the dispatch
carries their index (`triage-rules index`) and you read only the ones that could
apply (`triage-rules section <slug> …`). This file stays the single source of
truth — edit it, never the slices. Do not triage from memory or from the summary
stub in `CLAUDE.md`; the fast-paths, per-category rules, and the P1 policy all
live here and they change often.

**This instance's own senders, labels and fast-paths** live in
`agent/local/email-triage-rules.md`, under the same `### ` headings. The
ops supervisor merges the two by heading (a local section with a kernel
section's exact title extends it; the rest sit where they were written) and
points `triage-rules` at the merged copy through `TRIAGE_RULES_FILE`, so
`triage-rules core|index|section` read one ruleset. Edit the kernel file for
generic rules and the local file for anything about this user's own senders,
labels, properties, businesses or people.

**What the dispatch already carries (2026-10-04).** A `gmail:<messageId>` dispatch
now includes the From/To/Date/Subject headers, the intake stamps (`p1-sender`,
`reply-to-me-p1` — `p1` + star ALREADY applied — or `command-channel`), Jev's
verdict when it ran but did not act, the structured sender history, the
`--evidence-as-of` value for a P1 pointer, and the first 6000 chars of the body.
Use them; fetch through the Gmail connector only for attachments, the thread, or
text past the cut.

---

When a new email arrives (dispatched by the supervisor):

### Phone-channel notification policy (triage)

**Phone-channel pings about email triage are P1-only.** A P1 email triggers at most one ping per Step 5 (`edva-send-curl --intent p1-email --evidence-as-of <the email's own Date, ISO-8601> --p1-message <messageId> "🚨 P1 Email: [Subject] from [Sender]"`). Nothing else in the triage pipeline pushes to the phone channel.

**A P1 pings only when it needs the user to act (2026-10-22).** The same step that classifies the email and writes its pointer line also decides — your judgment of what the email says, never a keyword — whether it **needs the user to do something**: it asks them a question or for a decision, carries a deadline or a time-bound step, or wants something only they can do (sign, pay, reply, show up, choose). Only then send the ping. A P1 that needs nothing from the user — an automatic "we received your request" receipt, a confirmation of something already done, a notice that says in its own words there is nothing to do, small talk or a thank-you, an FYI — still gets the **full P1 Gmail state** (label + star + `p1`, left UNREAD) and its task only if there is a real action, but **no `edva-send-curl`, no chat line, no phone push**. When unsure whether they must act, ping. This applies to every section of this file that says "Notify via Edva" for a P1 (tickets, MyChart, bookings, signature requests…): those describe what the ping says *if* one is sent. Why: pings that need nothing teach the user to ignore the ones that matter. Same-sender burst folding (`--p1-message`, below) is unchanged.

**`--p1-message <messageId>` folds duplicate pushes — always pass it (added 2026-10-21).** It is the Gmail messageId you are triaging (never a threadId). With it, `edva-send-curl` asks `bin/p1-push-fold`, after the precheck has decided to send, whether the user already got a push for this email: the **same message** in the last 24 h (one email triaged twice, e.g. the watchdog's stuck-unread RECLASSIFY racing the Gmail push dispatch), or the **same Gmail thread from the same sender** in the last 15 min while that earlier email is still unread (a sender's near-simultaneous burst of "new mail" notices). If so, nothing is posted and the send prints `p1-push-fold: not sent …` and exits 0. That is the intended outcome, not a failure: do not resend or reword around it, and still finish Step 5 (labels, star, task). Why: on 2026-10-21 one "1 new item" email reached the user as two pings ten seconds apart. Keyed on Gmail structure only (message id, thread id, From address, UNREAD), never on wording. Decisions: `p1-push-fold tail`; off switch `data/.p1-push-fold-off`.

**`--evidence-as-of` is load-bearing — never omit it (added 2026-09-24).** The pointer quotes an email that arrived seconds ago, so its evidence date is a fact you already hold (the message's `Date` header, rendered ISO — e.g. `2026-09-24T15:51:37Z`), not a judgement. Leave it off and the truthfulness gate (`lib/claim-freshness.mjs`, Rule #2) sees `undated_evidence`, which does two things: it sends every pointer to a full Sonnet+Jev adjudication, and it widens the mailbox re-check to a **14-day lookback** — so a brand-new email gets "superseded" by older mail and the ping is suppressed before it reaches the user's phone.

Measured over eight weeks of `data/claim-freshness-log.jsonl` (to 2026-09-24): about two in five P1 pointers were suppressed or hedged, and **most of those cite a memory row dated BEFORE the ping — typically more than a week older, some by months**. The clearest proof it is the dating and not the judgement: a vendor's terminal-state status mail was dropped six times as superseded by an *earlier* in-progress status, and on 2026-09-24 two device-battery pointers were dropped minutes before two near-identical ones passed on the same facts.

Passing the real date fixes both halves. A fresh email exits at stage 0 for free — no Sonnet, no Jev. A genuinely old one (a catchup sweep) is still re-checked, but the window anchors at its own arrival, so only mail that arrived **after** it can resolve it. Pass the literal `live` only when you composed the claim from work you just did; for a pointer, the email's own date is the honest stamp. This does not weaken the gate — a `stale premise` drop still stands, and the 2026-09-01 decision to respect those (see the p1-email note in `bin/edva-send-curl`) is unchanged. A suppressed ping was never a lost email either: P1 mail stays labelled, starred, UNREAD and tasked. What this recovers is the notification.

DO NOT send a phone ping for any of these — they are noise:

- Reclassifications, downgrades, label flips ("X reclassified P1→P3", "moved to spam", "label applied", "fast-path matched"). The inbox state already reflects the change; the user does not need to be told.
- Phantom dispatch resolutions of any shape ("Phantom <messageId> resolved", "phantom cluster cleared", "skipped empty prefetch", "self-action marker filtered"). These are internal supervisor-level events; never user-facing.
- Unstar-scan P1 downgrade confirmations. Silent per `jobs/p1-resolve.md § Unstar scan`. Never ack individual unstar-driven downgrades.
- Spam-blocklist additions, second-reclassify escalations, classification-memory writes, email-mem updates, triage-pause/resume status flips.
- "Email triaged", "label applied", "marked read" status updates of any kind.

The narrow exception is a direct conversational reply to a user-initiated command — e.g., they said "the hosting outage is resolved" and the chat-agent dispatched `RESOLVE P1`, so the resulting `"✓ downgraded P1: ..."` ack is fine because it answers their question. The distinction is **agent-initiated push (forbidden) vs. reply-to-the-user ack on their own thread (fine)**. The flap-detection ask (`"Reclassified <Subject> N times in 30min. What priority do you want?"`) is also fine — it requires the user's input.

When in doubt, stay silent. Triage runs in the background; only P1s warrant a push.

### Step 0a: Read the triage playbook
Read `~/Dev/edva/data/email-triage-playbook.md` before classifying. This file contains learned patterns about how the user handles different senders and topics — response rates, priority accuracy, and preferences. Use these patterns to inform your classification and priority.

### Step 0b: Spam check
**Intake already runs both checks as code (2026-10-04)** — `intakeSpamCheck` in `gmail-source.mjs` calls `spam-filter check --sender` AND `--topic` on every inbound message and handles a blocked one with no dispatch (moved to Gmail's Spam folder when the entry is marked `scam`, otherwise marked read and left in the inbox), so you should rarely see blocked mail. Run them yourself only for a message that reached you some other way (a catchup sweep, a RECLASSIFY). Run **both** `spam-filter check --sender "<sender email>"` **and** `spam-filter check --topic "<subject>"` (at `~/Dev/edva/bin/spam-filter`) — the tool only inspects one list per invocation (`--sender` checks `blocklist.senders`, `--topic` checks `blocklist.topics`), so a topic-only block (e.g. a notification-subject rule such as `mentioned you in`) is invisible to a sender-only call. If either output says BLOCKED (exit code 2), handle it the way intake would and skip all other steps: an entry tagged `[scam: to Spam]` gets `gmail-action spam <messageId>`, any other entry gets `gmail-action mark-read <messageId>`.

**Old plain topic blocks may need the `scam` flag.** Topic blocks written before the `scam` flag existed match, mark read and leave the mail in the inbox, so a campaign they were meant to stop keeps showing up there. When one matches a scam campaign, re-add it with `--scam` so its mail moves to Spam. A campaign that burns a new domain per send often leaves the same obfuscated sender local-part (e.g. `promo.ltd.promo.ltd...@example.test`) on every one; that fragment can be a `scam` sender block too. When a spam shape keeps reaching the inbox, check `spam-filter check --json` for `scam:false` on the entry that matched before adding another pattern.

**Blocking a new sender: scam, or silence (2026-10-06).** The user's rule: confirmed scam mail goes to the Spam folder, not just blocked and marked read. So decide which kind of block it is:
- **Scam, phishing or junk from an unknown sender** (the `spam` definition in Step 3: fake offers, fake account-security or verification-code mail, an impersonated brand, a throwaway domain): `spam-filter block --sender <pattern> --reason "<reason>" --scam --message <messageId>`. The entry is recorded as a scam, so intake moves the sender's future mail to Spam, and this message is moved there now. For a recurring subject pattern independent of sender, use `--topic <pattern>` with the same flags. (The chat agent's `spam_block` tool takes `scam` and `message_id`.)
- **A real sender the user just doesn't want to hear from** (a company's marketing, routine receipts, a down-rank after a second reclassify): the same command **without** `--scam`. The message is marked read and stays in the inbox. Legit mail is never archived and never sent to Spam, where Gmail deletes it after 30 days.

When unsure which, use the plain block. A rotating-domain campaign also needs a content fingerprint (Step 0d); blocking one spent domain will not stop the next.

**Why both calls (root-caused 2026-08-26):** a topic block that was correct all along (`spam-filter check --topic "<subject>"` matched it) was reported as still broken several times, each time with the same guess ("known intake-bypass gap"). The actual bug was that this step only ever called `--sender`, so the topics list was never queried during triage.

### Step 0c: Intake-skip rules (rare in this code path)
The supervisor's `gmail-source.mjs` already enforces `data/intake-skip-rules.json` BEFORE dispatching to you. By the time a triage task lands in this agent's queue, any sender matching one of those rules has already been labeled + marked-read, so you should almost never see them. The LLM-side fast-paths in this ruleset (here and in the local additions) remain documented as **defense-in-depth** in case a rule fails to apply (e.g., gmail-action transient failure). If you do find yourself triaging a sender that matches an intake-skip rule, follow the fast-path AND record the gap as a `feedback`-tagged email-mem entry — that means the intake-skip cascade missed and should be debugged. (Added 2026-05-20.)

### Step 0d: Content-fingerprint spam — rotating-domain campaigns (Auto-Warranty Spam Fast-Path)

Sender-blocking (Step 0b) **cannot** catch a campaign that rotates throwaway sender domains on every send — by the time you block `@<domain>` the next blast already uses a fresh one. The recurring **auto-warranty / "$NNN off YOUR-PLAN"** campaign is exactly this shape: it churns through single-use domains (`@offer-one.example.test`, `@offer-two.example.test`, …). Every defense that blocks the spent domain *after* it reached the inbox is reactive; mail of this shape should be identified and handled as spam on arrival.

The fix is a **content fingerprint** matched at intake, in `data/local-triage-rules.json` (read fresh per email by `lib/local-triage.mjs`). At intake, `classifyInbound` in `lib/jev-email-triage.mjs` checks these rules **before Jev is asked**: a match whose verdict is `spam` (escalate false, sender not on the P1 list) is moved straight to Gmail's Spam folder and **the LLM dispatch is skipped entirely**. Jev cannot veto it (a scam that matched a fingerprint rule but whose fake verification-code body pushed Jev's needs-the-user answer up was once dispatched by a sub-threshold veto instead of filed). The first two rules, both `label:spam, priority:P3, escalate:false`:
- `spam-auto-warranty` — fires only when a **warranty anchor** (`carshield`, `vehicle protection/warranty/coverage`, `auto warranty/protection/coverage`, `extended warranty`, `protect your vehicle/car`, `endurance <auto|vehicle|warranty|protection>`, or the letter-spaced display-name tell `e n d u r a n c e`) **AND** an **offer bait** (`$NNN off`, `save $NNN`, `your-plan`, `got your back`, `protection plan`, `don't wait for a dashboard`) co-occur across the From display-name + subject. The conjunction is what keeps it precise — legit "your plan" / "endurance training" / "save $50" mail lacks the warranty anchor.
- `spam-obfuscated-blast` — domain/brand-agnostic backstop: the dotted `YYYY.MM.DD-HH.MM.SS` subject-tail artifact (spam tooling) **AND** offer bait. Catches the same tooling even if the brand words change.

So you should almost never see one of these in triage. **If you do** (a variant slipped the fingerprint): move it to Spam (`gmail-action spam <messageId>`), and — because this is a content campaign, not a useful sender — extend the fingerprint rather than just blocking the domain. Tighten/add a clause to the relevant rule in `local-triage-rules.json` (keep the **two-signal conjunction** so precision holds; validate with `node bin/local-classify email --from … --subject … --no-mem` plus a few legit-mail probes), and record a `feedback`-tagged `email-mem` entry noting the miss. A bare `spam-filter block --sender` on the spent domain is defense-in-depth only — it will not stop the next rotation. (Added 2026-06-19.)

### Step 0e: The P1 sender list — programmatic, not prose (added 2026-08-22)

**`data/p1-senders.json` is the ONE home for "mail from this sender is always urgent."** Before it existed, marking a sender always-P1 meant writing a paragraph here AND a regex in `local-triage-rules.json`, with no way to un-mark one — so the same fact lived in two places and drifted. Sender-based P1 has moved out of both; the P1 rules that remain in `local-triage-rules.json` are **content**-based (medical subject lines, investor/legal wording, and the instance's own content rules), which no sender list can express.

**You do not run this check by hand.** It runs as CODE at intake — `intakeP1Sender` in `gmail-source.mjs`, immediately after the spam check and ahead of every fast-path and the local classifier, on the live-push path and the catchup paths alike. It stamps `p1` + star, leaves the message **unread**, short-circuits the two skip-the-dispatch filters, and still dispatches full triage — so by the time an email reaches you, a listed sender already carries `p1`. Your job is the rest of Step 5: the topical label, the notification, the task. `local-classify` checks the same list, so a listed sender can never be auto-P3'd and dropped.

**When the user says "always treat X as urgent", add it to the list — do not write a new rule here:**

```bash
p1-sender add "@irs.gov" --label personal --reason "IRS — tax authority"   # or: edva triage p1 add ...
p1-sender remove "@irs.gov"
p1-sender list
p1-sender check --sender "noreply@irs.gov"    # exit 0 = P1, 3 = not
```

Matching is substring on the **lowercased email address only** — never the display name, so a spoofed `"IRS <scam@evil.tld>"` cannot buy itself a P1. `--regex` stores a JS regex instead. Changes take effect on the next email; no supervisor restart. `--label` is a hint the local classifier carries; **triage still owns the final label**.

Two optional subject conditions narrow an entry, and each fails toward the sender's own default:

- **`--only-subject <regex>`** — P1 for that subject shape ONLY, classified normally otherwise. Used by `@docusign.(net|com)`. Fails **closed** (an unreadable regex yields no P1) because the sender is not urgent by default.
- **`--unless-subject <regex>`** — P1 EXCEPT for that subject shape. Used, for example, to leave a sender's test-artifact intake-skip rule intact. Fails **open** (an unreadable regex keeps the P1) because the sender IS urgent by default.

Keep both rare and narrow: a sender needing several conditions is a content rule in `local-triage-rules.json`, not a list entry.

**What still wins over the list:** Step 0b spam / blocklist (the CLI warns if you add a sender that is also blocked, because the entry would never fire). Nothing else does.

The live set: `p1-sender list` (this instance's entries are described in the local additions under this heading). Run it rather than trusting any sentence.

### Step 1: Fetch the email
A live `gmail:<messageId>` dispatch already carries the headers and the first 6000 chars of the body — start from those. Use the Gmail connector (mcp__claude_ai_Gmail) only when the dispatch says the body was not prefetched (catchup sweeps, history-id fallbacks), or you need attachments, the thread, or text past the cut.

### Step 2: Check email memory
The dispatch's **Sender history** line is the structured record — every label/star/read gmail-action applied, per message, grouped by the sender's address (`lib/triage-decisions.js`; it counts only agent- or user-decided rows, never intake's own). Trust it over free-text memories for "what has this sender usually been". For the nuance it cannot carry (an exception, a standing instruction, a superseded rule), run `email-mem test --from "<sender>" --subject "<subject>"` (at `~/Dev/edva/bin/email-mem`) — those memories represent prior decisions the user confirmed.

**Retiring a rule means retiring its memories in the same change (added 2026-08-17).** Rows marked with `email-mem supersede <id> --by <id>` are excluded from what this step returns (and from `formatForPrompt`), while `email-mem search` / `list` still show them — history is kept, precedent is not. Until that filter existed the tag was cosmetic, and 37 rows describing the retired reply-echo rule out-ranked the one policy row replacing them. So when a policy here changes, `email-mem search` for the rows that encode the old behavior and supersede them by a new policy row.

### Step 3: Classify
Assign one label from the instance's label set (listed in the local additions under this heading); `personal`, `vendor` and `spam` always exist.

**`spam` is Gmail's own Spam folder, not an inbox label.** There is no user label by that name: `gmail-action label <id> spam` (same as `gmail-action spam <id>`) moves the message out of the inbox into Spam and marks it read, and Gmail deletes it after 30 days. So use it only for true junk (a real company's marketing is `vendor`). It is refused, with exit 3 and the message left untouched, for Edva's own mail, mail the user sent, a starred message and a listed P1 sender. `gmail-action not-spam <id>` (or `unlabel <id> spam`) puts a message back in the inbox.

**The label follows the relationship the mail is about, not the address it reached (2026-10-09).** A consumer promo that reaches a work address is `vendor`, not that business's label; the business label is for mail about an account or thread that business itself operates. The instance's own case is in the local additions.

### Step 4: Prioritize

**Senders that are always P1 are already decided** — the list in Step 0e stamped them at intake. What follows is the CONTENT judgment: which mail is urgent because of what it says, not who sent it.

- **P1 (urgent):** Investor emails, legal, emergencies at anything the user runs, a non-automated human reply on a business thread the user or their team is working, and the instance's own P1 categories (local additions, this heading). **Edva's own email to the user is P1** (2026-10-06): topical label + star + `p1`, **left UNREAD**, no re-notify, no task — except the push-failed fallback (`Edva notification (push failed)` → P3, `personal` + `edva-out`, read, no star). Edva answering the user (`gmail-action reply-to-me` exit 0) and Edva-initiated mail are both P1; intake finishes them in code (`finishEdvaP1` in `gmail-source.mjs`) and `gmail-action mark-read` refuses them, so you will normally not see them. **NEVER archive or trash, and NEVER spam-block Edva's own address.**
- **P2 (today):** Requires the user's reply within 24h
- **P3 (FYI):** Newsletters, receipts, automated notifications — label and mark read

**Before settling on a priority, run Step 4a** — a reply to something the user sent is P1 no matter what the rules above or any fast-path below would have said.

### Step 4a: A reply to an email the user sent is ALWAYS P1 (added 2026-08-17)

The user's rule: an email received in response to one they sent is always P1.

This is a machine fact, not a judgment call, so ask the machine:

```bash
~/Dev/edva/bin/gmail-action reply-to-me <messageId>   # exit 0 = yes, 3 = no, 1 = error
```

It answers from Gmail's own thread structure — the thread already contains an **older `SENT` message**, i.e. one the user sent from their Gmail or one `gmail-action send --from <the user's address>` sent on their behalf. (`email-send` traffic from Edva's own address goes out through SMTP2Go and never lands in `SENT`, so an agent-originated digest is correctly not counted as "an email the user sent.")

**Exit 0 → P1**, whatever the sender (the JSON's `via` says whether the evidence is the thread or a recent SENT to that exact address — see § support case below), and regardless of any P2/P3 fast-path below. Standard Step 5 P1 handling: topical label + star + `p1`, **leave unread**, notify, create the task. (The one variant: when the responder is Edva's own address — Edva answering the user — it is still P1 + star + unread, but **no notify and no task**, per the Edva self-sent rule in Step 4. Pinging the user about Edva's own email is a loop.) The rationale is that they write to a person only when they want something back, so the answer is the most time-sensitive mail in the inbox — and it was routinely landing under a vendor/personal P3 fast-path.

**The label is unchanged — this rule sets priority only.** A reply from a law office is still `personal`; from a business partner, still that business's label.

**Exit 3 (not a reply to the user) or exit 1 (API error) → change nothing**, carry on with the normal Step 4 rules. Fail open: an error must never manufacture a P1, nor suppress one that another rule would have given.

**This step now runs as CODE at intake, not only here (2026-08-21).** `runIntakeCascade` in `agent/supervisor/gmail-source.mjs` calls `reply-to-me` for every inbound message, ahead of the intake fast-paths and the local classifier, and stamps `p1` + star itself when it exits 0. Until then this rule lived only in this playbook, so it fired only when an LLM turn remembered it — and for one class it was structurally unreachable: `intakeLocalClassify` applies P3 and **skips the dispatch**, so those replies never reached Step 4a at all. Measured over six days of real threads on 2026-08-21, `reply-to-me` was correct **5/5** on messages that still carried no `p1` (several outside correspondents, and Edva's own replies to the user) — the discriminator was never the problem, the consumer was. Intake sets **priority only** (`p1` + star, left unread) and deliberately does **not** skip the dispatch, so the topical label and any action still come from full triage. Everything written above remains in force as defense in depth.

**What still wins over this rule**, in order:

1. **Step 0b spam / blocklist.** A blocked sender stays blocked.
1b. **Nothing, in the other direction:** the Step 0e P1 sender list does not compete with this rule — both stamp P1, and intake runs the sender list first only to save the `reply-to-me` call.
2. **One Edva's-own-address sender exception, and only one:** `Edva notification (push failed)` → P3. That is a plumbing fallback duplicating content already surfaced, and `reply-to-me` would not flag it anyway (new thread, no prior `SENT`); the sender check wins if it ever does. **The `Re:`-prefixed reply-echo is no longer an exception (2026-08-17)** — a Edva reply on a thread the user started is exactly "a response to an email they sent," `reply-to-me` returns exit 0 for it, and Step 4 now agrees: P1 + star, unread, no notify, no task.
3. **Messages the user sent themselves** (from the user's address, carrying `SENT`) — their `approve|edit|decline`, `RECLASSIFY:`, `RESOLVE P1:` replies and freeform instructions keep their existing handling. The check already returns exit 3 for these, so there is nothing to remember.

Everything else — a vendor answering the user's question, a contractor, a merchant, a doctor's office, an airline, a landlord, a support desk — is P1 by this rule even where a fast-path below names it P3.

**A support case the user opened counts as an email they sent (2026-10-06).** Support messages are directed personally to the user and need their response. A named advisor, agent, engineer or rep answering a case or request the user opened — through a web form, chat, phone call or email — is a reply to them, so it is **P1** by this step even when exit 3 says the thread holds nothing they sent. Case systems (a vendor support desk that mails from one address with subject `[<case-id>] … Support` is the reference shape) open a **new Gmail thread for each advisor contact**, so the case number, not the Gmail thread, is the conversation. That is how two advisor replies on one case were filed P3 under the vendor's sender consensus built from receipts and sign-in notices — one asked the user for information and sat unseen for a week (the instance's case is in the local additions under this heading). Two code backstops now exist: `reply-to-me` also exits 0 (`"via":"correspondent"`) when the user has sent mail to the exact sender address in the prior 30 days, and a sub-threshold Jev P1/P2 vetoes a legacy consensus auto-P3. The case's **own automated envelope stays P3**: the "Thanks for contacting us" case-opened ack, a status update that names nobody and asks nothing, the case-closed receipt, and the satisfaction survey. The test is whether a person wrote to the user and is waiting on them.

**Meeting requests are always P1 (2026-10-06, the user's rule).** A calendar invitation asking the user to attend — new or updated — is **P1** + star, left unread, whatever the label. Intake stamps it in code (`gmail-action meeting-request`: the invite's iCalendar part says `METHOD:REQUEST`; triage log kind `meeting-request-p1`), so by the time you see it `p1` is already applied — keep it, and still do the normal invite work (label, calendar event per the calendar-scheduling skill). Not covered: cancellations (`METHOD:CANCEL`), RSVPs to the user's own invites (`Accepted:`/`Declined:`, still P3 by the label rules) and party/RSVP sites without a calendar request (their own fast-paths).

**Automated answers count too** (out-of-office autoreplies, ticketing-system "we received your message" acks). The rule is deliberately *always*, with no automation carve-out; if those start crowding the P1 lane, narrowing it is the user's call, not a judgment to take mid-triage.

### Step 5: Act
Use `~/Dev/edva/bin/gmail-action` for all Gmail modifications:

**Pre-applied label mismatch:** some inbound mail can arrive with a label already applied by a Gmail filter before triage runs. Strip a wrong pre-applied label per email; the instance's known cause, and what not to re-alert on, are in the local additions under this heading.

- **P3 emails:** `gmail-action label <messageId> <label>` then `gmail-action mark-read <messageId>` — label, mark read. No notification. **NEVER archive emails.** (`spam` is the one label that leaves the inbox, by design; see Step 3.) (MCP equivalent: `gmail_label_read`. The archive MCP tools were removed 2026-10-06 after ops-light filed P3 mail with `gmail_label_archive`, leaving it unread and out of the inbox.)
- **P2 emails:** `gmail-action label <messageId> <label>` then `gmail-action star <messageId>` then `gmail-action mark-read <messageId>` — label, star (yellow), mark read. **Do NOT create draft replies.**
- **P1 emails:** `gmail-action label <messageId> <label>` then `gmail-action star <messageId>` then `gmail-action label <messageId> p1` — label, star, p1 label. **Do NOT mark-read** — P1 emails stay unread so the user sees them. Additionally:
  1. **Only if the email needs the user to act** (§ Phone-channel notification policy — a P1 that needs nothing from them stays starred, `p1` and unread with no ping), notify the user via Edva: `edva-send-curl --intent p1-email --evidence-as-of <the email's own Date, ISO-8601> --p1-message <messageId> "🚨 P1 Email: [Subject] from [Sender]"` — all three flags are required; see § Phone-channel notification policy above for why a missing `--evidence-as-of` silently suppresses the ping, and why `--p1-message` (which folds a second push for the same email or thread burst) may print `not sent` with exit 0.
  2. Create the task through the P1 wrapper, never `gog tasks add` directly: `~/Dev/edva/bin/p1-task add <messageId> --title "[Subject] from [Sender] — [action]" --due YYYY-MM-DD --notes "[context]"`
     - Due dates: weekday = today; weekend/holiday + less urgent = next Monday; always today for truly urgent
     - The wrapper stamps `[edva-p1 thread:… msg:…]` into the task's notes. That marker is what lets the task close itself when the P1 is resolved — the user replies on the thread (`p1-reply-sweep`, every 30 min), unstars it, or says it's handled — via `p1-downgrade` → `lib/p1-task.js`. A P1 task created with bare `gog tasks add` has no marker and can only be closed by a subject match, which deliberately refuses anything ambiguous. (2026-09-11, the user's rule: replying to a P1 email retires its task.)

### Timezone Rule for All Due Dates
The user's home timezone (HOME_TZ below) is given in the local additions under this heading. When extracting dates from emails:
- "Today", "tomorrow", "Saturday", etc. mean dates in HOME_TZ — run `TZ=<HOME_TZ> date +%Y-%m-%d` to get today's date there before computing any relative date.
- A retailer's "arriving Saturday, April 12" → use that date directly (the date in the email is already localized for the user).
- Never rely on UTC or your internal clock for date math. Always anchor to HOME_TZ.

### Shipping & Delivery Notifications — carrier-agnostic (generalized 2026-09-25)

**This rule is NOT Amazon-only — it applies to any shipping/delivery notification, from any carrier or retailer:** UPS, FedEx, USPS, DHL, a retailer's own shipment-confirmation email, or Amazon. Root cause of why it behaved as Amazon-only until now: this section only ever named Amazon's three sender addresses, so a triaging turn reading a UPS or FedEx shipping email found no instruction that appeared to cover it and fell through to the generic P3 "automated notification" bucket in Step 4 — no task, no notify — even though the underlying shape (item shipped, with a delivery date) is identical to Amazon's.

Only create delivery tasks from **shipping confirmation emails** (item has shipped, with an estimated delivery date) or the "out for delivery" equivalent. Do NOT create tasks from order confirmations or purchase receipts — wait for the shipped email.

**Judge non-Amazon carriers by content, not by a guessed sender list (Rule #0b).** UPS/FedEx/USPS/DHL and retailer-direct shipping mail don't have a small fixed set of sender addresses the way Amazon's three do — hardcoding a guessed carrier sender pattern here would be exactly the brittle, silently-wrong-later shape Rule #0b warns against (it matches today's example and misses the next one quietly). Instead, during normal full triage (these are not intake-skip fast-paths), read the email like any other and classify by what it actually says:
- Reads as **order placed / purchased**, no tracking number or delivery date yet → order confirmation. P3, label + mark read. **NO task, NO Edva notification.**
- Reads as **shipped / label created / out for delivery**, names an item and gives (or implies) an estimated delivery date → shipping confirmation. P3, notify + create delivery task per steps 1–5 below.
- Reads as **delivered / arrived** → delivery confirmation. P3, notify + close matching delivery task.

**Amazon keeps its own sender-based fast-path on top of the rule above** (apply by `From:` address, not subject line — subjects are ambiguous) because it's high-volume enough to warrant an intake-skip optimization (`data/intake-skip-rules.json` → `amazon-order-confirm` skips the order-confirmation state at intake entirely, before any dispatch). This is the same three-state shape every carrier follows, not a separate rule:
- `auto-confirm@amazon.com` → order confirmation. P3 personal, label + mark read. **NO task, NO Edva notification.** Wait for `shipment-tracking@amazon.com`.
- `shipment-tracking@amazon.com` → shipping confirmation with delivery date. P3 personal, notify + create delivery task per steps 1–5 below.
- `order-update@amazon.com` → delivery confirmation (item has arrived). P3 personal, notify + close matching delivery task.

When you detect a shipping confirmation (Amazon or any other carrier/retailer):
1. Extract: item name, carrier (if the email names one), estimated delivery date, tracking/order link
2. **Verify the due date in the home timezone** (see Timezone Rule above) — if the email says "arriving today" or a relative day, compute the correct `YYYY-MM-DD` there.
3. Notify via Edva using `$'...'` ANSI-C quoting so `\n` becomes a real newline: `edva-send-curl --evidence-as-of <the email's own Date, ISO-8601> $'Shipped: [item name] — arriving [delivery date]\n[order/tracking link]'`
4. Create a task with due date set to the **scheduled delivery date**: `gog tasks add @default --title "[item name] arriving" --due YYYY-MM-DD --no-input`
5. Label the email as usual (vendor/personal, P3) and mark read

If the email is a delivery confirmation (item already delivered), notify: `edva-send-curl --evidence-as-of <the email's own Date, ISO-8601> $'✅ Delivered: [item name]\n🔗 [link]'` and mark any matching delivery task as complete: `gog tasks done @default <taskId> --no-input`.

**Every notify in this section carries `--evidence-as-of <the email's own Date, ISO-8601>` — same rule and same reason as the P1 pointer (§ Phone-channel notification policy above), including a delay or exception update, not just the two commands above.** The carrier's notice IS the evidence and you are already holding it, so pass its `Date` header rather than the literal `live`: a catch-up run on a three-day-old notice then still gets re-checked, anchored at its own arrival, instead of claiming to be fresh. Leave the flag off and the truthfulness gate (`lib/claim-freshness.mjs`, Rule #2) sees `undated_evidence` and widens the mailbox re-check to a **14-day lookback** — and for shipping mail that window is mostly the *previous* shipment of the same thing. What that cost on 2026-09-26: a UPS "package was delivered" notice was notified 91 seconds later and **suppressed as a stale premise** — the 14-day search surfaced only the previous month's shipment of the same thing under a different tracking number, which the adjudicator read as "memory is silent about this one". With the `Date` header the identical message exits at stage 0 as `fresh_evidence` (age 91.9s) and costs nothing at all.

### Ticket Confirmation Emails (events, shows, concerts)
When an email is a ticket confirmation / "your tickets are here" / "you won the lottery — claim now" / order confirmation for a live event (theater, concert, sports, etc.):

1. **Extract:** event name, date, time, venue, number of tickets, total price.
2. **Calendar check:** query Google Calendar (`mcp__claude_ai_Google_Calendar__gcal_list_events`) around the show date for an existing event matching the show name OR the venue at that time. **If one exists, amend it — never refuse and ask (2026-10-22):** this email IS the confirmation for the booking, so `edva-calendar update <eventId> --from-confirmation <messageId> …` may correct its time, name and details even if the user created it themselves; add any standing attendee the local additions name if they are not on it.
3. **If event is NOT in calendar → P1:**
   - Auto-create the calendar event: invoke the `calendar-scheduling` skill, then `~/Dev/edva/bin/edva-calendar create --calendar primary --summary "<show name>" --from <RFC3339 start> --to <RFC3339 end> --location "<venue, full address if known>" --event-color 5`, plus the standing-invite attendees and `--attendee-authorized` quote the local additions give (none otherwise). End = showtime + 2.5h (evenings) or + 3h (matinees), in the venue's timezone. Color 5 (yellow) always — ticket confirmations are entertainment by definition. **Name the performer in the summary** when you know who it is.
   - Label `personal`, star, mark read, label `p1`.
   - Notify via Edva with show + date/time + venue + ticket count + total.
   - Create a Google Tasks reminder (`gog tasks add @default --title "<Show> at <Venue>" --due <show-date>`).
6. Record in `email-mem` with tags `personal,tickets,<event-type>`.

### Restaurant / Venue Reservation Confirmation Emails — P2 + auto-create calendar event (added 2026-09-21)

**Any reservation confirmation for a restaurant, bar, or venue — Resy, OpenTable, a direct restaurant-booking system, a hotel confirmation, or any equivalent — is P2 AND must get a matching calendar event.** Before this rule, a Resy confirmation was correctly classified P2 but nothing created the calendar event — the user caught a missing reservation themselves and had to create it by hand. This closes that gap: the reservation confirmation email is the only signal these bookings generate, so triage is the only place that can create the event.

**Detection — sender or subject/body shape, not Resy-only:**
- Sender domains: `@resy.com`, `@opentable.com`, `@noreply.opentable.com`, `@tables.opentable.com`, or a direct restaurant/venue booking system (the confirmation email arrives from the restaurant's own domain or its reservation platform).
- Hotel booking confirmations (`@booking.com`, `@marriott.com`, `@hilton.com`, `@hyatt.com`, direct hotel confirmation emails, etc.) that are a **stay confirmation**, not a flight/car booking — those already flow through the § Travel email fast-path above for travel-timeline purposes; this rule is about the **calendar event**, so both paths run (travel fast-path keeps presence data current, this rule puts the reservation on the calendar).
- Subject/body shape: "Your reservation is confirmed", "Reservation confirmed", "You're booked", "Table confirmed", "Booking confirmed", a party size + date + time + venue name, or a confirmation/cancellation link to a reservation platform. Judge by content when the sender isn't one of the known platforms above — a direct restaurant booking system will still read unambiguously as a reservation confirmation.
- Does NOT include: reservation **reminders** (day-of "see you tonight" emails — the event already exists, don't duplicate it), cancellation confirmations (handle per § Meeting Cancellation Emails below instead), waitlist/notify-me confirmations (no seated reservation yet), or marketing ("book now" upsells).

**Action:**
1. **Extract:** venue name, date, time, party size (guest count), and a confirmation/manage-reservation link if present.
2. **Calendar check:** query Google Calendar around the reservation date for an existing event matching the venue name or time, to avoid a duplicate (same check as the Ticket Confirmation rule above). **If one exists, amend it with `edva-calendar update <eventId> --from-confirmation <messageId> …`** (this email is the booking's confirmation, so time/name/details may change even on an event the user made) instead of creating a second one or asking.
3. **If no matching event exists, auto-create it via `edva-calendar` — the only sanctioned write path** (never `gog calendar` or the MCP calendar write tools — see § Calendar event creation and updates above):
   ```bash
   ~/Dev/edva/bin/edva-calendar create --calendar primary \
     --summary "Dinner at <Venue>" \
     --from <YYYY-MM-DDTHH:MM:00±HH:MM> --to <YYYY-MM-DDTHH:MM:00±HH:MM> \
     --location "<Venue>" \
     --description "<N> guests. Confirmation: <link if present>" \
     --colorId 5 -j
   ```
   (`-j` makes gog print the created event as JSON; its `id` (or `event.id`) is what step 3b needs.)
   - **Title:** `Dinner at <Venue>` (or `Lunch at <Venue>` / `Brunch at <Venue>` if the email's own time-of-day language says otherwise — check the user's own meal habits in memory before naming a late-morning booking). Use `Reservation at <Venue>` for a non-dining venue (bar, lounge) if "Dinner"/"Lunch" doesn't fit.
   - **Date/time:** parsed from the email, in the venue's local time (see § Timezone Rule above). **End time:** use the email's explicit end time / duration if given; otherwise default to **start + 1h15m** (a reservation, not a show — shorter default than the 2.5–3h ticket-confirmation default above).
   - **Location:** venue name (full address if the email includes one).
   - **Description:** guest count, and the confirmation/manage-reservation link if the email includes one.
   - **`colorId 5` (yellow/Banana) always** — restaurant reservations are entertainment per the pinned `feedback_calendar_event_colors` rule, same as ticket confirmations.
   - **No attendees.** Do not pass `--attendees` / `--add-attendee`; any standing per-category invite rule is in the local additions under this heading.
4. **Classify P2:** label `personal` (or the topical label if the reservation is clearly tied to one of the user's business threads), star, mark read. **No `p1`.** This is the existing P2 handling — visible via the star, no interrupt.
5. **No separate Edva notification and no task** (beyond any one question the local additions add to this path) — P2 doesn't page (see § Phone-channel notification policy at the top of this file), and the calendar event itself is the durable record; a reminder job (default calendar notification) covers day-of awareness. This mirrors how the Ticket Confirmation rule's own P1 path already folds the calendar write into normal Step 5 handling, minus the P1 ping since this is P2, not P1.
6. Record in `email-mem` with tags `personal,reservation,<venue-or-platform>`.

If the email is a cancellation of an existing reservation, follow § Meeting Cancellation Emails below instead (find and delete/decline the calendar event) rather than this create path.

### MyChart / Medical Portal Messages
Any email from MyChart (Epic), a hospital patient portal, a doctor's office, or a medical provider is **always P1**:
- Label `personal`, star, mark as p1, **leave unread**
- Notify via Edva: `edva-send-curl --p1-message <messageId> "🏥 P1 MyChart: [Subject] from [Sender]"`
- Create a Google Tasks task due today

This applies regardless of content — test results, appointment reminders, doctor messages, prescription notices, billing, all of it.

The **senders** are on the P1 sender list (Step 0e) — `mychart`, `@epic.com` — so they arrive already carrying `p1`; add any new portal domain with `p1-sender add`. The **subject** signals ("MyChart", "test results", "your doctor", "message from your care team") stay a content rule in `local-triage-rules.json` (`medical-subject`), because they catch a provider whose domain nobody has listed yet.

### Calendar event creation and updates — run through `calendar-scheduling`

**Any time this agent creates or updates a calendar event** — from a meeting invite in triage, a reschedule, a ticket confirmation, a cancellation (below), or any webhook-dispatched task that touches the calendar — **invoke the `calendar-scheduling` skill first**, then write via `~/Dev/edva/bin/edva-calendar create|update`. That wrapper is the **only sanctioned write path** (`agent/CLAUDE.md` § Calendar Invitations): it refuses any attendee other than the user unless you pass `--attendee-authorized "<what the user actually said>"`, and it sets `--send-updates` correctly on its own. **Do not call the raw calendar CLI's create/update directly, and do not reach for the MCP `gcal_create_event`/`gcal_update_event` tools** — those are no longer granted to any agent (`allowedTools` in `agents.json` lists only the read half), and a pre-commit lint fails new code that routes around the wrapper. Reads — `gog calendar list|show`, the MCP list/get/search tools — are unrestricted. The skill encodes: busy/free transparency rules, shared-event conflict rules, the household's own event conventions, weekday-only outside-party coordination, routine-maintenance bounds, per-visit sizing, pacing / don't-pack rule, events-vs-tasks heuristic, home-timezone discipline, color conventions, reminder defaults (`useDefault:true`), and `--send-updates all` when attendees are present. Scheduling without it reliably produces conflicts that the user has to fix manually.

### Meeting Cancellation Emails
When an email cancels or removes a scheduled meeting (subject contains "canceled", "cancelled", "has been removed", "declined", or body indicates the event is no longer happening):

1. **Find the calendar event:** Search Google Calendar around the meeting date/time for an event matching the meeting title or organizer. Use `mcp__claude_ai_Google_Calendar__gcal_list_events` with a tight time window.
2. **If found:** Delete or decline the event so reminder jobs don't fire for it.
   - If the user is the organizer: delete via `mcp__claude_ai_Google_Calendar__gcal_delete_event`.
   - If the user is an attendee: decline via `mcp__claude_ai_Google_Calendar__gcal_respond_to_event` with `response: "declined"`.
3. **If the meeting has a pre-built Edva reminder** (e.g., a recurring-call reminder job): the reminder job checks the calendar event at fire time — deleting/declining the event is sufficient to suppress it.
4. **Notify Edva** only if the meeting was P1-level (investors, legal, board, or a P1 contact the local additions name): `edva-send-curl "📅 [Meeting name] canceled — removed from calendar."`
5. Label `personal` (or relevant label), mark read (P3 unless it's a P1 meeting).

### Service Subscription Charges/Renewals
Recurring charges or renewal notices from SaaS/service providers (Google One, streaming services, etc.): P2 — label, star, mark read. No draft, no task. These are expected charges worth seeing but require no action.

### Billing-Reminder Keywords from Known Billers (NOT outage alerts)
Some billing reminders from telecom/comms vendors (telephony, SMS and email-delivery providers, etc.) use alarming language — `disconnected`, `suspended`, `will be disconnected`, `account will be suspended`, `reactivate`, `service will stop`, `credit low` — when the email is actually a routine "top up your balance" or "card on file failed" reminder. These are **vendor P3** (label `vendor`, mark read, no task, no notification), not outage alerts.

Rule: if the sender matches a known comms/telecom billing domain AND the body has billing context (an amount, a balance, "top up", "add funds", "payment method", "invoice", "credit"), classify as **vendor P3** regardless of outage-sounding keywords. Only escalate to P1/P2 when the email describes an actual in-flight outage with no billing context (e.g., "service outage report", "your number is currently offline" without a balance/payment angle).

Known-biller sender patterns: the instance's comms vendors are listed in the local additions under this heading; any "billing@" / "accounts@" / "finance@" on those domains counts too.

Why: a comms vendor's billing reminder with a "disconnected" keyword was once classified vendor P2 and surfaced, and it was a routine balance top-up. `feedback_whois_service_solicitations.md` covers cold service pitches; this rule covers the adjacent blind spot: routine billing noise dressed up with outage verbs.

### Subscription Expiring Notices
"Your subscription is expiring" emails (apps, streaming add-ons, etc.): P3 — label, mark read. No task, no notification.

### Signature requests are P1; signature *completions* are not (added 2026-08-22)

The user's rule: an e-signature request is P1; anything else from the vendor is classified normally.

The distinction is the whole rule, and it is not a sender question: the same e-signature vendor sends both a document waiting on the user (they are the blocker; nothing moves until they act) and a notice that someone else already signed (a receipt). So the P1 sender entry for `@docusign.(net|com)` carries an `only_subject_re` — the request phrasings (`Please DocuSign:`, `sent you a document to sign`, `Action Required … sign`, `awaiting/needs your signature`, `signature requested`) — **plus** an `unless_subject_re` for `Completed:` / `Signed:` / `Declined:` / `Voided:` / `Copy of…`, because **DocuSign echoes the original envelope subject in its completion mail**: `Completed: Please DocuSign: Contract.pdf` matches the request pattern on its face and is not a request. Everything else from DocuSign — completions, receipts, account and marketing mail — carries no `p1` and is classified normally.

A DocuSign signature request that reaches you already stamped `p1` + starred + unread still needs its Step 5 P1 handling: topical label (usually `personal`, or the business label the document belongs to), notify, create the task due today. **`p1-sender list` shows the live patterns** — add a phrasing there when a new one appears, do not write a rule here.

### Anthropic Statuspage Fast-Path (`noreply@statuspage.io`)
Anthropic ships incident notifications via statuspage.io for Claude model outages (Investigating → Identified → Monitoring → Resolved, typically 4-6 emails per incident over 30-90 min). Multiple incident waves per week.

**Fast-path classification:** if the sender is `noreply@statuspage.io` AND the subject contains "Claude", skip the full triage pipeline. Immediately: label `vendor`, mark read. **No star, no task, no Edva notification, no email-mem add.** All Anthropic statuspage emails are vendor status by construction. Same shape as the Proxy-Vote / Substack fast-paths.

Rationale: 12 statuspage reclassifications observed 2026-05-04 (Sonnet 4.5, Opus 4.5, Opus 4.7 incidents) + 4 on 2026-05-06 (multi-model incident). Each incident wave is 4-6 dispatches that all end at the same P3-vendor-marked-read state — fast-path saves ~16 LLM evaluations per week.

### App Store Connect / TestFlight / CI
Emails from Apple about App Store Connect, TestFlight builds, or app review status, and CI/CD emails (GitHub Actions, build succeed/fail notifications): label appropriately, mark read (P3). **Do not create tasks or notify Edva** — the user handles these directly.

**The label, and the P1/P2 exceptions for this user's own apps, are in the local additions under this heading.**

**Fast-path for paired App Store Connect + TestFlight builds:** every iOS build emits two emails ~10 seconds apart (one from App Store Connect, one from TestFlight) with matching build numbers. When you triage either one, immediately check the inbox for its sibling (same build number, received within ±60 s) and handle both in the same tool batch:
1. After classifying the first, run `~/Dev/edva/bin/gmail-action list-unread --from "@email.apple.com" --newer-than 2m` (or the equivalent Gmail search) to find the pair.
2. If found, label + mark-read both in the same turn (no separate triage dispatch).
3. Record a single `email-mem add` with tags `vendor,apple,testflight-pair` so the pattern is remembered.

Rationale: saves ~1.5 webhook dispatches per build, reducing phantom-rate load noted in the 2026-04-16 self-improvement review.

### Google OAuth Grant Notifications (`no-reply@accounts.google.com`)
The **first** "Security alert: You allowed [App] access to your Google Account" email for a new app stays P1 (real security alert; unauthorized OAuth grants are a critical threat). Standard P1 actions: label `personal`, star, label `p1`, notify, create task.

**Confirmation-echo rule.** If a *second* "You allowed [App] access" email for the **same app name** lands within 2 h of the first, treat it as a confirmation echo (the user re-tapped the consent flow, or Google re-sent), not a new grant. Auto-downgrade to P3 personal: unlabel `p1`, unstar, ensure `personal` label, mark read. No new notification, no new task. Beyond the 2 h window, treat as a fresh event (back to P1).

Why: on 2026-05-05 two self-authorized OAuth grants triggered initial-P1 → manual-walk-back-to-P3 cycles because the user re-clicked consent. The 2 h window matches observed echo timing (~2.3 h and ~3 min).

### Step 6: Record classification
**The outcome itself is recorded for you (2026-10-04).** Every `gmail-action label|unlabel|star|unstar|mark-read` writes the message's final state into `triage_decisions` (`lib/triage-decisions.js`, in `email-memory.db`), keyed by messageId with the sender address intake registered. That is what sender-history consensus reads now — a GROUP BY, not text extraction — so there is nothing to remember for the label/priority half.

`email-mem` is for what that row cannot hold — the WHY. For any non-trivial classification decision (not obvious spam/newsletters), record it:
`email-mem add "<decision summary>" --tags "<label>,<sender-domain>"`
This builds up the memory so future emails from the same sender/topic are classified consistently.

### Draft reply policy
**Do NOT create draft replies automatically.** The user writes their own replies. The agent's job is to label, prioritize, notify, and create tasks — not to draft responses.

### Freeform instructions in the user's reply emails — dispatch, don't chase inline

When triaging a reply from the user's address on a Edva-originated thread (a digest, a review, any email from Edva's own address) whose body contains a real, substantive instruction that does **NOT** match one of the already-structured reply patterns above (the `approve|edit|decline <draft-id>` regex, `RECLASSIFY:`, `RESOLVE P1:`, etc.) — e.g. "break up the proposed tuning into improvements — submit them in the improvement channel" on a hum-weekly digest thread — **do not try to fulfill it inline during this triage turn.** A per-email triage turn has no timeout override (the generic 10-min default applies to `gmail:<messageId>` sources) and an open-ended instruction like this can't be scoped and completed in that window — it will hang, get killed and retried once, hang again, and get silently **dropped**, losing the instruction entirely with no trace beyond a system-channel warning. (Exactly this happened 2026-07-26: a "Re: Hum weekly" reply asking to submit tuning as improvements was never executed — confirmed via transcript read, `self-improve-request`/`self-improve-feed-log` were only ever `cat`-read, never invoked.)

Instead: label + star + mark read as a normal P2 personal email (it needs follow-through, so don't silence it), then dispatch it as its own top-level task so it gets a fresh turn and proper budget — the usual webhook dispatch shape:

```bash
TOKEN=$(cat ~/Dev/edva/secrets/webhook-token) && curl -s -X POST http://localhost:9092 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"The user replied to <original subject> with an instruction: \"<verbatim instruction text>\". Context: <one-line summary of what the original email was about>. Follow the instruction.","source":"triage-reply-instruction"}'
```

This only applies to genuine instructions — a plain acknowledgment ("thanks", "got it"), a question, or commentary with nothing actionable stays as ordinary triage (label + read, no dispatch). When in doubt about whether something rises to "instruction," lean toward dispatching — a redundant task that finds nothing to do is cheap; a silently dropped instruction is not.

### No acknowledgment emails
**Never send an acknowledgment email into any thread.** This includes brief "On it", "Noted", "Got it", or "Plan: ..." replies into Gmail threads. Email conversations are not the phone channel — chat-style acks clutter threads and are never appropriate. Work silently. Only reply via `email-send` (via `email-inbound.md`) when you have a substantive result or response to deliver.

### Tools reference
- `~/Dev/edva/bin/gmail-action` — label, archive, mark-read, star, unstar, draft, draft-reply via Gmail REST API (auto-refreshes OAuth token). `spam <messageId>` / `not-spam <messageId>` move a message into or out of Gmail's Spam folder (guarded, see Step 3). Also `reply-to-me <messageId>` — the Step 4a always-P1 check (exit 0 = it answers something the user sent, 3 = it doesn't, 1 = error → fail open)
- `~/Dev/edva/bin/email-mem` — add/search/list/remove/test classification memories (SQLite FTS5)
- `~/Dev/edva/bin/spam-filter` — block/allow/unblock/list sender and topic patterns (`block --scam --message <id>` for a confirmed scam, see Step 0b; `check --json` reports whether an entry is a scam)
- `~/Dev/edva/data/spam-blocklist.json` — current blocklist data
- `~/Dev/edva/lib/email-memory.js` — underlying memory library (SQLite at `~/Dev/edva/data/email-memory.db`)

---

### Decide-then-act triage (`triage-decide`) — rollout state and cutover criteria (added 2026-10-04)

**What it is.** The same triage, split in two: ONE tool-less `claude -p` call (Max session, Sonnet, effort low, no MCP) reads this ruleset plus the prefetched email and returns `{label, priority, notify, urgent, task:{action}, action_tags[]}`; then **code** executes Step 5 exactly as written above — the gmail-action calls, the P1 pointer with `--evidence-as-of` taken from the Date header, `p1-task add` with the § Timezone due date, and any travel-scan webhook the instance's action tags call for. Anything that needs more than Step 5 (`calendar-event`, `meeting-cancellation`, `instruction`, `spam-campaign`, `other-agent`, and the instance's own action tags) still goes to a full agent dispatch. Mail addressed to Edva (the command channel) always does. Code: `lib/triage-decide.mjs`, CLI `bin/triage-decide`. Why: nearly all of what a `gmail:*` dispatch costs is the ops session floor re-read per turn — not the judgment — and email is one of the busiest dispatch sources.

**Current mode: `shadow`** (`data/triage-decide-config.json`). Live triage is unchanged: every email still dispatches to you. Alongside each dispatch a detached `triage-decide shadow` logs what it WOULD have done to `data/triage-decide-shadow.jsonl`. You do not interact with it.

**Measuring it.** `triage-decide report [--days N]` compares each shadow decision with what actually happened — the `triage_decisions` row (final label + priority, including any later reclassify or unstar by the user) — after a 20-minute settle.

**Cutover criteria — all must hold, over the report window:**
1. ≥ 150 compared emails spanning ≥ 7 days;
2. label agreement ≥ 95% and priority agreement ≥ 95%;
3. **zero missed P1s** (the actual outcome was P1 and the shadow said P2/P3);
4. (was: a human read of every disagreement first — waived by the user on 2026-10-05; read the `≠` rows in `triage-decide report` after the flip instead.)

**The flip is automatic.** The daily `shadow-cutover-check` cron (10:00 local) sets `"mode": "live"` in the config when `report --json` says `verdict.ready`, and announces it once on the system channel. Rollback is the same edit back to `"shadow"` (read per email; no restart). In live mode any model failure, invalid output, failed gmail-action call, or agent-needing tag falls back to the normal dispatch — an email is never dropped.
