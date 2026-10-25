# Integration: Supabase

Wire Supabase if you want any of:

- **The companion iOS/macOS app** to chat with your agent (requires Realtime).
- **Phone-context publishing** (motion / Wi-Fi / location → agent).
- **Persistent message + command history** that survives supervisor restarts.
- **APNs push routing** through a Supabase edge function.

Without Supabase, Edva still works for cron-driven jobs + email triage + the wiki/memory layer. The phone-channel + companion app are the only features that hard-require it.

## 1. Create a Supabase project

At https://supabase.com:

- New project. Pick a region close to your host (latency matters for Realtime).
- Note the **project ref** (the slug in `<ref>.supabase.co`).
- Service-role key → Settings → API → `service_role` (this is the secret one).
- Anon key → Settings → API → `anon` `public`.

Record the project in `agent/local/instance.json` (`"supabase_project": "<ref>"` — `edva init` asks for it; `EDVA_SUPABASE_PROJECT` in `.env` overrides), the public anon key in `agent/local/config/supabase.json` (`{"anon_key": "..."}`), and the secret in `.env`:

```
SUPABASE_SERVICE_ROLE_KEY=...
# SUPABASE_URL defaults to https://<supabase_project>.supabase.co; set it only for a custom domain.
```

For the MCP server's Management-API access (creating/inspecting projects via the agent):

```
SUPABASE_ACCESS_TOKEN=sbp_...    # generate at supabase.com/dashboard/account/tokens
```

## 2. Tables Edva expects

The phone-channel + companion-app pipeline expects these tables. Apply via the Supabase SQL editor or by adding migration files to your fork:

```sql
-- Messages between the user (via companion app) and the agent
create table edva_messages (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  read boolean default false,
  ack boolean default false,
  reaction text,
  device_token text,
  parent_id uuid references edva_messages(id),
  created_at timestamptz not null default now()
);
alter table edva_messages enable row level security;

-- Commands from the agent to the phone (e.g. get_location requests)
create table edva_commands (
  id uuid primary key default gen_random_uuid(),
  command text not null,
  payload jsonb,
  status text default 'pending',
  response jsonb,
  created_at timestamptz not null default now()
);
alter table edva_commands enable row level security;

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

Enable Realtime on `edva_messages` (Database → Replication → toggle on for the edva_messages table). Without this, the phone-channel can't subscribe.

If you also want location/health/photos sync (the companion app's full feature set), add the corresponding tables — see the iOS app's `SupabaseManager.swift` for the exact schemas. For a minimal setup, the four tables above are enough.

## 3. Verify

Start the agent (`./bin/edva up`), check the logs:

```
[phone-channel] subscribed to edva_messages realtime
[phone-channel] subscribed to phone_context realtime
[phone-channel] ready
```

If you see `FATAL: SUPABASE_SERVICE_ROLE_KEY not set in .env`, the env var didn't propagate — check that `.env` sits at `$EDVA_HOME/.env` and that `process-manager.mjs` loaded it (it logs a warning when it cannot).

## 4. Companion app pairing

For the iOS/macOS companion app at `apps/companion/`:

1. Build per [`apps/companion/CODE-SIGNING.md`](../../apps/companion/CODE-SIGNING.md).
2. The app sources carry placeholders, not a project: replace `${EDVA_SUPABASE_PROJECT}` and `${EDVA_SUPABASE_ANON_KEY}` in `apps/companion/Edva/SupabaseManager.swift` (and, for Trainer, `apps/trainer/Trainer/Services/TrainerSupabase.swift` plus the `SupabaseURL` / `SupabaseAnonKey` keys in `apps/trainer/Trainer/Info.plist`) with your project ref and anon key in your local build — or inject them at build time — and don't commit the filled-in values (`.tools/sanitize-guard.py` flags a committed JWT).
3. Run the app, sign in (Google Sign-In is the default; the app exchanges the Google credential for a Supabase session).
4. The app subscribes to `edva_messages` and posts new user messages there. The phone-channel daemon on your host sees them via Realtime and routes them to the chat-supervisor.

## RLS policies

The above schema enables Row Level Security but doesn't define any policies — that means no client can read/write through the anon key. The agent uses the **service-role** key (which bypasses RLS) so it works either way. If you want the companion app to be the ONLY client that reads/writes (which is the right security posture), add policies that scope to the authenticated user's UID.

A reasonable starting policy:

```sql
create policy "users can see their own messages"
  on edva_messages for select
  to authenticated
  using (auth.uid() is not null);

create policy "users can insert their own messages"
  on edva_messages for insert
  to authenticated
  with check (role = 'user');
```

## Cost

A typical chat-only deployment fits in Supabase's free tier (500 MB DB + 50 MB file storage + 2 GB egress + unlimited Realtime). If you also enable health-data sync (10+ tables, 10k+ rows/day depending on Apple Health activity), you'll need the Pro plan ($25/month).

## A dedicated project for the agent

Give the agent's operational data its own Supabase project (and, ideally, its own account identity) rather than reusing a personal one: token scope stays minimal, rotation stays simple, and nothing else breaks when you reset it.
