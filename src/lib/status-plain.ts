import type { ReportView, RunView } from "./report-model";
import { KNOWN_SOURCES, label } from "./health";

/*
 * What the front page may say about the data and the AI. Each line is derived from a recorded run or a saved report, and a stage
 * that is not recorded says "not recorded": collection succeeding is never presented as the AI step or the whole workflow succeeding.
 */
export type Tone = "ok" | "warn" | "bad" | "neutral";
export interface StatusLine { tone: Tone; headline: string; detail: string }

export function collectionStatus(run: RunView | null): StatusLine {
  if (!run) return { tone: "neutral", headline: "No check recorded yet", detail: "JARVIS has not recorded a check for new discussions." };
  if (run.status === "running") return { tone: "neutral", headline: "Check in progress", detail: "A check for new discussions is running now." };
  if (run.status === "failed") return { tone: "bad", headline: "The last check failed", detail: "No new discussions were added. Earlier data and reports are unchanged." };
  const checked = run.sources.filter((s) => (KNOWN_SOURCES as readonly string[]).includes(s.source));
  if (!checked.length) return { tone: "neutral", headline: "Check finished, sources not recorded", detail: "The run did not record what each source returned." };
  const bad = checked.filter((s) => s.status !== "ok");
  if (!bad.length) return { tone: "ok", headline: `${checked.length} sources answered`, detail: `${checked.map((s) => label(s.source)).join(", ")} responded to every request.` };
  const failed = bad.filter((s) => s.status === "error");
  return {
    tone: failed.length === checked.length ? "bad" : "warn",
    headline: `${checked.length - bad.length} of ${checked.length} sources answered fully`,
    detail: `${bad.map((s) => `${label(s.source)} ${s.status === "error" ? "did not answer" : "answered only in part"}`).join("; ")}. Counts for ${bad.length === 1 ? "that source" : "those sources"} may be too low.`,
  };
}

/** The AI step: sorting new discussions into problems, and writing the summary. Reported separately from collection. */
export function aiStatus(run: RunView | null, report: ReportView | null): StatusLine {
  if (!run) return { tone: "neutral", headline: "AI analysis not recorded", detail: "No run has recorded whether the AI step worked." };
  if (run.status === "failed") return { tone: "bad", headline: "AI analysis did not complete", detail: "The last run failed before the report was finished." };
  if (run.status === "running") return { tone: "neutral", headline: "AI analysis in progress", detail: "The run has not finished." };
  if (run.classified === null) return { tone: "neutral", headline: "AI analysis not recorded", detail: "This run did not record how many discussions the AI sorted." };
  if ((run.unclassified ?? 0) > 0) return { tone: "warn", headline: `AI sorted ${run.classified}, ${run.unclassified} still waiting`, detail: "Waiting discussions are retried on the next run, so some counts may be low." };
  if (run.classified === 0 && (run.newPosts ?? 0) === 0) return { tone: "neutral", headline: "Nothing new needed AI analysis", detail: "The last check found no new discussions, so the AI step had nothing to do. This is not a test of the AI." };
  const summary = run.usedFallback || report?.usedFallback;
  return summary
    ? { tone: "warn", headline: `AI sorted ${run.classified} discussions; summary is a template`, detail: "The AI could not write the summary, so a standard one was used. The counts are unaffected." }
    : { tone: "ok", headline: `AI sorted ${run.classified} discussions`, detail: "The AI step finished and wrote the summary." };
}

export function reportStatus(report: ReportView | null): StatusLine {
  if (!report) return { tone: "neutral", headline: "No report yet", detail: "The first report is created by the Friday run." };
  const d = report.delivery;
  const mail = d.status === "sent" ? "It was emailed." : d.status === "failed" ? "The email failed and will be retried." : d.status === "sending" ? "The email is being sent." : d.status === "unknown" ? "" : "It has not been emailed.";
  return { tone: d.status === "failed" ? "warn" : "ok", headline: `Report for ${report.periodLabel}`, detail: `Saved report, version ${report.version ?? 1}. ${mail}`.trim() };
}
