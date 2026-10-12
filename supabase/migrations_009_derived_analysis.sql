-- JARVIS: owner-derived analyses for reports that were saved without a sealed analysis, and a "withdrawn" review state.
-- ADDITIVE and re-runnable. A delivered report (briefs row) is never touched: the derived analysis lives in its own table.
-- Recovery: drop table if exists report_analyses;  (and, only if no row uses it, re-create review_items_state_check without 'withdrawn')
--
-- A derived analysis is immutable: it can be inserted and read, never updated or deleted. A newer method_version creates a NEW row.
create table if not exists report_analyses (
  id uuid primary key default gen_random_uuid(),
  week_start date not null references report_periods(week_start),
  method_version integer not null,
  kind text not null default 'derived_from_saved_evidence' check (kind = 'derived_from_saved_evidence'),
  analysis jsonb not null,
  provenance jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (week_start, kind, method_version)
);
alter table report_analyses enable row level security;

create or replace function report_analyses_immutable() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'a derived analysis is immutable (%).', tg_op using errcode = 'check_violation';
end $$;
drop trigger if exists report_analyses_immutable on report_analyses;
create trigger report_analyses_immutable before update or delete on report_analyses for each row execute function report_analyses_immutable();

-- Review items can be withdrawn ("unshortlisted") while they have no recorded decision. The row and its audit events are kept.
alter table review_items drop constraint if exists review_items_state_check;
alter table review_items add constraint review_items_state_check
  check (state in ('under_review', 'open_for_votes', 'prioritised', 'parked', 'rejected', 'already_addressed', 'withdrawn'));
