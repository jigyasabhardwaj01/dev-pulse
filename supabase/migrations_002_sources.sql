-- Allow Reddit and GitHub Issues as sources (applied after the initial schema).
alter table raw_posts drop constraint if exists raw_posts_source_check;
alter table raw_posts add constraint raw_posts_source_check
  check (source in ('hn', 'stackoverflow', 'reddit', 'github'));
