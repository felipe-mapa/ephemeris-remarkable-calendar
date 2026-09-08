import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { DateTime } from 'luxon';
import { EventStore, type ManualEventInput } from './db.js';
import { JobBusyError, JobRunner, type JobKind } from './jobs.js';
import { listCalendarSources } from './sources.js';
import { activeJob, enqueue, getJob, listJobs } from './jobqueue.js';
import * as pipeline from './pipeline.js';
import { TIMEZONE } from './paths.js';

export interface AppDeps {
  store: EventStore;
  jobs: JobRunner;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

interface ManualEventBody {
  summary?: string;
  date?: string;
  allDay?: boolean;
  startTime?: string; // HH:mm
  endTime?: string; // HH:mm
  endDate?: string; // for multi-day all-day events
  description?: string;
  location?: string;
}

/** Turn the form payload into the same storage format the ICS fetcher uses. */
export function manualEventFromBody(body: ManualEventBody, zone: string = TIMEZONE): ManualEventInput {
  const summary = (body.summary ?? '').trim();
  if (!summary) throw new Error('Title is required');
  if (!body.date || !DATE_RE.test(body.date)) throw new Error('A valid date (YYYY-MM-DD) is required');
  const parsed = DateTime.fromISO(body.date, { zone });
  if (!parsed.isValid) throw new Error('Invalid date');
  const day: DateTime = parsed;
  const iso = (d: DateTime) => d.toISO({ suppressMilliseconds: true }) as string;

  if (body.allDay) {
    let end: DateTime = day.plus({ days: 1 });
    if (body.endDate) {
      if (!DATE_RE.test(body.endDate)) throw new Error('Invalid end date');
      const e: DateTime = DateTime.fromISO(body.endDate, { zone });
      if (e < day) throw new Error('End date must not be before start date');
      end = e.plus({ days: 1 });
    }
    return {
      date: body.date, summary, allDay: true,
      dtstart: iso(day.startOf('day')), dtend: iso(end.startOf('day')),
      description: body.description ?? '', location: body.location ?? '',
    };
  }

  if (!body.startTime || !TIME_RE.test(body.startTime)) throw new Error('Start time (HH:mm) is required');
  const [sh, sm] = body.startTime.split(':').map(Number);
  const start = day.set({ hour: sh, minute: sm });
  let end = start.plus({ hours: 1 });
  if (body.endTime) {
    if (!TIME_RE.test(body.endTime)) throw new Error('Invalid end time');
    const [eh, em] = body.endTime.split(':').map(Number);
    end = day.set({ hour: eh, minute: em });
    if (end <= start) throw new Error('End time must be after start time');
  }
  return {
    date: body.date, summary, allDay: false,
    dtstart: iso(start), dtend: iso(end),
    description: body.description ?? '', location: body.location ?? '',
  };
}

export function createApp({ store, jobs }: AppDeps) {
  const app = new Hono();
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof JobBusyError) return c.json({ error: err.message, job: err.job }, 409);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

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

  // ---- events ----
  api.get('/events', async (c) => {
    const start = c.req.query('start');
    const end = c.req.query('end');
    if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) return c.json({ error: 'start and end (YYYY-MM-DD) are required' }, 400);
    const includeDeleted = c.req.query('includeDeleted') === 'true';
    return c.json({ events: await store.listRange(start, end, { includeDeleted }) });
  });

  api.post('/events', async (c) => {
    let input: ManualEventInput;
    try {
      input = manualEventFromBody((await c.req.json()) as ManualEventBody);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const id = await store.addManual(input);
    return c.json({ event: await store.get(id) }, 201);
  });

  api.delete('/events/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!(await store.get(id))) return c.json({ error: 'Not found' }, 404);
    await store.softDelete(id);
    return c.json({ event: await store.get(id) });
  });

  api.post('/events/:id/restore', async (c) => {
    const id = Number(c.req.param('id'));
    if (!(await store.get(id))) return c.json({ error: 'Not found' }, 404);
    await store.restore(id);
    return c.json({ event: await store.get(id) });
  });

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

  app.route('/api', api);
  return app;
}
