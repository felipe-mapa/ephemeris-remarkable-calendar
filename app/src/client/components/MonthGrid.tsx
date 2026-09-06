import { paletteColor, formatTime, type CalendarEvent } from '../api';

interface Props {
  year: number;
  month: number; // 1-12
  today: string;
  selected: string;
  eventsByDate: Map<string, CalendarEvent[]>;
  onSelect: (date: string) => void;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Build the 6x7 grid of ISO dates for a month, Monday first. */
export function monthCells(year: number, month: number): { date: string; inMonth: boolean }[] {
  const first = new Date(year, month - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const cells: { date: string; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month - 1, 1 - lead + i);
    cells.push({ date: isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate()), inMonth: d.getMonth() === month - 1 });
  }
  return cells;
}

export default function MonthGrid({ year, month, today, selected, eventsByDate, onSelect }: Props) {
  const cells = monthCells(year, month);
  return (
    <div className="flex flex-col h-full">
      <div className="grid grid-cols-7 border-b border-ink">
        {WEEKDAYS.map((w) => (
          <div key={w} className="px-2 py-1.5 text-xs text-muted">{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 grid-rows-6 flex-1 min-h-0">
        {cells.map(({ date, inMonth }, i) => {
          const evs = (eventsByDate.get(date) ?? []).filter((e) => e.deletedAt === null);
          const isSel = date === selected;
          const isToday = date === today;
          const shown = evs.slice(0, 4);
          return (
            <button
              key={date}
              onClick={() => onSelect(date)}
              aria-label={date}
              aria-pressed={isSel}
              className={[
                'text-left flex flex-col min-h-0 p-1.5 border-rule-soft border-b transition-colors',
                i % 7 !== 6 ? 'border-r' : '',
                isSel ? 'bg-marker/70' : 'hover:bg-paper-raised',
                inMonth ? '' : 'text-muted/70',
              ].join(' ')}
            >
              <span className={`self-start text-xs leading-none px-1 py-0.5 rounded-sm ${isToday ? 'bg-ink text-paper-raised font-semibold' : ''}`}>
                {Number(date.slice(-2))}
              </span>
              <ul className="mt-1 flex flex-col gap-0.5 min-h-0 overflow-hidden">
                {shown.map((e) => (
                  <li key={e.id} className="flex items-center gap-1 text-[11px] leading-tight truncate">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: paletteColor(e.color) }} aria-hidden />
                    {!e.allDay && <span className="text-muted shrink-0">{formatTime(e.dtstart)}</span>}
                    <span className={`truncate ${e.source === 'manual' ? 'font-medium' : ''}`}>{e.summary || '(untitled)'}</span>
                  </li>
                ))}
                {evs.length > shown.length && <li className="text-[11px] text-muted">+{evs.length - shown.length} more</li>}
              </ul>
            </button>
          );
        })}
      </div>
    </div>
  );
}
