-- Tombstone retention.
--
-- Soft-deleted rows (deleted_at is not null) must survive long enough for every
-- other device to observe the delete and purge its own local copy. After the
-- retention window they are removed for real, so the tables do not grow without
-- bound.
--
-- Keep TOMBSTONE_RETENTION_DAYS in src/sync.ts in sync with the 30 below.
-- Public notes are intentionally excluded: the notes feature does not exist yet
-- and will be built with soft delete from the start.

create index if not exists tasks_deleted_at_idx
  on public.tasks(deleted_at)
  where deleted_at is not null;

create index if not exists shopping_items_deleted_at_idx
  on public.shopping_items(deleted_at)
  where deleted_at is not null;

create index if not exists purchases_deleted_at_idx
  on public.purchases(deleted_at)
  where deleted_at is not null;

-- Purge expired tombstones. Safe to run repeatedly and from any device, since
-- it only removes rows whose tombstone is already older than the window.
-- Returns rows removed per table so the result can be verified.
create or replace function public.purge_expired_tombstones(retention_days integer default 30)
returns table (tasks_purged bigint, shopping_purged bigint, purchases_purged bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := now() - make_interval(days => retention_days);
begin
  delete from public.tasks
    where deleted_at is not null and deleted_at < cutoff;
  get diagnostics tasks_purged = row_count;

  delete from public.shopping_items
    where deleted_at is not null and deleted_at < cutoff;
  get diagnostics shopping_purged = row_count;

  delete from public.purchases
    where deleted_at is not null and deleted_at < cutoff;
  get diagnostics purchases_purged = row_count;

  return next;
end;
$$;

-- Run the purge daily. Requires pg_cron; enable it under Database > Extensions
-- if this statement errors.
select cron.schedule(
  'tandaan-purge-tombstones',
  '17 3 * * *',
  $$ select public.purge_expired_tombstones(30); $$
)
where not exists (
  select 1 from cron.job where jobname = 'tandaan-purge-tombstones'
);

-- Manual verification. Dry run, changes nothing:
--
--   select 'tasks' as table_name, count(*) from public.tasks
--     where deleted_at < now() - interval '30 days'
--   union all
--   select 'shopping_items', count(*) from public.shopping_items
--     where deleted_at < now() - interval '30 days'
--   union all
--   select 'purchases', count(*) from public.purchases
--     where deleted_at < now() - interval '30 days';
--
-- Run the purge once immediately:
--
--   select * from public.purge_expired_tombstones(30);
