import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { EventStore } from './db.js';
import { loadCalendarSources } from './config.js';
import { fetchAllSources } from './ics.js';
import type { JobContext } from './jobs.js';
import { paths, pdfPathForYear, RMAPI_IMAGE, TIMEZONE } from './paths.js';

const today = () => DateTime.now().setZone(TIMEZONE);
export const currentYear = () => today().year;
export const docNameForYear = (year: number) => `Calendar ${year}`;

/** Step 1 of ephemeris.sh generate: refresh Google events for the next N days. */
export async function fetchEvents(ctx: JobContext, store: EventStore, days: number): Promise<{ inserted: number; failures: string[] }> {
  const start = today().toISODate() as string;
  const end = today().plus({ days }).toISODate() as string;
  return fetchEventsRange(ctx, store, start, end);
}

export async function fetchEventsRange(ctx: JobContext, store: EventStore, start: string, end: string) {
  ctx.log(`📅 Fetching events from ${start} to ${end}...`);
  const sources = loadCalendarSources();
  if (sources.length === 0) ctx.log('⚠️  No calendars configured in config/config.yaml');
  const { events, failures } = await fetchAllSources(sources, start, end, { log: ctx.log });
  if (failures.length === sources.length && sources.length > 0) {
    throw new Error(`All calendar feeds failed: ${failures.join(', ')}`);
  }
  const inserted = store.replaceGoogleRange(start, end, events);
  ctx.log(`Saved ${inserted} events to database`);
  const backup = await store.backupFile();
  if (backup) ctx.log(`  📋 Created database backup: ${path.basename(backup)}`);
  return { inserted, failures };
}

function ensurePython() {
  if (!fs.existsSync(paths.venvPython)) {
    throw new Error(`Python venv not found at ${paths.venvPython}. Run: python3 -m venv venv && venv/bin/pip install -r requirements.txt`);
  }
}

/** Port of generate_pdf() in ephemeris.sh: render the full-year PDF from the database. */
export async function generatePdf(ctx: JobContext, year: number = currentYear()): Promise<string> {
  ensurePython();
  const out = pdfPathForYear(year);
  ctx.log(`🖨️  Generating PDF for ${year}...`);
  const res = await ctx.run(paths.venvPython, [paths.ephemerisPy], {
    env: {
      TIME_DATE_RANGE: `${year}-01-01:${year}-12-31`,
      APP_OUTPUT_PDF_PATH: out,
      APP_FORCE_REFRESH: 'true',
    },
    timeoutMs: 20 * 60_000,
  });
  if (res.code !== 0) throw new Error(`PDF generation failed (exit ${res.code})`);
  ctx.log(`✅ Wrote ${out}`);
  return out;
}

async function dockerAvailable(ctx: JobContext): Promise<boolean> {
  try {
    const r = await ctx.run('docker', ['info'], { timeoutMs: 15_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

function requireRmapiConfig() {
  if (!fs.existsSync(paths.rmapiConfig)) {
    throw new Error(`rmapi config not found at ${paths.rmapiConfig}. Run: venv/bin/python3 ephemeris/remarkable_credentials.py setup`);
  }
}

/** Port of backup_from_remarkable() in scripts/helpers/functions.sh. Returns the backup path or null when the document is not on the device. */
export async function backupFromRemarkable(ctx: JobContext, docName: string): Promise<string | null> {
  requireRmapiConfig();
  fs.mkdirSync(paths.backups, { recursive: true });
  if (!(await dockerAvailable(ctx))) {
    ctx.log('❌ Docker daemon is not reachable (is Docker Desktop running?)');
    return null;
  }
  const ts = today().toFormat('yyyyLLdd_HHmmss');
  const tempDownload = path.join(paths.backups, `${docName}.rmdoc`);
  const finalPath = path.join(paths.backups, `${docName}_${ts}.rmdoc`);
  ctx.log(`📥 Downloading "${docName}" from reMarkable...`);
  await ctx.run(
    'docker',
    ['run', '--rm', '-v', `${paths.rmapiConfig}:/root/.config/rmapi`, '-v', `${paths.backups}:/backup`, '-w', '/backup', RMAPI_IMAGE, 'rmapi', 'get', docName],
    { timeoutMs: 5 * 60_000 },
  );
  if (fs.existsSync(tempDownload)) {
    fs.renameSync(tempDownload, finalPath);
    ctx.log(`✅ Backup downloaded: ${path.basename(finalPath)}`);
    return finalPath;
  }
  return null;
}

export function latestLocalBackup(year: number): string | null {
  if (!fs.existsSync(paths.backups)) return null;
  const prefix = `${docNameForYear(year)}_`;
  const candidates = fs
    .readdirSync(paths.backups)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.rmdoc'))
    .map((f) => ({ f, m: fs.statSync(path.join(paths.backups, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return candidates.length ? path.join(paths.backups, candidates[0].f) : null;
}

export function listBackups(year: number) {
  if (!fs.existsSync(paths.backups)) return [];
  const prefix = `${docNameForYear(year)}_`;
  return fs
    .readdirSync(paths.backups)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.rmdoc'))
    .map((f) => {
      const st = fs.statSync(path.join(paths.backups, f));
      return { name: f, size: st.size, modifiedAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** Regenerate the PDF from the DB and merge it with a backup's annotations, then upload (ephemeris_merge_from_backup.py). */
async function mergeFromBackup(ctx: JobContext, backupPath: string, year: number) {
  ensurePython();
  ctx.log('🔄 Regenerating calendar and merging annotations...');
  const res = await ctx.run(paths.venvPython, [paths.mergeFromBackupPy, '--year', String(year), '--backup', backupPath], { timeoutMs: 30 * 60_000 });
  if (res.code !== 0) throw new Error(`Merge from backup failed (exit ${res.code})`);
  ctx.log('✅ Calendar merged and uploaded');
}

/** ephemeris.sh upload: generate then upload via ephemeris_merge_annotations.py (which itself tries to preserve device annotations). */
async function uploadFresh(ctx: JobContext, year: number) {
  ensurePython();
  const pdf = pdfPathForYear(year);
  if (!fs.existsSync(pdf)) await generatePdf(ctx, year);
  ctx.log('⚠️  No backup found, uploading fresh calendar...');
  const res = await ctx.run(paths.venvPython, [paths.mergeAnnotationsPy], { timeoutMs: 30 * 60_000 });
  if (res.code !== 0) throw new Error(`Upload failed (exit ${res.code})`);
  ctx.log('✅ Fresh calendar uploaded');
}

/**
 * Port of scripts/remarkable-sync-calendar.sh.
 * Steps: [fetch next N days] -> backup from device -> merge + upload,
 * falling back to the latest local backup, then to a fresh upload.
 */
export async function updateRemarkable(ctx: JobContext, store: EventStore, opts: { skipFetch?: boolean; days?: number } = {}) {
  const year = currentYear();
  ctx.log('🔍 Starting remarkable sync calendar');
  if (opts.skipFetch) {
    ctx.log('⏭️  Skipping calendar fetch, using existing database');
  } else {
    await fetchEvents(ctx, store, opts.days ?? 7);
    ctx.log('✅ Events fetched and stored in database');
  }

  const backup = await backupFromRemarkable(ctx, docNameForYear(year));
  if (backup) {
    await mergeFromBackup(ctx, backup, year);
  } else {
    const local = latestLocalBackup(year);
    if (local) {
      ctx.log(`⚠️  Live backup unavailable, using local backup: ${path.basename(local)}`);
      await mergeFromBackup(ctx, local, year);
    } else {
      await uploadFresh(ctx, year);
    }
  }
  ctx.log('✅ Calendar sync completed');
}
