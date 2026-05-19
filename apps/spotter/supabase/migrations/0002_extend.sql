-- Adds remaining state so Merlin / analytics can see the full picture:
-- per-exercise target overrides, day overrides, weekly plan defaults, and app settings.

create table if not exists public.exercise_targets (
    user_id uuid not null references auth.users(id) on delete cascade,
    exercise_slug text not null,
    target_sets int not null,
    target_reps_low int,
    target_reps_high int,
    updated_at timestamptz not null default now(),
    primary key (user_id, exercise_slug)
);

create table if not exists public.day_overrides (
    user_id uuid not null references auth.users(id) on delete cascade,
    date_key date not null,
    workout_type text,
    gym_available boolean,
    updated_at timestamptz not null default now(),
    primary key (user_id, date_key)
);

create table if not exists public.weekly_plan_days (
    user_id uuid not null references auth.users(id) on delete cascade,
    day_of_week smallint not null check (day_of_week between 1 and 7),
    gym_workout text not null,
    no_gym_workout text not null,
    updated_at timestamptz not null default now(),
    primary key (user_id, day_of_week)
);

create table if not exists public.app_settings (
    user_id uuid primary key references auth.users(id) on delete cascade,
    weight_unit text not null default 'lbs',
    rest_timer_enabled boolean not null default true,
    gym_available_default boolean not null default true,
    reminders_enabled boolean not null default true,
    updated_at timestamptz not null default now()
);

-- touch triggers
drop trigger if exists exercise_targets_touch on public.exercise_targets;
create trigger exercise_targets_touch
    before update on public.exercise_targets
    for each row execute function public.touch_updated_at();

drop trigger if exists day_overrides_touch on public.day_overrides;
create trigger day_overrides_touch
    before update on public.day_overrides
    for each row execute function public.touch_updated_at();

drop trigger if exists weekly_plan_days_touch on public.weekly_plan_days;
create trigger weekly_plan_days_touch
    before update on public.weekly_plan_days
    for each row execute function public.touch_updated_at();

drop trigger if exists app_settings_touch on public.app_settings;
create trigger app_settings_touch
    before update on public.app_settings
    for each row execute function public.touch_updated_at();

-- RLS
alter table public.exercise_targets enable row level security;
alter table public.day_overrides enable row level security;
alter table public.weekly_plan_days enable row level security;
alter table public.app_settings enable row level security;

drop policy if exists "own exercise_targets" on public.exercise_targets;
create policy "own exercise_targets" on public.exercise_targets
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own day_overrides" on public.day_overrides;
create policy "own day_overrides" on public.day_overrides
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own weekly_plan_days" on public.weekly_plan_days;
create policy "own weekly_plan_days" on public.weekly_plan_days
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own app_settings" on public.app_settings;
create policy "own app_settings" on public.app_settings
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Analytics: most-recent-set-per-(exercise, side) for smart prefill from any device
create or replace view public.last_set_per_exercise as
select distinct on (user_id, exercise_slug, coalesce(side,''))
    user_id,
    exercise_slug,
    side,
    reps,
    weight_lbs,
    duration_seconds,
    completed_at
from public.set_logs
order by user_id, exercise_slug, coalesce(side,''), completed_at desc;

grant select on public.last_set_per_exercise to authenticated;
