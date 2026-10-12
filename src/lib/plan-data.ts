import type { Session } from "./auth";
import { getReport } from "./data";
import { loadReview, type ReviewCard } from "./team-data";
import { problemsFrom, type ProblemView } from "./insights-view";
import { analysisFor } from "./analysis-source";
import { makeSupabaseStore } from "./store";
import { makeSupabaseTeamStore } from "./team-store";
import { formatDateTime } from "./view";
import { OUTCOME_LABEL } from "./decision-labels";


export interface PlanItem {
  itemId: string; theme: string; topicId: string; category: string; week: string | null;
  /** The reason the person gave when they shortlisted it. */
  why: string | null;
  discussions: number | null;
  outcome: string | null; rationale: string | null; decidedAt: string | null; followup: boolean;
  /** A generated suggestion, labelled as one wherever it is shown. */
  nextStep: string;
}
export interface Plan {
  week: string | null; periodLabel: string | null; summary: string | null; summaryIsTemplate: boolean;
  focus: PlanItem[]; considering: PlanItem[]; notNow: PlanItem[];
  /** Problems JARVIS found well supported that nobody has shortlisted yet. */
  suggested: ProblemView[];
}

export function toPlanItem(c: ReviewCard): PlanItem {
  const { item, current } = c.view;
  const outcome = current?.outcome ?? null;
  return {
    itemId: item.id, theme: item.theme, topicId: item.topic_id, category: c.topicName, week: item.first_week, why: item.reason,
    discussions: c.ai.discussions, outcome, rationale: current?.rationale ?? null, decidedAt: current?.decided_at ?? null, followup: Boolean(current?.followup),
    nextStep: outcome === "prioritised"
      ? (current?.followup ? "A follow-up was asked for. Agree who takes it and by when." : "Check whether this shows up in your own repositories, reviews or support requests, then name one owner.")
      : outcome ? "Nothing to do now. Look again if it returns in a later report."
        : "Read the evidence, then record a decision.",
  };
}

/** Everything the Weekly Action Plan shows, read from the saved report and the recorded decisions. */
export async function loadPlan(session: Session): Promise<Plan> {
  const report = await getReport();
  const cards = (await loadReview(session)).filter((c) => c.view.item.state !== "withdrawn");
  const items = cards.map(toPlanItem);
  const shortlisted = new Set(cards.map((c) => `${c.view.item.topic_id}|${c.view.item.theme}`));
  let suggested: ProblemView[] = [];
  if (report) {
    const a = await analysisFor(makeSupabaseStore(), makeSupabaseTeamStore(), report.weekStart).catch(() => null);
    if (a && a.kind !== "none") suggested = problemsFrom(a.analysis, report.weekStart).supported.filter((p) => !shortlisted.has(`${p.topicId}|${p.theme}`)).slice(0, 3);
  }
  return {
    week: report?.weekStart ?? null, periodLabel: report?.periodLabel ?? null, summary: report?.narrative ?? null, summaryIsTemplate: Boolean(report?.usedFallback),
    focus: items.filter((i) => i.outcome === "prioritised"),
    considering: items.filter((i) => !i.outcome),
    notNow: items.filter((i) => i.outcome && i.outcome !== "prioritised"),
    suggested,
  };
}

/** The plan as a plain Markdown document, for download. Same content as the page. */
export function planMarkdown(p: Plan): string {
  const L: string[] = [`# JARVIS weekly action plan`, ""];
  L.push(p.periodLabel ? `Based on the saved report for ${p.periodLabel}.` : "No report has been saved yet.", "");
  if (p.summary) L.push("## This week in short", "", p.summary, "", p.summaryIsTemplate ? "_This summary was written from a template, not by the AI._" : "_Summary written by the AI from the saved numbers._", "");
  const block = (title: string, rows: PlanItem[], empty: string) => {
    L.push(`## ${title}`, "");
    if (!rows.length) { L.push(empty, ""); return; }
    for (const r of rows) {
      L.push(`### ${r.theme}`, `- Area: ${r.category}${r.discussions !== null ? ` · ${r.discussions} separate discussions in the report` : ""}`);
      if (r.why) L.push(`- Why it was selected: ${r.why}`);
      if (r.outcome) L.push(`- Team decision: ${OUTCOME_LABEL[r.outcome] ?? r.outcome}${r.decidedAt ? ` (${formatDateTime(r.decidedAt)})` : ""}${r.rationale ? ` — "${r.rationale}"` : ""}`);
      L.push(`- Suggested next step (generated, not agreed): ${r.nextStep}`, "");
    }
  };
  block("Work on this", p.focus, "Nothing has been chosen for the coming week yet.");
  block("Still being considered", p.considering, "Nothing is waiting for a decision.");
  block("Not now", p.notNow, "Nothing has been set aside.");
  L.push("---", "Counts are public developer discussions that matched what JARVIS watches: a sample, not every developer. Decisions are written by people; suggestions are generated from the report's numbers.");
  return L.join("\n");
}
