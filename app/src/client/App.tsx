import { NavLink, Outlet, Link } from 'react-router';
import { JobsProvider, useJobs } from './hooks/useJobs';
import { JOB_LABELS } from './api';

function Header() {
  const { running, lastLine, error, start, dismissError } = useJobs();
  const busy = running !== null;
  return (
    <header className="border-b border-ink">
      <div className="flex items-center gap-6 px-6 h-14">
        <Link to="/" className="text-lg font-semibold tracking-tight">Ephemeris</Link>
        <nav className="flex items-center gap-1 text-sm">
          <NavLink to="/" className={({ isActive }) => `px-2 py-1 rounded-sm ${isActive ? 'bg-rule-soft' : 'text-muted hover:text-ink'}`}>Calendar</NavLink>
          <NavLink to="/activity" className={({ isActive }) => `px-2 py-1 rounded-sm ${isActive ? 'bg-rule-soft' : 'text-muted hover:text-ink'}`}>Activity</NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn" disabled={busy} onClick={() => start('fetch', { days: 30 })} title="Fetch the next 30 days from your calendar feeds into the database">
            Sync calendar
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => start('remarkable', { skipFetch: true })} title="Regenerate the PDF, back up the device copy, merge your annotations and upload">
            Update reMarkable
          </button>
        </div>
      </div>
      {busy && (
        <Link to={`/activity/${running.id}`} className="flex items-center gap-3 px-6 h-8 text-xs bg-marker text-ink border-t border-marker-deep">
          <span className="inline-block w-2 h-2 rounded-full bg-ink animate-pulse" aria-hidden />
          <span className="font-medium shrink-0">{JOB_LABELS[running.kind]}</span>
          <span className="truncate text-ink-soft">{lastLine || 'Starting…'}</span>
          <span className="ml-auto shrink-0 underline">Open log</span>
        </Link>
      )}
      {error && !busy && (
        <div className="flex items-center gap-3 px-6 h-8 text-xs bg-ink text-paper-raised">
          <span className="truncate">{error}</span>
          <Link to="/activity" className="underline shrink-0">See log</Link>
          <button className="ml-auto underline" onClick={dismissError}>Dismiss</button>
        </div>
      )}
    </header>
  );
}

export default function App() {
  return (
    <JobsProvider>
      <div className="min-h-full flex flex-col">
        <Header />
        <main className="flex-1 min-h-0">
          <Outlet />
        </main>
      </div>
    </JobsProvider>
  );
}
