import type { Source } from "./types";

export type SourceStatus = "ok" | "partial" | "error";
export interface SourceCoverage { status: SourceStatus; posts: number; truncated?: boolean }
/** Per-source record for one reporting period. A source absent from this map was not attempted. */
export type Coverage = Partial<Record<Source, SourceCoverage>>;

/** Sources deliberately NOT collected this period (disabled), with the reason. Distinct from a source that failed, and never a zero count. */
export type NotCollected = Partial<Record<Source, string>>;

export type ComparisonState = "comparable" | "no_prior" | "incomparable";
export interface Comparison {
  state: ComparisonState;
  /** Why the comparison is blocked (only present for "incomparable"). */
  reasons: string[];
  /** Non-blocking data-quality warnings shown next to a trend that is still being asserted. */
  caveats?: string[];
}

export const SOURCE_LABEL: Record<string, string> = { hn: "Hacker News", stackoverflow: "Stack Overflow", reddit: "Reddit", github: "GitHub" };
const label = (s: string) => SOURCE_LABEL[s] ?? s;

/** A source counts as materially present when it supplies at least this share of a period's posts. */
export const MATERIAL_SHARE = 0.1;
/** A source whose share of all posts moves by at least this much between periods earns a caveat. */
export const SHARE_SHIFT_CAVEAT = 0.3;

const RANK: Record<SourceStatus, number> = { error: 1, partial: 2, ok: 3 };

/** Status of one source across all of a run's per-topic fetches. */
export function summarizeStatuses(statuses: SourceStatus[]): SourceStatus {
  if (!statuses.length || statuses.every((s) => s === "ok")) return "ok";
  return statuses.every((s) => s === "error") ? "error" : "partial";
}

/**
 * Reruns of the same period can only add data (posts are never removed), so the best status
 * ever achieved for a source stands: a later failed rerun must not discredit data already stored.
 * Post counts always come from the current stored data.
 */
export function mergeCoverage(existing: Coverage | null, current: Coverage): Coverage {
  const out: Coverage = {};
  for (const s of new Set([...Object.keys(existing ?? {}), ...Object.keys(current)]) as Set<Source>) {
    const a = existing?.[s];
    const b = current[s];
    const status = a && b ? (RANK[a.status] >= RANK[b.status] ? a.status : b.status) : (a ?? b)!.status;
    out[s] = { status, posts: b?.posts ?? a?.posts ?? 0, ...(a?.truncated || b?.truncated ? { truncated: true } : {}) };
  }
  return out;
}

/**
 * Can this period be compared fairly with the previous one?
 *  - no previous record under the same period convention -> "no_prior"
 *  - a source tracked in only one period, a source whose fetch status differs between the periods,
 *    or a source that supplied a material share of one period and nothing in the other -> "incomparable"
 * A source that failed identically in both periods does not by itself make the comparison unfair.
 */
function caveatsFor(current: Coverage, previous: Coverage | null): string[] {
  const out: string[] = [];
  for (const [s, v] of Object.entries(current)) {
    if (v?.truncated) out.push(`${label(s)} results hit the page limit this period, so its counts may be understated`);
  }
  if (previous) {
    for (const [s, v] of Object.entries(previous)) {
      if (v?.truncated) out.push(`${label(s)} results hit the page limit in the previous period, so its counts may be understated`);
    }
    const total = (c: Coverage) => Object.values(c).reduce((n, x) => n + (x?.posts ?? 0), 0);
    const ct = total(current), pt = total(previous);
    if (ct && pt) {
      for (const s of new Set([...Object.keys(current), ...Object.keys(previous)])) {
        const shift = Math.abs((current[s as Source]?.posts ?? 0) / ct - (previous[s as Source]?.posts ?? 0) / pt);
        if (shift >= SHARE_SHIFT_CAVEAT) out.push(`${label(s)}'s share of collected posts changed by ${Math.round(shift * 100)} points, so the source mix differs`);
      }
    }
  }
  return out;
}

export function assessComparison(current: Coverage, previous: Coverage | null, notCollected: NotCollected = {}): Comparison {
  const caveats = caveatsFor(current, previous);
  // A source switched off on purpose does not make the comparison unfair when it was only a small part of the previous period:
  // the trend is shown, with a caveat saying what is missing. If it was a material share of the previous period, trends are withheld.
  const dropped: Coverage = {};
  if (previous) {
    const total = Object.values(previous).reduce((n, v) => n + (v?.posts ?? 0), 0);
    for (const s of Object.keys(notCollected) as Source[]) {
      const p = previous[s];
      if (!p || current[s]) continue;
      const share = total ? p.posts / total : 0;
      if (share < MATERIAL_SHARE) { dropped[s] = p; caveats.push(`${label(s)} was not collected this period; it supplied ${Math.round(share * 100)}% of the previous period's posts`); }
    }
  }
  const prevForBlocking = previous ? (Object.fromEntries(Object.entries(previous).filter(([s]) => !(s in dropped))) as Coverage) : null;
  const result = assessBlocking(current, prevForBlocking);
  return caveats.length ? { ...result, caveats } : result;
}

function assessBlocking(current: Coverage, previous: Coverage | null): Comparison {
  if (!previous) return { state: "no_prior", reasons: [] };
  const total = (c: Coverage) => Object.values(c).reduce((n, v) => n + (v?.posts ?? 0), 0);
  const curTotal = total(current);
  const prevTotal = total(previous);
  const reasons: string[] = [];

  for (const s of new Set([...Object.keys(current), ...Object.keys(previous)])) {
    const c = current[s as Source];
    const p = previous[s as Source];
    if (!c || !p) {
      reasons.push(`${label(s)} was tracked in only one of the two periods`);
      continue;
    }
    if (c.status !== p.status) {
      reasons.push(`${label(s)} fetch status differed (${p.status} before, ${c.status} now)`);
      continue;
    }
    const curShare = curTotal ? c.posts / curTotal : 0;
    const prevShare = prevTotal ? p.posts / prevTotal : 0;
    if ((c.posts === 0 && prevShare >= MATERIAL_SHARE) || (p.posts === 0 && curShare >= MATERIAL_SHARE)) {
      reasons.push(`${label(s)} supplied data in only one of the two periods`);
    }
  }
  return reasons.length ? { state: "incomparable", reasons } : { state: "comparable", reasons: [] };
}

/** One plain-language line for the dashboard and email. Null when there is nothing to qualify. */
export function comparisonNote(c: Comparison | null | undefined): string | null {
  if (!c || c.state === "comparable") return null;
  if (c.state === "no_prior") return "Trends start next week: there is no earlier report on the same reporting period to compare against.";
  return `Trends are not shown because source coverage differs from the previous period (${c.reasons.join("; ")}).`;
}

/** Non-blocking warnings (result caps, large source-mix shifts). Shown even when trends are asserted. */
export const comparisonCaveats = (c: Comparison | null | undefined): string[] => c?.caveats ?? [];
