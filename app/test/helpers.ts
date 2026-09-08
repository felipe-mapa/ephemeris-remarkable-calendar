import { connect, resolveUserId, EventStore } from '../src/server/db.js';

// Deliberately NOT process.env.DATABASE_URL: that variable also drives the real app
// (and app/.env may point it at a hosted project). testStore() truncates all data, so it
// must never be able to inherit a production connection string through that shared name.
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const TEST_USER_EMAIL = 'felipe@pavanela.com';

function assertLocalTestDb(url: string) {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`testStore(): TEST_DATABASE_URL is not a valid connection URL: ${url}`);
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(
      `Refusing to run tests against non-local host "${host}". testStore() truncates events/jobs/calendar_sources ` +
        `and deletes vault.secrets, so it only ever targets 127.0.0.1/localhost. If you really need a different ` +
        `test database, it must still resolve to a local host.`,
    );
  }
}

/** Fresh store against the local Supabase stack (`supabase start`). Wipes all user data first. */
export async function testStore(): Promise<EventStore> {
  assertLocalTestDb(TEST_DB_URL);
  const sql = connect(TEST_DB_URL);
  await sql`truncate public.events, public.jobs, public.calendar_sources restart identity`;
  await sql`delete from vault.secrets`;
  const userId = await resolveUserId(sql, TEST_USER_EMAIL);
  return new EventStore(sql, userId);
}
