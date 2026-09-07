import 'dotenv/config';

/** Defaults target the local `supabase start` stack; app/.env overrides them in production. */
export const env = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  userEmail: process.env.APP_USER_EMAIL ?? 'felipe@pavanela.com',
  /** Worker poll interval in ms; 0 disables the in-process worker. */
  workerIntervalMs: Number(process.env.APP_WORKER_INTERVAL_MS ?? 5000),
};
