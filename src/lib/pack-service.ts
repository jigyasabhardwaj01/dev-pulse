import { buildFridayBrief, type FridayBrief } from "./friday-brief";
import { formatPeriod } from "./view";
import { makeSupabaseStore, type Store } from "./store";
import type { TeamStore } from "./team-store";
import { analysisFor } from "./analysis-source";

/** The brief for the most recent saved report that has a sealed analysis, rebuilt from the SAVED record (never regenerated). */
export async function latestSavedBrief(team: Pick<TeamStore, "getDerivedAnalysis">, store: Pick<Store, "listReportPeriods" | "getBrief"> = makeSupabaseStore()): Promise<FridayBrief | null> {
  const periods = await store.listReportPeriods(new Date(Date.now() - 120 * 86_400_000));
  for (const p of periods) {
    const a = await analysisFor(store, team, p.week_start);
    const b = a.kind === "none" ? null : await store.getBrief(p.week_start);
    if (a.kind !== "none" && b) return buildFridayBrief({ weekStart: p.week_start, periodLabel: formatPeriod(p.week_start), analysis: a.analysis, narrative: b.narrative, usedFallback: b.usedFallback });
  }
  return null;
}
