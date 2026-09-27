alter table public.tasks
  add column if not exists reminder_at timestamptz null,
  add column if not exists reminder_sent_at timestamptz null;

create index if not exists tasks_reminder_at_idx
  on public.tasks(reminder_at)
  where deleted_at is null and reminder_enabled = true and is_completed = false;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, endpoint)
);

drop trigger if exists push_subscriptions_set_updated_at on public.push_subscriptions;
create trigger push_subscriptions_set_updated_at
before update on public.push_subscriptions
for each row execute function public.set_updated_at();

alter table public.push_subscriptions enable row level security;

drop policy if exists push_select_own on public.push_subscriptions;
create policy push_select_own on public.push_subscriptions for select to authenticated using (auth.uid() = user_id);

drop policy if exists push_insert_own on public.push_subscriptions;
create policy push_insert_own on public.push_subscriptions for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists push_update_own on public.push_subscriptions;
create policy push_update_own on public.push_subscriptions for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists push_delete_own on public.push_subscriptions;
create policy push_delete_own on public.push_subscriptions for delete to authenticated using (auth.uid() = user_id);
