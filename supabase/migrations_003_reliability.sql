-- Stage 1: reliability and trustworthy weekly metrics.
-- FOR REVIEW. Not applied to any database by the code or by its author.
-- Purely additive: no existing column, row or constraint is altered, dropped or rewritten.
-- Safe to re-run (every statement is idempotent).

-- 1. Email-once guard, one row per reporting week (briefs.week_start is already UNIQUE, which is what makes the
--    conditional-UPDATE claim in store.claimEmail atomic).
alter table briefs
  add column if not exists email_status text check (email_status in ('sending', 'sent', 'failed')),
  add column if not exists email_claimed_at timestamptz,
  add column if not exists email_sent_at timestamptz,
  add column if not exists email_error text;

-- 2. One row per pipeline execution.
create table if not exists pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,                           -- reporting-period key (IST date of the period's first day)
  period_start timestamptz not null,
  period_end timestamptz not null,                    -- exclusive
  trigger text not null check (trigger in ('scheduled', 'backfill')),
  status text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,                            -- null on a row whose function was killed mid-run
  fetched_total integer,
  new_posts integer,
  classified_ok integer,
  classification_failed integer,
  used_fallback boolean,
  email_status text check (email_status in ('sent', 'skipped', 'failed', 'already_sent', 'in_progress', 'unconfirmed', 'not_attempted')),
  warnings jsonb not null default '[]',
  error text                                          -- sanitized; never contains secrets
);
create index if not exists pipeline_runs_week_idx on pipeline_runs (week_start, started_at desc);

-- 3. One row per (run, topic, source): distinguishes a failed fetch from a successful fetch that found nothing.
create table if not exists source_fetches (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references pipeline_runs(id) on delete cascade,
  topic_id uuid references topics(id) on delete cascade,
  source text not null check (source in ('hn', 'stackoverflow', 'reddit', 'github')),
  status text not null check (status in ('ok', 'partial', 'error')),
  requests integer not null default 0,
  failed_requests integer not null default 0,
  fetched integer not null default 0,
  accepted integer not null default 0,
  inserted integer not null default 0,
  truncated boolean not null default false,
  error text,
  duration_ms integer,
  unique (run_id, topic_id, source)
);
create index if not exists source_fetches_run_idx on source_fetches (run_id);

-- 4. One row per reporting period recorded under the IST convention, with the sources that contributed.
--    Its mere existence (with matching period_start) is what makes a week a valid baseline: rows written before this
--    migration have no entry here and are never reinterpreted as comparable.
create table if not exists report_periods (
  week_start date primary key,
  period_start timestamptz not null,
  period_end timestamptz not null,
  coverage jsonb not null default '{}',               -- { sources: { hn: {status, posts}, ... }, comparison: {state, reasons} }
  updated_at timestamptz not null default now()
);

alter table pipeline_runs enable row level security;
alter table source_fetches enable row level security;
alter table report_periods enable row level security;
-- No policies: only the server's service-role key can read or write, as with the existing tables.
