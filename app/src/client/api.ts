export interface CalendarEvent {
  id: number; date: string; summary: string; description: string; location: string;
  dtstart: string; dtend: string; color: string; calendar: string; allDay: boolean;
  source: 'google' | 'manual'; deletedAt: string | null; createdAt: string;
}
export type JobKind = 'sync' | 'fetch' | 'generate' | 'remarkable' | 'backup';
export interface Job {
  id: string; kind: JobKind; status: 'running' | 'succeeded' | 'failed';
  startedAt: string; finishedAt: string | null; error: string | null; lines?: string[]; lineCount?: number;
}
export interface Status {
  timezone: string; today: string;
  stats: { totalEvents: number; totalDates: number; minDate: string | null; maxDate: string | null };
  calendars: { name: string; color: string }[];
  running: Job | null;
  backups: { name: string; size: number; modifiedAt: string }[];
}
export interface ManualEventPayload {
  summary: string; date: string; allDay: boolean; startTime?: string; endTime?: string; endDate?: string;
  description?: string; location?: string;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export const api = {
  status: () => req<Status>('/api/status'),
  events: (start: string, end: string, includeDeleted = false) =>
    req<{ events: CalendarEvent[] }>(`/api/events?start=${start}&end=${end}&includeDeleted=${includeDeleted}`).then((r) => r.events),
  addEvent: (payload: ManualEventPayload) => req<{ event: CalendarEvent }>('/api/events', { method: 'POST', body: JSON.stringify(payload) }).then((r) => r.event),
  deleteEvent: (id: number) => req<{ event: CalendarEvent }>(`/api/events/${id}`, { method: 'DELETE' }).then((r) => r.event),
  restoreEvent: (id: number) => req<{ event: CalendarEvent }>(`/api/events/${id}/restore`, { method: 'POST' }).then((r) => r.event),
  jobs: () => req<{ jobs: Job[] }>('/api/jobs').then((r) => r.jobs),
  job: (id: string) => req<{ job: Job }>(`/api/jobs/${id}`).then((r) => r.job),
  startJob: (route: 'fetch' | 'fetch-year' | 'generate' | 'remarkable' | 'sync' | 'backup', body: Record<string, unknown> = {}) =>
    req<{ job: Job }>(`/api/jobs/${route}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.job),
};

/** reMarkable palette names (gray0..gray15, black, white) to CSS colors; anything else passes through. */
export function paletteColor(name: string): string {
  const n = name.trim().toLowerCase();
  if (n === 'black') return '#161616';
  if (n === 'white') return '#ffffff';
  const m = /^gray(\d{1,2})$/.exec(n);
  if (m) {
    const level = Math.min(15, Number(m[1]));
    const v = Math.round(22 + (level / 15) * 200);
    return `rgb(${v},${v},${v})`;
  }
  return n;
}

export function formatTime(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : '';
}

export const JOB_LABELS: Record<JobKind, string> = {
  sync: 'Sync calendar and update reMarkable',
  fetch: 'Sync calendar',
  generate: 'Generate PDF',
  remarkable: 'Update reMarkable',
  backup: 'Back up from reMarkable',
};

/** Google feeds often carry HTML in descriptions; show them as plain text. */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
