-- Schedules live in Postgres; execution happens wherever the Node worker runs.
-- pg_cron uses UTC. 18:00 UTC = 06:00 NZST / 07:00 NZDT.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;

-- Daily: fetch the next 7 days, back up the device copy, merge annotations, upload.
select cron.schedule(
  'remarkable-daily-sync',
  '0 18 * * *',
  $$
  insert into public.jobs (user_id, kind, payload, requested_by)
  select u.id, 'sync', '{"days": 7}'::jsonb, 'cron'
  from public.users u
  where not exists (
    select 1 from public.jobs j where j.user_id = u.id and j.kind = 'sync' and j.status in ('queued', 'running')
  )
  $$
);

-- Every 6 hours: refresh the next 30 days so the web app stays current between syncs.
select cron.schedule(
  'remarkable-fetch-30d',
  '0 */6 * * *',
  $$
  insert into public.jobs (user_id, kind, payload, requested_by)
  select u.id, 'fetch', '{"days": 30}'::jsonb, 'cron'
  from public.users u
  where not exists (
    select 1 from public.jobs j where j.user_id = u.id and j.kind = 'fetch' and j.status in ('queued', 'running')
  )
  $$
);

-- Weekly housekeeping: drop finished job rows (and their logs) older than 30 days.
select cron.schedule(
  'remarkable-prune-jobs',
  '30 3 * * 0',
  $$ delete from public.jobs where finished_at < now() - interval '30 days' $$
);
