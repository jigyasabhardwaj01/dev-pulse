import type { Direction, ThemeCount, ThemeTrend } from "./types";
import { OTHER_THEME } from "./types";

/** A theme counts as "unresolved" when at least this share of its mentions are unresolved. */
export const UNRESOLVED_SHARE_THRESHOLD = 0.5;

export function computeTrend(current: number, previous: number): { direction: Direction; pct: number | null } {
  if (previous === 0 && current === 0) return { direction: "flat", pct: 0 };
  if (previous === 0) return { direction: "new", pct: null }; // no baseline: avoid divide-by-zero
  if (current === 0) return { direction: "down", pct: -100 }; // fully dropped off, still reported
  const pct = Math.round(((current - previous) / previous) * 1000) / 10;
  return { direction: pct > 0 ? "up" : pct < 0 ? "down" : "flat", pct };
}

const key = (c: { topic_id: string; theme: string }) => `${c.topic_id}\u0000${c.theme}`;

/**
 * Union of this week's and last week's (topic, theme) pairs, so a theme that was
 * present last week but has zero matches now is still reported as declined.
 * Ranked by current mentions, then by size of last week's baseline (biggest drops first).
 */
export function buildTrends(
  current: ThemeCount[],
  previous: ThemeCount[],
  topicNames: Record<string, string>,
): ThemeTrend[] {
  const cur = new Map(current.map((c) => [key(c), c]));
  const prev = new Map(previous.map((c) => [key(c), c]));
  const keys = new Set([...cur.keys(), ...prev.keys()]);

  const trends: ThemeTrend[] = [];
  for (const k of keys) {
    const c = cur.get(k);
    const p = prev.get(k);
    const base = (c ?? p)!;
    const count = c?.count ?? 0;
    const previousCount = p?.count ?? 0;
    const unresolvedCount = c?.unresolved ?? 0;
    const { direction, pct } = computeTrend(count, previousCount);
    trends.push({
      topic_id: base.topic_id,
      topic_name: topicNames[base.topic_id] ?? "Unknown topic",
      theme: base.theme,
      count,
      previous: previousCount,
      direction,
      pct,
      unresolved_count: unresolvedCount,
      unresolved: count > 0 && unresolvedCount / count >= UNRESOLVED_SHARE_THRESHOLD,
    });
  }
  return trends.sort((a, b) => b.count - a.count || b.previous - a.previous || a.theme.localeCompare(b.theme));
}

/** Pain points for the brief: real themes only ("other" is a review bucket, not a pain point). */
export const rankPainPoints = (trends: ThemeTrend[], limit = 10) =>
  trends.filter((t) => t.theme !== OTHER_THEME).slice(0, limit);
