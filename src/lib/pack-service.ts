import { buildPack, type SprintPack } from "./pack";
import { buildFridayBrief, type FridayBrief } from "./friday-brief";
import { formatPeriod } from "./view";
import { makeSupabaseStore, type Store } from "./store";
import type { TeamStore } from "./team-store";
import { tally } from "./team";

/** The brief for the most recent saved report that has a sealed analysis, rebuilt from the SAVED record (never regenerated). */
export async function latestSavedBrief(store: Pick<Store, "listReportPeriods" | "getBrief"> = makeSupabaseStore()): Promise<FridayBrief | null> {
  const periods = await store.listReportPeriods(new Date(Date.now() - 120 * 86_400_000));
  for (const p of periods) {
    const b = await store.getBrief(p.week_start);
    if (b?.analysis) return buildFridayBrief({ weekStart: p.week_start, periodLabel: formatPeriod(p.week_start), analysis: b.analysis, narrative: b.narrative, usedFallback: b.usedFallback });
  }
  return null;
}

export async function buildCurrentPack(team: TeamStore, by: string, store?: Pick<Store, "listReportPeriods" | "getBrief">, now = new Date()) {
  const [brief, items, decisions, votes] = await Promise.all([latestSavedBrief(store), team.listItems(), team.listDecisions(), team.listVotes()]);
  const votesByItem = new Map(items.map((i) => [i.id, tally(votes.filter((v) => v.item_id === i.id))]));
  const { pack, digest } = buildPack({ now, brief, items, decisions, votesByItem });
  const row = await team.savePack({ created_by: by, week_start: pack.weekStart, content: pack, decisions_digest: digest });
  return { id: row.id, pack: pack as SprintPack };
}
