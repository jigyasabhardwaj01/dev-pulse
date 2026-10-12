import type { Direction, ThemeTrend } from "./types";
import { isMostlyUnresolved } from "./trend";

export interface PainItem {
  topic_id: string;
  theme: string;
  count: number;
  previous: number;
  direction: Direction;
  pct: number | null;
  unresolved_count: number;
  mostlyUnresolved: boolean;
}

export interface PainGroup {
  topic_id: string;
  category: string;
  totalMentions: number;
  items: PainItem[];
}

/**
 * Shared by the email and the dashboard so both show the same structure: one group per category,
 * categories and the items inside them sorted by mentions (descending). The unresolved flag is
 * recomputed from the counts so briefs stored before the rule changed still render correctly.
 */
export function groupPainPoints(points: ThemeTrend[]): PainGroup[] {
  const groups = new Map<string, PainGroup>();
  for (const p of points) {
    const g = groups.get(p.topic_id) ?? { topic_id: p.topic_id, category: p.topic_name, totalMentions: 0, items: [] };
    g.totalMentions += p.count;
    g.items.push({
      topic_id: p.topic_id,
      theme: p.theme,
      count: p.count,
      previous: p.previous,
      direction: p.direction,
      pct: p.pct,
      unresolved_count: p.unresolved_count,
      mostlyUnresolved: isMostlyUnresolved(p.count, p.unresolved_count),
    });
    groups.set(p.topic_id, g);
  }
  const out = [...groups.values()];
  for (const g of out) g.items.sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme));
  return out.sort((a, b) => b.totalMentions - a.totalMentions || a.category.localeCompare(b.category));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** e.g. "13 mentions · 6 flagged unresolved" */
export const mentionsLine = (i: Pick<PainItem, "count" | "unresolved_count">) =>
  `${plural(i.count, "mention", "mentions")} · ${i.unresolved_count} flagged unresolved`;

/** Short trend label for display. */
export function trendLabel(i: Pick<PainItem, "direction" | "pct" | "count" | "previous">): string {
  switch (i.direction) {
    case "new": return "new this week";
    case "up": return `up ${i.pct}% (${i.previous} → ${i.count})`;
    case "down": return i.count === 0 ? `dropped to zero (was ${i.previous})` : `down ${Math.abs(i.pct ?? 0)}% (${i.previous} → ${i.count})`;
    default: return "no change";
  }
}

export const trendArrow = (d: Direction) => (d === "up" ? "▲" : d === "down" ? "▼" : d === "new" ? "●" : "–");
