import type { ReportAnalysis, PainPointAnalysis, EvidenceLink } from "./analysis";

/*
 * The Friday brief as structured data, built ONLY from the saved report (its sealed analysis and narrative). Nothing is regenerated
 * when the email is sent. Three kinds of content are kept apart and labelled:
 *   observed        - counts, sources and links taken straight from stored discussions
 *   interpretation  - the executive summary (AI-written or template) and the ranking explanation
 *   suggestions     - follow-up questions and actions: possibilities for a human to weigh, never findings
 */
export const BRIEF_DISCLAIMER =
  "Counts are public developer discussions that matched the watchlist in this period: a sample, not every developer and not every conversation.";

export interface BriefItem {
  rank?: number;
  key: string;
  theme: string;
  category: string;
  /** e.g. "12 discussions across 3 sources" */
  observed: string;
  /** Plain statement of movement, or why none is shown. */
  movement: string;
  resolution: string;
  evidenceStrength: string;
  /** The two factors that contributed most to its rank (for the top list). */
  because: string[];
  links: EvidenceLink[];
  earlySignal: boolean;
}

export interface FridayBrief {
  weekStart: string;
  periodLabel: string;
  observed: {
    totals: ReportAnalysis["totals"];
    top: BriefItem[];
    vsLastWeek: { available: boolean; lines: string[]; withheldBecause: string | null };
    vsBaseline: { available: boolean; lines: string[]; unavailableBecause: string | null };
    emerging: BriefItem[];
    rising: BriefItem[];
    declining: BriefItem[];
    unresolved: BriefItem[];
    limitations: string[];
  };
  interpretation: { executiveSummary: string; usedTemplate: boolean; rankingNote: string };
  suggestions: { label: string; items: { forTheme: string | null; text: string }[] };
  disclaimer: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const nameOf = (s: string) => ({ hn: "Hacker News", stackoverflow: "Stack Overflow", reddit: "Reddit", github: "GitHub" } as Record<string, string>)[s] ?? s;

function item(p: PainPointAnalysis, rank?: number): BriefItem {
  const srcs = Object.keys(p.sources).map(nameOf);
  const t = p.trend;
  const movement = !t.comparable ? "Change vs last week is not shown (no fair comparison)."
    : p.status === "new" ? "New this week: not seen in the previous period."
      : `${t.previous} → ${t.previous + t.delta} discussions vs last week${p.status === "rising" ? " (rising)" : p.status === "declining" ? " (declining)" : ""}.`;
  const r = p.resolution;
  return {
    rank, key: p.key, theme: p.theme, category: p.topic_name,
    observed: `${plural(p.discussions, "discussion", "discussions")}${p.rawPosts > p.discussions ? ` (${p.rawPosts} posts)` : ""} across ${plural(p.distinctSources, "source", "sources")} (${srcs.join(", ")})${p.authors !== null ? `, ${plural(p.authors, "distinct author", "distinct authors")}` : ""}`,
    movement,
    resolution: `${r.open} open, ${r.uncertain} uncertain, ${r.resolved} resolved in the sampled discussions`,
    evidenceStrength: p.evidence.strength,
    because: [...p.factors].sort((a, b) => b.contribution - a.contribution).slice(0, 2).map((f) => `${f.name}: ${f.note}`),
    links: p.links.slice(0, 3),
    earlySignal: p.evidence.earlySignals > p.discussions / 2,
  };
}

export function buildFridayBrief(args: {
  weekStart: string;
  periodLabel: string;
  analysis: ReportAnalysis;
  narrative: string;
  usedFallback: boolean;
}): FridayBrief {
  const { analysis: a } = args;
  const byKey = new Map(a.painPoints.map((p) => [p.key, p]));
  const top = a.top.map((k, i) => item(byKey.get(k)!, i + 1));
  const comparable = a.painPoints.some((p) => p.trend.comparable);
  const mover = (status: string) => a.painPoints.filter((p) => p.status === status).sort((x, y) => Math.abs(y.trend.delta) - Math.abs(x.trend.delta) || y.discussions - x.discussions).slice(0, 5).map((p) => item(p));

  const lastWeek: string[] = [];
  if (comparable) {
    lastWeek.push(`${plural(a.totals.emerging, "pain point is", "pain points are")} new, ${a.totals.rising} rising and ${a.totals.declining} declining versus the previous period.`);
    const big = [...a.painPoints].filter((p) => p.status === "rising" || p.status === "declining").sort((x, y) => Math.abs(y.trend.delta) - Math.abs(x.trend.delta))[0];
    if (big) lastWeek.push(`Largest change: "${big.theme}" (${big.trend.previous} → ${big.trend.previous + big.trend.delta} discussions).`);
  }
  const baseLines: string[] = [];
  if (a.baseline.available) {
    for (const p of a.painPoints.filter((x) => x.baseline).sort((x, y) => Math.abs(y.baseline!.vsBaseline) - Math.abs(x.baseline!.vsBaseline)).slice(0, 3)) {
      const d = p.baseline!.vsBaseline;
      baseLines.push(`"${p.theme}": ${p.discussions} this week vs a ${a.baseline.weeks}-week mean of ${p.baseline!.mean} (${d >= 0 ? "+" : ""}${d}).`);
    }
  }

  const unresolved = [...a.painPoints].filter((p) => p.resolution.open > 0).sort((x, y) => y.resolution.open - x.resolution.open || y.discussions - x.discussions).slice(0, 3).map((p) => item(p));

  const suggestions: FridayBrief["suggestions"]["items"] = [];
  for (const t of top.slice(0, 3)) {
    suggestions.push({ forTheme: t.theme, text: `Is "${t.theme}" visible in our own repositories, reviews or support requests? Pick one concrete recent example and check.` });
  }
  for (const u of unresolved.slice(0, 2)) {
    if (!top.some((t) => t.key === u.key)) suggestions.push({ forTheme: u.theme, text: `"${u.theme}" has open discussions with no resolution. Is there a workaround or tool the team could trial?` });
  }
  for (const r of mover("rising").slice(0, 1)) suggestions.push({ forTheme: r.theme, text: `"${r.theme}" is rising. Did a tool release or policy change recently coincide with it?` });
  if (!top.length && a.painPoints.length) suggestions.push({ forTheme: null, text: "No pain point has enough supporting evidence to rank this week. Consider reviewing the Evidence Explorer before drawing conclusions." });
  if (a.limitations.some((l) => /could not be collected|partly collected/.test(l))) suggestions.push({ forTheme: null, text: "A source was incomplete this week. Treat the counts above as a lower bound and check Pipeline Health." });

  return {
    weekStart: args.weekStart, periodLabel: args.periodLabel,
    observed: {
      totals: a.totals, top,
      vsLastWeek: { available: comparable, lines: lastWeek, withheldBecause: comparable ? null : a.limitations.find((l) => /earlier week|coverage differs/.test(l)) ?? "No fair comparison with the previous period." },
      vsBaseline: { available: a.baseline.available, lines: baseLines, unavailableBecause: a.baseline.available ? null : a.baseline.reason },
      emerging: mover("new"), rising: mover("rising"), declining: mover("declining"), unresolved, limitations: a.limitations,
    },
    interpretation: {
      executiveSummary: args.narrative, usedTemplate: args.usedFallback,
      rankingNote: `Ranked by a documented score (${a.scoring.model}): frequency, change, persistence, breadth of sources and authors, unresolved share and evidence strength. A pain point needs at least two discussions and a verified excerpt to be ranked.`,
    },
    suggestions: { label: "Suggestions for discussion (not findings, and not approved work)", items: suggestions },
    disclaimer: BRIEF_DISCLAIMER,
  };
}
