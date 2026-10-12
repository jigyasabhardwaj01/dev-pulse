import { analyse, BASELINE_WEEKS, shiftWeek, type ReportAnalysis } from "./analysis";
import { buildTrends } from "./trend";
import { isFrozen } from "./brief-policy";
import type { Store } from "./store";
import type { DerivedAnalysis, DerivedProvenance, TeamStore } from "./team-store";
import type { Coverage } from "./coverage";
import type { Result } from "./team";
import type { Session } from "./auth";

/*
 * Derive an analysis for a report that was saved WITHOUT a sealed one (reports made before analysis existed). Rules:
 *  - owner only; explicit; one immutable row per (week, method version) in its own table;
 *  - reads only what is already stored (the saved report's own aggregates and coverage, and classified posts): no source request,
 *    no model call, no backfill, no email;
 *  - never touches the saved report: its version, narrative, email state and idempotency claim are exactly as delivered;
 *  - says plainly what it is made from. Posts classified before classification v2 have no excerpt or confidence, so they cannot
 *    earn a "verified excerpt", and the analysis therefore ranks nothing rather than pretending.
 */
export const DERIVE_METHOD_VERSION = 1;

export async function deriveAnalysis(
  store: Pick<Store, "getReportPeriod" | "getBrief" | "getAggregates" | "getActiveTopics" | "getEvidencePosts" | "getPriorWeeks">,
  team: TeamStore, s: Session, weekStart: unknown, now = new Date(),
): Promise<Result<{ derived: DerivedAnalysis; created: boolean }>> {
  const fail = (status: number, error: string) => ({ ok: false as const, status, error });
  if (s.role !== "owner") return fail(403, "Only the owner can derive an analysis.");
  if (typeof weekStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return fail(400, "A report week (YYYY-MM-DD) is required.");
  const brief = await store.getBrief(weekStart);
  const period = await store.getReportPeriod(weekStart);
  if (!brief || !period) return fail(404, "There is no saved report for that week.");
  if (brief.analysis) return fail(409, "That report already has a sealed analysis; nothing to derive.");
  const existing = await team.getDerivedAnalysis(weekStart);
  if (existing && existing.method_version >= DERIVE_METHOD_VERSION) return { ok: true, derived: existing, created: false };

  const start = new Date(period.period_start), end = new Date(period.period_end);
  const topics = await store.getActiveTopics();
  const topicNames = Object.fromEntries(topics.map((t) => [t.id, t.name]));
  const current = await store.getAggregates(weekStart);
  if (!current.length) return fail(409, "That report has no stored counts to derive from.");
  const posts = await store.getEvidencePosts(start, end);
  if (!posts.length) return fail(409, "No classified posts are stored for that period, so there is no evidence to analyse.");

  // The comparison exactly as the saved report recorded it; a comparison that was not fair then is not made fair now.
  const comparison = period.coverage?.comparison?.state ?? "unavailable";
  const prevKey = shiftWeek(weekStart, -1);
  const prevPeriod = await store.getReportPeriod(prevKey);
  const prevAligned = prevPeriod && new Date(prevPeriod.period_end).getTime() === start.getTime();
  const previous = prevAligned ? await store.getAggregates(prevKey) : [];
  let trends = buildTrends(current, previous, topicNames);
  if (comparison !== "comparable") trends = trends.filter((t) => t.count > 0).map((t) => ({ ...t, direction: "unavailable" as const, pct: null }));
  const prior = await store.getPriorWeeks(weekStart, BASELINE_WEEKS).catch(() => []);
  const coverage = (period.coverage?.sources ?? null) as Coverage | null;

  const analysis: ReportAnalysis = analyse({ weekStart, posts, trends, topicNames, coverage, comparison: comparison as never, prior });
  const legacy = posts.every((p) => p.confidence === null && !p.excerpt);
  const notes = [
    "Derived after the report was saved, from stored classified posts and the report's own saved counts. It is not part of the delivered report.",
    ...(legacy ? ["These posts were classified before classification v2, so none has an excerpt or a confidence score. No pain point can be ranked in the top list; counts, sources and links are real."] : []),
    "Posts stored after delivery for the same period may be included, so discussion counts can differ slightly from the delivered report's mention counts.",
  ];
  analysis.limitations = [...analysis.limitations, ...notes.slice(1)];
  const provenance: DerivedProvenance = {
    method: `derived-from-saved-evidence-v${DERIVE_METHOD_VERSION}`, derivedAt: now.toISOString(), derivedBy: s.email, reportVersion: brief.version,
    reportEmailStatus: brief.emailStatus ?? null, evidencePosts: posts.length, legacyClassification: legacy, notes,
  };
  const saved = await team.saveDerivedAnalysis({ week_start: weekStart, method_version: DERIVE_METHOD_VERSION, analysis, provenance, created_by: s.email });
  if (!saved) return { ok: true, derived: (await team.getDerivedAnalysis(weekStart))!, created: false }; // lost a race: the stored one stands
  await team.addEvent({ item_id: null, actor: s.email, action: "analysis_derived", detail: { weekStart, method: provenance.method, evidencePosts: posts.length, reportVersion: brief.version, frozen: isFrozen(brief) } });
  return { ok: true, derived: saved, created: true };
}
