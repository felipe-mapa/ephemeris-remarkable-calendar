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
