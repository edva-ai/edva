# Integration: Supabase

Wire Supabase if you want any of:

- **The companion iOS/macOS app** to chat with your agent (requires Realtime).
- **Phone-context publishing** (motion / Wi-Fi / location → agent).
- **Persistent message + command history** that survives supervisor restarts.
- **APNs push routing** through a Supabase edge function.

Without Supabase, Merlin still works for cron-driven jobs + email triage + the wiki/memory layer. The phone-channel + companion app are the only features that hard-require it.

## 1. Create a Supabase project

At https://supabase.com:

- New project. Pick a region close to your host (latency matters for Realtime).
- Note the **project ref** (the slug in `<ref>.supabase.co`).
- Service-role key → Settings → API → `service_role` (this is the secret one).
- Anon key → Settings → API → `anon` `public`.

Add to `.env`:

```
SUPABASE_URL=https://<ref>.supabase.co
MERLIN_SUPABASE_PROJECT=<ref>
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

For the MCP server's Management-API access (creating/inspecting projects via the agent):

```
SUPABASE_ACCESS_TOKEN=sbp_...    # generate at supabase.com/dashboard/account/tokens
```

## 2. Tables Merlin expects

The phone-channel + companion-app pipeline expects these tables. Apply via the Supabase SQL editor or by adding migration files to your fork:

```sql
-- Messages between the user (via companion app) and the agent
create table merlin_messages (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  read boolean default false,
  ack boolean default false,
  reaction text,
  device_token text,
  parent_id uuid references merlin_messages(id),
  created_at timestamptz not null default now()
);
alter table merlin_messages enable row level security;

-- Commands from the agent to the phone (e.g. get_location requests)
create table merlin_commands (
  id uuid primary key default gen_random_uuid(),
  command text not null,
  payload jsonb,
  status text default 'pending',
  response jsonb,
  created_at timestamptz not null default now()
);
alter table merlin_commands enable row level security;

-- Phone context (motion + Wi-Fi + audio class) — one row per device
create table phone_context (
  device_id text primary key,
  motion_class text,
  wifi_ssid text,
  audio_class text,
  battery_pct int,
  charging boolean,
  updated_at timestamptz not null default now()
);
alter table phone_context enable row level security;

-- APNs device tokens (registered by the companion app)
create table device_tokens (
  device_id text primary key,
  apns_token text not null,
  environment text default 'production',
  updated_at timestamptz not null default now()
);
alter table device_tokens enable row level security;
```

Enable Realtime on `merlin_messages` (Database → Replication → toggle on for the merlin_messages table). Without this, the phone-channel can't subscribe.

If you also want location/health/photos sync (the companion app's full feature set), add the corresponding tables — see the iOS app's `SupabaseManager.swift` for the exact schemas. For a minimal setup, the four tables above are enough.

## 3. Verify

Start the agent (`./bin/merlin up`), check the logs:

```
[phone-channel] subscribed to merlin_messages realtime
[phone-channel] subscribed to phone_context realtime
[phone-channel] ready
```

If you see `FATAL: SUPABASE_SERVICE_ROLE_KEY not set in .env`, the env var didn't propagate — check that `.env` is in `${MERLIN_HOME}/.env` (not somewhere else) and that `process-manager.mjs` loaded it (look for `[process-manager]` startup log lines).

## 4. Companion app pairing

For the iOS/macOS companion app at `apps/companion/`:

1. Build per [`apps/companion/CODE-SIGNING.md`](../../apps/companion/CODE-SIGNING.md).
2. In the app's `SupabaseManager.swift`, fill in your `SUPABASE_URL` + `SUPABASE_ANON_KEY`.
3. Run the app, sign in (Google Sign-In is the default; the app exchanges the Google credential for a Supabase session).
4. The app subscribes to `merlin_messages` and posts new user messages there. The phone-channel daemon on your host sees them via Realtime and routes them to the chat-supervisor.

## RLS policies

The above schema enables Row Level Security but doesn't define any policies — that means no client can read/write through the anon key. The agent uses the **service-role** key (which bypasses RLS) so it works either way. If you want the companion app to be the ONLY client that reads/writes (which is the right security posture), add policies that scope to the authenticated user's UID.

A reasonable starting policy:

```sql
create policy "users can see their own messages"
  on merlin_messages for select
  to authenticated
  using (auth.uid() is not null);

create policy "users can insert their own messages"
  on merlin_messages for insert
  to authenticated
  with check (role = 'user');
```

## Cost

A typical chat-only deployment fits in Supabase's free tier (500 MB DB + 50 MB file storage + 2 GB egress + unlimited Realtime). If you also enable health-data sync (10+ tables, 10k+ rows/day depending on Apple Health activity), you'll need the Pro plan ($25/month).

## Migrating off a personal project

If you previously had a Supabase project tied to a personal account (the original gandalf source did), the cleanest migration is:

1. Create a fresh Supabase project under a dedicated service-identity email.
2. Apply the schema above.
3. Update `.env` with the new credentials.
4. Optionally bulk-import historical message rows via SQL editor.

This pattern (separate Supabase identity for the agent's operational data, distinct from your personal Supabase account) is what we run — see the original [§ 4.2 in the rebuild guide](../../system/architecture.md). It keeps token scope minimal and rotation simple.
