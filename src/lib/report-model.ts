import type { ThemeTrend } from "./types";
import type { Comparison, ComparisonState, Coverage, SourceStatus } from "./coverage";
import { coarseReason, parseDiagnostics, type Diagnostic } from "./diagnostics";
import { formatLegacyWeek, formatPeriod, summarizeReport, shortWeek, type ReportStats } from "./view";

/** What a `briefs` row looks like. Columns added by later migrations may be absent, so everything optional is optional. */
export interface BriefDbRow {
  week_start: string;
  narrative: string;
  top_pain_points: ThemeTrend[];
  created_at: string;
  coverage?: { sources: Coverage; comparison: Comparison } | null;
  version?: number | null;
  email_status?: "sending" | "sent" | "failed" | null;
  email_sent_at?: string | null;
  emailed_version?: number | null;
  used_fallback?: boolean | null;
}
export interface PeriodDbRow {
  week_start: string;
  period_start: string;
  period_end: string;
  coverage: { sources?: Coverage; comparison?: Comparison } | null;
}

/** "legacy" = recorded before reporting periods and source coverage existed; its trends cannot be vouched for. */
export type TrendReliability = ComparisonState | "legacy";
export type DeliveryStatus = "sent" | "sending" | "failed" | "not_sent" | "unknown";

export interface ReportView {
  weekStart: string;
  kind: "ist" | "legacy";
  periodLabel: string;
  narrative: string;
  /** Pain points as saved; use `displayPoints` for what may be shown. */
  points: ThemeTrend[];
  coverage: { sources: Coverage; comparison: Comparison } | null;
  reliability: TrendReliability;
  version: number | null;
  generatedAt: string;
  usedFallback: boolean;
  delivery: { status: DeliveryStatus; sentAt: string | null; version: number | null };
  nav: { prev: string | null; next: string | null };
  stats: ReportStats;
}

export function buildNav(istKeysNewestFirst: string[], weekStart: string): { prev: string | null; next: string | null } {
  const i = istKeysNewestFirst.indexOf(weekStart);
  if (i === -1) return { prev: null, next: null };
  return { prev: istKeysNewestFirst[i + 1] ?? null, next: i > 0 ? istKeysNewestFirst[i - 1] : null };
}

const deliveryOf = (b: BriefDbRow, kind: "ist" | "legacy"): ReportView["delivery"] => {
  if (kind === "legacy" && b.email_status === undefined) return { status: "unknown", sentAt: null, version: null };
  switch (b.email_status) {
    case "sent": return { status: "sent", sentAt: b.email_sent_at ?? null, version: b.emailed_version ?? null };
    case "sending": return { status: "sending", sentAt: null, version: null };
    case "failed": return { status: "failed", sentAt: null, version: null };
    default: return { status: kind === "legacy" ? "unknown" : "not_sent", sentAt: null, version: null };
  }
};

export function buildReportView(brief: BriefDbRow, period: PeriodDbRow | null, istKeysNewestFirst: string[]): ReportView {
  const kind = period ? "ist" : "legacy";
  // The coverage saved WITH the report version wins; the period record is the fallback for reports saved before versions existed.
  const cov = brief.coverage ?? (period?.coverage?.sources ? { sources: period.coverage.sources, comparison: period.coverage.comparison ?? { state: "no_prior" as const, reasons: [] } } : null);
  const points = brief.top_pain_points ?? [];
  return {
    weekStart: brief.week_start,
    kind,
    periodLabel: kind === "ist" ? formatPeriod(brief.week_start) : formatLegacyWeek(brief.week_start),
    narrative: brief.narrative,
    points,
    coverage: cov,
    reliability: kind === "legacy" || !cov ? "legacy" : cov.comparison.state,
    version: brief.version ?? null,
    generatedAt: brief.created_at,
    usedFallback: Boolean(brief.used_fallback),
    delivery: deliveryOf(brief, kind),
    nav: kind === "ist" ? buildNav(istKeysNewestFirst, brief.week_start) : { prev: null, next: null },
    stats: summarizeReport(points, cov?.sources),
  };
}

/**
 * The only pain points a page may show. Unless the comparison was fair, trend direction and percentage are
 * withheld (counts are kept), so an apparent rise or fall from different source coverage is never drawn as a trend.
 */
export function displayPoints(view: Pick<ReportView, "points" | "reliability">): ThemeTrend[] {
  if (view.reliability === "comparable") return view.points;
  return view.points.map((p) => ({ ...p, direction: "unavailable" as const, pct: null }));
}

export interface ReportListItem {
  weekStart: string;
  kind: "ist" | "legacy";
  periodLabel: string;
  mentions: number;
  painPoints: number;
  reliability: TrendReliability;
  delivery: DeliveryStatus;
  version: number | null;
  sourcesOk: number;
  sourcesTotal: number;
  /** Week-over-week counts; null when trends are withheld for that report (never zero). */
  emerging: number | null;
  rising: number | null;
  declining: number | null;
  /** The saved summary, for previews. */
  narrative: string;
}

export function toListItem(brief: BriefDbRow, period: PeriodDbRow | null): ReportListItem {
  const v = buildReportView(brief, period, []);
  const shown = displayPoints(v);
  const comparable = shown.some((p) => p.direction !== "unavailable");
  const n = (d: string) => (comparable ? shown.filter((p) => p.direction === d).length : null);
  return {
    weekStart: v.weekStart, kind: v.kind, periodLabel: v.periodLabel, mentions: v.stats.mentions, painPoints: v.stats.painPoints,
    reliability: v.reliability, delivery: v.delivery.status, version: v.version, sourcesOk: v.stats.sourcesOk, sourcesTotal: v.stats.sourcesTotal,
    emerging: n("new"), rising: n("up"), declining: n("down"), narrative: v.narrative,
  };
}

export interface HistoryRow { week: string; label: string; state: TrendReliability; [series: string]: string | number }

/** One chart row per week; `state` tells the chart which weeks are not fairly comparable with their neighbours. */
export function toHistoryRows(
  aggs: { week_start: string; topic_id: string; theme: string; mention_count: number }[],
  names: Map<string, string>,
  states: Map<string, TrendReliability>,
  maxSeries = 8,
): { series: string[]; rows: HistoryRow[] } {
  const nameOf = (a: { topic_id: string; theme: string }) => `${names.get(a.topic_id) ?? "?"} · ${a.theme}`;
  const totals = new Map<string, number>();
  for (const a of aggs) {
    if (a.theme === "other") continue;
    totals.set(nameOf(a), (totals.get(nameOf(a)) ?? 0) + a.mention_count);
  }
  const series = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxSeries).map(([s]) => s);
  const weeks = [...new Set(aggs.map((a) => a.week_start))].sort();
  const rows = weeks.map((w) => {
    const row: HistoryRow = { week: w, label: shortWeek(w), state: states.get(w) ?? "legacy" };
    for (const s of series) row[s] = 0;
    for (const a of aggs) if (a.week_start === w && series.includes(nameOf(a))) row[nameOf(a)] = a.mention_count;
    return row;
  });
  return { series, rows };
}

// ---------------------------------------------------------------------------------------------------------------
export interface RunDbRow {
  id: string; week_start: string; trigger: string; status: string; started_at: string; finished_at: string | null;
  email_status: string | null; used_fallback: boolean | null; error: string | null;
  fetched_total?: number | null; new_posts?: number | null; classified_ok?: number | null; classification_failed?: number | null;
  /** Pipeline warnings (sanitized strings). Only their NUMBER is ever shown on the public page. */
  warnings?: unknown;
}
export interface FetchDbRow {
  run_id: string; source: string; status: SourceStatus; fetched: number; accepted: number; inserted: number; truncated: boolean; error: string | null;
  /** Request-level telemetry, recorded per (run, topic, source). Optional so older rows and tests still work. */
  requests?: number | null; failed_requests?: number | null; duration_ms?: number | null;
}
export interface RunView {
  id: string; weekStart: string; periodLabel: string; trigger: string; status: string; startedAt: string; durationSec: number | null;
  emailStatus: string | null; usedFallback: boolean; problem: string | null; stuck: boolean;
  classified: number | null; unclassified: number | null; newPosts: number | null;
  sources: RunSourceView[];
  /** When the run recorded its end; null for a run that is running or was killed. */
  finishedAt: string | null;
  fetchedTotal: number | null;
  /** Warnings plus diagnostics recorded for the run (the raw text of legacy warnings is deliberately never exposed). */
  warningCount: number | null;
  /** Structured diagnostics: stable code, severity, stage, safe message. Empty for runs recorded before they existed. */
  diagnostics: Diagnostic[];
}

/** One source in one run, summed over its per-topic fetches. `status` is the worst status across topics; the counts say what really happened. */
export interface RunSourceView {
  source: string; status: SourceStatus; fetched: number; accepted: number; inserted: number; truncated: boolean; reason: string | null;
  /** Per-topic outcomes: how many topic fetches were ok, partly failed, or failed outright. */
  topics: { total: number; ok: number; partial: number; error: number };
  /** Requests made and failed, summed over topics. `known` is false when no row recorded request counts. */
  requests: number; failedRequests: number; requestsKnown: boolean;
  /** Longest single topic fetch, in milliseconds, or null when not recorded. */
  maxDurationMs: number | null;
}

export { coarseReason };

const RANK: Record<SourceStatus, number> = { ok: 0, partial: 1, error: 2 };
/** A function can run at most 300 s; a run still "running" long after that was killed. */
export const STUCK_AFTER_MS = 10 * 60_000;

export function summarizeRun(run: RunDbRow, fetches: FetchDbRow[], now: Date = new Date()): RunView {
  const per = new Map<string, RunSourceView>();
  for (const f of fetches.filter((x) => x.run_id === run.id)) {
    const cur = per.get(f.source) ?? {
      source: f.source, status: "ok" as SourceStatus, fetched: 0, accepted: 0, inserted: 0, truncated: false, reason: null as string | null,
      topics: { total: 0, ok: 0, partial: 0, error: 0 }, requests: 0, failedRequests: 0, requestsKnown: false, maxDurationMs: null as number | null,
    };
    cur.status = RANK[f.status] > RANK[cur.status] ? f.status : cur.status;
    cur.fetched += f.fetched; cur.accepted += f.accepted; cur.inserted += f.inserted;
    cur.truncated = cur.truncated || f.truncated;
    cur.reason = cur.reason ?? coarseReason(f.error);
    cur.topics.total += 1; cur.topics[f.status === "ok" ? "ok" : f.status === "partial" ? "partial" : "error"] += 1;
    if (typeof f.requests === "number" && f.requests > 0) { cur.requestsKnown = true; cur.requests += f.requests; cur.failedRequests += Math.max(0, f.failed_requests ?? 0); }
    if (typeof f.duration_ms === "number") cur.maxDurationMs = Math.max(cur.maxDurationMs ?? 0, f.duration_ms);
    per.set(f.source, cur);
  }
  const started = new Date(run.started_at).getTime();
  const finished = run.finished_at ? new Date(run.finished_at).getTime() : null;
  return {
    id: run.id, weekStart: run.week_start, periodLabel: formatPeriod(run.week_start), trigger: run.trigger, status: run.status,
    startedAt: run.started_at, durationSec: finished ? Math.round((finished - started) / 1000) : null,
    emailStatus: run.email_status, usedFallback: Boolean(run.used_fallback), problem: run.error ? "The run reported a problem. See the server logs for details." : null,
    stuck: run.status === "running" && now.getTime() - started > STUCK_AFTER_MS,
    classified: run.classified_ok ?? null, unclassified: run.classification_failed ?? null, newPosts: run.new_posts ?? null,
    finishedAt: run.finished_at, fetchedTotal: run.fetched_total ?? null,
    warningCount: Array.isArray(run.warnings) ? run.warnings.length : null, diagnostics: parseDiagnostics(run.warnings).items,
    sources: [...per.values()].sort((a, b) => a.source.localeCompare(b.source)),
  };
}
