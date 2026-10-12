import type { EvidenceLink, PainPointAnalysis, ReportAnalysis } from "./analysis";

/*
 * Plain-English view of a saved analysis. Pure: every sentence is built from the stored numbers, nothing is added.
 * "Supported" means the analysis itself found enough evidence to rank the problem (at least two separate discussions and a
 * verified excerpt); everything else is shown as an early signal and never ranked.
 */
const SOURCE_NAME: Record<string, string> = { hn: "Hacker News", stackoverflow: "Stack Overflow", reddit: "Reddit", github: "GitHub" };
export const sourceName = (s: string) => SOURCE_NAME[s] ?? s;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export type TrendKind = "increasing" | "decreasing" | "steady" | "new" | "unknown";
export type ConfidenceLevel = "high" | "medium" | "low";

export interface ProblemView {
  key: string;
  week: string;
  topicId: string;
  theme: string;
  category: string;
  /** Who runs into it: the developers working on this category, as recorded. Never a guessed job title. */
  who: string;
  whyItMatters: string;
  discussions: number;
  sources: string[];
  /** Posts not counted as separate discussions (replies in the same thread, repeats). */
  repeats: number;
  unresolved: number;
  trend: { kind: TrendKind; label: string; detail: string };
  confidence: { level: ConfidenceLevel; label: string; detail: string };
  supported: boolean;
  /** Why this problem was not ranked, when it was not. */
  notRankedBecause: string | null;
  rank: number | null;
  /** A generated suggestion for what to do next, never an agreed action. */
  nextAction: string;
  evidence: EvidenceLink[];
  firstSeen: string;
  lastSeen: string;
}

function trendOf(p: PainPointAnalysis): ProblemView["trend"] {
  const t = p.trend;
  if (!t.comparable || p.status === "unavailable") return { kind: "unknown", label: "Not enough data to compare", detail: "Last week's data is missing or was collected differently, so no rise or fall is claimed." };
  const now = t.previous + t.delta;
  if (p.status === "new") return { kind: "new", label: "New this week", detail: "It was not seen in the previous week." };
  if (p.status === "rising") return { kind: "increasing", label: "Increasing", detail: `${plural(now, "mention", "mentions")} this week, up from ${t.previous} last week.` };
  if (p.status === "declining") return { kind: "decreasing", label: "Decreasing", detail: `${plural(now, "mention", "mentions")} this week, down from ${t.previous} last week.` };
  return { kind: "steady", label: "About the same", detail: `${plural(now, "mention", "mentions")} this week, ${t.previous} last week.` };
}

function confidenceOf(p: PainPointAnalysis): ProblemView["confidence"] {
  if (p.evidence.strength === "strong") return { level: "high", label: "High confidence", detail: "Several separate discussions, on more than one site, with quotes we could check." };
  if (p.evidence.strength === "moderate") return { level: "medium", label: "Medium confidence", detail: "More than one discussion and at least one quote we could check, but a small sample." };
  return { level: "low", label: "Low confidence", detail: "Few discussions or mostly weak signals. Treat this as a hint, not a finding." };
}

function notRanked(p: PainPointAnalysis): string | null {
  if (p.eligibleForTop) return null;
  if (p.discussions < 2) return "Only one discussion mentions it, so it is not ranked.";
  if (p.evidence.withExcerpt < 1) return "No supporting quote could be verified, so it is not ranked.";
  return "Most of the evidence is a weak signal, so it is not ranked.";
}

function nextActionOf(p: PainPointAnalysis, trend: TrendKind): string {
  if (!p.eligibleForTop) return "Treat this as a hint. Read the discussions before deciding anything.";
  if (trend === "increasing") return "It is growing. Check whether a recent release or policy change lines up with it, then decide.";
  if (trend === "new") return "It is new this week. Read the discussions to see whether it is real for your team.";
  return "Check whether it shows up in your own repositories or support requests, then decide.";
}

export function toProblem(p: PainPointAnalysis, week: string, analysis: ReportAnalysis): ProblemView {
  const sources = Object.keys(p.sources).map(sourceName);
  const idx = analysis.top.indexOf(p.key);
  const parts = [`${plural(p.discussions, "separate discussion", "separate discussions")} about this ${p.discussions === 1 ? "was" : "were"} found${sources.length > 1 ? ` across ${sources.join(", ")}` : ` on ${sources[0] ?? "one site"}`}.`];
  if (p.resolution.open > 0) parts.push(`${p.resolution.open} of the ${plural(p.discussions, "discussion", "discussions")} look${p.resolution.open === 1 ? "s" : ""} unresolved.`);
  else if (p.resolution.resolved > 0 && p.resolution.open === 0) parts.push("The discussions we checked look mostly resolved.");
  return {
    key: p.key, week, topicId: p.topic_id, theme: p.theme, category: p.topic_name,
    who: `Developers working with ${p.topic_name}`,
    whyItMatters: parts.join(" "),
    discussions: p.discussions, sources, repeats: Math.max(0, p.rawPosts - p.discussions), unresolved: p.resolution.open,
    trend: trendOf(p), confidence: confidenceOf(p), supported: p.eligibleForTop, notRankedBecause: notRanked(p),
    rank: idx >= 0 ? idx + 1 : null,
    nextAction: nextActionOf(p, trendOf(p).kind),
    evidence: p.links, firstSeen: p.firstSeen, lastSeen: p.lastSeen,
  };
}

export const TOP_SHOWN = 5;

/** Supported problems first (best score first), then early signals by discussion count. Nothing unsupported is ever ranked. */
export function problemsFrom(analysis: ReportAnalysis, week: string): { supported: ProblemView[]; early: ProblemView[]; all: ProblemView[] } {
  const all = analysis.painPoints.map((p) => toProblem(p, week, analysis));
  const supported = all.filter((p) => p.supported).slice(0, TOP_SHOWN).map((p, i) => ({ ...p, rank: i + 1 }));
  const early = all.filter((p) => !p.supported).sort((a, b) => b.discussions - a.discussions || a.theme.localeCompare(b.theme));
  const rest = all.filter((p) => p.supported).slice(TOP_SHOWN);
  return { supported, early: [...rest, ...early], all: [...supported, ...rest, ...early] };
}

export const problemHref = (p: Pick<ProblemView, "week" | "topicId" | "theme">) => `/explore/problem?week=${p.week}&topic=${encodeURIComponent(p.topicId)}&theme=${encodeURIComponent(p.theme)}`;
export const compareKey = (p: Pick<ProblemView, "topicId" | "theme">) => `${p.topicId}|${p.theme}`;

export const SOURCE_ORDER = ["hn", "stackoverflow", "github", "reddit"] as const;
