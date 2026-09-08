import type { Sql } from 'postgres';
import type { EventStore } from './db.js';
import { JobRunner, JobBusyError, type JobContext, type JobKind } from './jobs.js';
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
  id: string; kind: JobKind; status: QueuedStatus; payload: Record<string, unknown> | string; requested_by: RequestedBy;
  error: string | null; log: string; created_at: Date; started_at: Date | null; finished_at: Date | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function rowToJob(r: JobRow): QueuedJob {
  // sql.unsafe() returns jsonb columns as raw text rather than parsing them (unlike the tagged-template form).
  const payload = typeof r.payload === 'string' ? (JSON.parse(r.payload) as Record<string, unknown>) : (r.payload ?? {});
  return {
    id: r.id, kind: r.kind, status: r.status, payload, requestedBy: r.requested_by, error: r.error,
    log: r.log, createdAt: r.created_at.toISOString(), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
  };
}

const COLS = 'id, kind, status, payload, requested_by, error, log, created_at, started_at, finished_at';

/** Record a job that starts running immediately (used by the CLI, which runs outside the queue). */
export async function startJobRecord(sql: Sql, userId: string, kind: JobKind, payload: Record<string, unknown> = {}, requestedBy: RequestedBy = 'cli'): Promise<QueuedJob> {
  const [row] = await sql.unsafe<JobRow[]>(
    `insert into public.jobs (user_id, kind, payload, requested_by, status, started_at) values ($1, $2, $3, $4, 'running', now()) returning ${COLS}`,
    [userId, kind, JSON.stringify(payload), requestedBy],
  );
  return rowToJob(row);
}

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
      if (err instanceof JobBusyError) {
        // Another process (e.g. a manual CLI sync) holds the lock file, not this worker's own
        // JobRunner (jobs.running is checked above). Release the row back to 'queued' so the
        // next tick retries it, instead of permanently failing a job that never actually ran.
        await sql`update public.jobs set status = 'queued', started_at = null where id = ${row.id}`;
      } else {
        await finishJob(sql, row.id, 'failed', err instanceof Error ? err.message : String(err));
      }
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
