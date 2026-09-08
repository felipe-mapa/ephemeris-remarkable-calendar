# Supabase Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the local SQLite file (`output/calendar.db`) with a Supabase Postgres database that holds the events, the private ICS feed URLs, and a job queue driven by Supabase cron, while keeping PDF rendering and the reMarkable upload exactly where they run today.

**Architecture:** Supabase Postgres becomes the single source of truth (users, calendar_sources, events, jobs). Feed URLs live in Supabase Vault, referenced by id from `calendar_sources`. `pg_cron` inserts rows into a `jobs` table on a schedule; the existing Node server gains a worker loop that claims queued jobs and runs the unchanged pipeline (fetch → device backup → Python render + annotation merge → rmapi upload). Python no longer opens any database: Node exports the year's events to a JSON file before every render and the renderer reads that.

**Tech Stack:** Supabase (Postgres 15+, Vault, pg_cron), Supabase CLI (already installed at `/opt/homebrew/bin/supabase`), Node 22 + TypeScript + Hono (existing `app/`), `postgres` (postgres.js) as the DB driver, Python 3.13 venv + ReportLab (existing renderer), Docker (existing patched `rmapi` image).

**Spec:** This document, §"Requirements" and §"Design", written 2026-09-07 from the user's request.

## Global Constraints

- Node `>=22` (installed: v22.19.0). `app/` stays ESM (`"type": "module"`), imports use the `.js` suffix.
- Python `3.13` venv at `venv/`; no new Python dependencies (JSON is stdlib).
- Supabase CLI at `/opt/homebrew/bin/supabase`, `psql` at `/opt/homebrew/bin/psql`, Docker running (needed both for `supabase start` and for `rmapi`).
- Single user, no authentication. The only user row is seeded with email `felipe@pavanela.com`. Row Level Security is enabled with **no policies**, so only the `postgres`/`service_role` connection the server uses can read anything; the browser never talks to Supabase directly.
- Never commit secrets: `app/.env`, `supabase/seed.private.sql`, `config/*` stay gitignored.
- The `events` table keeps the existing column semantics: `date` is the local calendar day, `dtstart`/`dtend` remain ISO-8601 strings **with offset** (text), because `remarkable_calendar/calendar_loader.py` parses them with `datetime.fromisoformat`.
- Every reMarkable `.rmdoc` backup is kept for 7 days; the newest backup per document is never deleted.
- All `npm` commands run from `app/`; all Python and `supabase` commands run from the project root.

---

## Requirements (from the request)

1. Move the database from SQLite to Supabase. Drop the SQLite "calendar backup" copies (`backups/db/`, `EventStore.backupFile`, `calendar_db_sqlite.backup_db`).
2. Supabase also holds the secret ICS calendar URLs (Google "private" links embed a token).
3. One user, no authentication, created only by the initial seed.
4. Cron jobs live in Supabase and trigger the scripts.
5. Answer: can Supabase Functions run the Python scripts? (See "Design → Can Supabase run the Python scripts?")
6. The initial seed also contains the current, most up-to-date calendar data (events from `output/calendar.db` and sources from `config/config.yaml`).
7. Keep `.rmdoc` device backups for 7 days and delete older ones as part of the sync.

## Design

### Can Supabase run the Python scripts?

**No.** Supabase Edge Functions run on Deno (TypeScript/JavaScript/WASM only), cannot spawn processes, have no Python interpreter, and are capped at roughly 2 s of CPU time, 150–400 s wall clock and 256 MB of memory. The pipeline needs a 366-page ReportLab render (minutes), a Go binary (`rmapi`) inside Docker, and a writable filesystem for the `.rmdoc` merge. None of that fits.

What Supabase *can* do is schedule and record the work:

- `pg_cron` runs SQL on a schedule inside Postgres (UTC).
- That SQL inserts a row into `public.jobs`.
- A worker with Python + Docker claims the row and runs the pipeline. In this plan the worker is the existing Node server (`npm start`), kept alive on the Mac by `launchd`. It polls the queue every 5 s, so no inbound network access to the Mac is needed.

If you later want the pipeline off the Mac, the same `jobs` table works unchanged with a GitHub Actions scheduled workflow (or Fly.io / Railway container) built from the existing `Dockerfile` plus Node. That is out of scope here; the queue design is what makes it a drop-in swap later.

The ICS fetch step is pure TypeScript (`app/src/server/ics.ts`) and *could* become an Edge Function so events refresh while the Mac is asleep. It is deliberately not in this plan: it would split the ICS code across two runtimes for little gain, since the daily sync fetches anyway.

### Data model

```
users              id uuid, email text unique, created_at
calendar_sources   id uuid, user_id → users, name, color, url_secret_id (→ vault.secrets.id), enabled, created_at
events             id bigint identity, user_id → users, date date, summary, description, location,
                   dtstart text, dtend text, color, calendar, all_day bool, source ('google'|'manual'),
                   deleted_at timestamptz, created_at ; unique (user_id, date, summary, dtstart)
jobs               id uuid, user_id → users, kind, status ('queued'|'running'|'succeeded'|'failed'),
                   payload jsonb, requested_by ('web'|'cli'|'cron'), error, log text, created_at, started_at, finished_at
```

Secrets: ICS URLs are stored with `vault.create_secret(...)`; the app reads them through `vault.decrypted_secrets`. The reMarkable device token stays where it is (`config/.rmapi/rmapi.conf`), because `rmapi` needs it as a mounted file and the worker runs on the same machine.

### Job flow

```
pg_cron (UTC schedule) ──insert──▶ public.jobs (status = queued)
web "Sync" button ──POST /api/jobs/sync──▶ public.jobs (status = queued)
                                                │
             Node server worker loop (every 5 s, `for update skip locked`)
                                                ▼
                    JobRunner (unchanged in-memory runner + lock file) runs pipeline.*
                    log lines → jobs.log (persisted) and SSE stream (live UI)
                                                ▼
                            jobs.status = succeeded | failed, finished_at
```

The CLI (`npm run cli -- sync`) still executes directly, without the queue, so the shell wrappers under `scripts/` keep working.

### Python renderer input

`pipeline.ts` writes `output/events_<year>.json` (array of `{date, summary, description, location, dtstart, dtend, color, calendar, all_day}`) before every render and passes `APP_EVENTS_JSON_PATH` to Python. `calendar_loader.load_events_from_json()` replaces `load_events_from_db()`. `calendar_db_sqlite.py`, `event_fetcher.py` and `show_events.py` are deleted (the last two were already superseded by `ics.ts` and only existed to feed SQLite).

### File map

| Path | Change |
|---|---|
| `supabase/config.toml`, `supabase/migrations/20260907000000_initial.sql`, `supabase/migrations/20260907000100_cron.sql`, `supabase/seed.sql` | Create |
| `supabase/seed.private.sql` | Generated, gitignored |
| `app/src/server/env.ts` | Create: loads `.env`, exposes `DATABASE_URL`, `APP_USER_EMAIL` |
| `app/src/server/db.ts` | Rewrite on postgres.js, async, user-scoped |
| `app/src/server/sources.ts` | Create: calendar sources + Vault (replaces `config.ts`) |
| `app/src/server/jobqueue.ts` | Create: `jobs` table access, `workFor`, `startWorker` |
| `app/src/server/jobs.ts` | `start()` accepts an id; `JobKind` gains `'fetch-year'` |
| `app/src/server/pipeline.ts` | Sources from DB, events JSON export, `pruneBackups`, no DB backup |
| `app/src/server/paths.ts` | Drop `db`/`dbBackups`, add `eventsJsonPathForYear` |
| `app/src/server/app.ts` | Async store, jobs through the queue |
| `app/src/server/index.ts` | Open the store asynchronously, start the worker |
| `app/src/cli.ts` | Async store; new `worker`, `add-source`, `export-seed` commands |
| `app/src/client/api.ts`, `app/src/client/hooks/useJobs.tsx` | `queued` status, `fetch-year` label |
| `app/test/helpers.ts` | Create: local Supabase test store |
| `app/test/db.test.ts`, `app/test/api.test.ts` | Rewrite for Postgres |
| `app/test/sources.test.ts`, `app/test/jobqueue.test.ts`, `app/test/backups.test.ts` | Create |
| `remarkable_calendar/settings.py`, `remarkable_calendar/calendar_loader.py`, `remarkable_calendar.py` | Read events from JSON |
| `remarkable_calendar/calendar_db_sqlite.py`, `remarkable_calendar/event_fetcher.py`, `show_events.py` | Delete |
| `scripts/launchd/com.remarkablecalendar.server.plist` | Create |
| `README.md`, `.gitignore` | Update |

---

### Task 1: Supabase project scaffold, schema migration and user seed

**Files:**
- Create: `supabase/config.toml` (via `supabase init`, then edit the `[db.seed]` section)
- Create: `supabase/migrations/20260907000000_initial.sql`
- Create: `supabase/seed.sql`
- Modify: `.gitignore`

**Interfaces:**
- Produces: tables `public.users`, `public.calendar_sources`, `public.events`, `public.jobs` exactly as below; one seeded user with email `felipe@pavanela.com`. Local connection string `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.

- [ ] **Step 1: Initialise the Supabase project**

Run from the project root:

```bash
supabase init
```

Answer "no" to generating IDE settings. This creates `supabase/config.toml`.

- [ ] **Step 2: Point the seed at both seed files and ignore private files**

In `supabase/config.toml` find the `[db.seed]` section and make it:

```toml
[db.seed]
enabled = true
sql_paths = ["./seed.sql", "./seed.private*.sql"]
```

Append to `.gitignore`:

```gitignore

# Supabase
supabase/.branches
supabase/.temp
supabase/seed.private*.sql
```

- [ ] **Step 3: Write the schema migration**

Create `supabase/migrations/20260907000000_initial.sql`:

```sql
-- reMarkableCalendar: single-user schema. RLS is enabled with no policies on purpose:
-- only the server's postgres/service_role connection may read or write.

create extension if not exists supabase_vault with schema vault;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

create table public.calendar_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null,
  color text not null default 'black',
  -- vault.secrets.id holding the ICS URL (Google private links embed a token)
  url_secret_id uuid not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  date date not null,                       -- local calendar day of the occurrence
  summary text not null default '',
  description text not null default '',
  location text not null default '',
  dtstart text not null,                    -- ISO 8601 with offset, parsed by Python fromisoformat
  dtend text not null,
  color text not null default 'black',
  calendar text not null default 'Unknown',
  all_day boolean not null default false,
  source text not null default 'google' check (source in ('google', 'manual')),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, date, summary, dtstart)  -- same dedupe key as the SQLite idx_event_unique
);
create index events_user_date_idx on public.events (user_id, date);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (kind in ('sync', 'fetch', 'fetch-year', 'generate', 'remarkable', 'backup')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  requested_by text not null default 'web' check (requested_by in ('web', 'cli', 'cron')),
  error text,
  log text not null default '',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index jobs_queue_idx on public.jobs (created_at) where status = 'queued';
create index jobs_user_created_idx on public.jobs (user_id, created_at desc);

alter table public.users enable row level security;
alter table public.calendar_sources enable row level security;
alter table public.events enable row level security;
alter table public.jobs enable row level security;
```

- [ ] **Step 4: Write the tracked seed (user only)**

Create `supabase/seed.sql`:

```sql
-- The one and only user. No authentication: the server identifies itself by APP_USER_EMAIL.
insert into public.users (email) values ('felipe@pavanela.com')
on conflict (email) do nothing;
```

- [ ] **Step 5: Start the local stack and apply**

```bash
supabase start
supabase db reset
```

Expected: `db reset` ends with "Finished supabase db reset". Note the `DB URL` printed by `supabase start` (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`).

- [ ] **Step 6: Verify the schema and the seed**

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "select email from public.users;" -c "\dt public.*" -c "select count(*) from vault.secrets;"
```

Expected: one row `felipe@pavanela.com`; tables `calendar_sources, events, jobs, users`; `count = 0`.

- [ ] **Step 7: Commit**

```bash
git add supabase/config.toml supabase/migrations/20260907000000_initial.sql supabase/seed.sql .gitignore
git commit -m "feat(supabase): initial schema, single-user seed and local stack config"
```

---

### Task 2: Postgres-backed EventStore

**Files:**
- Create: `app/src/server/env.ts`
- Rewrite: `app/src/server/db.ts`
- Modify: `app/src/server/paths.ts`
- Modify: `app/package.json`
- Create: `app/test/helpers.ts`
- Rewrite: `app/test/db.test.ts`
- Modify: `app/vite.config.ts`

**Interfaces:**
- Produces:
  - `connect(url?: string): Sql` (postgres.js client)
  - `resolveUserId(sql: Sql, email: string): Promise<string>`
  - `class EventStore { constructor(sql: Sql, userId: string); static open(url?, email?): Promise<EventStore>; listRange(start, end, opts?): Promise<CalendarEvent[]>; get(id): Promise<CalendarEvent | undefined>; addManual(input): Promise<number>; softDelete(id): Promise<boolean>; restore(id): Promise<boolean>; replaceGoogleRange(start, end, events): Promise<number>; stats(): Promise<{totalEvents, totalDates, minDate, maxDate}>; close(): Promise<void> }`
  - `testStore(): Promise<EventStore>` in `app/test/helpers.ts` (truncates `events, jobs, calendar_sources`)
  - `CalendarEvent`, `NewEvent`, `ManualEventInput`, `MANUAL_CALENDAR`, `MANUAL_COLOR` keep their current shapes.

- [ ] **Step 1: Install the driver and dotenv**

```bash
cd app && npm install postgres@^3.4.5 dotenv@^16.5.0
```

Leave `better-sqlite3` installed for now: Task 9's `export-seed` reads the old file with it.

- [ ] **Step 2: Add `env.ts`**

Create `app/src/server/env.ts`:

```ts
import 'dotenv/config';

/** Defaults target the local `supabase start` stack; app/.env overrides them in production. */
export const env = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  userEmail: process.env.APP_USER_EMAIL ?? 'felipe@pavanela.com',
  /** Worker poll interval in ms; 0 disables the in-process worker. */
  workerIntervalMs: Number(process.env.APP_WORKER_INTERVAL_MS ?? 5000),
};
```

- [ ] **Step 3: Remove the SQLite paths**

In `app/src/server/paths.ts` delete these two lines from `paths`:

```ts
  db: process.env.APP_CALENDAR_DB_PATH ?? path.join(PROJECT_ROOT, 'output', 'calendar.db'),
  dbBackups: path.join(PROJECT_ROOT, 'backups', 'db'),
```

and add after `pdfPathForYear`:

```ts
export const eventsJsonPathForYear = (year: number) => path.join(paths.output, `events_${year}.json`);
```

- [ ] **Step 4: Write the failing tests**

Create `app/test/helpers.ts`:

```ts
import { connect, resolveUserId, EventStore } from '../src/server/db.js';

export const TEST_DB_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const TEST_USER_EMAIL = 'felipe@pavanela.com';

/** Fresh store against the local Supabase stack (`supabase start`). Wipes all user data first. */
export async function testStore(): Promise<EventStore> {
  const sql = connect(TEST_DB_URL);
  await sql`truncate public.events, public.jobs, public.calendar_sources restart identity`;
  await sql`delete from vault.secrets`;
  const userId = await resolveUserId(sql, TEST_USER_EMAIL);
  return new EventStore(sql, userId);
}
```

Replace `app/test/db.test.ts` with:

```ts
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
```

Make vitest run files one at a time (they share one database). In `app/vite.config.ts` change the `test` block to:

```ts
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
  },
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd app && npx vitest run test/db.test.ts`
Expected: FAIL — `connect`/`resolveUserId` are not exported and `EventStore.open` is synchronous.

- [ ] **Step 6: Rewrite `db.ts` on postgres.js**

Replace `app/src/server/db.ts` with:

```ts
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
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd app && npx vitest run test/db.test.ts`
Expected: PASS (4 tests). `npx tsc --noEmit` will still fail because `app.ts`, `cli.ts`, `index.ts` and `pipeline.ts` call the old sync API; Tasks 3, 4, 6 and 7 fix them.

- [ ] **Step 8: Commit**

```bash
git add app/package.json app/package-lock.json app/src/server/env.ts app/src/server/db.ts app/src/server/paths.ts app/test/helpers.ts app/test/db.test.ts app/vite.config.ts
git commit -m "feat(db): EventStore on Supabase Postgres via postgres.js"
```

---

### Task 3: Calendar sources in the database with URLs in Vault

**Files:**
- Create: `app/src/server/sources.ts`
- Delete: `app/src/server/config.ts`
- Create: `app/test/sources.test.ts`
- Modify: `app/src/server/pipeline.ts` (import + `fetchEventsRange` only; the rest of the file changes in Task 4)
- Modify: `app/src/server/ics.ts:6` (type import)

**Interfaces:**
- Consumes: `EventStore.sql`, `EventStore.userId` from Task 2.
- Produces:
  - `interface CalendarSource { id: string; name: string; color: string; source: string }` (`source` is the decrypted URL, same field name `ics.ts` already expects)
  - `listCalendarSources(sql, userId): Promise<CalendarSource[]>`
  - `addCalendarSource(sql, userId, input: { name: string; url: string; color?: string }): Promise<string>`
  - `removeCalendarSource(sql, userId, id: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `app/test/sources.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EventStore } from '../src/server/db.js';
import { addCalendarSource, listCalendarSources, removeCalendarSource } from '../src/server/sources.js';
import { testStore } from './helpers.js';

describe('calendar sources', () => {
  let store: EventStore;
  beforeEach(async () => {
    store = await testStore();
  });
  afterEach(async () => {
    await store.close();
  });

  it('stores the URL in Vault and returns it decrypted on list', async () => {
    const url = 'https://calendar.google.com/calendar/ical/x%40example.com/private-SECRET/basic.ics';
    const id = await addCalendarSource(store.sql, store.userId, { name: 'TC', url, color: 'gray4' });
    const list = await listCalendarSources(store.sql, store.userId);
    expect(list).toEqual([{ id, name: 'TC', color: 'gray4', source: url }]);

    const [raw] = await store.sql<{ secret: string }[]>`select secret from vault.secrets`;
    expect(raw.secret).not.toContain('private-SECRET'); // encrypted at rest
  });

  it('defaults the color to black and deletes the secret with the source', async () => {
    const id = await addCalendarSource(store.sql, store.userId, { name: 'Home', url: 'https://example.com/home.ics' });
    expect((await listCalendarSources(store.sql, store.userId))[0].color).toBe('black');
    expect(await removeCalendarSource(store.sql, store.userId, id)).toBe(true);
    expect(await listCalendarSources(store.sql, store.userId)).toEqual([]);
    expect((await store.sql`select count(*)::int as n from vault.secrets`)[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run test/sources.test.ts`
Expected: FAIL — cannot find module `../src/server/sources.js`.

- [ ] **Step 3: Implement `sources.ts`**

Create `app/src/server/sources.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';

export interface CalendarSource {
  id: string;
  name: string;
  color: string;
  /** Decrypted ICS URL. Never send this to the browser. */
  source: string;
}

/** Enabled sources for the user, URLs decrypted from Vault. */
export async function listCalendarSources(sql: Sql, userId: string): Promise<CalendarSource[]> {
  return sql<CalendarSource[]>`
    select s.id, s.name, s.color, v.decrypted_secret as source
    from public.calendar_sources s
    join vault.decrypted_secrets v on v.id = s.url_secret_id
    where s.user_id = ${userId} and s.enabled
    order by s.created_at`;
}

export async function addCalendarSource(sql: Sql, userId: string, input: { name: string; url: string; color?: string }): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into public.calendar_sources (user_id, name, color, url_secret_id)
    values (${userId}, ${input.name}, ${input.color ?? 'black'},
            vault.create_secret(${input.url}, ${'ics:' + randomUUID()}, ${'ICS feed ' + input.name}))
    returning id`;
  return row.id;
}

export async function removeCalendarSource(sql: Sql, userId: string, id: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ url_secret_id: string }[]>`
      delete from public.calendar_sources where id = ${id} and user_id = ${userId} returning url_secret_id`;
    if (rows.length === 0) return false;
    await tx`delete from vault.secrets where id = ${rows[0].url_secret_id}`;
    return true;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run test/sources.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Use the database sources in the fetch step**

In `app/src/server/pipeline.ts` replace `import { loadCalendarSources } from './config.js';` with `import { listCalendarSources } from './sources.js';` and change `fetchEventsRange` to:

```ts
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
```

This also removes the two `store.backupFile()` lines (requirement 1). Delete `app/src/server/config.ts`:

```bash
git rm app/src/server/config.ts
```

`app/src/server/ics.ts:6` imports the type from it; change that line to `import type { CalendarSource } from './sources.js';` (the new type has the same `name`, `source`, `color` fields plus `id`). `app.ts` still imports `config.ts`; Task 7 fixes that.

- [ ] **Step 6: Commit**

```bash
git add app/src/server/sources.ts app/src/server/pipeline.ts app/src/server/ics.ts app/test/sources.test.ts
git commit -m "feat(sources): calendar feeds live in Postgres with URLs in Supabase Vault"
```

---

### Task 4: Python renders from an exported JSON file; SQLite code removed

**Files:**
- Modify: `remarkable_calendar/settings.py:60`
- Modify: `remarkable_calendar/calendar_loader.py:1-14,176-260`
- Modify: `remarkable_calendar.py:17,61`
- Delete: `remarkable_calendar/calendar_db_sqlite.py`, `remarkable_calendar/event_fetcher.py`, `show_events.py`
- Modify: `app/src/server/pipeline.ts` (`generatePdf`, `mergeFromBackup`, `uploadFresh`, `updateRemarkable`)
- Create: `app/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `EventStore.listRange` (Task 2), `eventsJsonPathForYear` (Task 2).
- Produces:
  - `exportEventsJson(store: EventStore, year: number): Promise<string>` — writes the file and returns its path.
  - `generatePdf(ctx, store, year?)` — **new `store` parameter**; `updateRemarkable(ctx, store, opts)` unchanged signature.
  - Python env var `APP_EVENTS_JSON_PATH` → `settings.EVENTS_JSON`; `calendar_loader.load_events_from_json()`.
  - JSON row shape: `{ "date": "YYYY-MM-DD", "summary", "description", "location", "dtstart", "dtend", "color", "calendar", "all_day": bool }`.

- [ ] **Step 1: Write the failing export test**

Create `app/test/pipeline.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run test/pipeline.test.ts`
Expected: FAIL — `exportEventsJson` is not exported.

- [ ] **Step 3: Export the JSON and pass it to every Python call**

In `app/src/server/pipeline.ts`:

Change the paths import to `import { paths, pdfPathForYear, eventsJsonPathForYear, RMAPI_IMAGE, TIMEZONE } from './paths.js';`.

Add after `ensurePython()`:

```ts
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
```

Replace `generatePdf`, `mergeFromBackup` and `uploadFresh`:

```ts
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
```

In `updateRemarkable` change the three call sites to pass the store: `await mergeFromBackup(ctx, store, backup, year);`, `await mergeFromBackup(ctx, store, local, year);`, `await uploadFresh(ctx, store, year);`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run test/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Switch the Python renderer to the JSON file**

In `remarkable_calendar/settings.py` replace the line

```python
CALENDAR_DB  = Path(os.getenv("APP_CALENDAR_DB_PATH", str(BASE_DIR / "output/calendar.db")))
```

with

```python
EVENTS_JSON  = Path(os.getenv("APP_EVENTS_JSON_PATH", str(BASE_DIR / "output/events.json")))
```

In `remarkable_calendar/calendar_loader.py` remove `import sqlite3` and `from remarkable_calendar.calendar_db_sqlite import get_db_path`, add `import json` next to the other stdlib imports, and replace the whole `load_events_from_db` function with:

```python
async def load_events_from_json() -> list[tuple]:
    """
    Load the events exported by the web app (app/src/server/pipeline.ts exportEventsJson)
    and convert them to the same format as load_raw_events (icalendar components).
    Returns list of tuples: (component, color, tz_factory, name).
    """
    path = settings.EVENTS_JSON
    if not path.exists():
        logger.warning("Events file not found at {}, rendering an empty calendar", path)
        return []

    logger.debug("Loading events from {}", path)
    rows = json.loads(path.read_text())
    all_events = []

    for row in rows:
        date_str = row.get('date', '')
        summary = row.get('summary') or ''
        dtstart_str = row.get('dtstart', '')
        dtend_str = row.get('dtend', '')
        all_day = bool(row.get('all_day'))

        event = iCalEvent()
        event.add('summary', summary)
        if row.get('description'):
            event.add('description', row['description'])
        if row.get('location'):
            event.add('location', row['location'])

        try:
            if all_day:
                dtstart = datetime.fromisoformat(dtstart_str).date()
                dtend = datetime.fromisoformat(dtend_str).date()
            else:
                dtstart = datetime.fromisoformat(dtstart_str)
                dtend = datetime.fromisoformat(dtend_str)
                if dtstart.tzinfo is None:
                    dtstart = dtstart.replace(tzinfo=settings.TZ_LOCAL)
                if dtend.tzinfo is None:
                    dtend = dtend.replace(tzinfo=settings.TZ_LOCAL)

            event.add('dtstart', dtstart)
            event.add('dtend', dtend)

            uid = f"{date_str}-{summary}-{dtstart_str}".replace(' ', '-').replace(':', '')
            event.add('uid', uid)
        except (ValueError, TypeError) as e:
            logger.warning("Failed to parse datetime for event '{}': {}", summary, e)
            continue

        # tz_factory is None because the datetimes are already timezone-aware
        all_events.append((event, row.get('color') or 'black', None, row.get('calendar') or 'Database'))

    logger.debug("Loaded {} events from JSON", len(all_events))
    return all_events
```

In `remarkable_calendar.py` change line 17 to `from remarkable_calendar.calendar_loader import load_raw_events, load_events_from_json` and line 61 to `raw_events = await load_events_from_json()`.

Delete the SQLite-only modules:

```bash
git rm remarkable_calendar/calendar_db_sqlite.py remarkable_calendar/event_fetcher.py show_events.py
```

Verify nothing else references them:

```bash
grep -rn -e calendar_db_sqlite -e event_fetcher -e load_events_from_db -e show_events --exclude-dir=venv --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs .
```

Expected: only comment hits in `app/src/server/ics.ts:43` and `README.md` (README is updated in Task 9); fix the `ics.ts` comment to say "Mirrors the former remarkable_calendar/event_fetcher.py".

- [ ] **Step 6: Render one day from a hand-written JSON file**

```bash
cat > /tmp/events_smoke.json <<'EOF'
[{"date":"2026-03-10","summary":"Standup","description":"","location":"","dtstart":"2026-03-10T09:00:00+13:00","dtend":"2026-03-10T09:30:00+13:00","color":"gray4","calendar":"TC","all_day":false},
 {"date":"2026-03-10","summary":"Trip","description":"","location":"","dtstart":"2026-03-10T00:00:00+13:00","dtend":"2026-03-11T00:00:00+13:00","color":"black","calendar":"Manual","all_day":true}]
EOF
APP_EVENTS_JSON_PATH=/tmp/events_smoke.json TIME_DATE_RANGE=2026-03-10:2026-03-10 APP_OUTPUT_PDF_PATH=output/smoke_json.pdf APP_FORCE_REFRESH=true venv/bin/python3 remarkable_calendar.py
venv/bin/python3 -c "from pypdf import PdfReader; r=PdfReader('output/smoke_json.pdf'); print(len(r.pages)); print('Standup' in r.pages[1].extract_text())"
```

Expected: no traceback; prints `2` (cover + one day) then `True`. Remove `output/smoke_json.pdf` afterwards.

- [ ] **Step 7: Commit**

```bash
git add remarkable_calendar/settings.py remarkable_calendar/calendar_loader.py remarkable_calendar.py app/src/server/pipeline.ts app/src/server/ics.ts app/test/pipeline.test.ts
git commit -m "feat(render): Python reads events from an exported JSON file, SQLite modules removed"
```

---

### Task 5: Keep `.rmdoc` backups for 7 days

**Files:**
- Modify: `app/src/server/pipeline.ts` (`updateRemarkable` + new `pruneBackups`)
- Create: `app/test/backups.test.ts`

**Interfaces:**
- Produces: `pruneBackups(opts?: { dir?: string; keepDays?: number; now?: number; log?: (line: string) => void }): string[]` — returns the deleted file names. Always keeps the newest file per document name.

- [ ] **Step 1: Write the failing test**

Create `app/test/backups.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run test/backups.test.ts`
Expected: FAIL — `pruneBackups` is not exported.

- [ ] **Step 3: Implement and wire into the sync**

Add to `app/src/server/pipeline.ts` after `listBackups`:

```ts
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
```

At the end of `updateRemarkable`, before `ctx.log('✅ Calendar sync completed');`, add:

```ts
  pruneBackups({ log: ctx.log });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run test/backups.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/server/pipeline.ts app/test/backups.test.ts
git commit -m "feat(backups): keep reMarkable .rmdoc backups for 7 days, prune during sync"
```

---

### Task 6: Job queue table and worker loop

**Files:**
- Modify: `app/src/server/jobs.ts`
- Create: `app/src/server/jobqueue.ts`
- Create: `app/test/jobqueue.test.ts`

**Interfaces:**
- Consumes: `JobRunner` (existing), `EventStore` (Task 2), `pipeline.*` (Tasks 3–5).
- Produces:
  - `JobKind` now `'sync' | 'fetch' | 'fetch-year' | 'generate' | 'remarkable' | 'backup'`; `JobRunner.start(kind, work, opts?: { id?: string })`.
  - `interface QueuedJob { id: string; kind: JobKind; status: 'queued' | 'running' | 'succeeded' | 'failed'; payload: Record<string, unknown>; requestedBy: 'web' | 'cli' | 'cron'; error: string | null; log: string; createdAt: string; startedAt: string | null; finishedAt: string | null }`
  - `enqueue(sql, userId, kind, payload?, requestedBy?): Promise<QueuedJob>` (returns the existing queued job of that kind if one exists)
  - `claimNext(sql): Promise<QueuedJob | null>`, `appendLog(sql, id, line)`, `finishJob(sql, id, status, error)`, `failStaleRunning(sql): Promise<number>`, `listJobs(sql, userId, limit?)`, `getJob(sql, id)`, `activeJob(sql, userId)`
  - `workFor(kind, payload, store): (ctx: JobContext) => Promise<void>`
  - `startWorker({ sql, store, jobs, intervalMs? }): { tick(): Promise<QueuedJob | null>; stop(): void }`

- [ ] **Step 1: Extend `JobRunner`**

In `app/src/server/jobs.ts`:

```ts
export type JobKind = 'sync' | 'fetch' | 'fetch-year' | 'generate' | 'remarkable' | 'backup';
```

and change the `start` signature and the id line:

```ts
  start(kind: JobKind, work: (ctx: JobContext) => Promise<void>, opts: { id?: string } = {}): JobRecord {
    if (this.current) throw new JobBusyError(this.current);
    if (!this.acquireLock()) throw new JobBusyError(null);

    const job: JobRecord = {
      id: opts.id ?? `${Date.now().toString(36)}-${(this.seq++).toString(36)}`,
```

- [ ] **Step 2: Write the failing tests**

Create `app/test/jobqueue.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EventStore } from '../src/server/db.js';
import { JobRunner } from '../src/server/jobs.js';
import { enqueue, claimNext, listJobs, getJob, failStaleRunning, startWorker, activeJob } from '../src/server/jobqueue.js';
import { testStore } from './helpers.js';

describe('job queue', () => {
  let store: EventStore;
  beforeEach(async () => {
    store = await testStore();
  });
  afterEach(async () => {
    await store.close();
  });

  it('enqueue is idempotent per kind while queued, claim marks running in FIFO order', async () => {
    const a = await enqueue(store.sql, store.userId, 'fetch', { days: 30 }, 'cron');
    const again = await enqueue(store.sql, store.userId, 'fetch', { days: 30 }, 'web');
    expect(again.id).toBe(a.id);
    const b = await enqueue(store.sql, store.userId, 'generate', { year: 2026 });
    expect(await activeJob(store.sql, store.userId)).toMatchObject({ id: a.id, status: 'queued' });

    const first = await claimNext(store.sql);
    expect(first).toMatchObject({ id: a.id, kind: 'fetch', status: 'running', payload: { days: 30 }, requestedBy: 'cron' });
    expect(first?.startedAt).not.toBeNull();
    expect((await claimNext(store.sql))?.id).toBe(b.id);
    expect(await claimNext(store.sql)).toBeNull();

    expect((await listJobs(store.sql, store.userId)).map((j) => j.id)).toEqual([b.id, a.id]);
    expect(await getJob(store.sql, a.id)).toMatchObject({ status: 'running' });
    expect(await failStaleRunning(store.sql)).toBe(2);
    expect(await getJob(store.sql, a.id)).toMatchObject({ status: 'failed', error: 'Worker restarted while the job was running' });
  });

  it('worker tick runs the job through the JobRunner and persists log and status', async () => {
    const jobs = new JobRunner(() => {});
    const worker = startWorker({ sql: store.sql, store, jobs, intervalMs: 0 }); // 0 = do not schedule, tick manually
    const queued = await enqueue(store.sql, store.userId, 'generate', { year: 2026 });

    // generate would spawn Python; substitute the work for this test
    const ran = await worker.tick((kind, payload) => async (ctx) => {
      ctx.log(`pretend ${kind} ${JSON.stringify(payload)}`);
    });

    expect(ran?.id).toBe(queued.id);
    const done = await getJob(store.sql, queued.id);
    expect(done).toMatchObject({ status: 'succeeded', error: null });
    expect(done?.log).toContain('pretend generate {"year":2026}');
    expect(done?.finishedAt).not.toBeNull();

    const failing = await enqueue(store.sql, store.userId, 'backup');
    await worker.tick(() => async () => {
      throw new Error('boom');
    });
    expect(await getJob(store.sql, failing.id)).toMatchObject({ status: 'failed', error: 'boom' });
    worker.stop();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd app && npx vitest run test/jobqueue.test.ts`
Expected: FAIL — cannot find module `../src/server/jobqueue.js`.

- [ ] **Step 4: Implement `jobqueue.ts`**

Create `app/src/server/jobqueue.ts`:

```ts
import type { Sql } from 'postgres';
import type { EventStore } from './db.js';
import { JobRunner, type JobContext, type JobKind } from './jobs.js';
import * as pipeline from './pipeline.js';

export type QueuedStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type RequestedBy = 'web' | 'cli' | 'cron';

export interface QueuedJob {
  id: string;
  kind: JobKind;
  status: QueuedStatus;
  payload: Record<string, unknown>;
  requestedBy: RequestedBy;
  error: string | null;
  log: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface JobRow {
  id: string; kind: JobKind; status: QueuedStatus; payload: Record<string, unknown>; requested_by: RequestedBy;
  error: string | null; log: string; created_at: Date; started_at: Date | null; finished_at: Date | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function rowToJob(r: JobRow): QueuedJob {
  return {
    id: r.id, kind: r.kind, status: r.status, payload: r.payload ?? {}, requestedBy: r.requested_by, error: r.error,
    log: r.log, createdAt: r.created_at.toISOString(), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
  };
}

const COLS = 'id, kind, status, payload, requested_by, error, log, created_at, started_at, finished_at';

/** Queue a job. If a job of the same kind is already queued, return it instead of adding a duplicate. */
export async function enqueue(sql: Sql, userId: string, kind: JobKind, payload: Record<string, unknown> = {}, requestedBy: RequestedBy = 'web'): Promise<QueuedJob> {
  const existing = await sql.unsafe<JobRow[]>(`select ${COLS} from public.jobs where user_id = $1 and kind = $2 and status = 'queued' order by created_at limit 1`, [userId, kind]);
  if (existing.length) return rowToJob(existing[0]);
  const [row] = await sql.unsafe<JobRow[]>(
    `insert into public.jobs (user_id, kind, payload, requested_by) values ($1, $2, $3, $4) returning ${COLS}`,
    [userId, kind, JSON.stringify(payload), requestedBy],
  );
  return rowToJob(row);
}

/** Atomically take the oldest queued job (safe with several workers thanks to skip locked). */
export async function claimNext(sql: Sql): Promise<QueuedJob | null> {
  const rows = await sql.unsafe<JobRow[]>(`
    update public.jobs set status = 'running', started_at = now()
    where id = (select id from public.jobs where status = 'queued' order by created_at limit 1 for update skip locked)
    returning ${COLS}`);
  return rows.length ? rowToJob(rows[0]) : null;
}

export async function appendLog(sql: Sql, id: string, line: string): Promise<void> {
  await sql`update public.jobs set log = log || ${line + '\n'} where id = ${id}`;
}

export async function finishJob(sql: Sql, id: string, status: 'succeeded' | 'failed', error: string | null): Promise<void> {
  await sql`update public.jobs set status = ${status}, error = ${error}, finished_at = now() where id = ${id}`;
}

/** Called on worker start: anything still "running" belonged to a process that died. */
export async function failStaleRunning(sql: Sql): Promise<number> {
  const res = await sql`update public.jobs set status = 'failed', error = 'Worker restarted while the job was running', finished_at = now() where status = 'running'`;
  return res.count;
}

export async function listJobs(sql: Sql, userId: string, limit = 50): Promise<QueuedJob[]> {
  const rows = await sql.unsafe<JobRow[]>(`select ${COLS} from public.jobs where user_id = $1 order by created_at desc limit $2`, [userId, limit]);
  return rows.map(rowToJob);
}

export async function getJob(sql: Sql, id: string): Promise<QueuedJob | undefined> {
  const rows = await sql.unsafe<JobRow[]>(`select ${COLS} from public.jobs where id = $1`, [id]);
  return rows.length ? rowToJob(rows[0]) : undefined;
}

/** The running job, else the oldest queued one, else null. Lets the UI show cron-queued work. */
export async function activeJob(sql: Sql, userId: string): Promise<QueuedJob | null> {
  const rows = await sql.unsafe<JobRow[]>(
    `select ${COLS} from public.jobs where user_id = $1 and status in ('running', 'queued') order by (status = 'running') desc, created_at limit 1`,
    [userId],
  );
  return rows.length ? rowToJob(rows[0]) : null;
}

export type WorkFactory = (kind: JobKind, payload: Record<string, unknown>, store: EventStore) => (ctx: JobContext) => Promise<void>;

/** Map a queued job to the pipeline step the HTTP routes used to call directly. */
export const workFor: WorkFactory = (kind, payload, store) => {
  const num = (k: string, d: number) => (typeof payload[k] === 'number' ? (payload[k] as number) : d);
  switch (kind) {
    case 'sync':
      return (ctx) => pipeline.updateRemarkable(ctx, store, { skipFetch: false, days: num('days', 7) });
    case 'fetch':
      return (ctx) => pipeline.fetchEvents(ctx, store, Math.min(Math.max(num('days', 30), 1), 400)).then(() => undefined);
    case 'fetch-year': {
      const year = num('year', pipeline.currentYear());
      return (ctx) => pipeline.fetchEventsRange(ctx, store, `${year}-01-01`, `${year}-12-31`).then(() => undefined);
    }
    case 'generate':
      return (ctx) => pipeline.generatePdf(ctx, store, num('year', pipeline.currentYear())).then(() => undefined);
    case 'remarkable':
      return (ctx) => pipeline.updateRemarkable(ctx, store, { skipFetch: payload.skipFetch !== false, days: num('days', 7) });
    case 'backup':
      return async (ctx) => {
        const file = await pipeline.backupFromRemarkable(ctx, pipeline.docNameForYear(pipeline.currentYear()));
        if (!file) throw new Error('Backup failed: document not downloaded');
      };
  }
};

/**
 * Poll the queue and run one job at a time through the JobRunner (so the lock file, SSE stream
 * and CLI keep working unchanged). intervalMs = 0 disables scheduling; call tick() yourself.
 */
export function startWorker(opts: { sql: Sql; store: EventStore; jobs: JobRunner; intervalMs?: number }) {
  const { sql, store, jobs } = opts;
  const intervalMs = opts.intervalMs ?? 5000;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (factory: WorkFactory = workFor): Promise<QueuedJob | null> => {
    if (jobs.running) return null;
    const row = await claimNext(sql);
    if (!row) return null;

    let chain = Promise.resolve();
    const onLine = (id: string, line: string) => {
      if (id !== row.id) return;
      chain = chain.then(() => appendLog(sql, id, line)).catch(() => {});
    };
    jobs.on('line', onLine);
    try {
      const job = jobs.start(row.kind, factory(row.kind, row.payload, store), { id: row.id });
      const done = await jobs.wait(job.id);
      await chain;
      await finishJob(sql, row.id, done.status === 'succeeded' ? 'succeeded' : 'failed', done.error);
    } catch (err) {
      await finishJob(sql, row.id, 'failed', err instanceof Error ? err.message : String(err));
    } finally {
      jobs.off('line', onLine);
    }
    return row;
  };

  const loop = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      console.error('worker tick failed', err);
    }
    if (!stopped && intervalMs > 0) timer = setTimeout(loop, intervalMs);
  };

  if (intervalMs > 0) {
    void failStaleRunning(sql).then(() => loop());
  }

  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd app && npx vitest run test/jobqueue.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add app/src/server/jobs.ts app/src/server/jobqueue.ts app/test/jobqueue.test.ts
git commit -m "feat(jobs): Postgres job queue with in-process worker loop"
```

---

### Task 7: HTTP API, server entry point, CLI and client on the queue

**Files:**
- Modify: `app/src/server/app.ts`
- Modify: `app/src/server/index.ts`
- Modify: `app/src/cli.ts`
- Modify: `app/src/client/api.ts`, `app/src/client/hooks/useJobs.tsx`
- Rewrite: `app/test/api.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 3, 6.
- Produces: same HTTP routes as today; `POST /api/jobs/<kind>` now returns `202 { job: QueuedJob }` with `status: 'queued'`; `GET /api/jobs` lists persisted jobs; `/api/jobs/:id/stream` works for queued, running and finished jobs. CLI gains `worker`, `add-source`, `list-sources`.

- [ ] **Step 1: Rewrite the API test**

Replace `app/test/api.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EventStore } from '../src/server/db.js';
import { JobRunner } from '../src/server/jobs.js';
import { createApp, manualEventFromBody } from '../src/server/app.js';
import { addCalendarSource } from '../src/server/sources.js';
import { getJob } from '../src/server/jobqueue.js';
import { testStore } from './helpers.js';

describe('manualEventFromBody', () => {
  it('builds timed events in the configured zone with a one hour default duration', () => {
    const e = manualEventFromBody({ summary: 'Dentist', date: '2026-03-10', startTime: '14:00' }, 'Pacific/Auckland');
    expect(e).toMatchObject({ dtstart: '2026-03-10T14:00:00+13:00', dtend: '2026-03-10T15:00:00+13:00', allDay: false });
  });
  it('builds multi-day all-day events with exclusive end', () => {
    const e = manualEventFromBody({ summary: 'Trip', date: '2026-04-10', allDay: true, endDate: '2026-04-12' }, 'Pacific/Auckland');
    expect(e).toMatchObject({ dtstart: '2026-04-10T00:00:00+12:00', dtend: '2026-04-13T00:00:00+12:00', allDay: true });
  });
  it('rejects missing title, bad dates and inverted times', () => {
    expect(() => manualEventFromBody({ summary: ' ', date: '2026-03-10', startTime: '10:00' })).toThrow(/Title/);
    expect(() => manualEventFromBody({ summary: 'x', date: '2026-3-1', startTime: '10:00' })).toThrow(/date/);
    expect(() => manualEventFromBody({ summary: 'x', date: '2026-03-10', startTime: '10:00', endTime: '09:00' })).toThrow(/after/);
  });
});

describe('API', () => {
  let store: EventStore;
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    store = await testStore();
    app = createApp({ store, jobs: new JobRunner(() => {}) });
  });
  afterEach(async () => {
    await store.close();
  });

  it('creates, lists, soft deletes and restores an event', async () => {
    const create = await app.request('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'Dentist', date: '2026-03-10', startTime: '14:00', endTime: '15:00' }),
    });
    expect(create.status).toBe(201);
    const { event } = (await create.json()) as { event: { id: number; source: string } };
    expect(event.source).toBe('manual');

    const list = await app.request('/api/events?start=2026-03-01&end=2026-03-31');
    expect(((await list.json()) as { events: unknown[] }).events).toHaveLength(1);

    expect((await app.request(`/api/events/${event.id}`, { method: 'DELETE' })).status).toBe(200);
    const active = (await (await app.request('/api/events?start=2026-03-01&end=2026-03-31')).json()) as { events: unknown[] };
    expect(active.events).toHaveLength(0);
    const all = (await (await app.request('/api/events?start=2026-03-01&end=2026-03-31&includeDeleted=true')).json()) as { events: { deletedAt: string | null }[] };
    expect(all.events[0].deletedAt).not.toBeNull();

    const restore = await app.request(`/api/events/${event.id}/restore`, { method: 'POST' });
    expect(((await restore.json()) as { event: { deletedAt: null } }).event.deletedAt).toBeNull();
  });

  it('returns 400 for invalid payloads and 404 for unknown ids', async () => {
    expect((await app.request('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
    expect((await app.request('/api/events/999', { method: 'DELETE' })).status).toBe(404);
    expect((await app.request('/api/events?start=x&end=y')).status).toBe(400);
  });

  it('status lists calendars without their URLs', async () => {
    await addCalendarSource(store.sql, store.userId, { name: 'TC', url: 'https://example.com/private-abc/basic.ics', color: 'gray4' });
    const status = (await (await app.request('/api/status')).json()) as { calendars: unknown[]; running: unknown };
    expect(status.calendars).toEqual([{ name: 'TC', color: 'gray4' }]);
    expect(JSON.stringify(status)).not.toContain('private-abc');
    expect(status.running).toBeNull();
  });

  it('queues jobs instead of running them inline and dedupes queued kinds', async () => {
    const res = await app.request('/api/jobs/sync', { method: 'POST', body: JSON.stringify({ days: 3 }) });
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: { id: string; status: string; payload: { days: number } } };
    expect(job).toMatchObject({ status: 'queued', payload: { days: 3 } });
    expect(await getJob(store.sql, job.id)).toMatchObject({ kind: 'sync', requestedBy: 'web' });

    const dup = (await (await app.request('/api/jobs/sync', { method: 'POST', body: '{}' })).json()) as { job: { id: string } };
    expect(dup.job.id).toBe(job.id);

    const list = (await (await app.request('/api/jobs')).json()) as { jobs: { id: string }[] };
    expect(list.jobs.map((j) => j.id)).toEqual([job.id]);
    const status = (await (await app.request('/api/status')).json()) as { running: { id: string; status: string } };
    expect(status.running).toMatchObject({ id: job.id, status: 'queued' });
  });

  it('streams the persisted log of a finished job', async () => {
    const { job } = (await (await app.request('/api/jobs/backup', { method: 'POST', body: '{}' })).json()) as { job: { id: string } };
    await store.sql`update public.jobs set status = 'failed', error = 'boom', log = 'line one\nline two\n', finished_at = now() where id = ${job.id}`;
    const res = await app.request(`/api/jobs/${job.id}/stream`);
    const text = await res.text();
    expect(text).toContain('data: line one');
    expect(text).toContain('data: line two');
    expect(text).toContain('event: done');
    expect(text).toContain('"status":"failed"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run test/api.test.ts`
Expected: FAIL — `app.ts` still imports `./config.js` and calls the sync store API.

- [ ] **Step 3: Rewrite the job and status routes in `app.ts`**

Replace the imports at the top of `app/src/server/app.ts` with:

```ts
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { DateTime } from 'luxon';
import { EventStore, type ManualEventInput } from './db.js';
import { JobBusyError, JobRunner, type JobKind } from './jobs.js';
import { listCalendarSources } from './sources.js';
import { activeJob, enqueue, getJob, listJobs } from './jobqueue.js';
import * as pipeline from './pipeline.js';
import { TIMEZONE } from './paths.js';
```

Replace the `/status` route:

```ts
  api.get('/status', async (c) =>
    c.json({
      timezone: TIMEZONE,
      today: DateTime.now().setZone(TIMEZONE).toISODate(),
      stats: await store.stats(),
      calendars: (await listCalendarSources(store.sql, store.userId)).map((s) => ({ name: s.name, color: s.color })),
      running: jobs.running ?? (await activeJob(store.sql, store.userId)),
      backups: pipeline.listBackups(pipeline.currentYear()),
    }),
  );
```

Make the four event routes `async` and `await` the store calls (`await store.listRange(...)`, `const id = await store.addManual(input); return c.json({ event: await store.get(id) }, 201);`, `if (!(await store.get(id))) return ...; await store.softDelete(id); return c.json({ event: await store.get(id) });`, same for restore).

Replace everything from `// ---- jobs ----` down to (but not including) `app.route('/api', api);` with:

```ts
  // ---- jobs: every request becomes a row in public.jobs; the worker loop picks it up ----
  const sql = store.sql;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

  api.get('/jobs', async (c) => c.json({ jobs: (await listJobs(sql, store.userId)).map(({ log, ...j }) => ({ ...j, lineCount: log ? log.split('\n').length - 1 : 0 })) }));
  api.get('/jobs/:id', async (c) => {
    const id = c.req.param('id');
    const row = await getJob(sql, id);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const mem = jobs.get(id);
    const { log, ...rest } = row;
    return c.json({ job: { ...rest, lines: mem ? mem.lines : log.split('\n').filter(Boolean) } });
  });

  const queueRoute = (route: string, kind: JobKind, payloadFrom: (body: Record<string, unknown>) => Record<string, unknown>) =>
    api.post(`/jobs/${route}`, async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const job = await enqueue(sql, store.userId, kind, payloadFrom(body), 'web');
      return c.json({ job }, 202);
    });

  queueRoute('fetch', 'fetch', (b) => ({ days: Math.min(Math.max(num(b.days) ?? 30, 1), 400) }));
  queueRoute('fetch-year', 'fetch-year', (b) => ({ year: num(b.year) ?? pipeline.currentYear() }));
  queueRoute('generate', 'generate', (b) => ({ year: num(b.year) ?? pipeline.currentYear() }));
  queueRoute('remarkable', 'remarkable', (b) => ({ skipFetch: b.skipFetch ?? true, days: num(b.days) ?? 7 }));
  queueRoute('sync', 'sync', (b) => ({ days: num(b.days) ?? 7 }));
  queueRoute('backup', 'backup', () => ({}));

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Live log stream for one job: waits while queued, follows the in-memory runner while running,
  // and replays the persisted log once finished.
  api.get('/jobs/:id/stream', async (c) => {
    const id = c.req.param('id');
    if (!(await getJob(sql, id))) return c.json({ error: 'Not found' }, 404);
    return streamSSE(c, async (stream) => {
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });
      // wait for the worker to claim it (the in-memory record appears at that moment)
      while (!aborted && !jobs.get(id)) {
        const row = await getJob(sql, id);
        if (!row) return;
        if (row.status === 'succeeded' || row.status === 'failed') {
          for (const line of row.log.split('\n').filter(Boolean)) await stream.writeSSE({ event: 'line', data: line });
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ status: row.status, error: row.error }) });
          return;
        }
        await sleep(1000);
      }
      const job = jobs.get(id);
      if (!job || aborted) return;
      let idx = 0;
      const flush = async () => {
        while (idx < job.lines.length) {
          await stream.writeSSE({ event: 'line', data: job.lines[idx++] });
        }
      };
      await flush();
      if (job.status !== 'running') {
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ status: job.status, error: job.error }) });
        return;
      }
      await new Promise<void>((resolve) => {
        const onLine = (jobId: string) => {
          if (jobId === job.id) void flush();
        };
        const onDone = async (j: typeof job) => {
          if (j.id !== job.id) return;
          jobs.off('line', onLine);
          jobs.off('done', onDone);
          await flush();
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ status: j.status, error: j.error }) });
          resolve();
        };
        jobs.on('line', onLine);
        jobs.on('done', onDone);
        stream.onAbort(() => {
          jobs.off('line', onLine);
          jobs.off('done', onDone);
          resolve();
        });
      });
    });
  });
```

`JobBusyError` is still thrown by the CLI path, so the `api.onError` handler stays as is.

- [ ] **Step 4: Run the API tests to verify they pass**

Run: `cd app && npx vitest run test/api.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Start the worker from the server entry point**

Replace `app/src/server/index.ts` with:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { EventStore } from './db.js';
import { JobRunner } from './jobs.js';
import { startWorker } from './jobqueue.js';
import { createApp } from './app.js';
import { env } from './env.js';
import { paths, TIMEZONE } from './paths.js';

const PORT = Number(process.env.PORT ?? 3210);
const store = await EventStore.open();
const jobs = new JobRunner();
const app = createApp({ store, jobs });

// In production serve the built client from app/dist; in dev Vite serves it and proxies /api here.
if (fs.existsSync(paths.clientDist)) {
  const rel = path.relative(process.cwd(), paths.clientDist);
  app.use('/*', serveStatic({ root: rel }));
  app.get('*', serveStatic({ root: rel, path: 'index.html' }));
}

// The same process drains public.jobs (filled by pg_cron and by the UI).
const worker = env.workerIntervalMs > 0 ? startWorker({ sql: store.sql, store, jobs, intervalMs: env.workerIntervalMs }) : null;

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`reMarkableCalendar server on http://localhost:${info.port} (tz ${TIMEZONE}, user ${env.userEmail}, worker ${worker ? `every ${env.workerIntervalMs}ms` : 'off'})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    worker?.stop();
    void store.close().finally(() => process.exit(0));
  });
}
```

- [ ] **Step 6: Update the CLI**

Replace `app/src/cli.ts` with:

```ts
#!/usr/bin/env tsx
/**
 * Command-line entry point (the shell scripts under scripts/ wrap it).
 *
 *   npm run cli -- sync [--skip-fetch] [--days N]   daily flow: fetch, backup, merge annotations, upload
 *   npm run cli -- fetch [days]                     refresh Google events for the next N days (default 30)
 *   npm run cli -- fetch-year [year]                refresh Google events for a whole year
 *   npm run cli -- generate [year]                  render the year PDF from the database
 *   npm run cli -- upload                           backup + merge annotations + upload (no fetch)
 *   npm run cli -- backup [docName]                 download the device copy into backups/
 *   npm run cli -- stats                            database statistics
 *   npm run cli -- worker                           drain the Supabase job queue until stopped
 *   npm run cli -- add-source <name> <url> [color]  store an ICS feed (URL goes to Supabase Vault)
 *   npm run cli -- list-sources                     list feeds (URLs masked)
 *   npm run cli -- export-seed [sqlitePath]         write supabase/seed.private.sql from the old SQLite file
 */
import { EventStore } from './server/db.js';
import { JobRunner, appendSyncLog } from './server/jobs.js';
import { startWorker } from './server/jobqueue.js';
import { addCalendarSource, listCalendarSources } from './server/sources.js';
import * as pipeline from './server/pipeline.js';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const positional = rest.filter((a) => !a.startsWith('--'));
const flagValue = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function main() {
  if (cmd === 'export-seed') {
    const { exportSeed } = await import('./server/seed.js');
    console.log(`Wrote ${await exportSeed(positional[0])}`);
    return;
  }

  const store = await EventStore.open();
  const jobs = new JobRunner((line) => {
    appendSyncLog(line);
  });
  jobs.on('line', (_id: string, line: string) => console.log(line));

  const runJob = async (kind: Parameters<JobRunner['start']>[0], work: Parameters<JobRunner['start']>[1]) => {
    const job = jobs.start(kind, work);
    const done = await jobs.wait(job.id);
    await store.close();
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
      return runJob('fetch-year', (ctx) => pipeline.fetchEventsRange(ctx, store, `${year}-01-01`, `${year}-12-31`).then(() => undefined));
    }
    case 'generate':
      return runJob('generate', (ctx) => pipeline.generatePdf(ctx, store, Number(positional[0] ?? pipeline.currentYear())).then(() => undefined));
    case 'upload':
      return runJob('remarkable', (ctx) => pipeline.updateRemarkable(ctx, store, { skipFetch: true }));
    case 'backup':
      return runJob('backup', async (ctx) => {
        const file = await pipeline.backupFromRemarkable(ctx, positional[0] ?? pipeline.docNameForYear(pipeline.currentYear()));
        if (!file) throw new Error('Backup failed: document not downloaded');
      });
    case 'stats': {
      const s = await store.stats();
      console.log(`Total events: ${s.totalEvents}\nTotal dates: ${s.totalDates}\nDate range: ${s.minDate} to ${s.maxDate}`);
      await store.close();
      return;
    }
    case 'worker': {
      console.log('Worker started, polling public.jobs every 5s (Ctrl+C to stop)');
      const worker = startWorker({ sql: store.sql, store, jobs, intervalMs: 5000 });
      process.on('SIGINT', () => {
        worker.stop();
        void store.close().finally(() => process.exit(0));
      });
      return;
    }
    case 'add-source': {
      const [name, url, color] = positional;
      if (!name || !url) throw new Error('Usage: add-source <name> <url> [color]');
      const id = await addCalendarSource(store.sql, store.userId, { name, url, color });
      console.log(`Added source ${name} (${id})`);
      await store.close();
      return;
    }
    case 'list-sources': {
      for (const s of await listCalendarSources(store.sql, store.userId)) {
        console.log(`${s.id}  ${s.name}  ${s.color}  …/${s.source.split('/').pop()}`);
      }
      await store.close();
      return;
    }
    default:
      console.log('Usage: npm run cli -- <sync|fetch|fetch-year|generate|upload|backup|stats|worker|add-source|list-sources|export-seed> [options]');
      process.exit(cmd === 'help' ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

`./server/seed.js` is created in Task 9; until then `export-seed` fails at runtime only.

- [ ] **Step 7: Teach the client about queued jobs**

In `app/src/client/api.ts`:

```ts
export type JobKind = 'sync' | 'fetch' | 'fetch-year' | 'generate' | 'remarkable' | 'backup';
export interface Job {
  id: string; kind: JobKind; status: 'queued' | 'running' | 'succeeded' | 'failed';
  startedAt: string | null; finishedAt: string | null; error: string | null; lines?: string[]; lineCount?: number;
  createdAt?: string; requestedBy?: 'web' | 'cli' | 'cron';
}
```

and add `'fetch-year': 'Sync whole year'` to `JOB_LABELS`.

`useJobs.tsx` needs no logic change: `follow()` opens the SSE stream immediately and the server now waits while the job is queued. In `App.tsx` the busy banner reads `JOB_LABELS[running.kind]`; prefix it with the status so a queued cron job is visible: change the `<span className="font-medium shrink-0">` content to `{running.status === 'queued' ? 'Queued: ' : ''}{JOB_LABELS[running.kind]}`.

- [ ] **Step 8: Type-check, run everything, try the app**

```bash
cd app && npx tsc --noEmit && npx vitest run
```

Expected: no type errors; all test files pass (db, sources, pipeline, backups, jobqueue, api, ics).

Then `npm run dev`, open http://localhost:5173, click **Sync calendar**: the banner shows "Queued: Sync calendar" for up to 5 s, then streams the fetch log. (`No calendar sources configured` is expected until Task 9 seeds them.)

- [ ] **Step 9: Commit**

```bash
git add app/src/server/app.ts app/src/server/index.ts app/src/cli.ts app/src/client/api.ts app/src/client/App.tsx app/test/api.test.ts
git commit -m "feat(api): jobs go through the Postgres queue; server runs the worker; CLI source commands"
```

---

### Task 8: Supabase cron schedules

**Files:**
- Create: `supabase/migrations/20260907000100_cron.sql`

**Interfaces:**
- Consumes: `public.jobs` and `public.users` from Task 1; the worker from Task 6 drains what cron inserts.
- Produces: cron jobs `remarkable-daily-sync`, `remarkable-fetch-30d`, `remarkable-prune-jobs`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260907000100_cron.sql`:

```sql
-- Schedules live in Postgres; execution happens wherever the Node worker runs.
-- pg_cron uses UTC. 18:00 UTC = 06:00 NZST / 07:00 NZDT.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;

-- Daily: fetch the next 7 days, back up the device copy, merge annotations, upload.
select cron.schedule(
  'remarkable-daily-sync',
  '0 18 * * *',
  $$
  insert into public.jobs (user_id, kind, payload, requested_by)
  select u.id, 'sync', '{"days": 7}'::jsonb, 'cron'
  from public.users u
  where not exists (
    select 1 from public.jobs j where j.user_id = u.id and j.kind = 'sync' and j.status in ('queued', 'running')
  )
  $$
);

-- Every 6 hours: refresh the next 30 days so the web app stays current between syncs.
select cron.schedule(
  'remarkable-fetch-30d',
  '0 */6 * * *',
  $$
  insert into public.jobs (user_id, kind, payload, requested_by)
  select u.id, 'fetch', '{"days": 30}'::jsonb, 'cron'
  from public.users u
  where not exists (
    select 1 from public.jobs j where j.user_id = u.id and j.kind = 'fetch' and j.status in ('queued', 'running')
  )
  $$
);

-- Weekly housekeeping: drop finished job rows (and their logs) older than 30 days.
select cron.schedule(
  'remarkable-prune-jobs',
  '30 3 * * 0',
  $$ delete from public.jobs where finished_at < now() - interval '30 days' $$
);
```

- [ ] **Step 2: Apply locally and verify the schedules exist**

```bash
supabase db reset
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "select jobname, schedule from cron.job order by jobname;"
```

Expected: three rows: `remarkable-daily-sync 0 18 * * *`, `remarkable-fetch-30d 0 */6 * * *`, `remarkable-prune-jobs 30 3 * * 0`.

- [ ] **Step 3: Verify the cron SQL enqueues exactly one job**

Run the daily command by hand twice and check the dedupe:

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  -c "select cron.schedule('tmp-now', '* * * * *', (select command from cron.job where jobname = 'remarkable-daily-sync'));" \
  -c "select pg_sleep(65);" \
  -c "select kind, status, requested_by, payload from public.jobs;" \
  -c "select cron.unschedule('tmp-now');" \
  -c "delete from public.jobs;"
```

Expected: one row `sync | queued | cron | {"days": 7}` (only one even if two minutes elapsed, thanks to the `not exists` guard).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260907000100_cron.sql
git commit -m "feat(cron): pg_cron schedules that enqueue sync, fetch and housekeeping jobs"
```

---

### Task 9: Seed the current calendar, deploy to hosted Supabase, keep the server alive, document

**Files:**
- Create: `app/src/server/seed.ts`
- Create: `app/test/seed.test.ts`
- Create: `scripts/launchd/com.remarkablecalendar.server.plist`
- Create: `app/.env` (gitignored), `app/.env.example`
- Modify: `README.md`
- Modify: `app/package.json` (move `better-sqlite3` + `@types/better-sqlite3` to `devDependencies` is **not** done: `export-seed` needs it at runtime; leave as is)

**Interfaces:**
- Consumes: `paths.root`, `paths.config`, `env.userEmail`.
- Produces: `exportSeed(sqlitePath?: string, outPath?: string): Promise<string>`; file `supabase/seed.private.sql` that inserts the user, the `config.yaml` sources (URLs through `vault.create_secret`) and every row of the SQLite `events` table including manual and soft-deleted ones.

- [ ] **Step 1: Write the failing test**

Create `app/test/seed.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { EventStore } from '../src/server/db.js';
import { exportSeed } from '../src/server/seed.js';
import { listCalendarSources } from '../src/server/sources.js';
import { testStore } from './helpers.js';

describe('exportSeed', () => {
  let store: EventStore;
  let dir: string;
  beforeEach(async () => {
    store = await testStore();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-seed-'));
  });
  afterEach(async () => {
    await store.close();
  });

  it('turns the SQLite file and config.yaml into SQL that reproduces the data (quotes included)', async () => {
    const sqlite = path.join(dir, 'calendar.db');
    const db = new Database(sqlite);
    db.exec(`
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, summary TEXT, description TEXT, location TEXT,
        dtstart TEXT NOT NULL, dtend TEXT NOT NULL, color TEXT, calendar TEXT, all_day INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        source TEXT NOT NULL DEFAULT 'google', deleted_at TEXT);
      INSERT INTO events (date, summary, description, dtstart, dtend, color, calendar, all_day, source, deleted_at, created_at)
        VALUES ('2026-03-10', 'Bob''s standup', 'line1' || char(10) || 'line2', '2026-03-10T09:00:00+13:00', '2026-03-10T09:30:00+13:00', 'gray4', 'TC', 0, 'google', NULL, '2026-01-02 03:04:05'),
               ('2026-03-11', 'Gone', '', '2026-03-11T00:00:00+13:00', '2026-03-12T00:00:00+13:00', 'black', 'Manual', 1, 'manual', '2026-03-01 10:00:00', '2026-01-02 03:04:05');
    `);
    db.close();
    const config = path.join(dir, 'config.yaml');
    fs.writeFileSync(config, "calendars:\n  - name: TC\n    source: https://example.com/private-x/basic.ics\n    color: gray4\n");
    const out = path.join(dir, 'seed.private.sql');

    expect(await exportSeed(sqlite, out, config)).toBe(out);
    await store.sql.file(out);

    const sources = await listCalendarSources(store.sql, store.userId);
    expect(sources).toMatchObject([{ name: 'TC', color: 'gray4', source: 'https://example.com/private-x/basic.ics' }]);
    const all = await store.listRange('2026-03-01', '2026-03-31', { includeDeleted: true });
    expect(all.map((e) => e.summary)).toEqual(["Bob's standup", 'Gone']);
    expect(all[0]).toMatchObject({ description: 'line1\nline2', source: 'google', deletedAt: null, createdAt: '2026-01-02T03:04:05.000Z' });
    expect(all[1]).toMatchObject({ source: 'manual', allDay: true, deletedAt: '2026-03-01T10:00:00.000Z' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run test/seed.test.ts`
Expected: FAIL — cannot find module `../src/server/seed.js`.

- [ ] **Step 3: Implement `seed.ts`**

Create `app/src/server/seed.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { env } from './env.js';
import { paths } from './paths.js';

interface SqliteRow {
  date: string; summary: string | null; description: string | null; location: string | null; dtstart: string; dtend: string;
  color: string | null; calendar: string | null; all_day: number | null; source: string | null; deleted_at: string | null; created_at: string | null;
}

/** SQL string literal; null stays null. Standard '' escaping, backslashes are literal in Postgres. */
const q = (v: string | null | undefined) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
/** SQLite's datetime('now') / CURRENT_TIMESTAMP are UTC without a zone marker. */
const ts = (v: string | null | undefined) => (v == null ? 'null' : `${q(v.includes('+') || v.endsWith('Z') ? v : v + '+00')}::timestamptz`);

/**
 * Write supabase/seed.private.sql from the legacy SQLite database and config.yaml.
 * The file is gitignored: it contains private feed URLs and calendar contents.
 */
export async function exportSeed(
  sqlitePath: string = path.join(paths.root, 'output', 'calendar.db'),
  outPath: string = path.join(paths.root, 'supabase', 'seed.private.sql'),
  configPath: string = paths.config,
): Promise<string> {
  const { default: Database } = await import('better-sqlite3');
  const user = q(env.userEmail);
  const lines: string[] = [
    `-- Generated by "npm run cli -- export-seed" on ${new Date().toISOString()}. Private data: never commit.`,
    `insert into public.users (email) values (${user}) on conflict (email) do nothing;`,
  ];

  if (fs.existsSync(configPath)) {
    const parsed = YAML.parse(fs.readFileSync(configPath, 'utf8')) as { calendars?: { name?: string; source?: string; color?: string }[] } | null;
    for (const c of parsed?.calendars ?? []) {
      if (!c.source) continue;
      lines.push(
        `insert into public.calendar_sources (user_id, name, color, url_secret_id) ` +
          `select id, ${q(c.name ?? 'Unknown')}, ${q(c.color ?? 'black')}, vault.create_secret(${q(c.source)}, ${q('ics:' + randomUUID())}, ${q('ICS feed ' + (c.name ?? 'Unknown'))}) ` +
          `from public.users where email = ${user};`,
      );
    }
  }

  if (fs.existsSync(sqlitePath)) {
    const db = new Database(sqlitePath, { readonly: true });
    const rows = db
      .prepare(`select date, summary, description, location, dtstart, dtend, color, calendar, all_day, source, deleted_at, created_at from events order by id`)
      .all() as SqliteRow[];
    db.close();
    for (const r of rows) {
      lines.push(
        `insert into public.events (user_id, date, summary, description, location, dtstart, dtend, color, calendar, all_day, source, deleted_at, created_at) ` +
          `select id, ${q(r.date)}::date, ${q(r.summary ?? '')}, ${q(r.description ?? '')}, ${q(r.location ?? '')}, ${q(r.dtstart)}, ${q(r.dtend)}, ` +
          `${q(r.color ?? 'black')}, ${q(r.calendar ?? 'Unknown')}, ${r.all_day ? 'true' : 'false'}, ${q(r.source === 'manual' ? 'manual' : 'google')}, ` +
          `${ts(r.deleted_at)}, coalesce(${ts(r.created_at)}, now()) ` +
          `from public.users where email = ${user} on conflict (user_id, date, summary, dtstart) do nothing;`,
      );
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  return outPath;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run test/seed.test.ts`
Expected: PASS.

- [ ] **Step 5: Generate the real seed and load it locally**

```bash
cd app && npm run cli -- export-seed && cd ..
grep -c "insert into public.events" supabase/seed.private.sql
supabase db reset
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "select count(*) filter (where deleted_at is null) as active, count(*) as total from public.events;" -c "select name, color from public.calendar_sources;"
cd app && npm run cli -- stats
```

Expected: the event count matches `sqlite3 output/calendar.db 'select count(*) from events'`; the `TC` source is listed; `stats` prints the same totals the old SQLite CLI did. `git status` must **not** show `supabase/seed.private.sql`.

- [ ] **Step 6: Create the hosted project and push**

1. In the Supabase dashboard create a project (region closest to New Zealand: Sydney). Save the database password.
2. Link and push:

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push
psql "<Session pooler URI from Dashboard → Connect>" -f supabase/seed.private.sql
psql "<Session pooler URI>" -c "select jobname from cron.job;" -c "select count(*) from public.events;" -c "select name from public.calendar_sources;"
```

Expected: three cron jobs, the same event count as locally, the `TC` source. If `db push` fails on `create extension pg_cron`, enable **Cron** under Dashboard → Integrations and re-run `supabase db push`.

- [ ] **Step 7: Point the app at the hosted database**

Create `app/.env.example` (tracked):

```dotenv
# Supabase → Connect → Session pooler (IPv4-friendly, fine for a long-lived server)
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
APP_USER_EMAIL=felipe@pavanela.com
# 0 disables the in-process worker (e.g. when running `npm run cli -- worker` separately)
APP_WORKER_INTERVAL_MS=5000
```

Copy it to `app/.env` with the real values, then:

```bash
cd app && npm run build && npm start
curl -s localhost:3210/api/status | head -c 400
```

Expected: JSON with `stats.totalEvents` matching the hosted count and the `TC` calendar. Click **Sync calendar** in the UI and confirm the job appears in the Activity page and in `select kind, status from public.jobs` on the hosted DB.

- [ ] **Step 8: Keep the server running with launchd**

Create `scripts/launchd/com.remarkablecalendar.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.remarkablecalendar.server</string>
  <key>WorkingDirectory</key><string>/Users/felipepavanela/Documents/Development/Ephemeris/app</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; npm start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/felipepavanela/Documents/Development/Ephemeris/logs/server.log</string>
  <key>StandardErrorPath</key><string>/Users/felipepavanela/Documents/Development/Ephemeris/logs/server.log</string>
</dict>
</plist>
```

Install it:

```bash
cp scripts/launchd/com.remarkablecalendar.server.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.remarkablecalendar.server.plist
launchctl print gui/$(id -u)/com.remarkablecalendar.server | grep state
curl -s localhost:3210/api/status >/dev/null && echo OK
```

Expected: `state = running`, `OK`. The Mac must be awake at 06:00 for the daily job; either keep it from sleeping or add a wake schedule with `sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00`. If the Mac is asleep the job simply waits in the queue and runs on wake. Then delete the "reMarkableCalendar Daily Sync" automation in Shortcuts so it does not double-run.

- [ ] **Step 9: Update the README**

In `README.md`:

- Under **Installation**, replace step 4 ("Configure calendars… `config/config.yaml`") with a **Database** section: `supabase start` + `supabase db reset` for local, `app/.env` from `app/.env.example` for hosted, and `npm run cli -- add-source <name> <url> [color]` to add feeds (URLs are stored encrypted in Supabase Vault; `config/config.yaml` is only read by `export-seed`).
- Under **Web app**, change the "Sync calendar fetches … into `output/calendar.db`" sentence to "into the Supabase database", and add: "Jobs are queued in Postgres and run by the server's worker; the daily 06:00 NZ sync and a 6-hourly fetch are scheduled by Supabase cron (`supabase/migrations/20260907000100_cron.sql`). `.rmdoc` device backups are kept for 7 days."
- Under **Command line**, add the `worker`, `add-source`, `list-sources`, `export-seed` lines from the `cli.ts` header comment.
- Replace the whole **Automation** section (Shortcuts + Calendar alarm) with the launchd instructions from Step 8 and a note that the schedule lives in Supabase.
- Remove the `calendar_db_sqlite.py stats` / `export` / "Database backups are automatically created in backups/db/" lines (around line 280) and any `show_events.py` mention.
- Add a short **Why the Python still runs locally** paragraph quoting the "Can Supabase run the Python scripts?" answer from this plan.

- [ ] **Step 10: Final verification and commit**

```bash
cd app && npx tsc --noEmit && npx vitest run && cd ..
git status --short   # must not list app/.env or supabase/seed.private.sql
git add app/src/server/seed.ts app/test/seed.test.ts app/.env.example scripts/launchd/com.remarkablecalendar.server.plist README.md
git commit -m "feat(seed): export current calendar to Supabase seed; launchd service; docs"
```

Expected: type-check clean, all tests green, private files untracked.

---

## Rollback

`output/calendar.db` and `config/config.yaml` are never modified by this plan. Checking out the commit before Task 1 and running `npm start` restores the SQLite setup. Once you are happy with the hosted database, delete `backups/db/` (the old SQLite copies) by hand; nothing writes there anymore.

## Follow-ups (not in this plan)

- Run the worker off the Mac (GitHub Actions cron with the existing `Dockerfile` + Node) — the queue design already supports it; only `launchd` and the poll target change.
- Move the ICS fetch into an Edge Function invoked by `pg_cron` + `pg_net` so events refresh while the Mac sleeps.
- Store the reMarkable device token in Vault and materialise `rmapi.conf` at run time, which is a prerequisite for the first follow-up.
