-- Syncs and fetches are triggered by hand (Mac Shortcut -> CLI -> public.jobs),
-- so the pg_cron schedules that enqueued them are gone. The worker loop is
-- unchanged: it still drains whatever lands in public.jobs, whoever queued it.
--
-- 'remarkable-prune-jobs' stays: it is the only thing deleting finished job
-- rows (and their logs) older than 30 days.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'remarkable-daily-sync') then
    perform cron.unschedule('remarkable-daily-sync');
  end if;
  if exists (select 1 from cron.job where jobname = 'remarkable-fetch-30d') then
    perform cron.unschedule('remarkable-fetch-30d');
  end if;
end
$$;
