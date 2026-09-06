import { describe, it, expect } from 'vitest';
import { expandIcs } from '../src/server/ics.js';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VTIMEZONE
TZID:Pacific/Auckland
BEGIN:STANDARD
TZOFFSETFROM:+1300
TZOFFSETTO:+1200
TZNAME:NZST
DTSTART:19700405T030000
RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU
END:STANDARD
BEGIN:DAYLIGHT
TZOFFSETFROM:+1200
TZOFFSETTO:+1300
TZNAME:NZDT
DTSTART:19700927T020000
RRULE:FREQ=YEARLY;BYMONTH=9;BYDAY=-1SU
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly@test
DTSTART;TZID=Pacific/Auckland:20260302T090000
DTEND;TZID=Pacific/Auckland:20260302T093000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=Pacific/Auckland:20260316T090000
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:weekly@test
RECURRENCE-ID;TZID=Pacific/Auckland:20260309T090000
DTSTART;TZID=Pacific/Auckland:20260309T100000
DTEND;TZID=Pacific/Auckland:20260309T103000
SUMMARY:Standup (moved)
END:VEVENT
BEGIN:VEVENT
UID:allday@test
DTSTART;VALUE=DATE:20260310
DTEND;VALUE=DATE:20260311
SUMMARY:Holiday
END:VEVENT
BEGIN:VEVENT
UID:floating@test
DTSTART:20260311T140000
SUMMARY:Floating
LOCATION:Room 1
END:VEVENT
BEGIN:VEVENT
UID:utc@test
DTSTART:20260312T020000Z
DTEND:20260312T030000Z
SUMMARY:UTC meeting
END:VEVENT
BEGIN:VEVENT
UID:outside@test
DTSTART;TZID=Pacific/Auckland:20260501T090000
DTEND;TZID=Pacific/Auckland:20260501T100000
SUMMARY:Outside range
END:VEVENT
END:VCALENDAR`;

describe('expandIcs', () => {
  const events = expandIcs(ICS, '2026-03-01', '2026-03-31', { name: 'TC', color: 'gray4' }, 'Pacific/Auckland');
  const byDate = (d: string) => events.filter((e) => e.date === d);

  it('expands weekly recurrence within the range, honouring EXDATE and RECURRENCE-ID overrides', () => {
    const standups = events.filter((e) => e.summary.startsWith('Standup'));
    expect(standups.map((e) => e.date)).toEqual(['2026-03-02', '2026-03-09', '2026-03-23', '2026-03-30']);
    expect(byDate('2026-03-09')[0]).toMatchObject({ summary: 'Standup (moved)', dtstart: '2026-03-09T10:00:00+13:00' });
    expect(byDate('2026-03-02')[0]).toMatchObject({ dtstart: '2026-03-02T09:00:00+13:00', dtend: '2026-03-02T09:30:00+13:00', allDay: false });
  });

  it('stores all-day events as local midnight with next-day end, like the Python fetcher', () => {
    expect(byDate('2026-03-10')).toEqual([
      expect.objectContaining({ summary: 'Holiday', allDay: true, dtstart: '2026-03-10T00:00:00+13:00', dtend: '2026-03-11T00:00:00+13:00' }),
    ]);
  });

  it('treats floating times as local and defaults missing DTEND to one hour', () => {
    expect(byDate('2026-03-11')[0]).toMatchObject({ summary: 'Floating', location: 'Room 1', dtstart: '2026-03-11T14:00:00+13:00', dtend: '2026-03-11T15:00:00+13:00' });
  });

  it('converts UTC times into the local zone and dates by local day', () => {
    expect(byDate('2026-03-12')[0]).toMatchObject({ summary: 'UTC meeting', dtstart: '2026-03-12T15:00:00+13:00' });
  });

  it('preserves local wall-clock time for far-future occurrences of a long-running weekly series', () => {
    // Regression: seeding the ical.js iterator with a UTC-zoned cursor to skip ahead used to
    // make every subsequent occurrence inherit that UTC zone, landing at the range's UTC hour
    // (midnight local) instead of the event's real time. Use a start date far past DTSTART so
    // the fast-forward path would previously have kicked in.
    const longRunning = expandIcs(ICS, '2027-06-01', '2027-06-07', { name: 'TC', color: 'gray4' }, 'Pacific/Auckland');
    const standups = longRunning.filter((e) => e.summary.startsWith('Standup'));
    expect(standups.length).toBeGreaterThan(0);
    for (const e of standups) expect(e.dtstart).toMatch(/T09:00:00/);
  });

  it('drops events outside the range and tags source/calendar/color', () => {
    expect(events.find((e) => e.summary === 'Outside range')).toBeUndefined();
    expect(events.every((e) => e.source === 'google' && e.calendar === 'TC' && e.color === 'gray4')).toBe(true);
  });
});
