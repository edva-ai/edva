MORNING DIGEST — Compile the morning brief, send as EMAIL, and post a short pointer to the phone channel.

Before starting, run `merlin doctor` to confirm the system is consistent. **Do NOT include `doctor` output in the email** — the email is user-facing content. If `doctor` reports failures, send a separate one-line Merlin phone ping (`${MERLIN_HOME}/bin/merlin-send-curl --suppress-hook "doctor: <N>/<M> failing — <short hint>"`) and continue with the job. The email stays focused on the brief only.

## Content to gather

### 1. Today's Calendar
- Use mcp__claude_ai_Google_Calendar to fetch today's events.
- List each event with time and title. If none, write "No events today".

### 2. Tasks
- `gog tasks list @default --plain`. Highlight overdue and due-today.

### 3. Overnight Email Summary
- `merlin triage recent` since midnight.
- Summarize P1 and P2 emails: sender, subject, label, action. Include a count of P3.

### 4. News Headlines (2-3 per category)
- **World**: NYT, WaPo, BBC, Reuters.
- **Israel**: Ynet, Haaretz, Times of Israel.
- **Business**: market-moving stories.
- **Local**: based on the user's current location (e.g. from a wired-in location source).
- Use `WebSearch` (not `WebFetch`) — queries like `site:nytimes.com OR site:bbc.com top news today`.
- Render each headline as plain HTML text (summary or one-line headline). **Do NOT `og-card` news-section URLs** — the og-cards for news homepages / masthead links resolve to the publisher's logo only and add no value. If a specific article URL is worth citing, link it inline with `<a>` and keep it terse.
- If a section yields nothing, say "No headlines available" — do not omit.

### 5. Weather
- `${MERLIN_HOME}/bin/apple-weather --findme`. On failure, fall back to open-meteo with lat/lon from `findme`. If both fail, "Weather unavailable".

### 6. Events, Holidays & Festivals
- Web search for today's events/festivals/holidays in the user's current city. 2-4 highlights, event-page URL below each. Always include the section.

## Step A — Build the email

Write HTML to `/tmp/morning-brief-<YYYYMMDD>.html`. No emojis anywhere. **Only EVENTS & FESTIVALS URLs** get rendered through `${MERLIN_HOME}/bin/og-card` (see ops-agent CLAUDE.md → "Use og-card for every URL in outbound email") — event cards show venue imagery that adds value. NEWS-section URLs must NOT be og-carded (cards for news-service homepages just show the publisher logo; zero signal). CALENDAR / TASKS / OVERNIGHT EMAIL / WEATHER have no URLs.

Structure (labels in plain HTML, each URL replaced by its og-card output):

```
<h1 style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:18px;margin:0 0 10px 0">Morning Brief — [Day, Date]</h1>

<h2>CALENDAR</h2>
- [time] [event]

<h2>TASKS</h2>
Due today:
- [task]
Due tomorrow:
- [task]

<h2>OVERNIGHT EMAIL</h2>
P1: [sender] — [subject] ([label], [action])
P2: [sender] — [subject] ([label], [action])
+ [N] P3 emails processed

<h2>NEWS</h2>
<h3>World</h3>
<ul><li>[headline] — [one-line summary]</li> ...</ul>
<h3>Israel</h3>
…
<h3>Business</h3>
…
<h3>Local ([city])</h3>
…

<h2>WEATHER ([city])</h2>
[High/Low, conditions]

<h2>EVENTS & FESTIVALS</h2>
<div>[event] — [desc]</div>
<!-- og-card stdout for the event URL -->
```

Batch the URL fetches (headlines + events together) for speed:

```bash
printf '%s\n' "${ALL_URLS[@]}" | ${MERLIN_HOME}/bin/og-card --batch > /tmp/morning-cards.html
# cards come back in input order separated by "<!-- og-card-sep -->"
```

## Step B — Send email (label `personal`, star, mark-read, no `p1`)

Per the universal long-form delivery rule in `ops-agent/CLAUDE.md`, every scheduled-job digest — including this one — ships as: `personal` label + **star (yellow)** + mark-read + no `p1` label. The phone pointer + APNs push below are the only notification; the star is for inbox visibility, NOT a re-notification trigger. Do NOT apply the `p1` label and do NOT leave unread — but DO star so the email stands out among third-party mail (policy updated 2026-04-19).

```bash
SUBJECT="Morning Brief — $(TZ=America/New_York date '+%a, %b %-d')"
${MERLIN_HOME}/bin/email-send \
  --to ${MERLIN_OWNER_EMAIL} \
  --subject "$SUBJECT" \
  --body-file /tmp/morning-brief-$(TZ=America/New_York date +%Y%m%d).html \
  --html
```

Wait for Gmail to index, then label `personal` and mark-read:

```bash
SUBJECT="Morning Brief — $(TZ=America/New_York date '+%a, %b %-d')"
until MSG_ID=$(/opt/homebrew/bin/node -e "
const { getAccessToken } = require('${MERLIN_HOME}/lib/google-auth.js');
(async () => {
  const tok = await getAccessToken();
  const q = encodeURIComponent('from:${MERLIN_AGENT_FROM_EMAIL} subject:\"' + process.argv[1] + '\" newer_than:1d');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' + q + '&maxResults=1', { headers: { Authorization: 'Bearer ' + tok } });
  const j = await r.json();
  if (j.messages && j.messages[0]) console.log(j.messages[0].id);
})();
" "$SUBJECT") && [ -n "$MSG_ID" ]; do sleep 5; done
${MERLIN_HOME}/bin/gmail-action label "$MSG_ID" personal
${MERLIN_HOME}/bin/gmail-action star "$MSG_ID"
${MERLIN_HOME}/bin/gmail-action mark-read "$MSG_ID"
```

Do NOT fire a P1 triage-style notification — the phone pointer below is the only ping. The star is inbox visibility only.

## Step C — Phone channel pointer

Send a single short message to the phone channel, then a single push. No content dump on phone — the full brief lives in email.

```bash
${MERLIN_HOME}/bin/merlin-send-curl --no-push --suppress-hook "Morning brief emailed — check inbox."
${MERLIN_HOME}/bin/merlin-notify "Morning brief for $(TZ=America/New_York date '+%a, %b %-d') is in your inbox"
```
