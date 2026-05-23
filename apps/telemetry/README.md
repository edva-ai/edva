# merlin-telemetry

Tiny Vercel edge function powering two anonymous endpoints for the public Merlin
project:

| URL                                   | What hits it                                      |
| ------------------------------------- | ------------------------------------------------- |
| `GET  /px[/anything]?r=<tag>`         | The README tracking pixel (and any docs pixels).  |
| `POST /install`                       | First-run install ping from `bin/merlin install`. |

Both routes share one handler (`api/ping.ts`). The two `vercel.json` rewrites
just give us nicer URLs in the README and CLI than `/api/ping`.

## What gets logged

One JSON line per hit to Vercel Runtime Logs (queryable with `vercel logs`):

```json
{"kind":"px","ts":"2026-05-23T18:00:00.000Z","ipHash":"a1b2…","ua":"…","ref":"…","tag":"readme"}
{"kind":"install","ts":"…","ipHash":"…","ua":"…","host_fp":"…","os":"darwin","arch":"arm64","ver":"0.1.0","sha":"deadbeef","ctx":"fresh-install"}
```

No database, no cookies, no raw IP retention. The IP is hashed with a
per-calendar-day salt so we can count unique-per-day cloners without storing
addresses across days. The hash narrows by ~50% every UTC midnight by design.

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
vercel --prod           # ships, prints the *.vercel.app URL
```

After the first deploy:

1. Take the printed URL (e.g. `https://merlin-telemetry.vercel.app`).
2. Insert it as `![](https://<url>/px?r=readme)` near the bottom of the root
   `README.md`.
3. Set `MERLIN_TELEMETRY_URL=https://<url>/install` in the `bin/merlin install`
   defaults (see `bin/merlin`).

The URL is the only thing the public Merlin clones learn about your telemetry
setup. Everything else is opaque to them.
