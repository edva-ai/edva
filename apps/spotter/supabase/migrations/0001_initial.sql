-- Exercise app schema — mirrors the SwiftData models.
-- Every row is owned by auth.users(id). Row-Level Security restricts reads/writes
-- to the signed-in user. Merlin queries happen under the service_role key from
-- the backend / MCP server, which bypasses RLS.

create extension if not exists "pgcrypto";

-- Finished workout sessions
create table if not exists public.sessions (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    started_at timestamptz not null,
    finished_at timestamptz,
    workout_type text not null,
    gym_used boolean not null default true,
    notes text not null default '',
    healthkit_uuid uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists sessions_user_started_idx on public.sessions(user_id, started_at desc);

-- Per-set log entries
create table if not exists public.set_logs (
    id uuid primary key,
    session_id uuid not null references public.sessions(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    exercise_slug text not null,
    set_number int not null,
    reps int,
    weight_lbs double precision,
    duration_seconds int,
    side text,
    rpe int,
    notes text not null default '',
    completed_at timestamptz not null,
    created_at timestamptz not null default now()
);

create index if not exists set_logs_user_completed_idx on public.set_logs(user_id, completed_at desc);
create index if not exists set_logs_exercise_idx on public.set_logs(user_id, exercise_slug, completed_at desc);

-- Trigger: keep updated_at fresh
create or replace function public.touch_updated_at() returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists sessions_touch on public.sessions;
create trigger sessions_touch
    before update on public.sessions
    for each row execute function public.touch_updated_at();

-- Row-Level Security
alter table public.sessions enable row level security;
alter table public.set_logs enable row level security;

drop policy if exists "own sessions" on public.sessions;
create policy "own sessions" on public.sessions
    for all
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

drop policy if exists "own set_logs" on public.set_logs;
create policy "own set_logs" on public.set_logs
    for all
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- Convenience view used by Merlin/analytics: per-exercise max weight + last date.
create or replace view public.exercise_highlights as
select
    user_id,
    exercise_slug,
    max(weight_lbs) as max_weight_lbs,
    max(completed_at) as last_performed_at,
    count(*) as total_sets
from public.set_logs
group by user_id, exercise_slug;

grant select on public.exercise_highlights to authenticated;
