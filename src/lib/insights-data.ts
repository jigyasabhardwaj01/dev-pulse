import { analysisFor, type AnalysisSource } from "./analysis-source";
import { getPostsFor, getRecentRuns, getReport, type PostRow } from "./data";
import { problemsFrom, type ProblemView } from "./insights-view";
import type { ReportView, RunView } from "./report-model";
import { makeSupabaseStore } from "./store";
import { makeSupabaseTeamStore } from "./team-store";

export interface InsightsData {
  report: ReportView | null;
  analysis: AnalysisSource;
  /** The newest recorded collection run. It can be newer than the newest completed report: shown separately on purpose. */
  run: RunView | null;
  runKnown: boolean;
  /** Recent runs (newest first), or null when run history could not be read. */
  runs: RunView[] | null;
  supported: ProblemView[];
  early: ProblemView[];
  all: ProblemView[];
  limitations: string[];
}

/** Latest completed report plus its analysis and the latest run. A database failure throws: the page shows an error, never an empty success. */
export async function loadInsights(week?: string): Promise<InsightsData> {
  const report = await getReport(week);
  const runs = await getRecentRuns(25).catch(() => null);
  const run = runs?.[0] ?? null;
  const analysis: AnalysisSource = report ? await analysisFor(makeSupabaseStore(), makeSupabaseTeamStore(), report.weekStart) : { kind: "none" };
  const p = analysis.kind === "none" || !report ? { supported: [], early: [], all: [] } : problemsFrom(analysis.analysis, report.weekStart);
  return { report, analysis, run, runKnown: runs !== null, runs, ...p, limitations: analysis.kind === "none" ? [] : analysis.analysis.limitations };
}

export async function loadProblem(week: string, topicId: string, theme: string) {
  const store = makeSupabaseStore();
  const team = makeSupabaseTeamStore();
  const a = await analysisFor(store, team, week);
  if (a.kind === "none") return { kind: "no_analysis" as const };
  const { all } = problemsFrom(a.analysis, week);
  const problem = all.find((p) => p.topicId === topicId && p.theme === theme);
  if (!problem) return { kind: "not_found" as const };
  let posts: PostRow[] = [];
  let postsFailed = false;
  try { posts = (await getPostsFor(topicId, theme, week)).posts; } catch { postsFailed = true; }
  return { kind: "ok" as const, problem, posts, postsFailed, analysisKind: a.kind, week };
}
