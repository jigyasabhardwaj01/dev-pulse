-- Stage 2: report integrity. FOR REVIEW. Not applied to any database by the code or by its author.
-- Apply AFTER migrations_003_reliability.sql. Additive and re-runnable; no existing row is rewritten.

-- 1. One saved report VERSION per reporting week: the dashboard and the email both read this row.
alter table briefs
  add column if not exists version integer not null default 1,          -- bumped only when the saved content changes
  add column if not exists pending_count integer not null default 0,    -- unclassified posts in the period when built
  add column if not exists used_fallback boolean not null default false,
  add column if not exists coverage jsonb,                              -- { sources: {...}, comparison: {...} } snapshot
  add column if not exists emailed_version integer,                     -- the version the provider accepted
  add column if not exists email_message_id text;

-- 2. Safety net: a delivered (or being-delivered) report is immutable (content, delivery record, and it cannot be deleted); "sent" is terminal.
--    The application already avoids these writes (compare-and-set in store.saveBrief); this makes a violation an error
--    instead of a silent overwrite.
create or replace function briefs_protect_delivered() returns trigger
language plpgsql as $$
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

-- 3. Consistency constraints flagged by the independent review (guarded so the script stays re-runnable).
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
