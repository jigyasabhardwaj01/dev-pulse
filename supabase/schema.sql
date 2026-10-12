-- Dev Pulse schema. Matches the spec, plus the additions marked "added".
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
  source text not null check (source in ('hn', 'stackoverflow')),
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
  created_at timestamptz not null default now()
);

-- Only the server (service role) touches these tables; RLS on with no policies blocks anon access.
alter table topics enable row level security;
alter table raw_posts enable row level security;
alter table weekly_aggregates enable row level security;
alter table briefs enable row level security;
