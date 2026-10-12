import type { ThemeTrend } from "./types";
import type { Coverage } from "./coverage";

const DAY = 86_400_000;
const IST = "Asia/Kolkata";

/** The IST period a report key stands for: Friday 00:00 IST for seven days (end exclusive). */
export function istPeriodFromKey(weekStart: string): { start: Date; end: Date } {
  const start = new Date(`${weekStart}T00:00:00+05:30`);
  return { start, end: new Date(start.getTime() + 7 * DAY) };
}

const dayFmt = (d: Date, withYear = false) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: IST, weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) })
    .format(d).replace(/,/g, "");

/** "Fri 2 Oct – Thu 8 Oct 2026 (IST)": the seven complete IST days the report covers. */
export function formatPeriod(weekStart: string): string {
  const { start, end } = istPeriodFromKey(weekStart);
  if (Number.isNaN(start.getTime())) return ""; // not a real period key: show nothing rather than throw
  return `${dayFmt(start)} – ${dayFmt(new Date(end.getTime() - 1), true)} (IST)`;
}

/** Short label for chart axes: "2 Oct". */
export function shortWeek(weekStart: string): string {
  if (Number.isNaN(istPeriodFromKey(weekStart).start.getTime())) return weekStart;
  return new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "numeric", month: "short" }).format(istPeriodFromKey(weekStart).start);
}

export interface ReportStats {
  mentions: number; // mentions matched to a tracked theme (excludes "other")
  painPoints: number; // themes with at least one mention
  unresolvedMentions: number;
  unresolvedShare: number; // 0..1
  topCategory: string | null;
  sourcesTotal: number;
  sourcesOk: number;
  sourcesNeedingAttention: string[]; // source ids that were partial or failed
}

/** Totals shown at the top of a report. One definition, used by the dashboard and the email. */
export function summarizeReport(points: ThemeTrend[], sources: Coverage | null | undefined): ReportStats {
  const active = points.filter((p) => p.count > 0);
  const mentions = active.reduce((s, p) => s + p.count, 0);
  const unresolvedMentions = active.reduce((s, p) => s + p.unresolved_count, 0);
  const byCategory = new Map<string, number>();
  for (const p of active) byCategory.set(p.topic_name, (byCategory.get(p.topic_name) ?? 0) + p.count);
  const top = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0];
  const entries = Object.entries(sources ?? {}) as [string, { status: string }][];
  return {
    mentions,
    painPoints: active.length,
    unresolvedMentions,
    unresolvedShare: mentions ? unresolvedMentions / mentions : 0,
    topCategory: top ? top[0] : null,
    sourcesTotal: entries.length,
    sourcesOk: entries.filter(([, v]) => v.status === "ok").length,
    sourcesNeedingAttention: entries.filter(([, v]) => v.status !== "ok").map(([k]) => k),
  };
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "12 Oct 2026, 08:26 IST" */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(",", "")} IST`;
}

/** Label for a week recorded before IST periods existed: its window began at UTC midnight on that date. */
export function formatLegacyWeek(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return weekStart;
  return `Week of ${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(d).replace(/,/g, "")} (earlier format)`;
}
