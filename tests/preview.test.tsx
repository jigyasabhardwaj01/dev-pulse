import { describe, it, vi } from "vitest";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { buildReportView } from "@/lib/report-model";
import { buildTrends } from "@/lib/trend";
import type { Comparison, Coverage } from "@/lib/coverage";

/**
 * Developer tool, skipped unless PREVIEW_DIR is set: renders the real pages from fixtures to static HTML so the design can be
 * looked at for report states the live database does not have yet. It changes no application code and touches no database.
 */
const data = vi.hoisted(() => ({ getReport: vi.fn(), getHistory: vi.fn(), listReports: vi.fn(), getPostsFor: vi.fn(), getRecentRuns: vi.fn() }));
vi.mock("@/lib/data", () => data);
vi.mock("@/components/TrendChart", () => ({ default: () => <div className="card chart-card" style={{ padding: 18, color: "var(--muted)" }}>[interactive chart renders here in the browser]</div> }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("nf"); }, usePathname: () => "/" }));

const names = { a: "Code review", b: "CI/CD automation", c: "Developer workflow" };
const cur = [
  { topic_id: "a", theme: "False positives / noisy automated comments", count: 13, unresolved: 9 },
  { topic_id: "a", theme: "Slow review turnaround", count: 6, unresolved: 2 },
  { topic_id: "a", theme: "AI code review quality", count: 4, unresolved: 1 },
  { topic_id: "b", theme: "Flaky tests", count: 11, unresolved: 4 },
  { topic_id: "b", theme: "Slow pipelines", count: 5, unresolved: 0 },
  { topic_id: "b", theme: "CI cost", count: 2, unresolved: 0 },
  { topic_id: "c", theme: "Context switching and interruptions", count: 7, unresolved: 1 },
];
const prev = [
  { topic_id: "a", theme: "False positives / noisy automated comments", count: 8, unresolved: 3 },
  { topic_id: "a", theme: "Slow review turnaround", count: 9, unresolved: 3 },
  { topic_id: "b", theme: "Flaky tests", count: 11, unresolved: 5 },
  { topic_id: "b", theme: "Build failures hard to debug", count: 4, unresolved: 1 },
  { topic_id: "c", theme: "Context switching and interruptions", count: 7, unresolved: 2 },
];
const sources: Coverage = { hn: { status: "ok", posts: 212 }, stackoverflow: { status: "ok", posts: 3 }, reddit: { status: "error", posts: 0 }, github: { status: "ok", posts: 30, truncated: true } };

const scenario = (state: Comparison["state"], reasons: string[] = [], caveats: string[] = [], over: object = {}) => {
  let points = buildTrends(cur, state === "no_prior" ? [] : prev, names);
  if (state !== "comparable") points = points.filter((p) => p.count > 0).map((p) => ({ ...p, direction: "unavailable" as const, pct: null }));
  return buildReportView(
    {
      week_start: "2026-10-16", narrative: state === "no_prior"
        ? "This is the first week of tracking, so there's nothing to compare against yet; trend arrows start appearing next week. \"False positives / noisy automated comments\" is the loudest pain point this week with 13 mentions, 9 flagged unresolved."
        : state === "incomparable"
          ? "Week-over-week trends are not compared this week because source coverage differs from the previous period. \"False positives / noisy automated comments\" is the loudest pain point this week with 13 mentions, 9 flagged unresolved."
          : "\"False positives / noisy automated comments\" moved the most, up from 8 to 13 mentions. 1 pain point is new this week.",
      top_pain_points: points, created_at: "2026-10-23T03:41:00Z", version: 2,
      coverage: { sources, comparison: { state, reasons, ...(caveats.length ? { caveats } : {}) } },
      email_status: "sent", email_sent_at: "2026-10-23T03:42:00Z", emailed_version: 2, ...over,
    },
    { week_start: "2026-10-16", period_start: "2026-10-15T18:30:00Z", period_end: "2026-10-22T18:30:00Z", coverage: null },
    ["2026-10-23", "2026-10-16", "2026-10-09"],
  );
};

describe("preview generator (dev tool)", async () => {
  const dir = process.env.PREVIEW_DIR;
  const { default: Layout } = await import("@/app/layout");
  const { default: ReportContent } = await import("@/components/ReportContent");
  const { default: History } = await import("@/app/history/page");
  const { default: Status } = await import("@/app/status/page");

  const write = (name: string, body: React.ReactElement) => {
    let out = renderToStaticMarkup(<Layout>{body}</Layout>);
    out = out.replace('<html lang="en">', '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><link rel="stylesheet" href="app.css"></head>');
    writeFileSync(`${dir}/${name}.html`, "<!doctype html>" + out);
  };

  it.skipIf(!dir)("writes the previews", async () => {
    mkdirSync(dir!, { recursive: true });
    copyFileSync("src/app/globals.css", `${dir}/app.css`);
    data.getHistory.mockResolvedValue({ series: [], rows: [], legacyOnly: false });

    data.getReport.mockResolvedValue(scenario("comparable", [], ["GitHub results hit the page limit this period, so its counts may be understated"]));
    write("comparable", await ReportContent({}));
    data.getReport.mockResolvedValue(scenario("incomparable", ["GitHub was tracked in only one of the two periods", "Reddit fetch status differed (ok before, error now)"]));
    write("incomparable", await ReportContent({}));
    data.getReport.mockResolvedValue(scenario("no_prior"));
    write("first-report", await ReportContent({}));
    data.getReport.mockResolvedValue(scenario("comparable", [], [], { email_status: "failed", email_sent_at: null, used_fallback: true }));
    write("email-failed", await ReportContent({}));

    const item = (w: string, label: string, r: string, d: string, v: number | null) => ({ weekStart: w, kind: "ist", periodLabel: label, mentions: 48, painPoints: 7, reliability: r, delivery: d, version: v, sourcesOk: 3, sourcesTotal: 4 });
    data.listReports.mockResolvedValue([
      item("2026-10-16", "Fri 16 Oct – Thu 22 Oct 2026 (IST)", "comparable", "sent", 2),
      item("2026-10-09", "Fri 9 Oct – Thu 15 Oct 2026 (IST)", "incomparable", "sent", 1),
      item("2026-10-02", "Fri 2 Oct – Thu 8 Oct 2026 (IST)", "no_prior", "sent", 1),
      { ...item("2026-10-06", "Week of Tue 6 Oct 2026 (earlier format)", "legacy", "unknown", null), kind: "legacy", sourcesTotal: 0, sourcesOk: 0 },
    ]);
    write("reports", await History());

    const run = (over: object = {}) => ({ id: "r", weekStart: "2026-10-16", periodLabel: "Fri 16 Oct – Thu 22 Oct 2026 (IST)", trigger: "scheduled", status: "partial", startedAt: "2026-10-23T03:30:00Z", durationSec: 94, emailStatus: "sent", usedFallback: false, error: null, stuck: false, classified: 61, unclassified: 3, newPosts: 64,
      sources: [{ source: "hn", status: "ok", fetched: 212, accepted: 180, inserted: 61, truncated: false, error: null }, { source: "reddit", status: "error", fetched: 0, accepted: 0, inserted: 0, truncated: false, error: "HTTP 429 for www.reddit.com" }, { source: "github", status: "ok", fetched: 30, accepted: 21, inserted: 3, truncated: true, error: null }], ...over });
    data.getRecentRuns.mockResolvedValue([run(), run({ id: "r2", status: "succeeded", trigger: "backfill", periodLabel: "Fri 9 Oct – Thu 15 Oct 2026 (IST)", unclassified: 0, sources: [] }), run({ id: "r3", status: "running", stuck: true, durationSec: null, startedAt: "2026-10-16T03:30:00Z" })]);
    write("status", await Status());
  });
});
