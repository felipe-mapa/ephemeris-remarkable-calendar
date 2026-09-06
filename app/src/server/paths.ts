import path from 'node:path';
import { fileURLToPath } from 'node:url';

// app/src/server/paths.ts -> project root is three levels up
const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..', '..', '..');

export const paths = {
  root: PROJECT_ROOT,
  config: path.join(PROJECT_ROOT, 'config', 'config.yaml'),
  rmapiConfig: path.join(PROJECT_ROOT, 'config', '.rmapi'),
  output: path.join(PROJECT_ROOT, 'output'),
  db: process.env.APP_CALENDAR_DB_PATH ?? path.join(PROJECT_ROOT, 'output', 'calendar.db'),
  backups: path.join(PROJECT_ROOT, 'backups'),
  dbBackups: path.join(PROJECT_ROOT, 'backups', 'db'),
  logs: path.join(PROJECT_ROOT, 'logs'),
  syncLog: path.join(PROJECT_ROOT, 'logs', 'remarkable-sync.log'),
  lockFile: path.join(PROJECT_ROOT, 'logs', 'ephemeris_sync.lock'),
  venvPython: path.join(PROJECT_ROOT, 'venv', 'bin', 'python3'),
  ephemerisPy: path.join(PROJECT_ROOT, 'ephemeris.py'),
  mergeFromBackupPy: path.join(PROJECT_ROOT, 'ephemeris', 'ephemeris_merge_from_backup.py'),
  mergeAnnotationsPy: path.join(PROJECT_ROOT, 'ephemeris', 'ephemeris_merge_annotations.py'),
  clientDist: path.resolve(here, '..', '..', 'dist'),
};

export const TIMEZONE = process.env.TZ ?? process.env.TIME_ZONE ?? 'Pacific/Auckland';
export const RMAPI_IMAGE = process.env.RMAPI_IMAGE ?? 'ephemeris-rmapi:latest';
export const pdfPathForYear = (year: number) => path.join(paths.output, `calendar_${year}.pdf`);
