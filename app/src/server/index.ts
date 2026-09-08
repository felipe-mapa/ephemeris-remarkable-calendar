import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { EventStore } from './db.js';
import { JobRunner } from './jobs.js';
import { startWorker } from './jobqueue.js';
import { createApp } from './app.js';
import { env } from './env.js';
import { paths, TIMEZONE } from './paths.js';

const PORT = Number(process.env.PORT ?? 3210);
const store = await EventStore.open();
const jobs = new JobRunner();
const app = createApp({ store, jobs });

// In production serve the built client from app/dist; in dev Vite serves it and proxies /api here.
if (fs.existsSync(paths.clientDist)) {
  const rel = path.relative(process.cwd(), paths.clientDist);
  app.use('/*', serveStatic({ root: rel }));
  app.get('*', serveStatic({ root: rel, path: 'index.html' }));
}

// The same process drains public.jobs (filled by pg_cron and by the UI).
const worker = env.workerIntervalMs > 0 ? startWorker({ sql: store.sql, store, jobs, intervalMs: env.workerIntervalMs }) : null;

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`reMarkableCalendar server on http://localhost:${info.port} (tz ${TIMEZONE}, user ${env.userEmail}, worker ${worker ? `every ${env.workerIntervalMs}ms` : 'off'})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    worker?.stop();
    void store.close().finally(() => process.exit(0));
  });
}
