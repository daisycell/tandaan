alter table public.tasks
  drop constraint if exists tasks_reminder_minutes_positive;

alter table public.tasks
  add constraint tasks_reminder_minutes_positive
  check (reminder_minutes_before >= 0);
