import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { DateTime } from 'luxon';
import { EventStore, type ManualEventInput } from './db.js';
import { JobBusyError, JobRunner, type JobKind } from './jobs.js';
import { loadCalendarSources } from './config.js';
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

  api.get('/status', (c) =>
    c.json({
      timezone: TIMEZONE,
      today: DateTime.now().setZone(TIMEZONE).toISODate(),
      stats: store.stats(),
      calendars: loadCalendarSources().map((s) => ({ name: s.name, color: s.color })),
      running: jobs.running,
      backups: pipeline.listBackups(pipeline.currentYear()),
    }),
  );

  // ---- events ----
  api.get('/events', (c) => {
    const start = c.req.query('start');
    const end = c.req.query('end');
    if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) return c.json({ error: 'start and end (YYYY-MM-DD) are required' }, 400);
    const includeDeleted = c.req.query('includeDeleted') === 'true';
    return c.json({ events: store.listRange(start, end, { includeDeleted }) });
  });

  api.post('/events', async (c) => {
    let input: ManualEventInput;
    try {
      input = manualEventFromBody((await c.req.json()) as ManualEventBody);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const id = store.addManual(input);
    return c.json({ event: store.get(id) }, 201);
  });

  api.delete('/events/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!store.get(id)) return c.json({ error: 'Not found' }, 404);
    store.softDelete(id);
    return c.json({ event: store.get(id) });
  });

  api.post('/events/:id/restore', (c) => {
    const id = Number(c.req.param('id'));
    if (!store.get(id)) return c.json({ error: 'Not found' }, 404);
    store.restore(id);
    return c.json({ event: store.get(id) });
  });

  // ---- jobs ----
  const startJob = (kind: JobKind, work: Parameters<JobRunner['start']>[1]) => jobs.start(kind, work);

  api.get('/jobs', (c) => c.json({ jobs: jobs.list().map(({ lines, ...j }) => ({ ...j, lineCount: lines.length })) }));
  api.get('/jobs/:id', (c) => {
    const job = jobs.get(c.req.param('id'));
    return job ? c.json({ job }) : c.json({ error: 'Not found' }, 404);
  });

  api.post('/jobs/fetch', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { days?: number };
    const days = Math.min(Math.max(Number(body.days ?? 30), 1), 400);
    const job = startJob('fetch', (ctx) => pipeline.fetchEvents(ctx, store, days).then(() => undefined));
    return c.json({ job }, 202);
  });
  api.post('/jobs/fetch-year', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { year?: number };
    const year = Number(body.year ?? pipeline.currentYear());
    const job = startJob('fetch', (ctx) => pipeline.fetchEventsRange(ctx, store, `${year}-01-01`, `${year}-12-31`).then(() => undefined));
    return c.json({ job }, 202);
  });
  api.post('/jobs/generate', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { year?: number };
    const job = startJob('generate', (ctx) => pipeline.generatePdf(ctx, Number(body.year ?? pipeline.currentYear())).then(() => undefined));
    return c.json({ job }, 202);
  });
  api.post('/jobs/remarkable', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { skipFetch?: boolean; days?: number };
    const job = startJob('remarkable', (ctx) => pipeline.updateRemarkable(ctx, store, { skipFetch: body.skipFetch ?? true, days: body.days }));
    return c.json({ job }, 202);
  });
  api.post('/jobs/sync', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { days?: number };
    const job = startJob('sync', (ctx) => pipeline.updateRemarkable(ctx, store, { skipFetch: false, days: body.days ?? 7 }));
    return c.json({ job }, 202);
  });
  api.post('/jobs/backup', (c) => {
    const job = startJob('backup', async (ctx) => {
      const file = await pipeline.backupFromRemarkable(ctx, pipeline.docNameForYear(pipeline.currentYear()));
      if (!file) throw new Error('Backup failed: document not downloaded');
    });
    return c.json({ job }, 202);
  });

  // Live log stream for one job. Sends the backlog first, then new lines, then a "done" event.
  api.get('/jobs/:id/stream', (c) => {
    const job = jobs.get(c.req.param('id'));
    if (!job) return c.json({ error: 'Not found' }, 404);
    return streamSSE(c, async (stream) => {
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
        const onLine = (id: string) => {
          if (id === job.id) void flush();
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
