import { SOURCE_LABEL, type Comparison, type Coverage } from "./coverage";
import { isMostlyUnresolved } from "./trend";
import type { ThemeTrend } from "./types";
import { formatPeriod, istPeriodFromKey, type ReportStats } from "./view";

/*
 * Presentation logic for the dashboard. Pure functions over data that is already stored; nothing here fetches,
 * recalculates a trend, or changes a saved report. Whatever `displayPoints` withheld stays withheld.
 */

const IST = "Asia/Kolkata";
const DAY = 86_400_000;
const label = (s: string) => SOURCE_LABEL[s] ?? s;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Report key of the period before this one (the comparison baseline). */
export function previousWeekKey(weekStart: string): string | null {
  const start = istPeriodFromKey(weekStart).start;
  if (Number.isNaN(start.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(start.getTime() - 7 * DAY));
}

/** "25 Sep – 1 Oct": compact range for chips. */
export function shortRange(weekStart: string): string {
  const { start, end } = istPeriodFromKey(weekStart);
  if (Number.isNaN(start.getTime())) return "";
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "numeric", month: "short" });
  return `${f.format(start)} – ${f.format(new Date(end.getTime() - 1))}`;
}

// ---------------------------------------------------------------------------------------------------------------
export type MovementKind = "up" | "down" | "new" | "flat" | "na";
export interface Movement {
  kind: MovementKind;
  /** Compact visible text, e.g. "+6", "New", "No change", "Not compared". */
  label: string;
  /** Counts that back it, e.g. "1 → 7". Empty when there is no baseline. */
  counts: string;
  /** Complete sentence for assistive technology and tooltips. */
  sentence: string;
}

/** A percentage is only quoted when the baseline is large enough for it to mean something. */
export const MIN_BASELINE_FOR_PERCENT = 5;

/** Movement of one pain point. Direction comes from the stored trend; this only words it and never invents a baseline. */
export function movement(p: Pick<ThemeTrend, "direction" | "count" | "previous" | "pct">): Movement {
  switch (p.direction) {
    case "unavailable":
      return { kind: "na", label: "Not compared", counts: "", sentence: "Not compared with the previous period: source coverage differs, so a rise or fall would not be reliable." };
    case "new":
      return { kind: "new", label: "New", counts: `0 → ${p.count}`, sentence: `New this period: ${p.count} ${p.count === 1 ? "mention" : "mentions"}, none in the previous period.` };
    case "up": {
      const d = p.count - p.previous;
      const pc = p.previous >= MIN_BASELINE_FOR_PERCENT && p.pct !== null ? ` (+${p.pct}%)` : "";
      return { kind: "up", label: `+${d}${pc}`, counts: `${p.previous} → ${p.count}`, sentence: `Up ${d} from ${p.previous} to ${p.count} mentions.` };
    }
    case "down": {
      const d = p.previous - p.count;
      if (p.count === 0) return { kind: "down", label: "Dropped to 0", counts: `${p.previous} → 0`, sentence: `Dropped from ${p.previous} mentions to none.` };
      const pc = p.previous >= MIN_BASELINE_FOR_PERCENT && p.pct !== null ? ` (−${Math.abs(p.pct)}%)` : "";
      return { kind: "down", label: `−${d}${pc}`, counts: `${p.previous} → ${p.count}`, sentence: `Down ${d} from ${p.previous} to ${p.count} mentions.` };
    }
    default:
      return { kind: "flat", label: "No change", counts: `${p.previous} → ${p.count}`, sentence: `No change: ${p.count} mentions, same as the previous period.` };
  }
}

// ---------------------------------------------------------------------------------------------------------------
export interface Mover {
  theme: string;
  topic_id: string;
  category: string;
  count: number;
  previous: number;
  unresolved_count: number;
  move: Movement;
}
export interface Movers {
  comparable: boolean;
  increases: Mover[];
  emerging: Mover[];
  decreases: Mover[];
  /** Pain points with the most flagged-unresolved mentions. Based on counts alone, so available whether or not trends are. */
  unresolved: Mover[];
  /** Largest pain points by mentions: the fallback when trends are withheld. */
  biggest: Mover[];
}

const toMover = (p: ThemeTrend): Mover => ({
  theme: p.theme, topic_id: p.topic_id, category: p.topic_name, count: p.count, previous: p.previous, unresolved_count: p.unresolved_count, move: movement(p),
});
const byCount = (a: ThemeTrend, b: ThemeTrend) => b.count - a.count || a.theme.localeCompare(b.theme);

/** `points` must be the output of `displayPoints`: withheld trends arrive as "unavailable" and yield no movers. */
export function selectMovers(points: ThemeTrend[], limit = 3): Movers {
  const comparable = points.some((p) => p.direction !== "unavailable");
  const live = points.filter((p) => p.count > 0 || p.previous > 0);
  const cut = (xs: ThemeTrend[]) => xs.slice(0, limit).map(toMover);
  return {
    comparable,
    increases: comparable ? cut(live.filter((p) => p.direction === "up").sort((a, b) => (b.count - b.previous) - (a.count - a.previous) || byCount(a, b))) : [],
    emerging: comparable ? cut(live.filter((p) => p.direction === "new").sort(byCount)) : [],
    decreases: comparable ? cut(live.filter((p) => p.direction === "down").sort((a, b) => (b.previous - b.count) - (a.previous - a.count) || byCount(a, b))) : [],
    unresolved: cut(points.filter((p) => p.unresolved_count > 0).sort((a, b) => b.unresolved_count - a.unresolved_count || byCount(a, b))),
    biggest: cut(points.filter((p) => p.count > 0).sort(byCount)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
export interface Kpis {
  mentions: number;
  /** Mentions in the previous period over the same themes; null unless the comparison is fair and the baseline is real. */
  previousMentions: number | null;
  painPoints: number;
  /** Pain points with no mention in the previous period; null when trends are withheld. */
  emerging: number | null;
  unresolvedMentions: number;
  unresolvedPainPoints: number;
  unresolvedShare: number;
}

export function computeKpis(points: ThemeTrend[], stats: ReportStats): Kpis {
  const comparable = points.some((p) => p.direction !== "unavailable");
  const prev = comparable ? points.reduce((s, p) => s + p.previous, 0) : 0;
  return {
    mentions: stats.mentions,
    previousMentions: comparable && prev > 0 ? prev : null,
    painPoints: stats.painPoints,
    emerging: comparable ? points.filter((p) => p.direction === "new").length : null,
    unresolvedMentions: stats.unresolvedMentions,
    unresolvedPainPoints: points.filter((p) => p.count > 0 && isMostlyUnresolved(p.count, p.unresolved_count)).length,
    unresolvedShare: stats.unresolvedShare,
  };
}

// ---------------------------------------------------------------------------------------------------------------
export type Reliability = "comparable" | "no_prior" | "incomparable" | "legacy";
export interface ComparisonStatus { tone: "ok" | "info" | "warn" | "neutral"; label: string; detail: string }

/** One line saying what the selected week was (or was not) compared with. */
export function comparisonStatus(reliability: Reliability, weekStart: string): ComparisonStatus {
  switch (reliability) {
    case "comparable": {
      const prev = previousWeekKey(weekStart);
      const range = prev ? shortRange(prev) : "";
      return { tone: "ok", label: range ? `Compared with ${range}` : "Compared with the previous period", detail: "Source coverage matched, so week-over-week changes are reliable." };
    }
    case "no_prior": return { tone: "info", label: "No earlier period to compare", detail: "This is the first report on the weekly period format; trends start with the next one." };
    case "incomparable": return { tone: "warn", label: "Trends withheld", detail: "Source coverage differed from the previous period, so a rise or fall would not be reliable. Counts are still accurate." };
    default: return { tone: "neutral", label: "Earlier format", detail: "Recorded before source coverage was tracked, so trends are not shown." };
  }
}

// ---------------------------------------------------------------------------------------------------------------
export interface CoverageNote { level: "warn" | "info"; scope: "this" | "previous" | "both"; text: string }
export interface CoverageReading {
  /** none: nothing to qualify. info: read with some care. warn: coverage changes how to read the report. */
  level: "none" | "info" | "warn";
  /** The concise, always-visible sentence. Null when level is none. */
  headline: string | null;
  notes: CoverageNote[];
}

const PREVIOUS_CAP = /^(.+?) results hit the page limit in the previous period/;
const THIS_CAP = /^(.+?) results hit the page limit this period/;
const labelToSource = (l: string) => Object.entries(SOURCE_LABEL).find(([, v]) => v === l)?.[0] ?? l;

/**
 * Collapses the stored coverage and caveats into a headline plus a short list of notes. Identical page-limit warnings
 * for this and the previous period become one note per scope instead of one line each, and every note says which period
 * it affects. A failed or partial source is never described as having returned zero posts.
 */
export function readCoverage(sources: Coverage | null | undefined, comparison: Comparison | null | undefined, reliability: Reliability): CoverageReading {
  const notes: CoverageNote[] = [];
  const entries = (Object.entries(sources ?? {}) as [string, { status: string; posts: number; truncated?: boolean }][]).filter(([, v]) => v);
  const failed = entries.filter(([, v]) => v.status === "error").map(([k]) => label(k));
  const partial = entries.filter(([, v]) => v.status === "partial").map(([k]) => label(k));

  if (failed.length) notes.push({ level: "warn", scope: "this", text: `${list(failed)} failed to return data this period. Its posts are missing from the counts; this is not zero posts.` });
  if (partial.length) notes.push({ level: "warn", scope: "this", text: `${list(partial)} ${partial.length === 1 ? "was" : "were"} only partly collected (some requests failed or were rate limited), so ${partial.length === 1 ? "its" : "their"} counts may be understated.` });
  if (reliability === "incomparable") {
    const reasons = comparison?.reasons ?? [];
    notes.push({ level: "warn", scope: "both", text: `Trends are withheld because source coverage differs from the previous period.${reasons.length ? ` ${reasons.join("; ")}.` : ""}` });
  }
  if (reliability === "no_prior") notes.push({ level: "info", scope: "previous", text: "There is no earlier report on the same weekly period format, so nothing is compared yet." });
  if (reliability === "legacy") notes.push({ level: "info", scope: "this", text: "This report predates source-coverage tracking, so source health and trends are unknown." });

  const cappedThis = new Set(entries.filter(([, v]) => v.truncated).map(([k]) => k));
  const cappedPrev = new Set<string>();
  const other: string[] = [];
  for (const c of comparison?.caveats ?? []) {
    const m = PREVIOUS_CAP.exec(c);
    if (m) { cappedPrev.add(labelToSource(m[1])); continue; }
    const t = THIS_CAP.exec(c);
    if (t) { cappedThis.add(labelToSource(t[1])); continue; }
    other.push(c);
  }
  const both = [...cappedThis].filter((s) => cappedPrev.has(s));
  const onlyThis = [...cappedThis].filter((s) => !cappedPrev.has(s));
  const onlyPrev = [...cappedPrev].filter((s) => !cappedThis.has(s));
  const names = (xs: string[]) => list(xs.map(label));
  if (both.length) notes.push({ level: "info", scope: "both", text: `${names(both)} hit the page limit in both this and the previous period, so ${both.length === 1 ? "its" : "their"} counts may be understated.` });
  if (onlyThis.length) notes.push({ level: "info", scope: "this", text: `${names(onlyThis)} hit the page limit this period, so ${onlyThis.length === 1 ? "its" : "their"} counts may be understated.` });
  if (onlyPrev.length) notes.push({ level: "info", scope: "previous", text: `${names(onlyPrev)} hit the page limit in the previous period, so the baseline may be understated.` });
  for (const o of other) notes.push({ level: "info", scope: "both", text: o.endsWith(".") ? o : `${o}.` });

  const parts: string[] = [];
  if (failed.length) parts.push(`${list(failed)} ${failed.length === 1 ? "failed" : "failed"}`);
  if (partial.length) parts.push(`${list(partial)} partly collected`);
  if (reliability === "incomparable") parts.push("trends withheld");
  const capped = [...new Set([...cappedThis, ...cappedPrev])];
  if (capped.length) parts.push(`page limits reached for ${names(capped)}`);
  if (reliability === "no_prior") parts.push("no earlier period to compare");
  if (reliability === "legacy") parts.push("earlier format, trends not shown");
  const level = notes.some((n) => n.level === "warn") ? "warn" : notes.length ? "info" : "none";
  return { level, headline: parts.length ? `${parts[0][0].toUpperCase()}${parts.join("; ").slice(1)}.` : null, notes };
}

// ---------------------------------------------------------------------------------------------------------------
export interface SourceRow {
  source: string;
  name: string;
  status: "ok" | "partial" | "error";
  /** Plain description of what the number means. Never "0 posts" for a failure. */
  state: string;
  posts: number | null;
  /** Share of all collected posts (0..1) when the source actually returned data. */
  share: number | null;
  capped: boolean;
}

export function sourceRows(sources: Coverage | null | undefined): SourceRow[] {
  const entries = (Object.entries(sources ?? {}) as [string, { status: "ok" | "partial" | "error"; posts: number; truncated?: boolean }][]).filter(([, v]) => v);
  const total = entries.reduce((s, [, v]) => s + (v.status === "error" ? 0 : v.posts), 0);
  return entries.map(([k, v]) => ({
    source: k,
    name: label(k),
    status: v.status,
    state: v.status === "error" ? "Failed: no data collected" : v.status === "partial" ? `Partly collected: ${v.posts} ${v.posts === 1 ? "post" : "posts"} (may be understated)` : v.posts === 0 ? "Collected: no posts in this period" : `Collected: ${v.posts} ${v.posts === 1 ? "post" : "posts"}`,
    posts: v.status === "error" ? null : v.posts,
    share: v.status === "error" || total === 0 ? null : v.posts / total,
    capped: Boolean(v.truncated),
  }));
}

/** The "week of" keys a report page links to; keeps URL building in one place. */
export const reportHref = (weekStart: string) => `/reports/${weekStart}`;
export const overviewHref = (weekStart?: string | null) => (weekStart ? `/?week=${weekStart}` : "/");
export const evidenceHref = (p: { topic_id: string; theme: string }, weekStart: string) =>
  `/posts?topic=${p.topic_id}&theme=${encodeURIComponent(p.theme)}&week=${weekStart}`;

export { formatPeriod };
