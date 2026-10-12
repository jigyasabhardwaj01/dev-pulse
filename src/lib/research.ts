import { invokedBy } from "./friday-status";
import type { RunView } from "./report-model";
import { periodFor } from "./week";
import { aiStatus, collectionStatus, type StatusLine } from "./status-plain";

/*
 * The Start Research button. It runs the same workflow as the Friday job (collect, AI analysis, rank, save the report) but is a
 * manual fallback: it NEVER emails (that is the Email Summary button) and it is recorded as a manual run, so it can never be
 * mistaken for the Friday schedule. Duplicate protection is decided here from recorded runs, and again by the pipeline's own guards.
 */
export const RESEARCH_COOLDOWN_MS = 10 * 60_000;

export type GateCode = "no_ai" | "running" | "friday_done" | "cooldown";
export type Gate = { ok: true; weekStart: string } | { ok: false; status: number; code: GateCode; message: string };

const IST = (ms: number) => `${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms)).replace(",", "")} IST`;

export function researchGate(a: { now: Date; aiConfigured: boolean; hasActive: boolean; runs: RunView[] }): Gate {
  const weekStart = periodFor(a.now).weekStart;
  if (!a.aiConfigured) return { ok: false, status: 409, code: "no_ai", message: "The AI is not set up, so research cannot run. Add OPENROUTER_API_KEY in Vercel first." };
  if (a.hasActive || a.runs.some((r) => r.status === "running" && !r.stuck)) return { ok: false, status: 409, code: "running", message: "Research is already running. Wait for it to finish; it usually takes a few minutes." };
  const friday = a.runs.find((r) => r.weekStart === weekStart && invokedBy(r) === "vercel-cron" && r.status === "succeeded");
  if (friday) return { ok: false, status: 409, code: "friday_done", message: `Friday's automatic run already completed this week's research (${IST(new Date(friday.finishedAt ?? friday.startedAt).getTime())}). There is nothing to refresh until the next period.` };
  const recent = a.runs.find((r) => r.weekStart === weekStart && r.finishedAt && a.now.getTime() - new Date(r.finishedAt).getTime() < RESEARCH_COOLDOWN_MS);
  if (recent) {
    const waitMin = Math.max(1, Math.ceil((RESEARCH_COOLDOWN_MS - (a.now.getTime() - new Date(recent.finishedAt!).getTime())) / 60_000));
    return { ok: false, status: 429, code: "cooldown", message: `Research just finished (${IST(new Date(recent.finishedAt!).getTime())}). Please wait about ${waitMin} more minute${waitMin === 1 ? "" : "s"} before running it again.` };
  }
  return { ok: true, weekStart };
}

export type ResearchState = "starting" | "running" | "success" | "problems" | "failed";
export interface ResearchResult { state: ResearchState; headline: string; lines: StatusLine[]; todo: string | null }

/**
 * What to tell the person about the newest run. "success" needs every stage to have worked: sources answered, the AI step finished
 * (or had nothing to do), the summary was AI-written, and the report save is recorded. Anything less is "problems", never success.
 */
export function researchResult(run: RunView | null, sinceMs: number | null): ResearchResult {
  const isNew = run && (sinceMs === null || new Date(run.startedAt).getTime() >= sinceMs - 10_000);
  if (!run || !isNew) return { state: "starting", headline: "Starting research…", lines: [], todo: null };
  if (run.status === "running") return { state: "running", headline: "Research is running", lines: [], todo: null };
  if (run.status === "failed") return { state: "failed", headline: "Research failed", lines: [{ tone: "bad", headline: "The run stopped before it finished", detail: "Nothing was changed: the saved reports and your decisions are untouched." }], todo: "Try again in a few minutes. If it keeps failing, open Settings & Diagnostics → Technical status to see which step failed." };
  const saved = run.diagnostics.find((d) => d.code === "REPORT_SAVED");
  const action = saved?.detail?.action;
  const report: StatusLine = !saved
    ? { tone: "warn", headline: "Report save not confirmed", detail: "The run did not record that the report was saved." }
    : action === "create" ? { tone: "ok", headline: "A new weekly report was saved", detail: `Version ${saved.detail?.version ?? 1} is now on the dashboard.` }
      : action === "replace" ? { tone: "ok", headline: "The weekly report was refreshed", detail: `Version ${saved.detail?.version ?? "?"} replaced the earlier, not yet emailed one.` }
        : { tone: "neutral", headline: "The saved report was kept as it is", detail: "It was already emailed or had nothing new, so it was not changed." };
  const lines = [collectionStatus(run), aiStatus(run, null), report];
  const clean = run.status === "succeeded" && saved !== undefined && !run.usedFallback && lines.every((l) => l.tone !== "bad" && l.tone !== "warn");
  return clean
    ? { state: "success", headline: "Research finished", lines, todo: null }
    : { state: "problems", headline: "Research finished with problems", lines, todo: "Some steps were incomplete. Nothing was lost, and the Friday run will try again. Open Settings & Diagnostics → Technical status for details." };
}
