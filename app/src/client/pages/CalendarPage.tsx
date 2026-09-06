import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, type CalendarEvent } from '../api';
import MonthGrid, { isoDate, monthCells } from '../components/MonthGrid';
import DayPanel from '../components/DayPanel';
import { useJobs } from '../hooks/useJobs';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function CalendarPage() {
  const params = useParams();
  const navigate = useNavigate();
  const { version } = useJobs();
  const now = new Date();
  const year = Number(params.year ?? now.getFullYear());
  const month = Number(params.month ?? now.getMonth() + 1);
  const todayIso = isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const selected = params.day ? isoDate(year, month, Number(params.day)) : (todayIso.startsWith(`${year}-${String(month).padStart(2, '0')}`) ? todayIso : isoDate(year, month, 1));

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const cells = useMemo(() => monthCells(year, month), [year, month]);
  const range = { start: cells[0].date, end: cells[cells.length - 1].date };

  const load = useCallback(() => {
    api.events(range.start, range.end, true).then(setEvents).catch((e: Error) => setLoadError(e.message));
  }, [range.start, range.end]);

  useEffect(load, [load, version]);

  const byDate = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const list = m.get(e.date) ?? [];
      list.push(e);
      m.set(e.date, list);
    }
    return m;
  }, [events]);

  const go = (y: number, m: number) => {
    if (m < 1) { y -= 1; m = 12; }
    if (m > 12) { y += 1; m = 1; }
    navigate(`/calendar/${y}/${m}`);
  };
  const select = (date: string) => {
    const [y, m, d] = date.split('-').map(Number);
    navigate(`/calendar/${y}/${m}/${d}`);
  };
  const upsert = (ev: CalendarEvent) =>
    setEvents((prev) => (prev.some((e) => e.id === ev.id) ? prev.map((e) => (e.id === ev.id ? ev : e)) : [...prev, ev]));

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-[560px]">
      <section className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-baseline gap-3 px-6 h-14 shrink-0">
          <h1 className="text-2xl font-semibold tracking-tight">{MONTHS[month - 1]} <span className="text-muted font-normal">{year}</span></h1>
          <div className="ml-auto flex items-center gap-1">
            <button className="btn btn-quiet px-2" onClick={() => go(year, month - 1)} aria-label="Previous month">‹</button>
            <button className="btn btn-quiet" onClick={() => select(todayIso)}>Today</button>
            <button className="btn btn-quiet px-2" onClick={() => go(year, month + 1)} aria-label="Next month">›</button>
          </div>
        </div>
        {loadError && <p className="px-6 pb-2 text-sm">Could not load events: {loadError}. Is the server running on port 3210?</p>}
        <div className="flex-1 min-h-0 px-6 pb-6">
          <div className="h-full border border-ink">
            <MonthGrid year={year} month={month} today={todayIso} selected={selected} eventsByDate={byDate} onSelect={select} />
          </div>
        </div>
      </section>
      <DayPanel date={selected} events={byDate.get(selected) ?? []} onChange={upsert} />
    </div>
  );
}
