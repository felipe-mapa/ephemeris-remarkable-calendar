#!/usr/bin/env tsx
/**
 * Command-line entry point replacing scripts/ephemeris.sh, scripts/remarkable-sync-calendar.sh
 * and scripts/backup-calendar.sh.
 *
 *   npm run cli -- sync [--skip-fetch] [--days N]   daily flow: fetch, backup, merge annotations, upload
 *   npm run cli -- fetch [days]                     refresh Google events for the next N days (default 30)
 *   npm run cli -- fetch-year [year]                refresh Google events for a whole year
 *   npm run cli -- generate [year]                  render the year PDF from the database
 *   npm run cli -- upload                           backup + merge annotations + upload (no fetch)
 *   npm run cli -- backup [docName]                 download the device copy into backups/
 *   npm run cli -- stats                            database statistics
 */
import { EventStore } from './server/db.js';
import { JobRunner, appendSyncLog } from './server/jobs.js';
import * as pipeline from './server/pipeline.js';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const positional = rest.filter((a) => !a.startsWith('--'));
const flagValue = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function main() {
  const store = EventStore.open();
  const jobs = new JobRunner((line) => {
    appendSyncLog(line);
  });
  jobs.on('line', (_id: string, line: string) => console.log(line));

  const runJob = async (kind: Parameters<JobRunner['start']>[0], work: Parameters<JobRunner['start']>[1]) => {
    const job = jobs.start(kind, work);
    const done = await jobs.wait(job.id);
    store.close();
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
      return runJob('fetch', (ctx) => pipeline.fetchEventsRange(ctx, store, `${year}-01-01`, `${year}-12-31`).then(() => undefined));
    }
    case 'generate':
      return runJob('generate', (ctx) => pipeline.generatePdf(ctx, Number(positional[0] ?? pipeline.currentYear())).then(() => undefined));
    case 'upload':
      return runJob('remarkable', (ctx) => pipeline.updateRemarkable(ctx, store, { skipFetch: true }));
    case 'backup':
      return runJob('backup', async (ctx) => {
        const file = await pipeline.backupFromRemarkable(ctx, positional[0] ?? pipeline.docNameForYear(pipeline.currentYear()));
        if (!file) throw new Error('Backup failed: document not downloaded');
      });
    case 'stats': {
      const s = store.stats();
      console.log(`Total events: ${s.totalEvents}\nTotal dates: ${s.totalDates}\nDate range: ${s.minDate} to ${s.maxDate}`);
      store.close();
      return;
    }
    default:
      console.log('Usage: npm run cli -- <sync|fetch|fetch-year|generate|upload|backup|stats> [options]');
      process.exit(cmd === 'help' ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
