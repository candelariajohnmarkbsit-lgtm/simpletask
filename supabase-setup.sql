-- ============================================================
-- SimpleTask database setup  (run once in Supabase > SQL Editor)
-- Safe to run on your existing project: it only adds what is missing.
-- ============================================================

-- 1) TASKS table (adds the new columns if the table already exists)
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  priority text not null default 'Medium',
  due_date timestamptz not null,
  is_completed boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.tasks add column if not exists description text;
alter table public.tasks add column if not exists estimated_minutes integer;
alter table public.tasks add column if not exists reminded boolean not null default false;
alter table public.tasks add column if not exists category text;
alter table public.tasks add column if not exists created_at timestamptz not null default now();
-- escalating reminders: when reminders start counting, and which steps were already emailed
alter table public.tasks add column if not exists remind_from timestamptz not null default now();
alter table public.tasks add column if not exists reminder_steps text[] not null default '{}';

-- tasks that were already emailed by the old single-reminder system: do not email them again
update public.tasks
   set reminder_steps = array['day5','day4','day3','day2','day1','morning','h6','h3','h1']
 where reminded = true and reminder_steps = '{}';

create index if not exists tasks_user_due_idx on public.tasks (user_id, due_date);
create index if not exists tasks_reminder_idx on public.tasks (is_completed, reminded, due_date);

-- 2) USER SETTINGS (reminder preferences)
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_reminders boolean not null default true,
  remind_hours integer not null default 24 check (remind_hours between 1 and 168),
  updated_at timestamptz not null default now()
);
-- escalating reminder preferences
alter table public.user_settings add column if not exists intensity text not null default 'normal';
alter table public.user_settings add column if not exists daily_hour integer not null default 8;
alter table public.user_settings add column if not exists quiet_start integer not null default 22;
alter table public.user_settings add column if not exists quiet_end integer not null default 7;
alter table public.user_settings add column if not exists timezone text not null default 'Asia/Manila';
alter table public.user_settings drop constraint if exists user_settings_intensity_check;
alter table public.user_settings add constraint user_settings_intensity_check check (intensity in ('off','gentle','normal','persistent'));
alter table public.user_settings drop constraint if exists user_settings_hours_check;
alter table public.user_settings add constraint user_settings_hours_check check (daily_hour between 0 and 23 and quiet_start between 0 and 23 and quiet_end between 0 and 23);

-- 3) REMINDERS log (one row for every reminder that was sent)
create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null default 'email',
  sent_at timestamptz not null default now()
);
alter table public.reminders add column if not exists step text;

-- 4) ROW LEVEL SECURITY: each student can only see and change their own data
alter table public.tasks enable row level security;
alter table public.user_settings enable row level security;
alter table public.reminders enable row level security;

drop policy if exists "tasks_select_own" on public.tasks;
drop policy if exists "tasks_insert_own" on public.tasks;
drop policy if exists "tasks_update_own" on public.tasks;
drop policy if exists "tasks_delete_own" on public.tasks;
create policy "tasks_select_own" on public.tasks for select using (auth.uid() = user_id);
create policy "tasks_insert_own" on public.tasks for insert with check (auth.uid() = user_id);
create policy "tasks_update_own" on public.tasks for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "tasks_delete_own" on public.tasks for delete using (auth.uid() = user_id);

drop policy if exists "settings_select_own" on public.user_settings;
drop policy if exists "settings_insert_own" on public.user_settings;
drop policy if exists "settings_update_own" on public.user_settings;
create policy "settings_select_own" on public.user_settings for select using (auth.uid() = user_id);
create policy "settings_insert_own" on public.user_settings for insert with check (auth.uid() = user_id);
create policy "settings_update_own" on public.user_settings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "reminders_select_own" on public.reminders;
create policy "reminders_select_own" on public.reminders for select using (auth.uid() = user_id);
-- (the reminder job uses the service role, which bypasses RLS, so it needs no insert policy)

-- 5) REALTIME: lets the dashboard update instantly across devices
alter table public.tasks replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.tasks;
exception when duplicate_object then
  null;
end $$;

-- 6) Refresh the API schema cache so the new columns are available immediately
notify pgrst, 'reload schema';
