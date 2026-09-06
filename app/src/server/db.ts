import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { paths } from './paths.js';

export type EventSource = 'google' | 'manual';

export interface CalendarEvent {
  id: number;
  date: string; // YYYY-MM-DD in local tz
  summary: string;
  description: string;
  location: string;
  dtstart: string; // ISO 8601 with offset
  dtend: string;
  color: string;
  calendar: string;
  allDay: boolean;
  source: EventSource;
  deletedAt: string | null;
  createdAt: string;
}

export type NewEvent = Omit<CalendarEvent, 'id' | 'deletedAt' | 'createdAt'>;
export type ManualEventInput = Pick<NewEvent, 'date' | 'summary' | 'description' | 'location' | 'dtstart' | 'dtend' | 'allDay'>;

interface Row {
  id: number; date: string; summary: string | null; description: string | null; location: string | null;
  dtstart: string; dtend: string; color: string | null; calendar: string | null; all_day: number | null;
  source: string | null; deleted_at: string | null; created_at: string;
}

const SELECT = `SELECT id, date, summary, description, location, dtstart, dtend, color, calendar, all_day, source, deleted_at, created_at FROM events`;

function rowToEvent(r: Row): CalendarEvent {
  return {
    id: r.id,
    date: r.date,
    summary: r.summary ?? '',
    description: r.description ?? '',
    location: r.location ?? '',
    dtstart: r.dtstart,
    dtend: r.dtend,
    color: r.color ?? 'black',
    calendar: r.calendar ?? 'Unknown',
    allDay: !!r.all_day,
    source: r.source === 'manual' ? 'manual' : 'google',
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
  };
}

export const MANUAL_CALENDAR = 'Manual';
export const MANUAL_COLOR = 'black';

export class EventStore {
  constructor(public readonly raw: Database.Database) {
    this.migrate();
  }

  static open(file: string = paths.db): EventStore {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    return new EventStore(db);
  }

  private migrate() {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        summary TEXT,
        description TEXT,
        location TEXT,
        dtstart TEXT NOT NULL,
        dtend TEXT NOT NULL,
        color TEXT,
        calendar TEXT,
        all_day INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_date ON events(date);
      CREATE INDEX IF NOT EXISTS idx_dtstart ON events(dtstart);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_event_unique ON events(date, summary, dtstart);
    `);
    const cols = new Set((this.raw.prepare(`PRAGMA table_info(events)`).all() as { name: string }[]).map((c) => c.name));
    if (!cols.has('source')) this.raw.exec(`ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'google'`);
    if (!cols.has('deleted_at')) this.raw.exec(`ALTER TABLE events ADD COLUMN deleted_at TEXT`);
  }

  listRange(start: string, end: string, opts: { includeDeleted?: boolean } = {}): CalendarEvent[] {
    const where = opts.includeDeleted ? '' : ' AND deleted_at IS NULL';
    const rows = this.raw.prepare(`${SELECT} WHERE date >= ? AND date <= ?${where} ORDER BY date, all_day DESC, dtstart`).all(start, end) as Row[];
    return rows.map(rowToEvent);
  }

  get(id: number): CalendarEvent | undefined {
    const row = this.raw.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  addManual(input: ManualEventInput): number {
    const res = this.raw
      .prepare(
        `INSERT INTO events (date, summary, description, location, dtstart, dtend, color, calendar, all_day, source)
         VALUES (@date, @summary, @description, @location, @dtstart, @dtend, @color, @calendar, @allDay, 'manual')`,
      )
      .run({ ...input, allDay: input.allDay ? 1 : 0, color: MANUAL_COLOR, calendar: MANUAL_CALENDAR });
    return Number(res.lastInsertRowid);
  }

  softDelete(id: number): boolean {
    return this.raw.prepare(`UPDATE events SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`).run(id).changes > 0;
  }

  restore(id: number): boolean {
    return this.raw.prepare(`UPDATE events SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`).run(id).changes > 0;
  }

  /**
   * Replace non-deleted Google events in [start, end] with a fresh set.
   * Manual events are untouched. Soft-deleted rows stay put, and because the
   * unique index is on (date, summary, dtstart), a re-fetched copy of a deleted
   * event is ignored rather than resurrected. Returns the number inserted.
   */
  replaceGoogleRange(start: string, end: string, events: NewEvent[]): number {
    const del = this.raw.prepare(`DELETE FROM events WHERE date >= ? AND date <= ? AND source = 'google' AND deleted_at IS NULL`);
    const ins = this.raw.prepare(
      `INSERT OR IGNORE INTO events (date, summary, description, location, dtstart, dtend, color, calendar, all_day, source)
       VALUES (@date, @summary, @description, @location, @dtstart, @dtend, @color, @calendar, @allDay, 'google')`,
    );
    const tx = this.raw.transaction((items: NewEvent[]) => {
      del.run(start, end);
      let count = 0;
      for (const e of items) {
        count += ins.run({ ...e, allDay: e.allDay ? 1 : 0 }).changes;
      }
      return count;
    });
    return tx(events);
  }

  stats(): { totalEvents: number; totalDates: number; minDate: string | null; maxDate: string | null } {
    const r = this.raw
      .prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT date) AS dates, MIN(date) AS minDate, MAX(date) AS maxDate FROM events WHERE deleted_at IS NULL`)
      .get() as { total: number; dates: number; minDate: string | null; maxDate: string | null };
    return { totalEvents: r.total, totalDates: r.dates, minDate: r.minDate, maxDate: r.maxDate };
  }

  /** Timestamped copy of the DB file, mirroring calendar_db_sqlite.backup_db. */
  async backupFile(dir: string = paths.dbBackups): Promise<string | null> {
    const file = (this.raw as unknown as { name: string }).name;
    if (!file || file === ':memory:' || !fs.existsSync(file)) return null;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1_$2');
    const dest = path.join(dir, `calendar_${stamp}.db`);
    await this.raw.backup(dest);
    return dest;
  }

  close() {
    this.raw.close();
  }
}
