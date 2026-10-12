import { makeSupabaseStore } from "./store";
import { makeSupabaseTeamStore, type Decision, type PackRow, type ReviewItem, type TeamStore, type VoteTally, type WatchChange } from "./team-store";
import { countTermMatches, termActivity, type Sensitivity, type TermActivity, type WatchTerm } from "./watchlist";
import { viewItem } from "./team";
import { analysisFor } from "./analysis-source";
import type { Session } from "./auth";
import { decisionsDigest } from "./team";
import { packFreshness, type SprintPack } from "./pack";

export const PRODUCTIVITY_DAYS = 28;

export interface TermView extends WatchTerm { matches: number; activity: TermActivity; scopeLabel: string | null }
export interface WatchlistView {
  sensitivity: Sensitivity;
  topics: { id: string; name: string; includes: TermView[]; excludes: TermView[]; legacy: boolean; legacyKeywords: string[] }[];
  changes: WatchChange[];
}

/** Everything the Watchlist page shows, read fresh from the database. */
export async function loadWatchlist(now = new Date(), team: TeamStore = makeSupabaseTeamStore()): Promise<WatchlistView> {
  const store = makeSupabaseStore();
  const [topics, terms, sensitivity, changes, matched] = await Promise.all([
    store.getActiveTopics(), team.getTerms(), team.getSensitivity(), team.getChanges(25),
    team.getMatchedTerms(new Date(now.getTime() - PRODUCTIVITY_DAYS * 86_400_000), now),
  ]);
  return {
    sensitivity, changes,
    topics: topics.map((t) => {
      const mine = terms.filter((x) => x.topic_id === t.id);
      const counts = countTermMatches(matched.filter((m) => m.topic_id === t.id));
      const byId = new Map(mine.map((x) => [x.id, x.term]));
      const view = (x: WatchTerm): TermView => ({ ...x, matches: counts.get(x.term) ?? 0, activity: termActivity(x, counts.get(x.term) ?? 0), scopeLabel: x.applies_to ? (byId.get(x.applies_to) ?? null) : null });
      return { id: t.id, name: t.name, includes: mine.filter((x) => x.kind === "include").map(view), excludes: mine.filter((x) => x.kind === "exclude").map(view), legacy: mine.length === 0, legacyKeywords: t.keywords };
    }),
  };
}

export interface ReviewCard {
  view: Awaited<ReturnType<typeof viewItem>>;
  topicName: string;
  ai: { rank: number | null; discussions: number | null; week: string | null };
}

/** All review items with their votes, decisions and where the saved report's ranking put them. */
export async function loadReview(session: Session, team: TeamStore = makeSupabaseTeamStore()): Promise<ReviewCard[]> {
  const store = makeSupabaseStore();
  const [items, topics] = await Promise.all([team.listItems(), store.getActiveTopics()]);
  const names = new Map(topics.map((t) => [t.id, t.name]));
  const weeks = [...new Set(items.map((i) => i.first_week).filter((w): w is string => Boolean(w)))];
  const briefs = new Map(await Promise.all(weeks.map(async (w) => { const a = await analysisFor(store, team, w); return [w, a.kind === "none" ? null : a.analysis] as const; })));
  return Promise.all(items.map(async (item: ReviewItem) => {
    const a = item.first_week ? briefs.get(item.first_week) : null;
    const p = a?.painPoints.find((x) => x.topic_id === item.topic_id && x.theme === item.theme);
    const idx = p && a ? a.top.indexOf(p.key) : -1;
    return { view: await viewItem(team, session, item), topicName: names.get(item.topic_id) ?? "Unknown topic", ai: { rank: idx >= 0 ? idx + 1 : null, discussions: p?.discussions ?? null, week: item.first_week } };
  }));
}

export interface PackView { row: PackRow | null; pack: SprintPack | null; freshness: ReturnType<typeof packFreshness> }
export async function loadPack(team: TeamStore = makeSupabaseTeamStore()): Promise<PackView> {
  const [row, decisions] = await Promise.all([team.latestPack(), team.listDecisions()]);
  const pack = (row?.content as SprintPack | undefined) ?? null;
  const store = makeSupabaseStore();
  const periods = await store.listReportPeriods(new Date(Date.now() - 120 * 86_400_000));
  const latestWeek = periods[0]?.week_start ?? null;
  return { row, pack, freshness: packFreshness(row ? { digest: row.decisions_digest, weekStart: row.week_start } : null, decisionsDigest(decisions as Decision[]), latestWeek) };
}
export type { VoteTally };
