import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { EventStore } from './db.js';
import { listCalendarSources } from './sources.js';
import { fetchAllSources } from './ics.js';
import type { JobContext } from './jobs.js';
import {
  paths,
  pdfPathForYear,
  eventsJsonPathForYear,
  RMAPI_IMAGE,
  PROJECT_ROOT,
  TIMEZONE,
} from "./paths.js";

const today = () => DateTime.now().setZone(TIMEZONE);
export const currentYear = () => today().year;
export const docNameForYear = (year: number) => `Calendar ${year}`;

/** Step 1 of remarkable_calendar.sh generate: refresh Google events for the next N days. */
export async function fetchEvents(ctx: JobContext, store: EventStore, days: number): Promise<{ inserted: number; failures: string[] }> {
  const start = today().toISODate() as string;
  const end = today().plus({ days }).toISODate() as string;
  return fetchEventsRange(ctx, store, start, end);
}

export async function fetchEventsRange(ctx: JobContext, store: EventStore, start: string, end: string) {
  ctx.log(`📅 Fetching events from ${start} to ${end}...`);
  const sources = await listCalendarSources(store.sql, store.userId);
  if (sources.length === 0) ctx.log('⚠️  No calendar sources configured. Add one with: npm run cli -- add-source <name> <url> [color]');
  const { events, failures } = await fetchAllSources(sources, start, end, { log: ctx.log });
  if (failures.length === sources.length && sources.length > 0) {
    throw new Error(`All calendar feeds failed: ${failures.join(', ')}`);
  }
  const inserted = await store.replaceGoogleRange(start, end, events);
  ctx.log(`Saved ${inserted} events to database`);
  return { inserted, failures };
}

function ensurePython() {
  if (!fs.existsSync(paths.venvPython)) {
    throw new Error(`Python venv not found at ${paths.venvPython}. Run: python3 -m venv venv && venv/bin/pip install -r requirements.txt`);
  }
}

/** Snapshot of the year's active events for the Python renderer (replaces its SQLite read). */
export async function exportEventsJson(store: EventStore, year: number): Promise<string> {
  const events = await store.listRange(`${year}-01-01`, `${year}-12-31`);
  const rows = events.map((e) => ({
    date: e.date, summary: e.summary, description: e.description, location: e.location,
    dtstart: e.dtstart, dtend: e.dtend, color: e.color, calendar: e.calendar, all_day: e.allDay,
  }));
  const file = eventsJsonPathForYear(year);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows));
  return file;
}

/** Environment every Python entry point needs to render `year` from the exported JSON. */
function pythonEnv(year: number, eventsJson: string): NodeJS.ProcessEnv {
  return {
    TIME_DATE_RANGE: `${year}-01-01:${year}-12-31`,
    APP_OUTPUT_PDF_PATH: pdfPathForYear(year),
    APP_FORCE_REFRESH: 'true',
    APP_EVENTS_JSON_PATH: eventsJson,
  };
}

/** Port of generate_pdf() in remarkable_calendar.sh: render the full-year PDF from the database. */
export async function generatePdf(ctx: JobContext, store: EventStore, year: number = currentYear()): Promise<string> {
  ensurePython();
  const out = pdfPathForYear(year);
  const eventsJson = await exportEventsJson(store, year);
  ctx.log(`🖨️  Generating PDF for ${year}...`);
  const res = await ctx.run(paths.venvPython, [paths.remarkableCalendarPy], { env: pythonEnv(year, eventsJson), timeoutMs: 20 * 60_000 });
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
    throw new Error(`rmapi config not found at ${paths.rmapiConfig}. Run: venv/bin/python3 remarkable_calendar/remarkable_credentials.py setup`);
  }
}

/**
 * RMAPI_IMAGE is built locally from the project's Dockerfile (there's no registry to pull it
 * from — `docker run` fails with "pull access denied" if it's missing). Build it on demand so a
 * fresh checkout, a renamed image tag, or a pruned image doesn't break unattended runs (e.g. via
 * the macOS Shortcut).
 */
async function ensureRmapiImage(ctx: JobContext): Promise<void> {
  const check = await ctx.run('docker', ['image', 'inspect', RMAPI_IMAGE], { timeoutMs: 15_000 });
  if (check.code === 0) return;
  ctx.log(`🐳 Docker image "${RMAPI_IMAGE}" not found locally, building it...`);
  const [image, tag] = RMAPI_IMAGE.split(':');
  const build = await ctx.run(
    'docker',
    ['build', '--target', 'remarkable-calendar-rmapi', '-t', `${image}:${tag ?? 'latest'}`, PROJECT_ROOT],
    { timeoutMs: 15 * 60_000 },
  );
  if (build.code !== 0) throw new Error(`Failed to build "${RMAPI_IMAGE}" (exit ${build.code}): ${build.stderr.trim()}`);
  ctx.log(`✅ Built "${RMAPI_IMAGE}"`);
}

/** Port of backup_from_remarkable() in scripts/helpers/functions.sh. Returns the backup path or null when the document is not on the device. */
export async function backupFromRemarkable(ctx: JobContext, docName: string): Promise<string | null> {
  requireRmapiConfig();
  fs.mkdirSync(paths.backups, { recursive: true });
  if (!(await dockerAvailable(ctx))) {
    ctx.log('❌ Docker daemon is not reachable (is Docker Desktop running?)');
    return null;
  }
  await ensureRmapiImage(ctx);
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

const DAY_MS = 86_400_000;
const BACKUP_STAMP_RE = /_\d{8}_\d{6}\.rmdoc$/;

/**
 * Delete device backups older than `keepDays` (default 7). The newest backup of each
 * document ("Calendar 2026", "Calendar 2027", ...) is always kept so a merge source survives.
 */
export function pruneBackups(opts: { dir?: string; keepDays?: number; now?: number; log?: (line: string) => void } = {}): string[] {
  const dir = opts.dir ?? paths.backups;
  const keepDays = opts.keepDays ?? 7;
  const now = opts.now ?? Date.now();
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => BACKUP_STAMP_RE.test(f))
    .map((f) => ({ f, doc: f.replace(BACKUP_STAMP_RE, ''), m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const newestSeen = new Set<string>();
  const removed: string[] = [];
  for (const { f, doc, m } of files) {
    if (!newestSeen.has(doc)) {
      newestSeen.add(doc);
      continue;
    }
    if (m < now - keepDays * DAY_MS) {
      fs.rmSync(path.join(dir, f), { force: true });
      removed.push(f);
    }
  }
  if (removed.length) opts.log?.(`🧹 Removed ${removed.length} backup(s) older than ${keepDays} days`);
  return removed;
}

/** Regenerate the PDF from the DB and merge it with a backup's annotations, then upload (remarkable_calendar_merge_from_backup.py). */
async function mergeFromBackup(ctx: JobContext, store: EventStore, backupPath: string, year: number) {
  ensurePython();
  const eventsJson = await exportEventsJson(store, year);
  ctx.log('🔄 Regenerating calendar and merging annotations...');
  const res = await ctx.run(paths.venvPython, [paths.mergeFromBackupPy, '--year', String(year), '--backup', backupPath], {
    env: pythonEnv(year, eventsJson), // merge_from_backup.py copies os.environ into its child remarkable_calendar.py
    timeoutMs: 30 * 60_000,
  });
  if (res.code !== 0) throw new Error(`Merge from backup failed (exit ${res.code})`);
  ctx.log('✅ Calendar merged and uploaded');
}

/** remarkable_calendar.sh upload: generate then upload via remarkable_calendar_merge_annotations.py. */
async function uploadFresh(ctx: JobContext, store: EventStore, year: number) {
  ensurePython();
  const pdf = pdfPathForYear(year);
  if (!fs.existsSync(pdf)) await generatePdf(ctx, store, year);
  ctx.log('⚠️  No backup found, uploading fresh calendar...');
  const res = await ctx.run(paths.venvPython, [paths.mergeAnnotationsPy], { env: pythonEnv(year, eventsJsonPathForYear(year)), timeoutMs: 30 * 60_000 });
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
    await mergeFromBackup(ctx, store, backup, year);
  } else {
    const local = latestLocalBackup(year);
    if (local) {
      ctx.log(`⚠️  Live backup unavailable, using local backup: ${path.basename(local)}`);
      await mergeFromBackup(ctx, store, local, year);
    } else {
      await uploadFresh(ctx, store, year);
    }
  }
  pruneBackups({ log: ctx.log });
  ctx.log('✅ Calendar sync completed');
}
