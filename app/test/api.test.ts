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
