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
