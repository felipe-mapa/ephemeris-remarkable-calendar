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
 *   npm run cli -- export-seed [sqlitePath]         write supabase/seed.private.sql from the old SQLite file
 */
import { EventStore } from './server/db.js';
import { JobRunner, appendSyncLog } from './server/jobs.js';
import { startWorker } from './server/jobqueue.js';
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
  const jobs = new JobRunner((line) => {
    appendSyncLog(line);
  });
  jobs.on('line', (_id: string, line: string) => console.log(line));

  const runJob = async (kind: Parameters<JobRunner['start']>[0], work: Parameters<JobRunner['start']>[1]) => {
    const job = jobs.start(kind, work);
    const done = await jobs.wait(job.id);
    await store.close();
    process.exit(done.status === 'succeeded' ? 0 : 1);
  };

  switch (cmd) {
    case 'sync':
      return runJob('sync', (ctx) =>
        pipeline.updateRemarkable(ctx, store, { skipFetch: flags.has('--skip-fetch'), days: Number(flagValue('--days') ?? 7) }),
      );
    case 'fetch':
      return runJob('fetch', (ctx) => pipeline.fetchEvents(ctx, store, Number(positional[0] ?? 30)).then(() => undefined));
    case 'fetch-year': {
      const year = Number(positional[0] ?? pipeline.currentYear());
      return runJob('fetch-year', (ctx) => pipeline.fetchEventsRange(ctx, store, `${year}-01-01`, `${year}-12-31`).then(() => undefined));
    }
    case 'generate':
      return runJob('generate', (ctx) => pipeline.generatePdf(ctx, store, Number(positional[0] ?? pipeline.currentYear())).then(() => undefined));
    case 'upload':
      return runJob('remarkable', (ctx) => pipeline.updateRemarkable(ctx, store, { skipFetch: true }));
    case 'backup':
      return runJob('backup', async (ctx) => {
        const file = await pipeline.backupFromRemarkable(ctx, positional[0] ?? pipeline.docNameForYear(pipeline.currentYear()));
        if (!file) throw new Error('Backup failed: document not downloaded');
      });
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
    default:
      console.log('Usage: npm run cli -- <sync|fetch|fetch-year|generate|upload|backup|stats|worker|add-source|list-sources|export-seed> [options]');
      process.exit(cmd === 'help' ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
