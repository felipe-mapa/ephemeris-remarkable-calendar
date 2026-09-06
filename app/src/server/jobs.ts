import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { paths } from './paths.js';

export type JobKind = 'sync' | 'fetch' | 'generate' | 'remarkable' | 'backup';
export type JobStatus = 'running' | 'succeeded' | 'failed';

export interface JobRecord {
  id: string;
  kind: JobKind;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  lines: string[];
  error: string | null;
}

export interface JobContext {
  log: (line: string) => void;
  run: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
}

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Append to logs/remarkable-sync.log in the same format as scripts/helpers/functions.sh. */
export function appendSyncLog(line: string, file: string = paths.syncLog) {
  try {
    fs.mkdirSync(paths.logs, { recursive: true });
    fs.appendFileSync(file, `[${stamp()}] ${line}\n`);
  } catch {
    /* logging must never break a job */
  }
}

/**
 * In-memory registry of jobs. Only one job runs at a time; this replaces the
 * PID lock file in remarkable-sync-calendar.sh (the lock file is still written
 * so the old shell wrapper and the web server cannot overlap).
 */
export class JobRunner extends EventEmitter {
  private jobs = new Map<string, JobRecord>();
  private current: JobRecord | null = null;
  private seq = 0;

  constructor(private readonly persistLog: (line: string) => void = appendSyncLog) {
    super();
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  get running(): JobRecord | null {
    return this.current;
  }

  private acquireLock(): boolean {
    try {
      fs.mkdirSync(paths.logs, { recursive: true });
      if (fs.existsSync(paths.lockFile)) {
        const pid = Number(fs.readFileSync(paths.lockFile, 'utf8').trim());
        if (pid && pid !== process.pid) {
          try {
            process.kill(pid, 0);
            return false; // another live process holds it
          } catch {
            /* stale */
          }
        }
      }
      fs.writeFileSync(paths.lockFile, String(process.pid));
      return true;
    } catch {
      return true;
    }
  }

  private releaseLock() {
    try {
      fs.rmSync(paths.lockFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  start(kind: JobKind, work: (ctx: JobContext) => Promise<void>): JobRecord {
    if (this.current) throw new JobBusyError(this.current);
    if (!this.acquireLock()) throw new JobBusyError(null);

    const job: JobRecord = {
      id: `${Date.now().toString(36)}-${(this.seq++).toString(36)}`,
      kind,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      lines: [],
      error: null,
    };
    this.jobs.set(job.id, job);
    this.current = job;
    this.emit('update', job);

    const log = (line: string) => {
      // loguru colours its output; keep the stored log plain text
      for (const l of line.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
        if (!l.trim()) continue;
        job.lines.push(l);
        this.persistLog(l);
        this.emit('line', job.id, l);
      }
    };

    const run: JobContext['run'] = (cmd, args, opts = {}) =>
      new Promise((resolve, reject) => {
        log(`$ ${[cmd, ...args].join(' ')}`);
        const child = spawn(cmd, args, { cwd: opts.cwd ?? paths.root, env: { ...process.env, ...opts.env } });
        let stdout = '';
        let stderr = '';
        const timer = opts.timeoutMs
          ? setTimeout(() => {
              child.kill('SIGKILL');
              reject(new Error(`Command timed out after ${opts.timeoutMs! / 1000}s: ${cmd}`));
            }, opts.timeoutMs)
          : null;
        child.stdout.on('data', (d: Buffer) => {
          stdout += d;
          log(d.toString());
        });
        child.stderr.on('data', (d: Buffer) => {
          stderr += d;
          log(d.toString());
        });
        child.on('error', (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        });
        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });

    work({ log, run })
      .then(() => {
        job.status = 'succeeded';
      })
      .catch((err: unknown) => {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        log(`❌ ${job.error}`);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        this.current = null;
        this.releaseLock();
        this.emit('update', job);
        this.emit('done', job);
        // keep memory bounded
        const ids = [...this.jobs.keys()];
        while (ids.length > 50) this.jobs.delete(ids.shift() as string);
      });

    return job;
  }

  /** Resolve when the job finishes (used by the CLI). */
  wait(id: string): Promise<JobRecord> {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new Error(`Unknown job ${id}`));
    if (job.status !== 'running') return Promise.resolve(job);
    return new Promise((resolve) => {
      const handler = (j: JobRecord) => {
        if (j.id === id) {
          this.off('done', handler);
          resolve(j);
        }
      };
      this.on('done', handler);
    });
  }
}

export class JobBusyError extends Error {
  constructor(public readonly job: JobRecord | null) {
    super(job ? `A ${job.kind} job is already running` : 'Another sync process holds the lock file');
  }
}
