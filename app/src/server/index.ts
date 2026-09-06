import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { EventStore } from './db.js';
import { JobRunner } from './jobs.js';
import { createApp } from './app.js';
import { paths, TIMEZONE } from './paths.js';

const PORT = Number(process.env.PORT ?? 3210);
const store = EventStore.open();
const jobs = new JobRunner();
const app = createApp({ store, jobs });

// In production serve the built client from app/dist; in dev Vite serves it and proxies /api here.
if (fs.existsSync(paths.clientDist)) {
  const rel = path.relative(process.cwd(), paths.clientDist);
  app.use('/*', serveStatic({ root: rel }));
  app.get('*', serveStatic({ root: rel, path: 'index.html' }));
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`reMarkableCalendar server on http://localhost:${info.port} (tz ${TIMEZONE}, db ${paths.db})`);
});
