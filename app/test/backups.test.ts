import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { pruneBackups } from '../src/server/pipeline.js';

const DAY = 86_400_000;

function touch(dir: string, name: string, ageDays: number, now: number) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x');
  const t = new Date(now - ageDays * DAY);
  fs.utimesSync(file, t, t);
}

describe('pruneBackups', () => {
  it('deletes .rmdoc files older than keepDays but always keeps the newest per document', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-backups-'));
    const now = Date.parse('2026-09-07T00:00:00Z');
    touch(dir, 'Calendar 2026_20260906_225319.rmdoc', 1, now);
    touch(dir, 'Calendar 2026_20260830_100000.rmdoc', 8, now);
    touch(dir, 'Calendar 2026_20260120_100000.rmdoc', 230, now);
    touch(dir, 'Calendar 2025_20251220_100000.rmdoc', 260, now); // only backup of that document: kept
    touch(dir, '.gitkeep', 400, now);

    const removed = pruneBackups({ dir, keepDays: 7, now });

    expect(removed.sort()).toEqual(['Calendar 2026_20260120_100000.rmdoc', 'Calendar 2026_20260830_100000.rmdoc']);
    expect(fs.readdirSync(dir).sort()).toEqual(['.gitkeep', 'Calendar 2025_20251220_100000.rmdoc', 'Calendar 2026_20260906_225319.rmdoc']);
  });

  it('is a no-op when the directory does not exist', () => {
    expect(pruneBackups({ dir: '/nonexistent/backups' })).toEqual([]);
  });
});
