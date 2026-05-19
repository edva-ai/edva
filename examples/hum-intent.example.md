---
type: reference
title: Hum intent
description: North-star doc for what the hum loop should and shouldn't surface for the user.
status: active
last_verified_at: 2026-01-01
---

# Hum intent

This file is hum's north star. Every time hum-review runs (weekly by default), it reads this and grades the prior week's ticks against it. Surfaced pings that align with intent → good. Pings that violate it → tuning proposals. Silent ticks that should have surfaced → also tuning proposals.

**Copy this template to `data/hum-intent.md`** (gitignored) and edit to fit. Empty intent = hum-review has nothing to grade against and the loop will optimize for raw engagement, which is the wrong target.

---

## What hum is for

Surface useful information at the right moment so the user notices it before they would have on their own. Two kinds of utility:

1. **Time-sensitive helpfulness.** The meeting that starts in 30 minutes at a place you're not currently at. The flight that's now delayed. The task that's overdue and quietly important. Things where being told *now* materially changes what you do.

2. **Pattern-aware nudges.** The week is half over and you're 1 of 5 expected sessions on a habit you committed to. A friend's birthday is in 9 days. A topic you said you'd circle back to has had 14 days of silence.

Both serve the same goal: **make me realize something I'd have missed**, with enough lead time to act.

## Success criteria (graded by hum-review)

A surfaced ping is **good** when:

- The user reacts positively (👍 / helpful / "thanks" / silence-then-acts-on-it).
- It surfaces something materially time-sensitive that would have been missed.
- It connects two signals that weren't obvious in isolation (cross-topic synthesis).

A surfaced ping is **bad** when:

- The user reacts negatively (👎 / skip / "stop") or with confusion ("what is this?").
- It restates something the user already knows or just did.
- It would have been better as silence — a tick that didn't need to fire.

A silent tick is **good** when:

- The user's situation is steady-state (focused work, mid-conversation, sleeping).
- All candidates are below the relevance threshold.
- The user explicitly asked for quiet (`hum pause` was active).

A silent tick is **bad** when:

- A clear ping-worthy candidate was below threshold and was filtered out by an over-conservative gate.
- An active quiet window blocked a high-urgency signal.

## Anti-patterns (never do these)

- **Re-surfacing.** Same finding twice without new information. Use the suggestion-history ledger.
- **Pestering on rejection.** If the user said no to a category, that's a signal. Update memory; back off.
- **Spam thresholds.** No "well, two pings a day is the cap, so fire something." Quality over cadence.
- **Generic restatements.** "Your morning is busy" is not a ping. "Your 11am needs prep — last related thread was the doc you opened 3 days ago" is.

## Operating assumptions to encode

Fill in your own here. Things the agent should treat as load-bearing context:

- **Work hours**: weekdays 09:30–18:00 local. Outside these, lower the urgency floor.
- **Sleep window**: 23:00–07:00. No pings except safety/financial emergencies.
- **Lunch**: typically 12:30–13:30. Soft quiet.
- **Pre-meeting buffer**: 15 min before any calendar event, prefer departure/prep findings over other topics.
- **Travel disclosure**: if a trip is on the calendar, pre-trip prep findings should crowd out routine candidates for 48h before departure.

(Add your own. The more specific, the better hum-review's tuning proposals get.)

## What the user has explicitly said no to

Initially empty. Hum-review and the suggestion-history ledger will surface candidate-rejection patterns; document the durable ones here so they survive tuning churn.

Example structure once you start:

- *Hallmark holidays* — never surface gift/itinerary ideas for Mother's Day / Father's Day / Valentine's Day.
- *Stock-watching pings during market hours* — too noisy; just digest at close.

## Tuning history (most recent first)

Initially empty. Hum-review proposes tuning here once a week. Apply the ones you agree with; ignore the rest.

Example structure once you start:

- *2026-MM-DD* — raised score threshold from 0.45 → 0.50 after a week of 8% off-target pings. Reverted 2026-MM-DD when miss rate climbed.
- *2026-MM-DD* — added `serendipity` to quiet-window list during work hours. Worked.
