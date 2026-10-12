import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DataQuality from "@/components/DataQuality";
import ChartTable from "@/components/ChartTable";
import PainPointGroups from "@/components/PainPointGroups";
import ReportHeader from "@/components/ReportHeader";
import SourceHealth from "@/components/SourceHealth";
import StatTiles from "@/components/StatTiles";
import TrendBadge from "@/components/TrendBadge";
import { buildReportView, displayPoints, type BriefDbRow } from "@/lib/report-model";
import { summarizeReport } from "@/lib/view";
import { buildTrends } from "@/lib/trend";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const ARROWS = /[▲▼]/;
const names = { a: "Code review", b: "CI/CD automation" };
const points = buildTrends(
  [{ topic_id: "a", theme: "Slow reviews", count: 10, unresolved: 6 }, { topic_id: "a", theme: "Review tone", count: 2, unresolved: 0 }, { topic_id: "b", theme: "Flaky tests", count: 4, unresolved: 1 }],
  [{ topic_id: "a", theme: "Slow reviews", count: 5, unresolved: 0 }, { topic_id: "a", theme: "Gone", count: 3, unresolved: 0 }],
  names,
);
const T = (over: object = {}) => ({ direction: "up" as const, pct: 100, count: 10, previous: 5, ...over });

describe("TrendBadge", () => {
  it("shows direction by arrow AND words for a real trend", () => {
    expect(html(<TrendBadge item={T()} />)).toMatch(/▲[\s\S]*up 100%/);
    expect(html(<TrendBadge item={T({ direction: "down", pct: -50, count: 2, previous: 4 })} />)).toMatch(/▼[\s\S]*down 50%/);
    expect(html(<TrendBadge item={T({ direction: "new", pct: null, previous: 0 })} />)).toContain("new this week");
  });
  it("never draws an unavailable trend as an arrow, and explains itself", () => {
    const out = html(<TrendBadge item={T({ direction: "unavailable", pct: null })} />);
    expect(out).not.toMatch(ARROWS);
    expect(out).not.toContain("%");
    expect(out).toContain("trend not compared");
    expect(out).toContain("title=");
  });
});

describe("PainPointGroups", () => {
  const out = html(<PainPointGroups points={points.filter((p) => p.count > 0)} weekStart="2026-10-02" />);
  it("shows each category once, as a heading, sorted by mentions", () => {
    expect(out.match(/Code review/g)).toHaveLength(2); // heading + section aria-label
    expect(out.indexOf("Code review")).toBeLessThan(out.indexOf("CI/CD automation"));
  });
  it("shows mentions and unresolved on one line and flags 'mostly unresolved' only when more than half", () => {
    expect(out).toContain("10 mentions · 6 flagged unresolved");
    expect(out.match(/mostly unresolved/g)).toHaveLength(1);
  });
  it("gives every bar a text alternative", () => {
    expect(out).toContain('aria-label="10 mentions, 6 flagged unresolved (60%)"');
  });
  it("links each item to its evidence with an encoded theme and the week", () => {
    expect(out).toContain('href="/posts?topic=a&amp;theme=Slow%20reviews&amp;week=2026-10-02"');
  });
  it("drops-to-zero items keep a line but offer no bar and no evidence link", () => {
    const gone = html(<PainPointGroups points={points.filter((p) => p.theme === "Gone")} weekStart="w" />);
    expect(gone).toContain("dropped to zero");
    expect(gone).not.toContain("/posts?");
    expect(gone).not.toContain('class="bar"');
  });
  it("has a clear empty state", () => {
    expect(html(<PainPointGroups points={[]} weekStart="w" />)).toContain("No pain points recorded");
  });
});

describe("DataQuality banners", () => {
  const cmp = (state: "comparable" | "no_prior" | "incomparable", reasons: string[] = [], caveats?: string[]) => ({ state, reasons, ...(caveats ? { caveats } : {}) });
  it("says nothing when the comparison is fair", () => {
    expect(html(<DataQuality reliability="comparable" comparison={cmp("comparable")} usedFallback={false} />)).toBe("");
  });
  it("explains an earlier-format report", () => {
    const out = html(<DataQuality reliability="legacy" comparison={null} usedFallback={false} />);
    expect(out).toContain("Earlier-format report");
    expect(out).toContain("trend arrows are not");
    expect(out).toContain("unverified"); // the stored summary may still describe a trend
  });
  it("explains a first report on the period format", () => {
    expect(html(<DataQuality reliability="no_prior" comparison={cmp("no_prior")} usedFallback={false} />)).toContain("trend arrows start next week");
  });
  it("lists every reason trends are withheld, and says counts are still accurate", () => {
    const out = html(<DataQuality reliability="incomparable" comparison={cmp("incomparable", ["GitHub was tracked in only one of the two periods", "Reddit fetch status differed (ok before, error now)"])} usedFallback={false} />);
    expect(out).toContain("Trends not compared");
    expect(out).toContain("GitHub was tracked in only one of the two periods");
    expect(out).toContain("Reddit fetch status differed");
    expect(out).toContain("Counts are still accurate");
  });
  it("shows non-blocking caveats beside real trends", () => {
    const out = html(<DataQuality reliability="comparable" comparison={cmp("comparable", [], ["GitHub results hit the page limit this period, so its counts may be understated"])} usedFallback={false} />);
    expect(out).toContain("Read with care");
    expect(out).toContain("page limit");
  });
  it("discloses a template-written summary", () => {
    expect(html(<DataQuality reliability="comparable" comparison={cmp("comparable")} usedFallback />)).toContain("written from a template");
  });
});

describe("SourceHealth", () => {
  it("shows healthy, partly failed, failed and capped sources distinctly, with a definition of 'posts'", () => {
    const out = html(<SourceHealth sources={{ hn: { status: "ok", posts: 120 }, github: { status: "ok", posts: 30, truncated: true }, reddit: { status: "error", posts: 0 }, stackoverflow: { status: "partial", posts: 1 } }} />);
    expect(out).toContain("Hacker News");
    expect(out).toContain("healthy");
    expect(out).toContain("fetch failed");
    expect(out).toContain("partly failed");
    expect(out).toContain("30 posts · capped");
    expect(out).toContain("1 post<");
    expect(out).toContain("larger than the mention counts");
    expect(out).toContain("chip error");
  });
  it("renders nothing without coverage", () => {
    expect(html(<SourceHealth sources={null} />)).toBe("");
    expect(html(<SourceHealth sources={{}} />)).toBe("");
  });
});

describe("StatTiles", () => {
  const stats = summarizeReport(points, { hn: { status: "ok", posts: 3 }, reddit: { status: "error", posts: 0 } });
  it("shows totals with one definition, and source health only when coverage exists", () => {
    const out = html(<StatTiles stats={stats} showSources />);
    expect(out).toContain(">16<"); // 10 + 2 + 4 mentions
    expect(out).toContain("Sources healthy");
    expect(out).toContain("1/2");
    expect(out).toContain("1 need attention");
    expect(html(<StatTiles stats={stats} showSources={false} />)).not.toContain("Sources healthy");
  });
  it("handles a report with no mentions", () => {
    expect(html(<StatTiles stats={summarizeReport([], null)} showSources={false} />)).toContain("–");
  });
});

describe("ReportHeader", () => {
  const brief = (over: Partial<BriefDbRow> = {}): BriefDbRow => ({
    week_start: "2026-10-09", narrative: "n", top_pain_points: [], created_at: "2026-10-16T03:40:00Z", version: 3,
    coverage: { sources: {}, comparison: { state: "comparable", reasons: [] } }, email_status: "sent", email_sent_at: "2026-10-16T03:41:00Z", emailed_version: 3, ...over,
  });
  const period = { week_start: "2026-10-09", period_start: "2026-10-08T18:30:00Z", period_end: "2026-10-15T18:30:00Z", coverage: null };
  it("shows the IST period, version and delivery, with navigation to neighbouring weeks", () => {
    const out = html(<ReportHeader report={buildReportView(brief(), period, ["2026-10-16", "2026-10-09", "2026-10-02"])} />);
    expect(out).toContain("Fri 9 Oct – Thu 15 Oct 2026 (IST)");
    expect(out).toContain("Report version 3");
    expect(out).toContain("Emailed 16 Oct 2026 09:11 IST");
    expect(out).toContain('href="/?week=2026-10-02"');
    expect(out).toContain('href="/?week=2026-10-16"');
  });
  it("describes failed and not-yet-sent deliveries honestly", () => {
    expect(html(<ReportHeader report={buildReportView(brief({ email_status: "failed" }), period, [])} />)).toContain("Email failed");
    expect(html(<ReportHeader report={buildReportView(brief({ email_status: null }), period, [])} />)).toContain("Not emailed yet");
  });
  it("labels an earlier-format report as such", () => {
    const out = html(<ReportHeader report={buildReportView(brief({ coverage: null, email_status: undefined, version: undefined }), null, [])} />);
    expect(out).toContain("Earlier-format report");
  });
});

describe("ChartTable", () => {
  it("offers the chart data with each week's data-quality label", () => {
    const out = html(<ChartTable series={["A · x"]} rows={[{ week: "2026-10-02", label: "2 Oct", state: "incomparable", "A · x": 4 }]} />);
    expect(out).toContain("View the chart data as a table");
    expect(out).toContain("Coverage differed");
    expect(out).toContain(">4<");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Whole pages, with the database layer replaced.
const data = vi.hoisted(() => ({ getReport: vi.fn(), getHistory: vi.fn(), listReports: vi.fn(), getPostsFor: vi.fn(), getRecentRuns: vi.fn() }));
vi.mock("@/lib/data", () => data);
vi.mock("@/components/TrendChart", () => ({ default: () => <div data-testid="chart" /> }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, usePathname: () => "/" }));

const reportFor = (reliability: "comparable" | "incomparable" | "no_prior" | "legacy") =>
  buildReportView(
    {
      week_start: "2026-10-02", narrative: "Slow reviews led. Nothing else.", top_pain_points: points, created_at: "2026-10-09T03:40:00Z", version: 1,
      coverage: reliability === "legacy" ? null : { sources: { hn: { status: "ok", posts: 9 } }, comparison: { state: reliability, reasons: reliability === "incomparable" ? ["GitHub was tracked in only one of the two periods"] : [] } },
      email_status: null,
    },
    reliability === "legacy" ? null : { week_start: "2026-10-02", period_start: "2026-10-01T18:30:00Z", period_end: "2026-10-08T18:30:00Z", coverage: null },
    ["2026-10-02"],
  );

describe("Home page", async () => {
  const { default: Home } = await import("@/app/page");
  const { default: ReportContent } = await import("@/components/ReportContent");
  const render = async (week?: string) => html(await ReportContent({ week }));
  const setup = (r: ReturnType<typeof reportFor> | null | Error) => {
    if (r instanceof Error) data.getReport.mockRejectedValue(r); else data.getReport.mockResolvedValue(r);
    data.getHistory.mockResolvedValue({ series: [], rows: [], legacyOnly: false });
  };

  it("shows real trend arrows only when the comparison was fair", async () => {
    setup(reportFor("comparable"));
    const out = await render();
    expect(out).toMatch(ARROWS);
    expect(out).toContain("Slow reviews led.");
    expect(out).not.toContain("Trends not compared");
  });
  it.each(["incomparable", "no_prior", "legacy"] as const)("shows NO trend arrows or percentages for a %s report, even though the saved points contain them", async (r) => {
    setup(reportFor(r));
    const out = await render();
    expect(out).not.toMatch(ARROWS);
    expect(out).not.toMatch(/up \d+%|down \d+%/);
    expect(out).toContain("trend not compared");
    expect(out).toContain("10 mentions · 6 flagged unresolved"); // counts are intact
  });
  it("explains an incomparable report with its reasons", async () => {
    setup(reportFor("incomparable"));
    expect(await render()).toContain("GitHub was tracked in only one of the two periods");
  });
  it("passes the requested week to the data layer", async () => {
    setup(reportFor("comparable"));
    await render("2026-10-02");
    expect(data.getReport).toHaveBeenLastCalledWith("2026-10-02");
  });
  it("404s a malformed week BEFORE streaming (a real 404), and an unknown week once the data answers", async () => {
    await expect(Home({ searchParams: Promise.resolve({ week: "not-a-date" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(Home({ searchParams: Promise.resolve({ week: "2026-1-2" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(Home({ searchParams: Promise.resolve({ week: "2026-01-02" }) })).resolves.toBeTruthy(); // well-formed: checked against the data inside Suspense
    setup(null);
    await expect(render("2026-01-02")).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("has a friendly first-run state and a database-down state", async () => {
    setup(null);
    expect(await render()).toContain("No report yet");
    setup(new Error("db down"));
    const out = await render();
    expect(out).toContain("couldn&#x27;t load the report");
    expect(out).not.toContain("db down"); // internals are not leaked
  });
  it("still renders the report when only the history query fails", async () => {
    setup(reportFor("comparable"));
    data.getHistory.mockRejectedValue(new Error("boom"));
    expect(await render()).toContain("Slow reviews");
  });
});

describe("Reports page", async () => {
  const { default: History } = await import("@/app/history/page");
  const item = (over: object = {}) => ({ weekStart: "2026-10-02", kind: "ist", periodLabel: "Fri 2 Oct – Thu 8 Oct 2026 (IST)", mentions: 16, painPoints: 3, reliability: "incomparable", delivery: "sent", version: 2, sourcesOk: 1, sourcesTotal: 2, ...over });
  it("lists reports with their data-quality state and a link to open each", async () => {
    data.listReports.mockResolvedValue([item(), item({ weekStart: "2026-09-29", kind: "legacy", periodLabel: "Earlier format, window starting 2026-09-29", reliability: "legacy", delivery: "unknown", version: null, sourcesTotal: 0 })]);
    data.getHistory.mockResolvedValue({ series: [], rows: [], legacyOnly: false });
    const out = html(await History());
    expect(out).toContain("Trends withheld");
    expect(out).toContain("Earlier format");
    expect(out).toContain('href="/?week=2026-10-02"');
    expect(out).toContain("1/2");
  });
  it("warns when only earlier-format weeks can be charted", async () => {
    data.listReports.mockResolvedValue([item()]);
    data.getHistory.mockResolvedValue({ series: ["A · x"], rows: [{ week: "2026-10-02", label: "2 Oct", state: "legacy", "A · x": 1 }], legacyOnly: true });
    expect(html(await History())).toContain("Earlier-format weeks only");
  });
  it("handles empty and failing data", async () => {
    data.listReports.mockResolvedValue([]); data.getHistory.mockResolvedValue({ series: [], rows: [], legacyOnly: false });
    expect(html(await History())).toContain("No reports yet");
    data.listReports.mockRejectedValue(new Error("x"));
    expect(html(await History())).toContain("couldn&#x27;t load the reports");
  });
});

describe("Evidence page", async () => {
  const { default: Posts } = await import("@/app/posts/page");
  const UUID = "12db9f28-c7de-4600-adc8-3d23f714012d";
  const post = (id: string, source: string, over: object = {}) => ({ id, source, title: `Title ${id}`, body: "b".repeat(500), url: `https://x.test/${id}`, author: "ann", posted_at: "2026-10-05T10:00:00Z", unresolved: true, sentiment: "negative", ...over });
  const ok = { posts: [post("1", "hn"), post("2", "github", { unresolved: false })], total: 5, bySource: { hn: 3, github: 2 }, topicName: "CI/CD automation", periodLabel: "Fri 2 Oct – Thu 8 Oct 2026 (IST)" };
  it("asks for a selection when the parameters are missing or malformed", async () => {
    for (const q of [{}, { topic: "nope", theme: "x", week: "2026-10-02" }, { topic: UUID, theme: "x", week: "oct" }]) {
      expect(html(await Posts({ searchParams: Promise.resolve(q) }))).toContain("Pick a pain point first");
    }
    expect(data.getPostsFor).not.toHaveBeenCalled();
  });
  it("shows the period, per-source counts and the posts; links open safely", async () => {
    data.getPostsFor.mockResolvedValue(ok);
    const out = html(await Posts({ searchParams: Promise.resolve({ topic: UUID, theme: "Flaky tests", week: "2026-10-02" }) }));
    expect(out).toContain("Fri 2 Oct – Thu 8 Oct 2026 (IST)");
    expect(out).toContain("Hacker News (3)");
    expect(out).toContain("GitHub (2)");
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("opens in a new tab");
    expect(out).not.toContain("b".repeat(400)); // snippets are truncated
  });
  it("labels an earlier-format week as such, never with an IST range", async () => {
    data.getPostsFor.mockResolvedValue({ ...ok, periodLabel: "Week of Tue 6 Oct 2026 (earlier format)" });
    const out = html(await Posts({ searchParams: Promise.resolve({ topic: UUID, theme: "Flaky tests", week: "2026-10-06" }) }));
    expect(out).toContain("Week of Tue 6 Oct 2026 (earlier format)");
    expect(out).not.toContain("(IST)");
  });
  it("passes only allow-listed filters to the data layer", async () => {
    data.getPostsFor.mockResolvedValue(ok);
    await Posts({ searchParams: Promise.resolve({ topic: UUID, theme: "t", week: "2026-10-02", source: "github", sentiment: "negative", unresolved: "1" }) });
    expect(data.getPostsFor).toHaveBeenLastCalledWith(UUID, "t", "2026-10-02", { source: "github", sentiment: "negative", unresolvedOnly: true });
    await Posts({ searchParams: Promise.resolve({ topic: UUID, theme: "t", week: "2026-10-02", source: "evil", sentiment: "<script>" }) });
    expect(data.getPostsFor).toHaveBeenLastCalledWith(UUID, "t", "2026-10-02", { source: undefined, sentiment: undefined, unresolvedOnly: false });
  });
  it("says so when filters match nothing, and offers to clear them", async () => {
    data.getPostsFor.mockResolvedValue({ ...ok, posts: [] });
    const out = html(await Posts({ searchParams: Promise.resolve({ topic: UUID, theme: "t", week: "2026-10-02", source: "hn" }) }));
    expect(out).toContain("No posts match these filters");
    expect(out).toContain("Clear filters");
  });
});

describe("Pipeline page", async () => {
  const { default: Status } = await import("@/app/status/page");
  const run = (over: object = {}) => ({
    id: "r1", weekStart: "2026-10-02", periodLabel: "Fri 2 Oct – Thu 8 Oct 2026 (IST)", trigger: "scheduled", status: "partial", startedAt: "2026-10-09T03:30:00Z", durationSec: 90,
    emailStatus: "sent", usedFallback: false, problem: null, stuck: false, classified: 40, unclassified: 3, newPosts: 43,
    sources: [{ source: "reddit", status: "error", fetched: 0, accepted: 0, inserted: 0, truncated: false, reason: "Rate limited by the source" }, { source: "hn", status: "ok", fetched: 50, accepted: 40, inserted: 40, truncated: true, reason: null }], ...over,
  });
  it("shows a failed source as failed, not as zero posts, and surfaces what will be retried", async () => {
    data.getRecentRuns.mockResolvedValue([run()]);
    const out = html(await Status());
    expect(out).toContain("Completed with issues");
    expect(out).toContain("Reddit");
    expect(out).toContain("failed");
    expect(out).toContain("Rate limited by the source");
    expect(out).toContain("3 awaiting classification");
    expect(out).toContain("capped");
  });
  it("flags a run that appears stuck and labels backfills", async () => {
    data.getRecentRuns.mockResolvedValue([run({ status: "running", stuck: true, trigger: "backfill", durationSec: null })]);
    const out = html(await Status());
    expect(out).toContain("Appears stuck");
    expect(out).toContain("Backfill");
  });
  it("explains a missing run-history table and an empty history", async () => {
    data.getRecentRuns.mockResolvedValue(null);
    expect(html(await Status())).toContain("isn&#x27;t available yet");
    data.getRecentRuns.mockResolvedValue([]);
    expect(html(await Status())).toContain("No runs recorded yet");
  });
  it("shows only a coarse problem line, never raw detail", async () => {
    data.getRecentRuns.mockResolvedValue([run({ problem: "The run reported a problem. See the server logs for details." })]);
    const out = html(await Status());
    expect(out).toContain("See the server logs");
  });
  it("is read-only: no forms, buttons or links that act", async () => {
    data.getRecentRuns.mockResolvedValue([run()]);
    const out = html(await Status());
    expect(out).not.toMatch(/<form|<button|method=/i);
  });
});
