create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  timezone text not null default 'UTC',
  onboarding_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  is_completed boolean not null default false,
  due_date date null,
  due_time time without time zone null,
  reminder_enabled boolean not null default true,
  reminder_minutes_before integer not null default 1440 check (reminder_minutes_before > 0),
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  quantity numeric(12,3) null,
  unit text null,
  expected_price numeric(12,2) null check (expected_price is null or expected_price >= 0),
  is_purchased boolean not null default false,
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_name text not null,
  quantity numeric(12,3) null,
  unit text null,
  price numeric(12,2) null check (price is null or price >= 0),
  currency char(3) not null default 'PHP',
  purchased_at timestamptz not null default now(),
  notes text null,
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_user_updated_idx on public.tasks(user_id, updated_at);
create index if not exists tasks_user_due_idx on public.tasks(user_id, due_date);
create index if not exists shopping_user_updated_idx on public.shopping_items(user_id, updated_at);
create index if not exists purchases_user_updated_idx on public.purchases(user_id, updated_at);
create index if not exists notes_user_updated_idx on public.notes(user_id, updated_at);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at before update on public.tasks for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.tasks enable row level security;
alter table public.shopping_items enable row level security;
alter table public.purchases enable row level security;
alter table public.notes enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated using (auth.uid() = id);
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles for insert to authenticated with check (auth.uid() = id);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists tasks_select_own on public.tasks;
create policy tasks_select_own on public.tasks for select to authenticated using (auth.uid() = user_id);
drop policy if exists tasks_insert_own on public.tasks;
create policy tasks_insert_own on public.tasks for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists tasks_update_own on public.tasks;
create policy tasks_update_own on public.tasks for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists tasks_delete_own on public.tasks;
create policy tasks_delete_own on public.tasks for delete to authenticated using (auth.uid() = user_id);

-- The same CRUD pattern for shopping_items, purchases and notes:
drop policy if exists shopping_select_own on public.shopping_items;
create policy shopping_select_own on public.shopping_items for select to authenticated using (auth.uid() = user_id);
drop policy if exists shopping_insert_own on public.shopping_items;
create policy shopping_insert_own on public.shopping_items for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists shopping_update_own on public.shopping_items;
create policy shopping_update_own on public.shopping_items for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists shopping_delete_own on public.shopping_items;
create policy shopping_delete_own on public.shopping_items for delete to authenticated using (auth.uid() = user_id);

drop policy if exists purchases_select_own on public.purchases;
create policy purchases_select_own on public.purchases for select to authenticated using (auth.uid() = user_id);
drop policy if exists purchases_insert_own on public.purchases;
create policy purchases_insert_own on public.purchases for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists purchases_update_own on public.purchases;
create policy purchases_update_own on public.purchases for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists purchases_delete_own on public.purchases;
create policy purchases_delete_own on public.purchases for delete to authenticated using (auth.uid() = user_id);

drop policy if exists notes_select_own on public.notes;
create policy notes_select_own on public.notes for select to authenticated using (auth.uid() = user_id);
drop policy if exists notes_insert_own on public.notes;
create policy notes_insert_own on public.notes for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists notes_update_own on public.notes;
create policy notes_update_own on public.notes for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists notes_delete_own on public.notes;
create policy notes_delete_own on public.notes for delete to authenticated using (auth.uid() = user_id);

drop trigger if exists shopping_items_set_updated_at on public.shopping_items;
create trigger shopping_items_set_updated_at before update on public.shopping_items for each row execute function public.set_updated_at();
drop trigger if exists purchases_set_updated_at on public.purchases;
create trigger purchases_set_updated_at before update on public.purchases for each row execute function public.set_updated_at();
drop trigger if exists notes_set_updated_at on public.notes;
create trigger notes_set_updated_at before update on public.notes for each row execute function public.set_updated_at();

-- v15 allows terse purchase entries to be stored before a price is known.
alter table public.purchases alter column price drop not null;
alter table public.purchases drop constraint if exists purchases_price_nonnegative;
alter table public.purchases add constraint purchases_price_nonnegative check (price is null or price >= 0);
