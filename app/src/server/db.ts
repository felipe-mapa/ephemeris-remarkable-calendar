import postgres, { type Sql } from 'postgres';
import { env } from './env.js';

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
  id: number; date: string; summary: string; description: string; location: string;
  dtstart: string; dtend: string; color: string; calendar: string; all_day: boolean;
  source: string; deleted_at: Date | null; created_at: Date;
}

function rowToEvent(r: Row): CalendarEvent {
  return {
    id: Number(r.id),
    date: r.date,
    summary: r.summary,
    description: r.description,
    location: r.location,
    dtstart: r.dtstart,
    dtend: r.dtend,
    color: r.color,
    calendar: r.calendar,
    allDay: r.all_day,
    source: r.source === 'manual' ? 'manual' : 'google',
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

export const MANUAL_CALENDAR = 'Manual';
export const MANUAL_COLOR = 'black';

/** postgres.js client. `date` columns come back as 'YYYY-MM-DD' strings, not JS Dates. */
export function connect(url: string = env.databaseUrl): Sql {
  return postgres(url, {
    max: 5,
    prepare: false, // required by Supabase's transaction pooler; harmless on direct/session connections
    types: {
      date: { to: 1082, from: [1082], serialize: (v: string) => v, parse: (v: string) => v },
    },
  });
}

export async function resolveUserId(sql: Sql, email: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`select id from public.users where email = ${email}`;
  if (rows.length === 0) throw new Error(`No user with email ${email}. Apply supabase/seed.sql (locally: supabase db reset).`);
  return rows[0].id;
}

const CHUNK = 500;

export class EventStore {
  constructor(public readonly sql: Sql, public readonly userId: string) {}

  static async open(url: string = env.databaseUrl, email: string = env.userEmail): Promise<EventStore> {
    const sql = connect(url);
    return new EventStore(sql, await resolveUserId(sql, email));
  }

  private cols() {
    return this.sql`id::int as id, date, summary, description, location, dtstart, dtend, color, calendar, all_day, source, deleted_at, created_at`;
  }

  async listRange(start: string, end: string, opts: { includeDeleted?: boolean } = {}): Promise<CalendarEvent[]> {
    const rows = await this.sql<Row[]>`
      select ${this.cols()} from public.events
      where user_id = ${this.userId} and date >= ${start} and date <= ${end}
      ${opts.includeDeleted ? this.sql`` : this.sql`and deleted_at is null`}
      order by date, all_day desc, dtstart`;
    return rows.map(rowToEvent);
  }

  async get(id: number): Promise<CalendarEvent | undefined> {
    const rows = await this.sql<Row[]>`select ${this.cols()} from public.events where id = ${id} and user_id = ${this.userId}`;
    return rows[0] ? rowToEvent(rows[0]) : undefined;
  }

  async addManual(input: ManualEventInput): Promise<number> {
    const [row] = await this.sql<{ id: number }[]>`
      insert into public.events (user_id, date, summary, description, location, dtstart, dtend, color, calendar, all_day, source)
      values (${this.userId}, ${input.date}, ${input.summary}, ${input.description}, ${input.location}, ${input.dtstart}, ${input.dtend},
              ${MANUAL_COLOR}, ${MANUAL_CALENDAR}, ${input.allDay}, 'manual')
      returning id::int as id`;
    return Number(row.id);
  }

  async softDelete(id: number): Promise<boolean> {
    const res = await this.sql`update public.events set deleted_at = now() where id = ${id} and user_id = ${this.userId} and deleted_at is null`;
    return res.count > 0;
  }

  async restore(id: number): Promise<boolean> {
    const res = await this.sql`update public.events set deleted_at = null where id = ${id} and user_id = ${this.userId} and deleted_at is not null`;
    return res.count > 0;
  }

  /**
   * Replace non-deleted Google events in [start, end] with a fresh set. Manual events are untouched.
   * Soft-deleted rows stay put and, because of the (user_id, date, summary, dtstart) unique key,
   * a re-fetched copy of a deleted event is ignored rather than resurrected. Returns the number inserted.
   */
  async replaceGoogleRange(start: string, end: string, events: NewEvent[]): Promise<number> {
    return this.sql.begin(async (tx) => {
      await tx`delete from public.events where user_id = ${this.userId} and date >= ${start} and date <= ${end} and source = 'google' and deleted_at is null`;
      let count = 0;
      for (let i = 0; i < events.length; i += CHUNK) {
        const rows = events.slice(i, i + CHUNK).map((e) => ({
          user_id: this.userId, date: e.date, summary: e.summary, description: e.description, location: e.location,
          dtstart: e.dtstart, dtend: e.dtend, color: e.color, calendar: e.calendar, all_day: e.allDay, source: 'google',
        }));
        const res = await tx`insert into public.events ${tx(rows)} on conflict (user_id, date, summary, dtstart) do nothing`;
        count += res.count;
      }
      return count;
    });
  }

  async stats(): Promise<{ totalEvents: number; totalDates: number; minDate: string | null; maxDate: string | null }> {
    const [r] = await this.sql<{ total: number; dates: number; min_date: string | null; max_date: string | null }[]>`
      select count(*)::int as total, count(distinct date)::int as dates, min(date)::text as min_date, max(date)::text as max_date
      from public.events where user_id = ${this.userId} and deleted_at is null`;
    return { totalEvents: r.total, totalDates: r.dates, minDate: r.min_date, maxDate: r.max_date };
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
