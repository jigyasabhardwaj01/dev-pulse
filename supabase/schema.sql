-- JARVIS schema (internal project id: dev-pulse). Matches the spec, plus the additions marked "added".
create table if not exists topics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  keywords text[] not null default '{}',
  canonical_themes text[] not null default '{}',
  tags text[] not null default '{}',            -- added: optional Stack Overflow tags
  category text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists raw_posts (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('hn', 'stackoverflow', 'reddit', 'github')),
  source_id text not null,
  topic_id uuid references topics(id) on delete cascade,
  title text not null default '',
  body text not null default '',
  url text,
  author text,
  posted_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  is_answered boolean,                          -- stack overflow only; null for hn
  theme text,                                   -- added: classification result (null = not yet classified)
  sentiment text,                               -- added
  unresolved boolean,                           -- added
  classified_at timestamptz,                    -- added
  unique (source, source_id)
);
create index if not exists raw_posts_posted_at_idx on raw_posts (posted_at);

create table if not exists weekly_aggregates (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  topic_id uuid references topics(id) on delete cascade,
  theme text not null,                          -- one of topics.canonical_themes, or 'other'
  mention_count integer not null default 0,
  unresolved_count integer not null default 0,  -- added
  created_at timestamptz not null default now(),
  unique (week_start, topic_id, theme)
);

create table if not exists briefs (
  id uuid primary key default gen_random_uuid(),
  week_start date not null unique,
  narrative text not null,
  top_pain_points jsonb not null default '[]',
  created_at timestamptz not null default now(),
  email_status text check (email_status in ('sending', 'sent', 'failed')),  -- added (stage 1)
  email_claimed_at timestamptz,
  email_sent_at timestamptz,
  email_error text,
  version integer not null default 1,                                   -- stage 2: saved report version
  pending_count integer not null default 0,
  used_fallback boolean not null default false,
  coverage jsonb,
  emailed_version integer,
  email_message_id text
);

-- Only the server (service role) touches these tables; RLS on with no policies blocks anon access.
alter table topics enable row level security;
alter table raw_posts enable row level security;
alter table weekly_aggregates enable row level security;
alter table briefs enable row level security;

-- Stage 1 additions (see migrations_003_reliability.sql for the commented version).
create table if not exists pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  trigger text not null check (trigger in ('scheduled', 'backfill')),
  status text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fetched_total integer,
  new_posts integer,
  classified_ok integer,
  classification_failed integer,
  used_fallback boolean,
  email_status text check (email_status in ('sent', 'skipped', 'failed', 'already_sent', 'in_progress', 'unconfirmed', 'not_attempted')),
  warnings jsonb not null default '[]',
  error text
);
create index if not exists pipeline_runs_week_idx on pipeline_runs (week_start, started_at desc);

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

create table if not exists report_periods (
  week_start date primary key,
  period_start timestamptz not null,
  period_end timestamptz not null,
  coverage jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table pipeline_runs enable row level security;
alter table source_fetches enable row level security;
alter table report_periods enable row level security;

-- Stage 2 additions (see migrations_004_report_integrity.sql for the commented version).
create or replace function briefs_protect_delivered() returns trigger
language plpgsql
set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.email_status in ('sent', 'sending') then
      raise exception 'brief % is delivered or being delivered and cannot be deleted', old.week_start
        using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.email_status = 'sent' and new.email_status is distinct from 'sent' then
    raise exception 'brief % was delivered; its delivery state cannot be changed', old.week_start
      using errcode = 'check_violation';
  end if;
  if old.email_status = 'sent' and (
         new.email_sent_at     is distinct from old.email_sent_at
      or new.emailed_version   is distinct from old.emailed_version
      or new.email_message_id  is distinct from old.email_message_id
  ) then
    raise exception 'brief % was delivered; its delivery record is immutable', old.week_start
      using errcode = 'check_violation';
  end if;
  if old.email_status in ('sent', 'sending') and (
         new.narrative       is distinct from old.narrative
      or new.top_pain_points is distinct from old.top_pain_points
      or new.coverage        is distinct from old.coverage
      or new.version         is distinct from old.version
      or new.pending_count   is distinct from old.pending_count
      or new.used_fallback   is distinct from old.used_fallback
  ) then
    raise exception 'brief % is delivered or being delivered; its content is immutable', old.week_start
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists briefs_protect_delivered on briefs;
create trigger briefs_protect_delivered
  before update or delete on briefs
  for each row execute function briefs_protect_delivered();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'report_periods_seven_days' and conrelid = 'report_periods'::regclass) then
    alter table report_periods add constraint report_periods_seven_days
      check (period_end = period_start + interval '7 days');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'source_fetches_failed_le_requests' and conrelid = 'source_fetches'::regclass) then
    alter table source_fetches add constraint source_fetches_failed_le_requests
      check (failed_requests <= requests);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pipeline_runs_finished_consistent' and conrelid = 'pipeline_runs'::regclass) then
    alter table pipeline_runs add constraint pipeline_runs_finished_consistent
      check ((status = 'running') = (finished_at is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'briefs_sent_has_timestamp' and conrelid = 'briefs'::regclass) then
    alter table briefs add constraint briefs_sent_has_timestamp
      check (email_status is distinct from 'sent' or email_sent_at is not null);
  end if;
end $$;
