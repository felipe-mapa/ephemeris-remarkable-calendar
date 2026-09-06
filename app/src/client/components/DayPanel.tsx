import { useState } from 'react';
import { api, formatTime, paletteColor, plainText, type CalendarEvent } from '../api';
import EventForm from './EventForm';

interface Props {
  date: string;
  events: CalendarEvent[]; // includes deleted
  onChange: (e: CalendarEvent) => void;
}

const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function EventRow({ ev, onChange }: { ev: CalendarEvent; onChange: (e: CalendarEvent) => void }) {
  const [busy, setBusy] = useState(false);
  const deleted = ev.deletedAt !== null;
  async function toggle() {
    setBusy(true);
    try {
      onChange(deleted ? await api.restoreEvent(ev.id) : await api.deleteEvent(ev.id));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className={`flex gap-3 py-2.5 border-b border-rule-soft ${deleted ? 'opacity-50' : ''}`}>
      <span className="mt-1.5 w-2 h-2 rounded-full shrink-0" style={{ background: paletteColor(ev.color) }} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-medium leading-snug ${deleted ? 'line-through' : ''}`}>{ev.summary || '(untitled)'}</div>
        <div className="text-xs text-muted mt-0.5">
          {ev.allDay ? 'All day' : `${formatTime(ev.dtstart)} – ${formatTime(ev.dtend)}`}
          {ev.location && ` · ${ev.location}`}
          {' · '}
          {ev.source === 'manual' ? 'Added here' : ev.calendar}
        </div>
        {ev.description && !deleted && <p className="text-xs text-ink-soft mt-1 whitespace-pre-wrap line-clamp-3">{plainText(ev.description)}</p>}
        {deleted && <div className="text-xs text-muted mt-0.5">Removed. It stays out of the PDF and won't come back on sync.</div>}
      </div>
      <button className="btn btn-quiet h-7 px-2 text-xs self-start" disabled={busy} onClick={toggle}>
        {deleted ? 'Restore' : 'Remove'}
      </button>
    </li>
  );
}

export default function DayPanel({ date, events, onChange }: Props) {
  const [adding, setAdding] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const active = events.filter((e) => e.deletedAt === null);
  const deleted = events.filter((e) => e.deletedAt !== null);

  return (
    <aside className="w-[360px] shrink-0 border-l border-ink flex flex-col min-h-0">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-base font-semibold leading-tight">{longDate(date)}</h2>
        <p className="text-xs text-muted mt-1">
          {active.length === 0 ? 'Nothing scheduled' : `${active.length} event${active.length === 1 ? '' : 's'}`}
          {deleted.length > 0 && (
            <>
              {' · '}
              <button className="underline" onClick={() => setShowDeleted((s) => !s)}>
                {showDeleted ? 'hide' : 'show'} {deleted.length} removed
              </button>
            </>
          )}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-5">
        <ul>
          {active.map((e) => <EventRow key={e.id} ev={e} onChange={onChange} />)}
          {showDeleted && deleted.map((e) => <EventRow key={e.id} ev={e} onChange={onChange} />)}
        </ul>
        <div className="py-4">
          {adding ? (
            <EventForm date={date} onCancel={() => setAdding(false)} onCreated={(e) => { onChange(e); setAdding(false); }} />
          ) : (
            <button className="btn w-full" onClick={() => setAdding(true)}>Add event</button>
          )}
        </div>
      </div>
    </aside>
  );
}
