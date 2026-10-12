import type { ReportAnalysis } from "./analysis";
import type { Store } from "./store";
import type { DerivedProvenance, TeamStore } from "./team-store";

/** Which analysis backs a saved report: the one sealed with it, one the owner derived later (clearly labelled), or none. */
export type AnalysisSource =
  | { kind: "sealed"; analysis: ReportAnalysis }
  | { kind: "derived"; analysis: ReportAnalysis; provenance: DerivedProvenance }
  | { kind: "none" };

export async function analysisFor(store: Pick<Store, "getBrief">, team: Pick<TeamStore, "getDerivedAnalysis">, weekStart: string): Promise<AnalysisSource> {
  const brief = await store.getBrief(weekStart);
  if (!brief) return { kind: "none" };
  if (brief.analysis) return { kind: "sealed", analysis: brief.analysis };
  const d = await team.getDerivedAnalysis(weekStart).catch(() => null); // the table may not exist on an older database: treat as none
  return d ? { kind: "derived", analysis: d.analysis, provenance: d.provenance } : { kind: "none" };
}
