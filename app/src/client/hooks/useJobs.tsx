import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type Job } from '../api';

interface JobsState {
  running: Job | null;
  lastLine: string;
  error: string | null;
  /** bumps every time a job finishes so pages can refetch */
  version: number;
  start: (...args: Parameters<typeof api.startJob>) => Promise<void>;
  dismissError: () => void;
}

const Ctx = createContext<JobsState | null>(null);

export function JobsProvider({ children }: { children: ReactNode }) {
  const [running, setRunning] = useState<Job | null>(null);
  const [lastLine, setLastLine] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const source = useRef<EventSource | null>(null);

  const follow = useCallback((job: Job) => {
    source.current?.close();
    setRunning(job);
    setLastLine('');
    const es = new EventSource(`/api/jobs/${job.id}/stream`);
    source.current = es;
    es.addEventListener('line', (e) => setLastLine((e as MessageEvent).data as string));
    es.addEventListener('done', (e) => {
      const { status, error } = JSON.parse((e as MessageEvent).data as string) as { status: Job['status']; error: string | null };
      es.close();
      source.current = null;
      setRunning(null);
      setVersion((v) => v + 1);
      if (status === 'failed') setError(error ?? 'Job failed');
    });
    es.onerror = () => {
      es.close();
      source.current = null;
      setRunning(null);
      setVersion((v) => v + 1);
    };
  }, []);

  // Attach to a job already running on the server (e.g. started from the CLI or another tab).
  useEffect(() => {
    api.status().then((s) => s.running && follow(s.running)).catch(() => {});
    return () => source.current?.close();
  }, [follow]);

  const start = useCallback<JobsState['start']>(
    async (route, body) => {
      setError(null);
      try {
        follow(await api.startJob(route, body));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [follow],
  );

  const value = useMemo(() => ({ running, lastLine, error, version, start, dismissError: () => setError(null) }), [running, lastLine, error, version, start]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useJobs(): JobsState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useJobs outside JobsProvider');
  return v;
}
