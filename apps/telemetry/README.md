# merlin-telemetry

Tiny Vercel edge function powering two anonymous endpoints for the public Merlin
project:

| URL                                   | What hits it                                      |
| ------------------------------------- | ------------------------------------------------- |
| `GET  /px[/anything]?r=<tag>`         | The README tracking pixel (and any docs pixels).  |
| `POST /install`                       | First-run install ping from `bin/merlin install`. |
| `GET  /stats`                         | Aggregate, anonymous install counters (JSON).     |
| `GET\|POST /usage`                    | Private Claude usage/cost rollup (token-gated).   |

All four routes share one handler (`api/ping.ts`). The `vercel.json` rewrites
just give us nicer URLs in the README and CLI than `/api/ping`.

## What gets logged

One JSON line per hit to Vercel Runtime Logs (queryable with `vercel logs`):

```json
{"kind":"px","ts":"2026-05-23T18:00:00.000Z","ipHash":"a1b2…","ua":"…","ref":"…","tag":"readme"}
{"kind":"install","ts":"…","ipHash":"…","ua":"…","host_fp":"…","os":"darwin","arch":"arm64","ver":"0.1.0","sha":"deadbeef","ctx":"fresh-install"}
```

No cookies, no raw IP retention. The IP is hashed with a per-calendar-day salt
so we can count unique-per-day cloners without storing addresses across days.
The hash narrows by ~50% every UTC midnight by design.

## Durable install counters (KV)

Vercel Runtime Logs expire (and the CLI can only *stream* them live — it can't
fetch history), so the install ping also writes **anonymous aggregate counters**
to a KV store (Upstash Redis / Vercel KV) that survive log expiry. Read them at
`GET /stats`:

```jsonc
{
  "installs_total": 42,        // running total of install pings
  "unique_hosts": 17,          // HyperLogLog cardinality of host_fp
  "last_install": "2026-06-18T…",
  "by_os":      { "darwin": 30, "linux": 12 },
  "by_arch":    { "arm64": 28, "x64": 14 },
  "by_version": { "0.1.0": 42 },
  "by_context": { "fresh-install": 35, "reinstall": 7 },
  "recent":     [ { "ts": "…", "os": "darwin", "arch": "arm64", "ver": "0.1.0", "ctx": "fresh-install" } ]
}
```

What KV stores is **only counters and a HyperLogLog** of host fingerprints — the
`host_fp` values themselves are never written, so `unique_hosts` is a cardinality
estimate with nothing to leak. The `recent` feed carries no IP and no `host_fp`,
just the coarse os/arch/ver/ctx descriptors.

KV is **best-effort**: every write is wrapped, and if the KV env vars are absent
the function behaves exactly like the pre-KV, logs-only version — an install
ping can never fail because of telemetry. `/stats` returns `503` when KV isn't
configured, and can be gated behind a `STATS_TOKEN` env var (`/stats?token=…`).

## Claude usage/cost monitoring (`/usage`)

Separate from anonymous adoption telemetry, `/usage` is **private operator
telemetry** for central Claude API usage/cost monitoring across hosts. Merlin's
supervisor already writes per-job token/cost rows locally
(`agent/logs/supervisor-ops/job-costs.ndjson`, read by `bin/merlin-cost-report`);
`merlin-cost-report --push` rolls those up **per day** and POSTs them here so they
survive log rotation and are queryable from anywhere.

```bash
# on each host (token from .env / MERLIN_USAGE_TOKEN), e.g. from nightly-review:
merlin-cost-report --since 2d --push
```

- **Always token-gated** (`STATS_TOKEN`, via `?token=` or `Authorization: Bearer`).
  The endpoint returns `503` if no token is configured, so cost data can never be
  ingested or read anonymously. Public clones leave `MERLIN_USAGE_TOKEN` unset.
- **Idempotent** per `(host, day)`: re-pushing a day overwrites that host's
  snapshot rather than double-counting, so a cron that pushes a 2-day window is safe.
- **Cost figures are estimates.** Per merlin's Max-only auth invariant the
  supervisor's `total_cost_usd` is an SDK estimate, not billed spend. `/usage`
  carries a `cost_is_estimated` flag and names the field `est_cost_usd`. The
  signals that matter for cost *reduction* are token volume and `cache_hit_rate`.

Read the rollup (default last 30 days, `?days=N` to widen):

```bash
curl -s "https://merlin-telemetry.vercel.app/usage?days=14&token=$(op read 'op://Dev/Merlin Telemetry Upstash KV/STATS_TOKEN')"
```

```jsonc
{
  "window_days": 14,
  "unique_hosts": 2,
  "last_push": "2026-06-18T…",
  "cost_is_estimated": true,
  "totals": { "dispatches": 410, "input_tokens": 1200000, "output_tokens": 90000,
              "cache_read_tokens": 8400000, "cache_creation_tokens": 320000,
              "web_search_requests": 12, "total_turns": 980,
              "total_duration_ms": 5400000, "est_cost_usd": 0 },
  "cache_hit_rate": 0.875,                 // cache_read / (cache_read + input)
  "by_job": { "hum": { … }, "webhook": { … } },
  "by_day": { "2026-06-17": { … }, "2026-06-18": { … } }
}
```

## What is **not** logged

- The raw client IP (only an 8-byte hash, salted per day).
- Anything from clients that send `DNT: 1` or set `MERLIN_NO_TELEMETRY=1` in
  their environment (handled by the CLI, not the server).
- Anything the CLI didn't choose to send — there is no user-content collection,
  no environment dump, no path enumeration. Look at `bin/merlin` to verify.

## Reality check on the README pixel

GitHub renders README images through their Camo proxy. That means hits *from
github.com viewers* will look like:

- `ipHash`: a small handful of Camo IPs (not the viewer's IP).
- `ua`: `github-camo/…` (not the viewer's UA).
- `ref`: usually empty.
- Cached, so subsequent views of the same URL by the same Camo edge may not
  re-fetch.

The pixel still gives signal for:

- Readers who open the README in a local editor that fetches images (VS Code
  preview, JetBrains, Obsidian, etc.) — those hit the function directly.
- Mirrors that don't proxy (forks rendered elsewhere, awesome-lists, etc.).
- `raw.githubusercontent.com` direct viewers.

If you want a stronger "real human is trying merlin" signal, the install ping
is the right metric — that requires actually downloading the repo and running
the installer.

## Deploy

```bash
cd apps/telemetry
vercel login            # one-time
vercel link             # one-time, scope to a Vercel team

# one-time: provision a KV store and attach it to this project. The Upstash
# Redis marketplace integration injects KV_REST_API_URL / KV_REST_API_TOKEN.
#   Dashboard → Storage → Create → Upstash Redis → Connect to merlin-telemetry
# then pull the new env vars locally:
vercel env pull

# optional: gate /stats behind a token
vercel env add STATS_TOKEN production

vercel --prod           # ships, prints the *.vercel.app URL
```

If you skip the KV step the function still deploys and works — it just falls
back to logs-only and `/stats` returns `503` until a store is attached.

After the first deploy:

1. Take the printed URL (e.g. `https://merlin-telemetry.vercel.app`).
2. Insert it as `![](https://<url>/px?r=readme)` near the bottom of the root
   `README.md`.
3. Set `MERLIN_TELEMETRY_URL=https://<url>/install` in the `bin/merlin install`
   defaults (see `bin/merlin`).

The URL is the only thing the public Merlin clones learn about your telemetry
setup. Everything else is opaque to them.
