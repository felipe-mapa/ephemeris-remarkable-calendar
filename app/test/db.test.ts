import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventStore, type NewEvent } from '../src/server/db.js';

function legacyDb(): Database.Database {
  // Mirrors the schema created by ephemeris/calendar_db_sqlite.py before this app existed.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, summary TEXT, description TEXT, location TEXT,
      dtstart TEXT NOT NULL, dtend TEXT NOT NULL, color TEXT, calendar TEXT,
      all_day INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX idx_event_unique ON events(date, summary, dtstart);
    INSERT INTO events (date, summary, dtstart, dtend, color, calendar, all_day)
      VALUES ('2026-03-10', 'Legacy standup', '2026-03-10T09:00:00+13:00', '2026-03-10T09:30:00+13:00', 'gray4', 'TC', 0);
  `);
  return db;
}

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

describe('EventStore', () => {
  let store: EventStore;
  beforeEach(() => {
    store = new EventStore(legacyDb());
  });

  it('migrates a legacy database, marking existing rows as google-sourced', () => {
    const events = store.listRange('2026-03-01', '2026-03-31');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ summary: 'Legacy standup', source: 'google', deletedAt: null });
  });

  it('migration is idempotent', () => {
    expect(() => new EventStore(store.raw)).not.toThrow();
  });

  it('replaceGoogleRange keeps manual events and does not resurrect soft-deleted ones', () => {
    const manualId = store.addManual({
      date: '2026-03-10',
      summary: 'Dentist',
      dtstart: '2026-03-10T14:00:00+13:00',
      dtend: '2026-03-10T15:00:00+13:00',
      allDay: false,
      description: '',
      location: '',
    });
    const legacy = store.listRange('2026-03-10', '2026-03-10').find((e) => e.summary === 'Legacy standup')!;
    store.softDelete(legacy.id);

    const inserted = store.replaceGoogleRange('2026-03-01', '2026-03-31', [
      google({ summary: 'Legacy standup' }), // same key as the soft-deleted row
      google({ summary: 'Planning', dtstart: '2026-03-11T10:00:00+13:00', dtend: '2026-03-11T11:00:00+13:00', date: '2026-03-11' }),
    ]);

    expect(inserted).toBe(1);
    const all = store.listRange('2026-03-01', '2026-03-31', { includeDeleted: true });
    const byTitle = Object.fromEntries(all.map((e) => [e.summary, e]));
    expect(byTitle['Dentist']).toMatchObject({ id: manualId, source: 'manual', deletedAt: null });
    expect(byTitle['Legacy standup'].deletedAt).not.toBeNull();
    expect(byTitle['Planning']).toMatchObject({ source: 'google', deletedAt: null });
    // Active list hides the soft-deleted row
    expect(store.listRange('2026-03-01', '2026-03-31').map((e) => e.summary).sort()).toEqual(['Dentist', 'Planning']);
  });

  it('restore clears deleted_at and delete of a manual event is soft too', () => {
    const id = store.addManual({
      date: '2026-04-01', summary: 'Trip', dtstart: '2026-04-01T00:00:00+13:00', dtend: '2026-04-02T00:00:00+13:00',
      allDay: true, description: '', location: '',
    });
    store.softDelete(id);
    expect(store.get(id)?.deletedAt).not.toBeNull();
    store.restore(id);
    expect(store.get(id)?.deletedAt).toBeNull();
  });

  it('stats reports counts and range of active events', () => {
    const s = store.stats();
    expect(s).toEqual({ totalEvents: 1, totalDates: 1, minDate: '2026-03-10', maxDate: '2026-03-10' });
  });
});
