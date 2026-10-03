create table if not exists public.debts (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  direction text not null check (direction in ('owe','owed_to_me')),
  person_name text not null,
  description text null,
  original_amount_cents bigint not null check (original_amount_cents > 0),
  due_date date null,
  reminder_enabled boolean not null default false,
  reminder_minutes_before integer null check (reminder_minutes_before is null or reminder_minutes_before >= 0),
  reminder_at timestamptz null,
  reminder_sent_at timestamptz null,
  payments jsonb not null default '[]'::jsonb,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create index if not exists debts_user_updated_idx on public.debts(user_id, updated_at);
create index if not exists debts_reminder_at_idx on public.debts(reminder_at)
  where deleted_at is null and reminder_enabled = true and reminder_sent_at is null;

alter table public.debts enable row level security;
drop policy if exists debts_select_own on public.debts;
create policy debts_select_own on public.debts for select to authenticated using (auth.uid() = user_id);
drop policy if exists debts_insert_own on public.debts;
create policy debts_insert_own on public.debts for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists debts_update_own on public.debts;
create policy debts_update_own on public.debts for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists debts_delete_own on public.debts;
create policy debts_delete_own on public.debts for delete to authenticated using (auth.uid() = user_id);

drop trigger if exists debts_set_updated_at on public.debts;
create trigger debts_set_updated_at before update on public.debts for each row execute function public.set_updated_at();
