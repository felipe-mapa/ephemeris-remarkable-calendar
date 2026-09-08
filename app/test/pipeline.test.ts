import fs from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EventStore } from '../src/server/db.js';
import { exportEventsJson } from '../src/server/pipeline.js';
import { testStore } from './helpers.js';

describe('exportEventsJson', () => {
  let store: EventStore;
  beforeEach(async () => {
    store = await testStore();
  });
  afterEach(async () => {
    await store.close();
  });

  it('writes the year of active events in the shape calendar_loader.py expects', async () => {
    await store.replaceGoogleRange('2026-01-01', '2026-12-31', [{
      date: '2026-03-10', summary: 'Standup', description: 'd', location: 'l', dtstart: '2026-03-10T09:00:00+13:00',
      dtend: '2026-03-10T09:30:00+13:00', color: 'gray4', calendar: 'TC', allDay: false, source: 'google',
    }]);
    const id = await store.addManual({ date: '2026-03-11', summary: 'Gone', dtstart: '2026-03-11T00:00:00+13:00', dtend: '2026-03-12T00:00:00+13:00', allDay: true, description: '', location: '' });
    await store.softDelete(id);

    const file = await exportEventsJson(store, 2026);
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>[];
    expect(file.endsWith('events_2026.json')).toBe(true);
    expect(rows).toEqual([{
      date: '2026-03-10', summary: 'Standup', description: 'd', location: 'l', dtstart: '2026-03-10T09:00:00+13:00',
      dtend: '2026-03-10T09:30:00+13:00', color: 'gray4', calendar: 'TC', all_day: false,
    }]);
  });
});
