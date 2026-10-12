import { assessComparison, type ComparisonState, type Coverage } from "./coverage";
import { OTHER_THEME, type Direction, type Resolution, type ThemeCount, type ThemeTrend } from "./types";

/*
 * Weekly analysis: stable pain-point aggregation, an honest baseline, and a ranking whose every factor is explained.
 * Pure functions over stored data. The result is JSON-serialisable and contains nothing volatile (no timestamps of its own),
 * so the same inputs always produce the same analysis and it can be sealed with the report version.
 */
export const SOURCES = ["hn", "stackoverflow", "reddit", "github"] as const;
export const ANALYSIS_VERSION = 1;

export interface EvidencePost {
  id: string;
  source: string;
  topic_id: string;
  theme: string;
  title: string;
  url: string | null;
  author: string | null;
  posted_at: string;
  confidence: number | null;
  excerpt: string | null;
  resolution: Resolution | null;
  unresolved: boolean | null;
  flags: string[];
}

export interface EvidenceLink { id: string; source: string; url: string | null; title: string; excerpt: string | null; posted_at: string; confidence: number | null }
export type EvidenceStrength = "strong" | "moderate" | "limited";
export type PainStatus = "new" | "rising" | "declining" | "steady" | "unavailable";

export interface Factor { name: string; weight: number; value: number; contribution: number; note: string }

export interface PainPointAnalysis {
  key: string;
  topic_id: string;
  topic_name: string;
  theme: string;
  /** Distinct discussion threads (comments under one thread are one discussion). */
  discussions: number;
  /** All posts counted, before collapsing threads and duplicates. */
  rawPosts: number;
  /** Discussions as used for ranking: each thread counts as at most 1.25, however many comments it has. */
  effectiveDiscussions: number;
  sources: Record<string, number>;
  distinctSources: number;
  /** Distinct authors, or null when too many posts lack an author to say. Never inferred from post counts. */
  authors: number | null;
  authorsKnownPosts: number;
  firstSeen: string;
  lastSeen: string;
  resolution: { open: number; resolved: number; uncertain: number };
  evidence: { strength: EvidenceStrength; meanConfidence: number | null; withExcerpt: number; earlySignals: number };
  trend: { direction: Direction; previous: number; delta: number; pct: number | null; comparable: boolean };
  baseline: { mean: number; weeks: number; vsBaseline: number } | null;
  persistence: { weeksPresent: number; of: number } | null;
  status: PainStatus;
  eligibleForTop: boolean;
  score: number;
  factors: Factor[];
  links: EvidenceLink[];
}

export interface PriorWeek { weekStart: string; counts: ThemeCount[]; coverage: Coverage | null; legacy?: boolean }

export interface Baseline {
  available: boolean;
  weeks: number;
  method: string;
  /** Why it is unavailable (or a caveat when available). */
  reason: string | null;
}

export interface ReportAnalysis {
  version: number;
  scoring: { model: string; weights: Record<string, number>; note: string };
  painPoints: PainPointAnalysis[];
  top: string[];
  baseline: Baseline;
  totals: { relevantDiscussions: number; painPoints: number; emerging: number; rising: number; declining: number; unresolved: number; uncertain: number; earlySignals: number };
  limitations: string[];
}

// ---------------------------------------------------------------------------------------------------------------------------
/** The scoring model. Weights sum to 1. Documented in BACKEND.md and shown with every ranked item. */
export const WEIGHTS = { frequency: 0.35, change: 0.2, persistence: 0.15, breadth: 0.15, unresolved: 0.1, strength: 0.05 } as const;
/** A thread may count as at most this many discussions however many comments it holds, so one viral thread cannot dominate. */
export const THREAD_CAP = 1.25;
export const MIN_AUTHOR_COVERAGE = 0.5;
export const BASELINE_WEEKS = 4;
export const TOP_N = 3;
/** To be ranked in the top list a pain point needs at least this many distinct discussions and one verified supporting excerpt. */
export const TOP_MIN_DISCUSSIONS = 2;

// "|" not NUL: this key is stored inside the sealed analysis (jsonb), which cannot hold U+0000. topic_id is a uuid, so it is unambiguous.
const key = (c: { topic_id: string; theme: string }) => `${c.topic_id}|${c.theme}`;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Identity of a discussion: the same thread title in the same source is one discussion (many comments, one conversation). */
function threadKey(p: EvidencePost): string {
  const t = norm(p.title);
  return t.length >= 12 ? `${p.source}|${t}` : `${p.source}|id:${p.id}`;
}
/** Identity for removing exact repeats: the same author posting the same title anywhere is one post. */
function repeatKey(p: EvidencePost): string | null {
  const t = norm(p.title);
  return p.author && t.length >= 12 ? `${p.author.toLowerCase()}|${t}` : null;
}

function resolutionOf(p: EvidencePost): Resolution {
  if (p.resolution) return p.resolution;
  return p.unresolved ? "open" : "uncertain"; // posts classified before resolution existed: never assumed resolved
}

// ---------------------------------------------------------------------------------------------------------------------------
/**
 * The baseline is the mean of the FOUR immediately preceding weeks, and exists only if all four are present, consecutive,
 * recorded under the same period convention, and comparable with this week's source coverage. Otherwise it is unavailable.
 */
export function computeBaseline(currentWeek: string, current: Coverage | null, prior: PriorWeek[]): { baseline: Baseline; means: Map<string, number> } {
  const method = `mean of the ${BASELINE_WEEKS} preceding weeks`;
  const none = (reason: string) => ({ baseline: { available: false, weeks: 0, method, reason }, means: new Map<string, number>() });
  if (!current) return none("This report has no recorded source coverage, so earlier weeks cannot be compared with it.");
  const wanted = Array.from({ length: BASELINE_WEEKS }, (_, i) => shiftWeek(currentWeek, -(i + 1)));
  const have = new Map(prior.map((p) => [p.weekStart, p]));
  const found = wanted.map((w) => have.get(w));
  const present = found.filter((p): p is PriorWeek => Boolean(p) && !p!.legacy && p!.coverage !== null);
  if (present.length < BASELINE_WEEKS) return none(`Only ${present.length} of the ${BASELINE_WEEKS} preceding weeks have comparable records, so no ${BASELINE_WEEKS}-week baseline is shown.`);
  const incomparable = present.filter((p) => assessComparison(current, p.coverage).state !== "comparable");
  if (incomparable.length) return none(`${incomparable.length} of the ${BASELINE_WEEKS} preceding weeks had different source coverage, so no ${BASELINE_WEEKS}-week baseline is shown.`);
  const sums = new Map<string, number>();
  for (const p of present) for (const c of p.counts) sums.set(key(c), (sums.get(key(c)) ?? 0) + c.count);
  const means = new Map([...sums].map(([k, v]) => [k, round(v / BASELINE_WEEKS, 2)]));
  return { baseline: { available: true, weeks: BASELINE_WEEKS, method, reason: null }, means };
}

/** Report keys are IST dates of a Friday; weeks are exactly 7 days apart. */
export function shiftWeek(weekStart: string, weeks: number): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------------------------------
export interface AnalysisInput {
  weekStart: string;
  posts: EvidencePost[];
  trends: ThemeTrend[];
  topicNames: Record<string, string>;
  coverage: Coverage | null;
  comparison: ComparisonState;
  prior: PriorWeek[];
  pendingPosts?: number;
}

export function analyse(input: AnalysisInput): ReportAnalysis {
  const { posts, trends, topicNames, comparison } = input;
  const comparable = comparison === "comparable";
  const trendBy = new Map(trends.map((t) => [key(t), t]));
  const { baseline, means } = computeBaseline(input.weekStart, input.coverage, input.prior);

  const groups = new Map<string, EvidencePost[]>();
  for (const p of posts) {
    if (p.theme === OTHER_THEME) continue;
    const k = key(p);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
  }

  // consecutive prior weeks that are comparable with this one (for persistence)
  const priorComparable = input.prior
    .filter((p) => !p.legacy && p.coverage && input.coverage && assessComparison(input.coverage, p.coverage).state === "comparable")
    .slice(0, BASELINE_WEEKS);

  const built: Omit<PainPointAnalysis, "score" | "factors" | "eligibleForTop">[] = [];
  for (const [k, group] of groups) {
    // remove exact repeats first, then collapse threads
    const seen = new Set<string>();
    const unique = group.filter((p) => { const r = repeatKey(p); if (!r) return true; if (seen.has(r)) return false; seen.add(r); return true; });
    const threads = new Map<string, EvidencePost[]>();
    for (const p of unique) (threads.get(threadKey(p)) ?? threads.set(threadKey(p), []).get(threadKey(p))!).push(p);
    const effective = [...threads.values()].reduce((s, t) => s + 1 + Math.min(0.25 * (t.length - 1), THREAD_CAP - 1), 0);
    const sources: Record<string, number> = {};
    for (const t of threads.values()) sources[t[0].source] = (sources[t[0].source] ?? 0) + 1;
    // keys in a fixed order, so the stored JSON never depends on the order posts arrived in
    for (const s of Object.keys(sources).sort()) { const n = sources[s]; delete sources[s]; sources[s] = n; }
    const withAuthor = unique.filter((p) => p.author && p.author.trim());
    const authorsKnownPosts = withAuthor.length;
    const authors = authorsKnownPosts / Math.max(unique.length, 1) >= MIN_AUTHOR_COVERAGE ? new Set(withAuthor.map((p) => p.author!.toLowerCase())).size : null;
    const dates = unique.map((p) => p.posted_at).sort();
    const res = { open: 0, resolved: 0, uncertain: 0 };
    for (const p of unique) res[resolutionOf(p)]++;
    const confs = unique.map((p) => p.confidence).filter((c): c is number => typeof c === "number");
    const meanConfidence = confs.length ? round(confs.reduce((a, b) => a + b, 0) / confs.length, 2) : null;
    const withExcerpt = unique.filter((p) => p.excerpt).length;
    const earlySignals = unique.filter((p) => p.flags.includes("early_signal")).length;
    const strength: EvidenceStrength =
      earlySignals > unique.length / 2 ? "limited"
        : threads.size >= 3 && Object.keys(sources).length >= 2 && withExcerpt >= 2 && (meanConfidence ?? 0.6) >= 0.6 ? "strong"
          : threads.size >= 2 && withExcerpt >= 1 ? "moderate" : "limited";
    const t = trendBy.get(k);
    const prev = t?.previous ?? 0;
    const direction: Direction = comparable ? (t?.direction ?? "new") : "unavailable";
    const links: EvidenceLink[] = [...unique]
      .sort((a, b) => (b.excerpt ? 1 : 0) - (a.excerpt ? 1 : 0) || (b.confidence ?? 0) - (a.confidence ?? 0) || b.posted_at.localeCompare(a.posted_at) || a.id.localeCompare(b.id))
      .slice(0, 5)
      .map((p) => ({ id: p.id, source: p.source, url: p.url, title: p.title.slice(0, 160), excerpt: p.excerpt, posted_at: p.posted_at, confidence: p.confidence }));
    const mean = baseline.available ? (means.get(k) ?? 0) : null;
    const weeksPresent = priorComparable.filter((w) => w.counts.some((c) => key(c) === k && c.count > 0)).length;
    const status: PainStatus = !comparable ? "unavailable" : direction === "new" ? "new" : direction === "up" && t && t.count - prev >= Math.max(2, prev * 0.25) ? "rising" : direction === "down" && t && prev - t.count >= Math.max(2, prev * 0.25) ? "declining" : "steady";
    built.push({
      key: k, topic_id: group[0].topic_id, topic_name: topicNames[group[0].topic_id] ?? "Unknown topic", theme: group[0].theme,
      discussions: threads.size, rawPosts: group.length, effectiveDiscussions: round(effective, 2), sources, distinctSources: Object.keys(sources).length,
      authors, authorsKnownPosts, firstSeen: dates[0], lastSeen: dates[dates.length - 1], resolution: res,
      evidence: { strength, meanConfidence, withExcerpt, earlySignals },
      trend: { direction, previous: prev, delta: comparable ? (t?.count ?? unique.length) - prev : 0, pct: comparable ? (t?.pct ?? null) : null, comparable },
      baseline: mean === null ? null : { mean, weeks: BASELINE_WEEKS, vsBaseline: round((t?.count ?? unique.length) - mean, 2) },
      persistence: priorComparable.length >= 1 ? { weeksPresent, of: priorComparable.length } : null,
      status, links,
    });
  }

  const maxEff = Math.max(1, ...built.map((b) => b.effectiveDiscussions));
  const ranked = built.map((b): PainPointAnalysis => {
    const frequency = Math.log2(1 + b.effectiveDiscussions) / Math.log2(1 + maxEff);
    const sourceBreadth = b.distinctSources / SOURCES.length;
    const authorBreadth = b.authors === null ? null : clamp01(b.authors / Math.max(b.discussions, 1));
    const breadth = authorBreadth === null ? sourceBreadth : 0.6 * sourceBreadth + 0.4 * authorBreadth;
    // change: from the week-over-week trend when comparable, blended with the baseline when one exists; otherwise neutral
    let change = 0.5;
    let changeNote = "No fair comparison with last week, so change is neutral (0.5).";
    if (b.trend.comparable) {
      const x = b.trend.direction === "new" ? 0.6 : clamp01((b.trend.delta / Math.max(b.trend.previous, 3) + 1) / 2);
      change = x; changeNote = b.trend.direction === "new" ? "New this week (0.6)." : `${b.trend.delta >= 0 ? "+" : ""}${b.trend.delta} vs last week.`;
      if (b.baseline) { const y = clamp01((b.baseline.vsBaseline / Math.max(b.baseline.mean, 3) + 1) / 2); change = (x + y) / 2; changeNote += ` ${b.baseline.vsBaseline >= 0 ? "+" : ""}${b.baseline.vsBaseline} vs the 4-week mean.`; }
    }
    const persistence = b.persistence ? b.persistence.weeksPresent / Math.max(b.persistence.of, 1) : 0;
    const total = b.resolution.open + b.resolution.resolved + b.resolution.uncertain;
    const unresolved = total ? (b.resolution.open + 0.5 * b.resolution.uncertain) / total : 0;
    const strengthVal = b.evidence.strength === "strong" ? 1 : b.evidence.strength === "moderate" ? 0.6 : 0.3;
    const factors: Factor[] = ([
      ["frequency", frequency, `${b.effectiveDiscussions} effective discussions (threads capped at ${THREAD_CAP}); log-scaled against the largest.`],
      ["change", change, changeNote],
      ["persistence", persistence, b.persistence ? `Present in ${b.persistence.weeksPresent} of ${b.persistence.of} comparable earlier weeks.` : "No comparable earlier weeks, so persistence is 0."],
      ["breadth", breadth, `${b.distinctSources} source${b.distinctSources === 1 ? "" : "s"}${b.authors === null ? "; authors unknown for too many posts, so not counted" : `, ${b.authors} distinct author${b.authors === 1 ? "" : "s"}`}.`],
      ["unresolved", unresolved, `${b.resolution.open} open, ${b.resolution.uncertain} uncertain, ${b.resolution.resolved} resolved (uncertain counts half).`],
      ["strength", strengthVal, `Evidence is ${b.evidence.strength}${b.evidence.meanConfidence === null ? "" : `; the model's own confidence (${b.evidence.meanConfidence}) has only this small weight`}.`],
    ] as [keyof typeof WEIGHTS, number, string][]).map(([name, value, note]) => ({ name, weight: WEIGHTS[name], value: round(value), contribution: round(WEIGHTS[name] * value * 100, 1), note }));
    const score = round(factors.reduce((s, f) => s + f.contribution, 0), 1);
    const eligibleForTop = b.discussions >= TOP_MIN_DISCUSSIONS && b.evidence.withExcerpt >= 1 && b.evidence.earlySignals <= b.discussions / 2;
    return { ...b, score, factors, eligibleForTop };
  }).sort((a, b) => b.score - a.score || b.discussions - a.discussions || a.theme.localeCompare(b.theme) || a.topic_id.localeCompare(b.topic_id));

  const top = ranked.filter((r) => r.eligibleForTop).slice(0, TOP_N).map((r) => r.key);
  const totals = {
    relevantDiscussions: ranked.reduce((s, r) => s + r.discussions, 0),
    painPoints: ranked.length,
    emerging: ranked.filter((r) => r.status === "new").length,
    rising: ranked.filter((r) => r.status === "rising").length,
    declining: ranked.filter((r) => r.status === "declining").length,
    unresolved: ranked.reduce((s, r) => s + r.resolution.open, 0),
    uncertain: ranked.reduce((s, r) => s + r.resolution.uncertain, 0),
    earlySignals: ranked.reduce((s, r) => s + r.evidence.earlySignals, 0),
  };

  const limitations: string[] = [];
  const cov = Object.entries(input.coverage ?? {}) as [string, { status: string; posts: number; truncated?: boolean }][];
  const nameOf = (s: string) => ({ hn: "Hacker News", stackoverflow: "Stack Overflow", reddit: "Reddit", github: "GitHub" } as Record<string, string>)[s] ?? s;
  for (const [s, v] of cov) {
    if (v.status === "error") limitations.push(`${nameOf(s)} could not be collected this period; its discussions are missing from these counts.`);
    else if (v.status === "partial") limitations.push(`${nameOf(s)} was only partly collected, so its counts may be understated.`);
  }
  const capped = cov.filter(([, v]) => v.truncated).map(([s]) => nameOf(s));
  if (capped.length) limitations.push(`${capped.join(" and ")} returned only the newest results (page limit), so counts are a sample, not exhaustive.`);
  if (!baseline.available && baseline.reason) limitations.push(baseline.reason);
  if (comparison !== "comparable") limitations.push(comparison === "no_prior" ? "There is no earlier week on the same period format to compare with." : "Source coverage differs from last week, so week-over-week change is not shown.");
  if (totals.earlySignals) limitations.push(`${totals.earlySignals} supporting ${totals.earlySignals === 1 ? "discussion is" : "discussions are"} early signals with low confidence.`);
  if (ranked.some((r) => r.authors === null)) limitations.push("Some pain points have too many posts without an author to count distinct developers; those are not estimated.");
  if ((input.pendingPosts ?? 0) > 0) limitations.push(`${input.pendingPosts} collected posts were still waiting for classification when this report was built.`);
  if (ranked.length && top.length < Math.min(TOP_N, ranked.length)) limitations.push(`Only ${top.length} pain point${top.length === 1 ? " has" : "s have"} enough supporting evidence (at least ${TOP_MIN_DISCUSSIONS} discussions and a verified excerpt) to be ranked.`);

  return {
    version: ANALYSIS_VERSION,
    scoring: {
      model: "weighted-v1", weights: { ...WEIGHTS },
      note: "Score = 100 x the weighted sum of six factors, each 0-1. Threads count at most 1.25 discussions; the model's confidence only enters through evidence strength (5%); change and persistence are neutral or zero when no fair comparison exists.",
    },
    painPoints: ranked, top, baseline, totals, limitations,
  };
}
