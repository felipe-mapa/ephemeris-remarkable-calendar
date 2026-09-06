import { useState, type FormEvent } from 'react';
import { api, type CalendarEvent, type ManualEventPayload } from '../api';

interface Props {
  date: string;
  onCreated: (e: CalendarEvent) => void;
  onCancel: () => void;
}

export default function EventForm({ date, onCreated, onCancel }: Props) {
  const [summary, setSummary] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [endDate, setEndDate] = useState(date);
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const payload: ManualEventPayload = allDay
      ? { summary, date, allDay: true, endDate, location, description }
      : { summary, date, allDay: false, startTime, endTime, location, description };
    try {
      onCreated(await api.addEvent(payload));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border border-rule rounded-sm p-3 bg-paper-raised/60">
      <input className="field" placeholder="Title" value={summary} onChange={(e) => setSummary(e.target.value)} autoFocus required />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="accent-ink" />
        All day
      </label>
      {allDay ? (
        <label className="text-sm flex items-center gap-2">
          <span className="text-muted w-14">Until</span>
          <input type="date" className="field" value={endDate} min={date} onChange={(e) => setEndDate(e.target.value)} />
        </label>
      ) : (
        <div className="flex items-center gap-2 text-sm">
          <input type="time" className="field" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
          <span className="text-muted">to</span>
          <input type="time" className="field" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </div>
      )}
      <input className="field" placeholder="Location" value={location} onChange={(e) => setLocation(e.target.value)} />
      <textarea className="field-area" placeholder="Notes" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      {error && <p className="text-sm text-ink">{error}</p>}
      <div className="flex gap-2 justify-end">
        <button type="button" className="btn btn-quiet" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Adding…' : 'Add event'}</button>
      </div>
    </form>
  );
}
