import { describe, expect, it } from "vitest";
import { formatDateTime, formatLegacyWeek, formatPeriod, pct, shortWeek, summarizeReport, istPeriodFromKey } from "@/lib/view";
import {
  buildNav, buildReportView, displayPoints, summarizeRun, coarseReason, toHistoryRows, toListItem, STUCK_AFTER_MS,
  type BriefDbRow, type PeriodDbRow, type RunDbRow,
} from "@/lib/report-model";
import { buildTrends } from "@/lib/trend";
import type { Coverage } from "@/lib/coverage";

const names = { a: "Code review", b: "CI/CD" };
const sources: Coverage = { hn: { status: "ok", posts: 100 }, github: { status: "partial", posts: 20, truncated: true } };
const points = buildTrends(
  [{ topic_id: "a", theme: "Slow reviews", count: 10, unresolved: 6 }, { topic_id: "b", theme: "Flaky tests", count: 4, unresolved: 1 }, { topic_id: "a", theme: "Gone", count: 0, unresolved: 0 }],
  [{ topic_id: "a", theme: "Slow reviews", count: 5, unresolved: 0 }, { topic_id: "a", theme: "Gone", count: 3, unresolved: 0 }],
  names,
);
const brief = (over: Partial<BriefDbRow> = {}): BriefDbRow => ({
  week_start: "2026-10-02", narrative: "N1. N2.", top_pain_points: points, created_at: "2026-10-09T03:40:00Z",
  coverage: { sources, comparison: { state: "comparable", reasons: [] } }, version: 2, email_status: "sent", email_sent_at: "2026-10-09T03:41:00Z", emailed_version: 2, ...over,
});
const period = (k = "2026-10-02"): PeriodDbRow => ({ week_start: k, period_start: "2026-10-01T18:30:00Z", period_end: "2026-10-08T18:30:00Z", coverage: null });

describe("view helpers", () => {
  it("labels the IST period a key stands for", () => {
    expect(formatPeriod("2026-10-02")).toBe("Fri 2 Oct – Thu 8 Oct 2026 (IST)");
    expect(formatPeriod("2026-12-25")).toBe("Fri 25 Dec – Thu 31 Dec 2026 (IST)");
    expect(formatPeriod("2027-01-01")).toBe("Fri 1 Jan – Thu 7 Jan 2027 (IST)"); // across a year boundary
    expect(formatPeriod("nonsense")).toBe("");
  });
  it("labels an earlier-format week by its UTC start, never as an IST range", () => {
    expect(formatLegacyWeek("2026-10-06")).toBe("Week of Tue 6 Oct 2026 (earlier format)");
    expect(formatLegacyWeek("garbage")).toBe("garbage");
  });
  it("gives short axis labels and tolerates bad input", () => {
    expect(shortWeek("2026-10-02")).toBe("2 Oct");
    expect(shortWeek("bad")).toBe("bad");
  });
  it("converts a key to exact UTC instants", () => {
    const p = istPeriodFromKey("2026-10-02");
    expect([p.start.toISOString(), p.end.toISOString()]).toEqual(["2026-10-01T18:30:00.000Z", "2026-10-08T18:30:00.000Z"]);
  });
  it("formats timestamps in IST", () => {
    expect(formatDateTime("2026-10-09T03:30:00Z")).toBe("9 Oct 2026 09:00 IST");
    expect(formatDateTime(null)).toBe("");
    expect(formatDateTime("garbage")).toBe("");
  });
  it("summarizes one definition of totals: mentions exclude zero-count themes", () => {
    const s = summarizeReport(points, sources);
    expect(s).toMatchObject({ mentions: 14, painPoints: 2, unresolvedMentions: 7, unresolvedShare: 0.5, topCategory: "Code review", sourcesTotal: 2, sourcesOk: 1, sourcesNeedingAttention: ["github"] });
    expect(summarizeReport([], null)).toMatchObject({ mentions: 0, painPoints: 0, unresolvedShare: 0, topCategory: null, sourcesTotal: 0 });
    expect(pct(0.5)).toBe("50%");
  });
});

describe("report view model", () => {
  it("navigates between IST reports newest-first", () => {
    const keys = ["2026-10-16", "2026-10-09", "2026-10-02"];
    expect(buildNav(keys, "2026-10-09")).toEqual({ prev: "2026-10-02", next: "2026-10-16" });
    expect(buildNav(keys, "2026-10-16")).toEqual({ prev: "2026-10-09", next: null });
    expect(buildNav(keys, "2026-10-02")).toEqual({ prev: null, next: "2026-10-09" });
    expect(buildNav(keys, "2026-09-29")).toEqual({ prev: null, next: null });
  });
  it("builds an IST report with delivery, version and coverage", () => {
    const v = buildReportView(brief(), period(), ["2026-10-02"]);
    expect(v).toMatchObject({ kind: "ist", reliability: "comparable", version: 2, usedFallback: false, periodLabel: "Fri 2 Oct – Thu 8 Oct 2026 (IST)" });
    expect(v.delivery).toEqual({ status: "sent", sentAt: "2026-10-09T03:41:00Z", version: 2 });
  });
  it("treats a brief with no period record as an earlier-format (legacy) report whose trends cannot be vouched for", () => {
    const v = buildReportView(brief({ coverage: null, email_status: undefined, version: undefined }), null, []);
    expect(v).toMatchObject({ kind: "legacy", reliability: "legacy", coverage: null, version: null });
    expect(v.delivery.status).toBe("unknown");
    expect(v.periodLabel).toBe("Week of Fri 2 Oct 2026 (earlier format)");
  });
  it("falls back to the period record's coverage when the saved brief has none", () => {
    const p = { ...period(), coverage: { sources, comparison: { state: "incomparable" as const, reasons: ["x"] } } };
    expect(buildReportView(brief({ coverage: null }), p, []).reliability).toBe("incomparable");
  });
  it("maps every delivery state", () => {
    const status = (e: BriefDbRow["email_status"]) => buildReportView(brief({ email_status: e }), period(), []).delivery.status;
    expect([status("sent"), status("sending"), status("failed"), status(null)]).toEqual(["sent", "sending", "failed", "not_sent"]);
  });
  it("shows real trends only for a comparable report; otherwise withholds direction and percentage but keeps counts", () => {
    const comparable = buildReportView(brief(), period(), []);
    expect(displayPoints(comparable).find((p) => p.theme === "Slow reviews")).toMatchObject({ direction: "up", pct: 100, count: 10 });
    for (const reliability of ["incomparable", "no_prior", "legacy"] as const) {
      const shown = displayPoints({ points, reliability });
      expect(shown.every((p) => p.direction === "unavailable" && p.pct === null)).toBe(true);
      expect(shown.map((p) => p.count)).toEqual(points.map((p) => p.count)); // counts untouched
    }
  });
  it("lists reports with consistent totals", () => {
    expect(toListItem(brief(), period())).toMatchObject({ kind: "ist", mentions: 14, painPoints: 2, sourcesOk: 1, sourcesTotal: 2, delivery: "sent", reliability: "comparable" });
  });
});

describe("history rows", () => {
  const aggs = [
    { week_start: "2026-10-02", topic_id: "a", theme: "Slow reviews", mention_count: 5 },
    { week_start: "2026-10-09", topic_id: "a", theme: "Slow reviews", mention_count: 8 },
    { week_start: "2026-10-09", topic_id: "a", theme: "other", mention_count: 50 },
    { week_start: "2026-10-09", topic_id: "b", theme: "Flaky tests", mention_count: 2 },
  ];
  it("excludes 'other', zero-fills missing series, and carries each week's data-quality state", () => {
    const states = new Map([["2026-10-02", "no_prior" as const], ["2026-10-09", "incomparable" as const]]);
    const { series, rows } = toHistoryRows(aggs, new Map([["a", "Code review"], ["b", "CI/CD"]]), states);
    expect(series).toEqual(["Code review · Slow reviews", "CI/CD · Flaky tests"]);
    expect(rows).toEqual([
      { week: "2026-10-02", label: "2 Oct", state: "no_prior", "Code review · Slow reviews": 5, "CI/CD · Flaky tests": 0 },
      { week: "2026-10-09", label: "9 Oct", state: "incomparable", "Code review · Slow reviews": 8, "CI/CD · Flaky tests": 2 },
    ]);
  });
  it("marks weeks with no recorded state as legacy and caps the number of series", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ week_start: "2026-10-02", topic_id: "a", theme: `T${i}`, mention_count: 12 - i }));
    const { series, rows } = toHistoryRows(many, new Map([["a", "X"]]), new Map(), 8);
    expect(series).toHaveLength(8);
    expect(rows[0].state).toBe("legacy");
  });
});

describe("report list items (History comparison)", () => {
  const pts = [
    { topic_id: "a", topic_name: "A", theme: "x", count: 9, previous: 3, direction: "up" as const, pct: 200, unresolved_count: 1, unresolved: false },
    { topic_id: "a", topic_name: "A", theme: "y", count: 3, previous: 0, direction: "new" as const, pct: null, unresolved_count: 0, unresolved: false },
    { topic_id: "a", topic_name: "A", theme: "z", count: 1, previous: 6, direction: "down" as const, pct: -83.3, unresolved_count: 0, unresolved: false },
  ];
  const brief = (state: "comparable" | "incomparable" | "no_prior") => ({ week_start: "2026-10-02", narrative: "n", top_pain_points: pts, created_at: "2026-10-09T03:40:00Z", version: 1, coverage: { sources: {}, comparison: { state, reasons: [] } } });
  const period = { week_start: "2026-10-02", period_start: "2026-10-01T18:30:00Z", period_end: "2026-10-08T18:30:00Z", coverage: null };
  it("counts new, rising and declining pain points for a fair comparison", () => {
    expect(toListItem(brief("comparable"), period)).toMatchObject({ emerging: 1, rising: 1, declining: 1, narrative: "n" });
  });
  it("gives null, never zero, when the comparison is withheld or there is no baseline", () => {
    for (const s of ["incomparable", "no_prior"] as const) expect(toListItem(brief(s), period)).toMatchObject({ emerging: null, rising: null, declining: null });
    expect(toListItem({ ...brief("comparable"), coverage: null }, null)).toMatchObject({ emerging: null, rising: null, declining: null });
  });
});

describe("pipeline run view", () => {
  const run = (over: Partial<RunDbRow> = {}): RunDbRow => ({ id: "r1", week_start: "2026-10-02", trigger: "scheduled", status: "partial", started_at: "2026-10-09T03:30:00Z", finished_at: "2026-10-09T03:31:30Z", email_status: "sent", used_fallback: false, error: null, ...over });
  const f = (source: string, status: "ok" | "partial" | "error", n = 1, extra = {}) => ({ run_id: "r1", source, status, fetched: n, accepted: n, inserted: n, truncated: false, error: null as string | null, ...extra });
  it("takes the worst status per source across topics and sums the counts", () => {
    const v = summarizeRun(run(), [f("reddit", "ok", 2), f("reddit", "error", 0, { error: "HTTP 429 for www.reddit.com" }), f("hn", "ok", 5), f("hn", "ok", 5, { truncated: true }), f("x", "ok", 9, { run_id: "other" })]);
    expect(v.sources.map((s) => [s.source, s.status, s.fetched])).toEqual([["hn", "ok", 10], ["reddit", "error", 2]]);
    expect(v.sources[0].truncated).toBe(true);
    expect(v.sources[1].reason).toBe("Rate limited by the source");
    expect(JSON.stringify(v)).not.toContain("www.reddit.com");
    expect(v.durationSec).toBe(90);
  });
  it("never lets raw error text (hosts, constraint or table names) reach the view", () => {
    const leak = 'new row for relation "briefs" violates check constraint "briefs_sent_has_timestamp" at db.abcdefg.supabase.co';
    const v = summarizeRun(run({ error: leak }), [f("hn", "error", 0, { error: leak })]);
    const json = JSON.stringify(v);
    for (const bad of ["briefs", "constraint", "supabase.co", "violates"]) expect(json).not.toContain(bad);
    expect(v.sources[0].reason).toBe("Source did not return usable data");
    expect(v.problem).toBeTruthy();
    expect(coarseReason(null)).toBeNull();
    expect(coarseReason("operation timed out")).toBe("Timed out");
    expect(coarseReason("HTTP 403 for x")).toBe("Access refused by the source");
  });
  it("flags a run that never finished long after a function could have lived", () => {
    const now = new Date("2026-10-09T03:30:00Z");
    expect(summarizeRun(run({ status: "running", finished_at: null }), [], new Date(now.getTime() + STUCK_AFTER_MS + 1000)).stuck).toBe(true);
    expect(summarizeRun(run({ status: "running", finished_at: null }), [], new Date(now.getTime() + 60_000)).stuck).toBe(false);
    expect(summarizeRun(run({ status: "succeeded" }), [], new Date(now.getTime() + 9e9)).stuck).toBe(false);
  });
});
