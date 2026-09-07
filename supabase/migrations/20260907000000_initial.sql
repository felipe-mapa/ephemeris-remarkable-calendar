-- reMarkableCalendar: single-user schema. RLS is enabled with no policies on purpose:
-- only the server's postgres/service_role connection may read or write.

create extension if not exists supabase_vault with schema vault;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

create table public.calendar_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null,
  color text not null default 'black',
  -- vault.secrets.id holding the ICS URL (Google private links embed a token)
  url_secret_id uuid not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  date date not null,                       -- local calendar day of the occurrence
  summary text not null default '',
  description text not null default '',
  location text not null default '',
  dtstart text not null,                    -- ISO 8601 with offset, parsed by Python fromisoformat
  dtend text not null,
  color text not null default 'black',
  calendar text not null default 'Unknown',
  all_day boolean not null default false,
  source text not null default 'google' check (source in ('google', 'manual')),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, date, summary, dtstart)  -- same dedupe key as the SQLite idx_event_unique
);
create index events_user_date_idx on public.events (user_id, date);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (kind in ('sync', 'fetch', 'fetch-year', 'generate', 'remarkable', 'backup')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  requested_by text not null default 'web' check (requested_by in ('web', 'cli', 'cron')),
  error text,
  log text not null default '',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index jobs_queue_idx on public.jobs (created_at) where status = 'queued';
create index jobs_user_created_idx on public.jobs (user_id, created_at desc);

alter table public.users enable row level security;
alter table public.calendar_sources enable row level security;
alter table public.events enable row level security;
alter table public.jobs enable row level security;
