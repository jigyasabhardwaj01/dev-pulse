import { supabaseFromEnv } from "./store";
import { legacyWindowForWeekStart } from "./week";
import { formatLegacyWeek, formatPeriod } from "./view";
import {
  buildReportView, summarizeRun, toHistoryRows, toListItem,
  type BriefDbRow, type FetchDbRow, type HistoryRow, type PeriodDbRow, type ReportListItem, type ReportView, type RunDbRow, type RunView,
  type TrendReliability,
} from "./report-model";

/*
 * Read-only queries for the pages. Each one tolerates the reliability/integrity migrations not being applied yet
 * (a missing table or column is treated as "no data of that kind"), so the site keeps working during a rollout.
 */
type Db = ReturnType<typeof supabaseFromEnv>;

async function readPeriods(db: Db): Promise<Map<string, PeriodDbRow>> {
  const { data, error } = await db.from("report_periods").select("week_start, period_start, period_end, coverage");
  return new Map(error ? [] : (data as PeriodDbRow[]).map((p) => [p.week_start, p]));
}

/** Report keys, newest first, split by convention. */
async function readKeys(db: Db, periods: Map<string, PeriodDbRow>) {
  const { data, error } = await db.from("briefs").select("week_start").order("week_start", { ascending: false });
  if (error) throw new Error(error.message);
  const all = (data as { week_start: string }[]).map((r) => r.week_start);
  const ist = all.filter((k) => periods.has(k)).sort((a, b) => b.localeCompare(a));
  const legacy = all.filter((k) => !periods.has(k));
  return { ist, legacy, all: new Set(all) };
}

/** A saved report. With no `weekStart`, the newest report under the IST convention (else the newest legacy one). */
export async function getReport(weekStart?: string): Promise<ReportView | null> {
  const db = supabaseFromEnv();
  const periods = await readPeriods(db);
  const keys = await readKeys(db, periods);
  const target = weekStart ?? keys.ist[0] ?? keys.legacy[0];
  if (!target || !keys.all.has(target)) return null;
  const { data, error } = await db.from("briefs").select("*").eq("week_start", target).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? buildReportView(data as BriefDbRow, periods.get(target) ?? null, keys.ist) : null;
}

/**
 * Does a saved report exist for this key? A cheap existence check so a page can return a genuine 404 BEFORE it starts streaming.
 * Throws on a database error; callers decide how to degrade (the pages treat that as "exists" and show their own error state).
 */
export async function hasReport(weekStart: string): Promise<boolean> {
  const { data, error } = await supabaseFromEnv().from("briefs").select("week_start").eq("week_start", weekStart).maybeSingle();
  if (error) throw new Error(error.message);
  return data !== null;
}

/** Every saved report, newest first: reports under the IST convention, then the earlier-format ones. */
export async function listReports(): Promise<ReportListItem[]> {
  const db = supabaseFromEnv();
  const periods = await readPeriods(db);
  const { data, error } = await db.from("briefs").select("*");
  if (error) throw new Error(error.message);
  const rows = (data as BriefDbRow[]).map((b) => toListItem(b, periods.get(b.week_start) ?? null));
  const byWeek = (a: ReportListItem, b: ReportListItem) => b.weekStart.localeCompare(a.weekStart);
  return [...rows.filter((r) => r.kind === "ist").sort(byWeek), ...rows.filter((r) => r.kind === "legacy").sort(byWeek)];
}

export interface HistoryData {
  series: string[];
  rows: HistoryRow[];
  /** true when only earlier-format weeks exist (no IST-convention week has been recorded yet). */
  legacyOnly: boolean;
}

export async function getHistory(maxSeries = 8): Promise<HistoryData> {
  const db = supabaseFromEnv();
  const [aggs, topics, periods] = await Promise.all([
    db.from("weekly_aggregates").select("week_start, topic_id, theme, mention_count").order("week_start"),
    db.from("topics").select("id, name"),
    readPeriods(db),
  ]);
  if (aggs.error) throw new Error(aggs.error.message);
  if (topics.error) throw new Error(topics.error.message);
  const names = new Map((topics.data ?? []).map((t) => [t.id as string, t.name as string]));
  // Weeks recorded under the IST convention are comparable with each other. Earlier-format weeks are shown only
  // until at least one IST week exists, and are never mixed with them.
  const legacyOnly = periods.size === 0;
  const rows = (aggs.data ?? []).filter((a) => legacyOnly || periods.has(a.week_start as string)) as
    { week_start: string; topic_id: string; theme: string; mention_count: number }[];
  const states = new Map<string, TrendReliability>();
  for (const [k, p] of periods) states.set(k, (p.coverage?.comparison?.state ?? "no_prior") as TrendReliability);
  return { ...toHistoryRows(rows, names, states, maxSeries), legacyOnly };
}

export interface PostRow {
  id: string; source: string; title: string; body: string; url: string | null; author: string | null;
  posted_at: string; unresolved: boolean | null; sentiment: string | null;
}
export interface PostFilters { source?: string; unresolvedOnly?: boolean; sentiment?: string }

/** The underlying posts behind one (week, topic, theme) count, newest first. */
export async function getPostsFor(topicId: string, theme: string, weekStart: string, filters: PostFilters = {}) {
  const db = supabaseFromEnv();
  const rp = await db.from("report_periods").select("period_start, period_end").eq("week_start", weekStart).maybeSingle();
  const isIst = !rp.error && Boolean(rp.data);
  const { start, end } = isIst
    ? { start: new Date(rp.data!.period_start as string), end: new Date(rp.data!.period_end as string) }
    : legacyWindowForWeekStart(weekStart);
  const [all, topic] = await Promise.all([
    db.from("raw_posts").select("id, source, title, body, url, author, posted_at, unresolved, sentiment")
      .eq("topic_id", topicId).eq("theme", theme)
      .gte("posted_at", start.toISOString()).lt("posted_at", end.toISOString())
      .order("posted_at", { ascending: false }).order("id").limit(300),
    db.from("topics").select("name").eq("id", topicId).maybeSingle(),
  ]);
  if (all.error) throw new Error(all.error.message);
  const rows = (all.data ?? []) as PostRow[];
  const bySource: Record<string, number> = {};
  for (const r of rows) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  const posts = rows.filter((r) =>
    (!filters.source || r.source === filters.source) &&
    (!filters.unresolvedOnly || r.unresolved === true) &&
    (!filters.sentiment || r.sentiment === filters.sentiment));
  return { posts, total: rows.length, bySource, topicName: (topic.data?.name as string) ?? "", periodLabel: isIst ? formatPeriod(weekStart) : formatLegacyWeek(weekStart) };
}

/** Recent pipeline runs with per-source health. Null when the run-history tables do not exist yet. */
export async function getRecentRuns(limit = 8): Promise<RunView[] | null> {
  const db = supabaseFromEnv();
  const runs = await db.from("pipeline_runs").select("*").order("started_at", { ascending: false }).limit(limit);
  if (runs.error) return null;
  const list = (runs.data ?? []) as RunDbRow[];
  if (!list.length) return [];
  const f = await db.from("source_fetches").select("run_id, source, status, requests, failed_requests, fetched, accepted, inserted, truncated, error, duration_ms").in("run_id", list.map((r) => r.id));
  const fetches = (f.error ? [] : f.data) as FetchDbRow[];
  return list.map((r) => summarizeRun(r, fetches));
}
