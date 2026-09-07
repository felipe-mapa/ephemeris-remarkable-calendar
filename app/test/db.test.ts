import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStore, type NewEvent } from '../src/server/db.js';
import { testStore } from './helpers.js';

const google = (over: Partial<NewEvent> = {}): NewEvent => ({
  date: '2026-03-10',
  summary: 'Standup',
  description: '',
  location: '',
  dtstart: '2026-03-10T09:00:00+13:00',
  dtend: '2026-03-10T09:30:00+13:00',
  color: 'gray4',
  calendar: 'TC',
  allDay: false,
  source: 'google',
  ...over,
});

describe('EventStore (Postgres)', () => {
  let store: EventStore;
  beforeEach(async () => {
    store = await testStore();
  });
  afterEach(async () => {
    await store.close();
  });

  it('returns dates as YYYY-MM-DD strings and booleans for allDay', async () => {
    await store.replaceGoogleRange('2026-03-01', '2026-03-31', [google()]);
    const [e] = await store.listRange('2026-03-01', '2026-03-31');
    expect(e).toMatchObject({ date: '2026-03-10', allDay: false, source: 'google', deletedAt: null, color: 'gray4', calendar: 'TC' });
    expect(typeof e.id).toBe('number');
    expect(typeof e.createdAt).toBe('string');
  });

  it('replaceGoogleRange keeps manual events and does not resurrect soft-deleted ones', async () => {
    await store.replaceGoogleRange('2026-03-01', '2026-03-31', [google({ summary: 'Legacy standup' })]);
    const manualId = await store.addManual({
      date: '2026-03-10', summary: 'Dentist', dtstart: '2026-03-10T14:00:00+13:00', dtend: '2026-03-10T15:00:00+13:00',
      allDay: false, description: '', location: '',
    });
    const legacy = (await store.listRange('2026-03-10', '2026-03-10')).find((e) => e.summary === 'Legacy standup')!;
    await store.softDelete(legacy.id);

    const inserted = await store.replaceGoogleRange('2026-03-01', '2026-03-31', [
      google({ summary: 'Legacy standup' }), // same key as the soft-deleted row
      google({ summary: 'Planning', dtstart: '2026-03-11T10:00:00+13:00', dtend: '2026-03-11T11:00:00+13:00', date: '2026-03-11' }),
    ]);

    expect(inserted).toBe(1);
    const all = await store.listRange('2026-03-01', '2026-03-31', { includeDeleted: true });
    const byTitle = Object.fromEntries(all.map((e) => [e.summary, e]));
    expect(byTitle['Dentist']).toMatchObject({ id: manualId, source: 'manual', deletedAt: null });
    expect(byTitle['Legacy standup'].deletedAt).not.toBeNull();
    expect(byTitle['Planning']).toMatchObject({ source: 'google', deletedAt: null });
    expect((await store.listRange('2026-03-01', '2026-03-31')).map((e) => e.summary).sort()).toEqual(['Dentist', 'Planning']);
  });

  it('restore clears deleted_at and delete of a manual event is soft too', async () => {
    const id = await store.addManual({
      date: '2026-04-01', summary: 'Trip', dtstart: '2026-04-01T00:00:00+13:00', dtend: '2026-04-02T00:00:00+13:00',
      allDay: true, description: '', location: '',
    });
    expect(await store.softDelete(id)).toBe(true);
    expect((await store.get(id))?.deletedAt).not.toBeNull();
    expect(await store.restore(id)).toBe(true);
    expect((await store.get(id))?.deletedAt).toBeNull();
    expect(await store.get(999999)).toBeUndefined();
  });

  it('stats reports counts and range of active events', async () => {
    await store.replaceGoogleRange('2026-03-01', '2026-03-31', [google(), google({ date: '2026-03-12', dtstart: '2026-03-12T09:00:00+13:00' })]);
    expect(await store.stats()).toEqual({ totalEvents: 2, totalDates: 2, minDate: '2026-03-10', maxDate: '2026-03-12' });
  });
});
