#!/usr/bin/env tsx
/**
 * Command-line entry point (the shell scripts under scripts/ wrap it).
 *
 *   npm run cli -- sync [--skip-fetch] [--days N]   daily flow: fetch, backup, merge annotations, upload
 *   npm run cli -- fetch [days]                     refresh Google events for the next N days (default 30)
 *   npm run cli -- fetch-year [year]                refresh Google events for a whole year
 *   npm run cli -- generate [year]                  render the year PDF from the database
 *   npm run cli -- upload                           backup + merge annotations + upload (no fetch)
 *   npm run cli -- backup [docName]                 download the device copy into backups/
 *   npm run cli -- stats                            database statistics
 *   npm run cli -- worker                           drain the Supabase job queue until stopped
 *   npm run cli -- add-source <name> <url> [color]  store an ICS feed (URL goes to Supabase Vault)
 *   npm run cli -- list-sources                     list feeds (URLs masked)
 *   npm run cli -- jobs [n]                         list the last n job runs (default 10), CLI and web/cron alike
 *   npm run cli -- jobs <id>                        print the full log of one job
 *   npm run cli -- export-seed [sqlitePath]         write supabase/seed.private.sql from the old SQLite file
 */
import { EventStore } from './server/db.js';
import { JobRunner } from './server/jobs.js';
import { startWorker, startJobRecord, appendLog, finishJob, listJobs, getJob } from './server/jobqueue.js';
import { addCalendarSource, listCalendarSources } from './server/sources.js';
import * as pipeline from './server/pipeline.js';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const positional = rest.filter((a) => !a.startsWith('--'));
const flagValue = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function main() {
  if (cmd === 'export-seed') {
    // @ts-expect-error - ./server/seed.ts is created by Task 9; this branch only runs (and fails) at runtime until then.
    const { exportSeed } = await import('./server/seed.js');
    console.log(`Wrote ${await exportSeed(positional[0])}`);
    return;
  }

  const store = await EventStore.open();
  const jobs = new JobRunner();
  jobs.on('line', (_id: string, line: string) => console.log(line));

  const runJob = async (
    kind: Parameters<JobRunner['start']>[0],
    work: Parameters<JobRunner['start']>[1],
    payload: Record<string, unknown> = {},
  ) => {
    const jobRow = await startJobRecord(store.sql, store.userId, kind, payload, 'cli');
    let chain = Promise.resolve();
    const onLine = (id: string, line: string) => {
      if (id !== jobRow.id) return;
      chain = chain.then(() => appendLog(store.sql, id, line)).catch(() => {});
    };
    jobs.on('line', onLine);
    const job = jobs.start(kind, work, { id: jobRow.id });
    const done = await jobs.wait(job.id);
    await chain;
    jobs.off('line', onLine);
    await finishJob(store.sql, jobRow.id, done.status === 'succeeded' ? 'succeeded' : 'failed', done.error);
    await store.close();
    process.exit(done.status === 'succeeded' ? 0 : 1);
  };

  switch (cmd) {
    case 'sync': {
      const skipFetch = flags.has('--skip-fetch');
      const days = Number(flagValue('--days') ?? 7);
      return runJob('sync', (ctx) => pipeline.updateRemarkable(ctx, store, { skipFetch, days }), { skipFetch, days });
    }
    case 'fetch': {
      const days = Number(positional[0] ?? 30);
      return runJob('fetch', (ctx) => pipeline.fetchEvents(ctx, store, days).then(() => undefined), { days });
    }
    case 'fetch-year': {
      const year = Number(positional[0] ?? pipeline.currentYear());
      return runJob('fetch-year', (ctx) => pipeline.fetchEventsRange(ctx, store, `${year}-01-01`, `${year}-12-31`).then(() => undefined), { year });
    }
    case 'generate': {
      const year = Number(positional[0] ?? pipeline.currentYear());
      return runJob('generate', (ctx) => pipeline.generatePdf(ctx, store, year).then(() => undefined), { year });
    }
    case 'upload':
      return runJob('remarkable', (ctx) => pipeline.updateRemarkable(ctx, store, { skipFetch: true }), { skipFetch: true });
    case 'backup': {
      const docName = positional[0] ?? pipeline.docNameForYear(pipeline.currentYear());
      return runJob(
        'backup',
        async (ctx) => {
          const file = await pipeline.backupFromRemarkable(ctx, docName);
          if (!file) throw new Error('Backup failed: document not downloaded');
        },
        { docName },
      );
    }
    case 'stats': {
      const s = await store.stats();
      console.log(`Total events: ${s.totalEvents}\nTotal dates: ${s.totalDates}\nDate range: ${s.minDate} to ${s.maxDate}`);
      await store.close();
      return;
    }
    case 'worker': {
      console.log('Worker started, polling public.jobs every 5s (Ctrl+C to stop)');
      const worker = startWorker({ sql: store.sql, store, jobs, intervalMs: 5000 });
      process.on('SIGINT', () => {
        worker.stop();
        void store.close().finally(() => process.exit(0));
      });
      return;
    }
    case 'add-source': {
      const [name, url, color] = positional;
      if (!name || !url) throw new Error('Usage: add-source <name> <url> [color]');
      const id = await addCalendarSource(store.sql, store.userId, { name, url, color });
      console.log(`Added source ${name} (${id})`);
      await store.close();
      return;
    }
    case 'list-sources': {
      for (const s of await listCalendarSources(store.sql, store.userId)) {
        console.log(`${s.id}  ${s.name}  ${s.color}  …/${s.source.split('/').pop()}`);
      }
      await store.close();
      return;
    }
    case 'jobs': {
      const arg = positional[0];
      if (arg && !/^\d+$/.test(arg)) {
        const job = await getJob(store.sql, arg);
        if (!job) throw new Error(`No job with id ${arg}`);
        console.log(`${job.kind}  ${job.status}  requestedBy=${job.requestedBy}  started=${job.startedAt}  finished=${job.finishedAt ?? '-'}`);
        if (job.error) console.log(`error: ${job.error}`);
        console.log(job.log || '(no log lines)');
      } else {
        const limit = Number(arg ?? 10);
        for (const j of await listJobs(store.sql, store.userId, limit)) {
          console.log(`${j.id}  ${j.kind.padEnd(10)}  ${j.status.padEnd(9)}  ${j.requestedBy.padEnd(4)}  ${j.startedAt ?? j.createdAt}${j.error ? `  error: ${j.error}` : ''}`);
        }
      }
      await store.close();
      return;
    }
    default:
      console.log('Usage: npm run cli -- <sync|fetch|fetch-year|generate|upload|backup|stats|worker|add-source|list-sources|jobs|export-seed> [options]');
      process.exit(cmd === 'help' ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
