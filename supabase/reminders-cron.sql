-- Tandaan reminder scheduler.
-- Replace the placeholders before running this once in Supabase SQL Editor.

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists vault;

-- Store these in Supabase Vault so the scheduler doesn't expose the secret in cron.job.
select vault.create_secret(
  'https://YOUR-VERCEL-DOMAIN.vercel.app/api/send-due-reminders',
  'tandaan_reminder_url'
);

select vault.create_secret(
  'REPLACE_WITH_THE_SAME_REMINDER_CRON_SECRET_USED_IN_VERCEL',
  'tandaan_reminder_cron_secret'
);

-- Run once per minute. Supabase Cron supports this cadence.
select cron.schedule(
  'tandaan-due-reminders',
  '* * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'tandaan_reminder_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'tandaan_reminder_cron_secret')
      ),
      body := jsonb_build_object('source', 'supabase-cron', 'time', now())
    );
  $$
);
