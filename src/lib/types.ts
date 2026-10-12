export type Source = "hn" | "stackoverflow" | "reddit" | "github";
export const SOURCES: Source[] = ["hn", "stackoverflow", "reddit", "github"];
export type Sentiment = "negative" | "neutral" | "positive";
export type Direction = "up" | "down" | "flat" | "new";

export const OTHER_THEME = "other";

export interface Topic {
  id: string;
  name: string;
  keywords: string[];
  canonical_themes: string[];
  tags: string[];
  category: string | null;
  active: boolean;
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
  start: Date; // inclusive
  end: Date; // exclusive
  weekStart: string; // YYYY-MM-DD
  prevWeekStart: string;
}

export type ModelCaller = (prompt: string, opts?: { json?: boolean }) => Promise<string>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type SourceFetcher = (topic: Topic, window: FetchWindow) => Promise<FetchedPost[]>;
