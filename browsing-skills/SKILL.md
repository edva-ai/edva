---
name: edva-browsing-skills
description: "Umbrella skill for Edva's browsing-skills registry. Use when the user's request targets a website covered by either the upstream public registry (Reddit, Amazon, Airbnb, Booking, X, LinkedIn, TikTok, Facebook, Walmart, Target, AliExpress) or one of this installation's private skills (indexed in agent/local/browsing-skills.md). For supported sites, load the site-specific action index at the matching path, then open only the linked reference file for the chosen action. For unsupported sites, fall back to normal browsing — don't force this skill." # kernel-guard-ok: Airbnb here is the upstream public registry skill, not an installation-private one
edvaPrivate: true
---

# Edva — Browsing Skills

This is Edva's internal browsing-skills registry. It complements (and reuses) the public `browsing-skills/browsing-skills` library by way of the operator's fork (named in `agent/local/browsing-skills.md`). The fork is auto-pulled into `external/` daily by `bin/browsing-skills-sync`.

## When to use

Before scraping any of the sites listed below, **load the matching site SKILL.md** instead of inspecting the DOM from scratch. The site SKILL.md routes you to one focused action reference per task.

## Site index

### Upstream (synced from the fork → `external/`)

| Site | Path | Available actions |
|---|---|---|
| Reddit | `external/skills/reddit.com/SKILL.md` | subreddit-feed, search, post-thread, user-profile, current-user-list, **submit-comment** *(write, our fork addition)* |
| X (Twitter) | `external/skills/x.com/SKILL.md` | search, post-data, profile-data |
| LinkedIn | `external/skills/linkedin.com/SKILL.md` | post-data |
| TikTok | `external/skills/tiktok.com/SKILL.md` | get-post-analytics, get-posts-list, download-post-video |
| Facebook | `external/skills/facebook.com/SKILL.md` | marketplace-search, marketplace-listing-data, marketplace-seller-data ⚠️ *avoid private-group scraping* |
| Amazon | `external/skills/amazon.com/SKILL.md` | search, product-data, grocery-storefront, cart-data, add-to-cart |
| Walmart | `external/skills/walmart.com/SKILL.md` | search, product-data, cart-data, add-to-cart |
| Target | `external/skills/target.com/SKILL.md` | search, product-data, cart-data, add-to-cart |
| AliExpress | `external/skills/aliexpress.com/SKILL.md` | search, product-data, cart-data, add-to-cart |
| Booking.com | `external/skills/booking.com/SKILL.md` | search, hotel-data, reviews, book-room |
| Airbnb | `external/skills/airbnb.com/SKILL.md` | search, listing-data, reviews, availability-price | <!-- kernel-guard-ok: an upstream public registry skill -->

### Installation-private (this repo, under `skills/`)

This installation's own site skills — sites tied to its accounts, bookings and jobs — are indexed in **`agent/local/browsing-skills.md`** (same table shape: site, path, actions, and the job each one drives). Read it before scraping a site that is not in the table above.

## How to execute an action

All actions run via Edva's `chrome-devtools-mcp` against the automation Chrome on `localhost:9222` (see `system/architecture.md` § "Host"). The execution shape is identical to the upstream:

```js
// In a playbook step, AFTER navigating to the right URL:
const code = await fs.readFile('browsing-skills/external/skills/<site>/references/<action>.md', 'utf8');
const jsBlock = extractJsBlock(code);          // last ```js ... ``` in the file
const result = await cdp.evaluate(`(${jsBlock}).execute(${JSON.stringify(params)})`);
const data = JSON.parse(result.content[0].text);
```

Or one-shot from the CLI for ad-hoc / debugging:

```bash
browsing-skills/tools/run-action.js <site>/<action> --params '{...}'
```

## Write-action policy

Any action that modifies external state (Reddit submit-comment, Booking.com book-room, a cart add-to-cart, a vote or an entry form) requires:

1. **Explicit user consent** for the exact target + payload — never run on speculation.
2. **DOM verification** that the write took effect — clicking a button is not proof.
3. **Structured error returns** instead of throws — at minimum `posted: false, error: "<code>"` so cron diagnoses cleanly.
4. **Cooldowns** appropriate to the platform — see each site's SKILL.md.

## Adding a new skill

1. `mkdir -p skills/<domain>/references`
2. Write `SKILL.md` (frontmatter `name` + `description` required) with an Action Index linking to references.
3. Write each `references/<action>.md` with the standard sections (Requirements, How to run, Action, Code, Returns).
4. Run `browsing-skills/tools/validate-skill.js` — must pass.
5. Add an integration test: `fixtures/<domain>__<action>.test.html` + `.expected.json`.
6. Add a line to the site index: this umbrella's for an upstream site, `agent/local/browsing-skills.md` for a private one.
7. Update `system/architecture.md` per Rule #1.
8. On an empty or unparseable page, return `{ events: [] , diagnostic: "<why>" }` (or the action's own empty shape plus `diagnostic`), and have the caller log failures as `{"skill","action","error","diagnostic","url"}`. That line is what lets the same-day repair loop (`jobs/skill-repair.md`) fix the action when the site changes.
