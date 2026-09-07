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
