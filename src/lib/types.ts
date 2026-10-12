export type Source = "hn" | "stackoverflow" | "reddit" | "github";
export const SOURCES: Source[] = ["hn", "stackoverflow", "reddit", "github"];
export type Sentiment = "negative" | "neutral" | "positive";
export type Direction = "up" | "down" | "flat" | "new" | "unavailable";

export const OTHER_THEME = "other";

export interface Topic {
  id: string;
  name: string;
  keywords: string[];
  canonical_themes: string[];
  tags: string[];
  category: string | null;
  active: boolean;
  created_at?: string; // used only for deterministic ordering
}

export interface FetchedPost {
  source: Source;
  source_id: string;
  topic_id: string;
  title: string;
  body: string;
  url: string | null;
  author: string | null;
  posted_at: string; // ISO
  is_answered: boolean | null; // stack overflow only
}

export interface StoredPost extends FetchedPost {
  id: string;
  theme: string | null;
  sentiment: Sentiment | null;
  unresolved: boolean | null;
}

export interface Classification {
  id: string; // StoredPost.id
  theme: string;
  sentiment: Sentiment;
  unresolved: boolean;
}

export interface ThemeCount {
  topic_id: string;
  theme: string;
  count: number;
  unresolved: number;
}

export interface ThemeTrend {
  topic_id: string;
  topic_name: string;
  theme: string;
  count: number;
  previous: number;
  direction: Direction;
  pct: number | null; // null when there is no baseline (direction "new")
  unresolved_count: number;
  unresolved: boolean;
}

export interface FetchWindow {
  start: Date; // inclusive (UTC instant)
  end: Date; // exclusive (UTC instant)
  weekStart: string; // reporting-period key: IST calendar date of the period's first day (a Friday)
  prevWeekStart: string;
  prevStart: Date; // UTC instant at which the previous period began
}

/** What a source adapter reports. A request that failed is not the same as a request that returned nothing. */
export interface FetchResult {
  posts: FetchedPost[];
  requests: number; // upstream requests attempted
  failed: number; // how many of them failed
  errors: string[]; // sanitized, short
  truncated: boolean; // some request hit its page cap, so more may exist
  /** Extra attempts made after a transient failure or a rate-limit wait (not counted in `requests`). */
  retries?: number;
  /** Milliseconds spent waiting for a provider's rate limit to reset. */
  waitedMs?: number;
}

export type ModelCaller = (prompt: string, opts?: { json?: boolean; deadline?: number }) => Promise<string>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type SourceFetcher = (topic: Topic, window: FetchWindow) => Promise<FetchResult | FetchedPost[]>;
