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
