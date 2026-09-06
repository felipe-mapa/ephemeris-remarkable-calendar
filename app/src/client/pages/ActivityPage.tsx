import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, JOB_LABELS, type Job, type Status } from '../api';
import { useJobs } from '../hooks/useJobs';

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function JobLog({ jobId }: { jobId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Job['status'] | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setLines([]);
    setStatus(null);
    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    es.addEventListener('line', (e) => setLines((l) => [...l, (e as MessageEvent).data as string]));
    es.addEventListener('done', (e) => {
      setStatus((JSON.parse((e as MessageEvent).data as string) as { status: Job['status'] }).status);
      es.close();
    });
    es.onerror = () => es.close();
    return () => es.close();
  }, [jobId]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [lines]);
  return (
    <div className="border border-ink bg-paper-raised h-full overflow-y-auto">
      <pre className="p-4 text-xs leading-relaxed whitespace-pre-wrap break-words font-mono">
        {lines.length === 0 ? (status ? 'No output.' : 'Waiting for output…') : lines.join('\n')}
        <div ref={bottom} />
      </pre>
    </div>
  );
}

export default function ActivityPage() {
  const { jobId } = useParams();
  const { running, version, start } = useJobs();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    api.jobs().then(setJobs).catch(() => {});
    api.status().then(setStatus).catch(() => {});
  }, [version, running?.id]);
  const activeId = jobId ?? running?.id ?? jobs[0]?.id;
  const busy = running !== null;
  const stats = status?.stats;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-[560px]">
      <aside className="w-[360px] shrink-0 border-r border-ink flex flex-col min-h-0">
        <div className="px-5 pt-5 pb-4 border-b border-rule">
          <h1 className="text-base font-semibold">More actions</h1>
          <p className="text-xs text-muted mt-1">Each step of the daily sync, on its own.</p>
          <div className="mt-3 flex flex-col gap-2">
            <button className="btn justify-start" disabled={busy} onClick={() => start('sync', { days: 7 })}>Sync calendar and update reMarkable</button>
            <button className="btn justify-start" disabled={busy} onClick={() => start('fetch-year', {})}>Sync calendar for the whole year</button>
            <button className="btn justify-start" disabled={busy} onClick={() => start('generate', {})}>Generate PDF only</button>
            <button className="btn justify-start" disabled={busy} onClick={() => start('backup', {})}>Back up device copy only</button>
          </div>
        </div>
        {stats && (
          <div className="px-5 py-4 border-b border-rule text-xs text-muted leading-relaxed">
            <div>{stats.totalEvents} events across {stats.totalDates} days{stats.minDate && ` (${stats.minDate} to ${stats.maxDate})`}</div>
            <div>Feeds: {status?.calendars.map((c) => c.name).join(', ') || 'none configured'}</div>
            <div>Time zone: {status?.timezone}</div>
            <div>Device backups: {status?.backups.length ?? 0}{status?.backups[0] && `, latest ${fmt(status.backups[0].modifiedAt)}`}</div>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          <h2 className="px-5 pt-4 pb-2 text-xs text-muted">Recent runs</h2>
          {jobs.length === 0 && <p className="px-5 text-sm text-muted">Nothing has run since the server started.</p>}
          <ul>
            {jobs.map((j) => (
              <li key={j.id}>
                <Link
                  to={`/activity/${j.id}`}
                  className={`flex items-center gap-3 px-5 py-2.5 text-sm border-b border-rule-soft ${j.id === activeId ? 'bg-marker/60' : 'hover:bg-paper-raised'}`}
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${j.status === 'running' ? 'bg-ink animate-pulse' : j.status === 'failed' ? 'bg-ink' : 'border border-ink'}`}
                    aria-hidden
                  />
                  <span className="truncate">{JOB_LABELS[j.kind]}</span>
                  <span className="ml-auto text-xs text-muted shrink-0">{j.status === 'running' ? 'running' : j.status === 'failed' ? 'failed' : fmt(j.finishedAt ?? j.startedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className="flex-1 min-w-0 p-6">
        {activeId ? <JobLog jobId={activeId} /> : <p className="text-sm text-muted">Run something to see its log here.</p>}
      </section>
    </div>
  );
}
