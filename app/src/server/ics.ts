import fs from 'node:fs/promises';
import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import type { NewEvent } from './db.js';
import { TIMEZONE } from './paths.js';
import type { CalendarSource } from './config.js';

export interface FetchOptions {
  timezone?: string;
  log?: (line: string) => void;
}

/** Fetch raw ICS text from an http(s) URL or a local file path. */
export async function readIcs(source: string): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${source.slice(0, 60)}`);
    return res.text();
  }
  return fs.readFile(source, 'utf8');
}

function isFloating(t: ICAL.Time): boolean {
  const z = t.zone as ICAL.Timezone | undefined;
  return !z || z === ICAL.Timezone.localTimezone || z.tzid === 'floating';
}

/** Convert an ICAL.Time to a luxon DateTime in the target zone. */
export function icalTimeToDateTime(t: ICAL.Time, zone: string): DateTime {
  if (t.isDate || isFloating(t)) {
    return DateTime.fromObject(
      { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second },
      { zone },
    );
  }
  return DateTime.fromSeconds(t.toUnixTime(), { zone });
}

const iso = (d: DateTime) => d.toISO({ suppressMilliseconds: true }) as string;

/**
 * Expand every VEVENT in an ICS document into per-occurrence rows for [start, end] (inclusive, YYYY-MM-DD).
 * Mirrors remarkable_calendar/event_fetcher.py: one row per occurrence, keyed by the local date of its start.
 */
export function expandIcs(
  icsText: string,
  start: string,
  end: string,
  source: Pick<CalendarSource, 'name' | 'color'>,
  zone: string = TIMEZONE,
): NewEvent[] {
  const root = new ICAL.Component(ICAL.parse(icsText));
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    const tzid = vtz.getFirstPropertyValue('tzid') as string | null;
    if (tzid && !ICAL.TimezoneService.has(tzid)) {
      ICAL.TimezoneService.register(new ICAL.Timezone({ component: vtz, tzid }));
    }
  }

  const rangeStart = DateTime.fromISO(start, { zone }).startOf('day');
  const rangeEnd = DateTime.fromISO(end, { zone }).endOf('day');

  const masters: ICAL.Event[] = [];
  const exceptions: ICAL.Event[] = [];
  for (const comp of root.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(comp);
    (ev.isRecurrenceException() ? exceptions : masters).push(ev);
  }
  const byUid = new Map(masters.map((m) => [m.uid, m]));
  const orphans: ICAL.Event[] = [];
  for (const ex of exceptions) {
    const master = byUid.get(ex.uid);
    if (master) master.relateException(ex);
    else orphans.push(ex);
  }

  const out: NewEvent[] = [];
  const push = (item: ICAL.Event, s: ICAL.Time, e: ICAL.Time) => {
    const allDay = s.isDate;
    const startDt = icalTimeToDateTime(s, zone);
    let endDt = icalTimeToDateTime(e, zone);
    if (endDt <= startDt) endDt = startDt.plus(allDay ? { days: 1 } : { hours: 1 });
    if (startDt > rangeEnd || startDt < rangeStart) return;
    out.push({
      date: startDt.toISODate() as string,
      summary: item.summary ?? '',
      description: item.description ?? '',
      location: item.location ?? '',
      dtstart: iso(startDt),
      dtend: iso(endDt),
      color: source.color,
      calendar: source.name,
      allDay,
      source: 'google',
    });
  };

  for (const ev of masters) {
    if (!ev.startDate) continue;
    if (!ev.isRecurring()) {
      push(ev, ev.startDate, ev.endDate);
      continue;
    }
    // Always seed the iterator from the event's own DTSTART: passing a seed Time built in
    // another zone (e.g. a UTC "start of range" cursor) makes ical.js's recurrence expansion
    // lock onto that zone for every occurrence, which silently corrupts the time of day
    // (occurrences would land at the range's UTC hour, e.g. midnight local, instead of the
    // event's actual time). Occurrences before the range are cheap to skip in push().
    const it = ev.iterator();
    let next: ICAL.Time | null;
    let guard = 0;
    while ((next = it.next()) && guard++ < 20_000) {
      if (icalTimeToDateTime(next, zone) > rangeEnd) break;
      const d = ev.getOccurrenceDetails(next);
      push(d.item, d.startDate, d.endDate);
    }
  }
  for (const ex of orphans) push(ex, ex.startDate, ex.endDate);

  out.sort((a, b) => a.dtstart.localeCompare(b.dtstart));
  return out;
}

/** Fetch and expand every configured calendar. Errors on one feed are logged and skipped (like the Python fetcher). */
export async function fetchAllSources(
  sources: CalendarSource[],
  start: string,
  end: string,
  opts: FetchOptions = {},
): Promise<{ events: NewEvent[]; failures: string[] }> {
  const zone = opts.timezone ?? TIMEZONE;
  const log = opts.log ?? (() => {});
  const events: NewEvent[] = [];
  const failures: string[] = [];
  for (const src of sources) {
    log(`Fetching ${src.name} from ${src.source.slice(0, 50)}...`);
    try {
      const text = await readIcs(src.source);
      const found = expandIcs(text, start, end, src, zone);
      log(`  Found ${found.length} events`);
      events.push(...found);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  Error fetching ${src.name}: ${msg}`);
      failures.push(src.name);
    }
  }
  log(`Fetched ${events.length} events total`);
  return { events, failures };
}
