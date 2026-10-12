-- JARVIS 2.0: watchlist, classification metadata, source checkpoints, review/vote/decision workflow, sprint packs, alerts, magic-link auth.
-- ADDITIVE and re-runnable. No existing table, column, row or constraint is altered or removed, and no existing report or post is rewritten.
-- Apply after migrations_005_trigger_search_path.sql.
--
-- Recovery: every object below is new (or a new nullable column). To undo, drop the new tables and columns; nothing existing depends on them.
--   drop table if exists review_events, review_decisions, review_votes, review_items, sprint_packs, alert_log, auth_tokens,
--     source_checkpoints, watchlist_changes, watchlist_settings, watch_terms cascade;
--   alter table raw_posts drop column if exists confidence, drop column if exists problem, ...;  (column list at the end of this file)
--
-- All new tables have row-level security enabled with NO policies: only the server's service-role key can read or write them, exactly as
-- for the existing tables. The browser never holds a privileged key.

-- 1. Watchlist -------------------------------------------------------------------------------------------------------------------
create table if not exists watch_terms (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references topics(id) on delete cascade,
  term text not null check (char_length(term) between 2 and 80 and term = lower(btrim(term)) and term !~ '\s{2,}'),
  kind text not null check (kind in ('include', 'exclude')),
  status text not null default 'active' check (status in ('active', 'paused')),
  -- an exclusion may be scoped to ONE include term, so a broad phrase cannot hide valid evidence for the topic's other terms
  applies_to uuid references watch_terms(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (applies_to is null or kind = 'exclude')
);
create unique index if not exists watch_terms_identity
  on watch_terms (topic_id, kind, term, coalesce(applies_to, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists watch_terms_topic_idx on watch_terms (topic_id, status);

create table if not exists watchlist_settings (
  id integer primary key check (id = 1),
  sensitivity text not null default 'balanced' check (sensitivity in ('strict', 'balanced', 'early')),
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into watchlist_settings (id) values (1) on conflict (id) do nothing;

create table if not exists watchlist_changes (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  subject text not null,
  before jsonb,
  after jsonb
);
create index if not exists watchlist_changes_at_idx on watchlist_changes (at desc);

-- Seed the watchlist from each topic's existing keywords (one-time, idempotent). topics.keywords stays as the legacy fallback.
insert into watch_terms (topic_id, term, kind)
select t.id, lower(regexp_replace(btrim(k), '\s+', ' ', 'g')), 'include'
from topics t, unnest(t.keywords) k
where char_length(regexp_replace(btrim(k), '\s+', ' ', 'g')) between 2 and 80
on conflict do nothing;

-- 2. Reproducibility: the effective watchlist used by a run, and the analysis sealed with a report --------------------------------
alter table pipeline_runs add column if not exists config_snapshot jsonb;
alter table briefs add column if not exists config_snapshot jsonb;
alter table briefs add column if not exists analysis jsonb;

-- 3. Classification v2 metadata on each post (all nullable; existing rows are untouched) ----------------------------------------
alter table raw_posts add column if not exists relevant boolean;
alter table raw_posts add column if not exists confidence real check (confidence is null or (confidence >= 0 and confidence <= 1));
alter table raw_posts add column if not exists problem text;
alter table raw_posts add column if not exists excerpt text;
alter table raw_posts add column if not exists post_kind text check (post_kind is null or post_kind in ('existing_problem', 'improvement_request', 'workaround', 'resolved_issue', 'discussion'));
alter table raw_posts add column if not exists resolution text check (resolution is null or resolution in ('open', 'resolved', 'uncertain'));
alter table raw_posts add column if not exists matched_terms text[];
alter table raw_posts add column if not exists flags text[];
alter table raw_posts add column if not exists classification_version integer;
alter table raw_posts add column if not exists classification_error text;

-- 4. Source checkpoints: attempt, success and COMMITTED progress are different things --------------------------------------------
create table if not exists source_checkpoints (
  source text not null check (source in ('hn', 'stackoverflow', 'reddit', 'github')),
  topic_id uuid not null references topics(id) on delete cascade,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  -- everything posted before this instant has been fetched COMPLETELY and stored. It never moves past data that was not durably processed.
  committed_through timestamptz,
  last_status text check (last_status is null or last_status in ('ok', 'partial', 'error')),
  primary key (source, topic_id)
);

-- 5. Review, votes, decisions, audit -------------------------------------------------------------------------------------------
create table if not exists review_items (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references topics(id) on delete cascade,
  theme text not null check (char_length(theme) between 1 and 120),
  state text not null default 'under_review' check (state in ('under_review', 'open_for_votes', 'prioritised', 'parked', 'rejected', 'already_addressed')),
  reason text check (reason is null or char_length(reason) <= 500),
  first_week text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (topic_id, theme)
);

create table if not exists review_votes (
  item_id uuid not null references review_items(id) on delete cascade,
  voter text not null,
  choice text not null check (choice in ('prioritise', 'park')),
  updated_at timestamptz not null default now(),
  primary key (item_id, voter)
);

-- Decisions are never deleted or edited: a new decision supersedes the old one, so the history stays complete.
create table if not exists review_decisions (
  id bigserial primary key,
  item_id uuid not null references review_items(id) on delete cascade,
  outcome text not null check (outcome in ('prioritised', 'parked', 'rejected', 'already_addressed')),
  decided_by text not null,
  decided_at timestamptz not null default now(),
  rationale text not null check (char_length(rationale) between 1 and 1000),
  evidence jsonb,
  vote_snapshot jsonb,
  followup boolean not null default false,
  superseded_at timestamptz
);
create unique index if not exists review_decisions_one_current on review_decisions (item_id) where superseded_at is null;

-- A recorded decision is history. The only permitted change is marking it superseded (once); it can never be edited or deleted
-- directly. (Deleting the whole review item cascades, which is an explicit owner action on the item itself, not on a decision.)
create or replace function review_decisions_protect() returns trigger
language plpgsql
set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;  -- allow the cascade from deleting the item
    raise exception 'decision % is history and cannot be deleted', old.id using errcode = 'check_violation';
  end if;
  if old.superseded_at is not null
     or new.item_id is distinct from old.item_id or new.outcome is distinct from old.outcome or new.decided_by is distinct from old.decided_by
     or new.decided_at is distinct from old.decided_at or new.rationale is distinct from old.rationale or new.evidence is distinct from old.evidence
     or new.vote_snapshot is distinct from old.vote_snapshot or new.followup is distinct from old.followup then
    raise exception 'decision % is history; only superseding it is allowed', old.id using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists review_decisions_protect on review_decisions;
create trigger review_decisions_protect before update or delete on review_decisions for each row execute function review_decisions_protect();

create table if not exists review_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  item_id uuid references review_items(id) on delete cascade,
  actor text not null,
  action text not null,
  detail jsonb
);
create index if not exists review_events_item_idx on review_events (item_id, at desc);

-- 6. Monday sprint packs -------------------------------------------------------------------------------------------------------
create table if not exists sprint_packs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by text not null,
  week_start text,
  content jsonb not null,
  -- identifies the exact set of final decisions the pack was built from, so a later change makes it visibly stale
  decisions_digest text not null
);
create index if not exists sprint_packs_created_idx on sprint_packs (created_at desc);

-- 7. Failure alerts (idempotent and bounded) and single-use sign-in links ---------------------------------------------------------
create table if not exists alert_log (
  id bigserial primary key,
  key text not null unique,
  kind text not null,
  run_id uuid,
  status text not null default 'sent' check (status in ('sent', 'failed')),
  at timestamptz not null default now()
);
create index if not exists alert_log_kind_at_idx on alert_log (kind, at desc);

create table if not exists auth_tokens (
  nonce text primary key,
  email text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_tokens_email_idx on auth_tokens (email, created_at desc);

-- 8. Row-level security: server-only, like every other table ---------------------------------------------------------------------
alter table watch_terms enable row level security;
alter table watchlist_settings enable row level security;
alter table watchlist_changes enable row level security;
alter table source_checkpoints enable row level security;
alter table review_items enable row level security;
alter table review_votes enable row level security;
alter table review_decisions enable row level security;
alter table review_events enable row level security;
alter table sprint_packs enable row level security;
alter table alert_log enable row level security;
alter table auth_tokens enable row level security;
-- No policies: the public (anon/publishable) key can read and write nothing.

-- Column list for the recovery note above:
--   raw_posts: relevant, confidence, problem, excerpt, post_kind, resolution, matched_terms, flags, classification_version, classification_error
--   pipeline_runs: config_snapshot      briefs: config_snapshot, analysis
