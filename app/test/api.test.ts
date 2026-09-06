import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { EventStore } from '../src/server/db.js';
import { JobRunner } from '../src/server/jobs.js';
import { createApp, manualEventFromBody } from '../src/server/app.js';

function makeApp() {
  const store = new EventStore(new Database(':memory:'));
  const jobs = new JobRunner(() => {});
  return { app: createApp({ store, jobs }), store, jobs };
}

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

describe('events API', () => {
  it('creates, lists, soft deletes and restores an event', async () => {
    const { app } = makeApp();
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

    const del = await app.request(`/api/events/${event.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const active = (await (await app.request('/api/events?start=2026-03-01&end=2026-03-31')).json()) as { events: unknown[] };
    expect(active.events).toHaveLength(0);
    const all = (await (await app.request('/api/events?start=2026-03-01&end=2026-03-31&includeDeleted=true')).json()) as { events: { deletedAt: string | null }[] };
    expect(all.events[0].deletedAt).not.toBeNull();

    const restore = await app.request(`/api/events/${event.id}/restore`, { method: 'POST' });
    expect(((await restore.json()) as { event: { deletedAt: null } }).event.deletedAt).toBeNull();
  });

  it('returns 400 for invalid payloads and 404 for unknown ids', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
    expect((await app.request('/api/events/999', { method: 'DELETE' })).status).toBe(404);
    expect((await app.request('/api/events?start=x&end=y')).status).toBe(400);
  });

  it('refuses a second job while one is running', async () => {
    const { app, jobs } = makeApp();
    let release!: () => void;
    jobs.start('fetch', () => new Promise<void>((r) => (release = r)));
    const res = await app.request('/api/jobs/generate', { method: 'POST', body: '{}' });
    expect(res.status).toBe(409);
    release();
  });
});
