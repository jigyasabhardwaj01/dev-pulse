import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ChartTable from "@/components/ChartTable";
import CoverageAlert from "@/components/CoverageAlert";
import KpiCards from "@/components/KpiCards";
import MovementBadge from "@/components/MovementBadge";
import PainPointTable from "@/components/PainPointTable";
import PeriodHeader from "@/components/PeriodHeader";
import SourceCoverage, { DataNotes } from "@/components/SourceCoverage";
import { computeKpis, readCoverage } from "@/lib/insights";
import { buildReportView, displayPoints, type BriefDbRow } from "@/lib/report-model";
import { buildTrends } from "@/lib/trend";
import { summarizeReport } from "@/lib/view";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const ARROWS = /[▲▼]/;
const names = { a: "Code review", b: "CI/CD automation" };
const points = buildTrends(
  [{ topic_id: "a", theme: "Slow reviews", count: 10, unresolved: 6 }, { topic_id: "a", theme: "Review tone", count: 2, unresolved: 0 }, { topic_id: "b", theme: "Flaky tests", count: 4, unresolved: 1 }],
  [{ topic_id: "a", theme: "Slow reviews", count: 5, unresolved: 0 }, { topic_id: "a", theme: "Gone", count: 3, unresolved: 0 }],
  names,
);
const T = (over: object = {}) => ({ direction: "up" as const, pct: 100, count: 10, previous: 5, ...over });

describe("MovementBadge", () => {
  it("shows direction by arrow AND words for a real trend, with the counts that back it", () => {
    expect(html(<MovementBadge item={T()} showCounts />)).toMatch(/▲[\s\S]*\+5 \(\+100%\)[\s\S]*5 → 10/);
    expect(html(<MovementBadge item={T({ direction: "down", pct: -50, count: 2, previous: 8 })} />)).toMatch(/▼[\s\S]*−6/);
    expect(html(<MovementBadge item={T({ direction: "new", pct: null, previous: 0 })} showCounts />)).toMatch(/New[\s\S]*0 → 10/);
  });
  it("does not quote a percentage for a tiny baseline", () => {
    expect(html(<MovementBadge item={T({ previous: 1, count: 7, pct: 600 })} />)).not.toContain("%");
  });
  it("never draws a withheld trend as an arrow or a percentage, and explains itself", () => {
    const out = html(<MovementBadge item={T({ direction: "unavailable", pct: null })} showCounts />);
    expect(out).not.toMatch(ARROWS);
    expect(out).not.toContain("%");
    expect(out).toContain("Not compared");
    expect(out).toContain("title=");
    expect(out).not.toContain("→");
  });
});

describe("PainPointTable", () => {
  const out = html(<PainPointTable points={points.filter((p) => p.count > 0)} weekStart="2026-10-02" />);
  it("shows each category once as a heading, sorted by mentions", () => {
    expect(out.match(/<h3>Code review<\/h3>/g)).toHaveLength(1);
    expect(out.indexOf("Code review")).toBeLessThan(out.indexOf("CI/CD automation"));
  });
  it("shows mentions and unresolved per row and flags 'mostly unresolved' only when more than half", () => {
    expect(out).toContain("6 of 10 flagged unresolved");
    expect(out.match(/Mostly unresolved/g)).toHaveLength(1);
  });
  it("gives every proportional bar a text alternative, with real values", () => {
    expect(out).toContain('aria-label="10 mentions, 6 flagged unresolved (60%)"');
    expect(out).toContain("width:100%"); // the largest item fills the track
    expect(out).toContain("width:20%"); // 2 of 10
  });
  it("links each item to its evidence with an encoded theme and the week", () => {
    expect(out).toContain('href="/posts?topic=a&amp;theme=Slow%20reviews&amp;week=2026-10-02"');
  });
  it("an item that dropped to zero keeps its row but has no bar fill and no evidence link", () => {
    const gone = html(<PainPointTable points={points.filter((p) => p.theme === "Gone")} weekStart="w" />);
    expect(gone).toContain("Dropped to 0");
    expect(gone).not.toContain("/posts?");
    expect(gone).not.toContain("bar-fill");
  });
  it("has a clear empty state", () => {
    expect(html(<PainPointTable points={[]} weekStart="w" />)).toContain("No pain points recorded");
  });
});

describe("coverage alert and data notes", () => {
  const cmp = (state: "comparable" | "no_prior" | "incomparable", reasons: string[] = [], caveats?: string[]) => ({ state, reasons, ...(caveats ? { caveats } : {}) });
  const alertFor = (rel: "comparable" | "no_prior" | "incomparable" | "legacy", c: ReturnType<typeof cmp> | null, sources = {}, fb = false) =>
    html(<CoverageAlert reading={readCoverage(sources, c, rel)} usedFallback={fb} />);
  it("says nothing when the comparison is fair and coverage is clean", () => {
    expect(alertFor("comparable", cmp("comparable"), { hn: { status: "ok", posts: 3 } })).toBe("");
  });
  it("shows a concise visible note for an earlier-format report and a first report", () => {
    expect(alertFor("legacy", null)).toContain("Earlier format, trends not shown");
    expect(alertFor("no_prior", cmp("no_prior"))).toContain("No earlier period to compare");
  });
  it("warns, visibly, when trends are withheld, a source failed or collection was partial", () => {
    const w = alertFor("incomparable", cmp("incomparable", ["GitHub was tracked in only one of the two periods"]));
    expect(w).toContain("alert warn");
    expect(w).toContain("rends withheld");
    expect(alertFor("comparable", cmp("comparable"), { reddit: { status: "error", posts: 0 } })).toContain("Reddit failed");
    expect(alertFor("comparable", cmp("comparable"), { reddit: { status: "partial", posts: 0 } })).toContain("Reddit partly collected");
    expect(alertFor("comparable", cmp("comparable"), { reddit: { status: "partial", posts: 0 } })).toContain('href="#data-notes"');
  });
  it("puts the stored reasons in the data notes and says which period they affect", () => {
    const out = html(<DataNotes sources={{ hn: { status: "ok", posts: 5 } }} comparison={cmp("incomparable", ["GitHub was tracked in only one of the two periods", "Reddit fetch status differed (ok before, error now)"])} reliability="incomparable" />);
    expect(out).toContain("GitHub was tracked in only one of the two periods");
    expect(out).toContain("Reddit fetch status differed");
    expect(out).toContain("This and previous period");
  });
  it("collapses repeated page-limit caveats into one note, so the same warning is not repeated", () => {
    const caveats = [
      "Hacker News results hit the page limit this period, so its counts may be understated",
      "Hacker News results hit the page limit in the previous period, so its counts may be understated",
    ];
    const out = html(<DataNotes sources={{ hn: { status: "ok", posts: 100, truncated: true } }} comparison={cmp("comparable", [], caveats)} reliability="comparable" />);
    expect(out.match(/page limit/g)).toHaveLength(1);
    expect(out).toContain("both this and the previous period");
    expect(out).toContain("Data notes (1)");
  });
  it("is open by default only when something needs care, and says when there are no issues", () => {
    expect(html(<DataNotes sources={{ reddit: { status: "error", posts: 0 } }} comparison={cmp("comparable")} reliability="comparable" />)).toMatch(/<details[^>]* open/);
    const calm = html(<DataNotes sources={{ hn: { status: "ok", posts: 5 } }} comparison={cmp("comparable")} reliability="comparable" />);
    expect(calm).not.toMatch(/<details[^>]* open/);
    expect(calm).toContain("No coverage issues");
  });
  it("discloses a template-written summary", () => {
    expect(alertFor("comparable", cmp("comparable"), {}, true)).toContain("written from a template");
  });
});

describe("SourceCoverage", () => {
  it("shows healthy, partly collected, failed and capped sources distinctly and never calls a failure zero", () => {
    const out = html(<SourceCoverage sources={{ hn: { status: "ok", posts: 120 }, github: { status: "ok", posts: 30, truncated: true }, reddit: { status: "error", posts: 0 }, stackoverflow: { status: "partial", posts: 1 } }} />);
    expect(out).toContain("Hacker News");
    expect(out).toContain("Healthy");
    expect(out).toContain("Failed: no data collected");
    expect(out).toContain("Partly collected");
    expect(out).toContain("Capped");
    expect(out).toContain("Collected: 120 posts");
    expect(out).toContain("outnumber the mentions");
    expect(out).not.toMatch(/Reddit[^<]*0 posts/);
  });
  it("shows a healthy source with no posts as collected, not failed", () => {
    expect(html(<SourceCoverage sources={{ stackoverflow: { status: "ok", posts: 0 } }} />)).toContain("Collected: no posts in this period");
  });
  it("renders nothing without coverage", () => {
    expect(html(<SourceCoverage sources={null} />)).toBe("");
    expect(html(<SourceCoverage sources={{}} />)).toBe("");
  });
});

describe("KpiCards", () => {
  const stats = summarizeReport(points, { hn: { status: "ok", posts: 3 } });
  it("shows mentions with the real baseline, emerging and unresolved counts for a fair comparison", () => {
    const out = html(<KpiCards kpis={computeKpis(points, stats)} />);
    expect(out).toContain(">16<"); // 10 + 2 + 4 mentions
    expect(out).toContain("Relevant mentions");
    expect(out).toContain("Newly emerging");
    expect(out).toContain("vs 8 last week"); // previous: Slow reviews 5 + Gone 3
  });
  it("shows a dash, not zero, when trends are withheld, and no baseline", () => {
    const w = displayPoints({ points, reliability: "incomparable" });
    const out = html(<KpiCards kpis={computeKpis(w, summarizeReport(w, null))} />);
    expect(out).toContain("not compared this week");
    expect(out).not.toContain("last week");
    expect(out).toMatch(/Newly emerging<\/span><span class="k-value">–/);
  });
  it("handles a report with no mentions", () => {
    expect(html(<KpiCards kpis={computeKpis([], summarizeReport([], null))} />)).toContain("no mentions");
  });
});

describe("PeriodHeader", () => {
  const brief = (over: Partial<BriefDbRow> = {}): BriefDbRow => ({
    week_start: "2026-10-09", narrative: "n", top_pain_points: [], created_at: "2026-10-16T03:40:00Z", version: 3,
    coverage: { sources: {}, comparison: { state: "comparable", reasons: [] } }, email_status: "sent", email_sent_at: "2026-10-16T03:41:00Z", emailed_version: 3, ...over,
  });
  const period = { week_start: "2026-10-09", period_start: "2026-10-08T18:30:00Z", period_end: "2026-10-15T18:30:00Z", coverage: null };
  const view = (b: BriefDbRow, p: typeof period | null = period, keys: string[] = ["2026-10-16", "2026-10-09", "2026-10-02"]) => buildReportView(b, p, keys);
  it("overview: titled Developer Intelligence, with the IST period, comparison status, version and delivery", () => {
    const out = html(<PeriodHeader report={view(brief())} mode="overview" />);
    expect(out).toContain("Developer Intelligence");
    expect(out).toContain("Fri 9 Oct – Thu 15 Oct 2026 (IST)");
    expect(out).toContain("Compared with 2 Oct – 8 Oct");
    expect(out).toContain("Version 3");
    expect(out).toContain("Emailed 16 Oct 2026 09:11 IST");
    expect(out).toContain('href="/?week=2026-10-02"');
    expect(out).toContain('href="/?week=2026-10-16"');
    expect(out).toContain('href="/reports/2026-10-09"');
  });
  it("report page: the period is the title and navigation stays within reports", () => {
    const out = html(<PeriodHeader report={view(brief())} mode="report" />);
    expect(out).toContain("<h1>Fri 9 Oct – Thu 15 Oct 2026 (IST)</h1>");
    expect(out).toContain('href="/reports/2026-10-02"');
    expect(out).toContain('href="/?week=2026-10-09"');
  });
  it("says plainly when there is no earlier period or trends are withheld", () => {
    expect(html(<PeriodHeader report={view(brief({ coverage: { sources: {}, comparison: { state: "no_prior", reasons: [] } } }))} mode="overview" />)).toContain("No earlier period to compare");
    expect(html(<PeriodHeader report={view(brief({ coverage: { sources: {}, comparison: { state: "incomparable", reasons: ["x"] } } }))} mode="overview" />)).toContain("Trends withheld");
  });
  it("describes failed and not-yet-sent deliveries honestly", () => {
    expect(html(<PeriodHeader report={view(brief({ email_status: "failed" }), period, [])} mode="overview" />)).toContain("Email failed");
    expect(html(<PeriodHeader report={view(brief({ email_status: null }), period, [])} mode="overview" />)).toContain("Not emailed yet");
  });
  it("labels an earlier-format report as such", () => {
    const out = html(<PeriodHeader report={view(brief({ coverage: null, email_status: undefined, version: undefined }), null, [])} mode="overview" />);
    expect(out).toContain("(earlier format)");
    expect(out).toContain("Earlier format");
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
const data = vi.hoisted(() => ({ getReport: vi.fn(), getHistory: vi.fn(), listReports: vi.fn(), getPostsFor: vi.fn(), getRecentRuns: vi.fn(), hasReport: vi.fn() }));
const nav = vi.hoisted(() => ({ path: "/" }));
vi.mock("@/lib/data", () => data);
vi.mock("@/components/TrendChart", () => ({ default: () => <div data-testid="chart" /> }));
vi.mock("@/components/VolumeChart", () => ({ default: () => <div data-testid="volume" /> }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, usePathname: () => nav.path }));

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

describe("Overview page", async () => {
  const { default: Home } = await import("@/app/page");
  const { default: ReportContent } = await import("@/components/ReportContent");
  const render = async (week?: string, mode: "overview" | "report" = "overview") => html(await ReportContent({ week, mode }));
  const setup = (r: ReturnType<typeof reportFor> | null | Error) => {
    if (r instanceof Error) data.getReport.mockRejectedValue(r); else data.getReport.mockResolvedValue(r);
    data.getHistory.mockResolvedValue({ series: [], rows: [], legacyOnly: false });
    data.listReports.mockResolvedValue([]);
    data.hasReport.mockResolvedValue(true);
  };

  it("puts the intelligence first: summary, then top movers, then pain points, then supporting metrics and coverage", async () => {
    setup(reportFor("comparable"));
    const out = await render();
    const order = ["Developer Intelligence", "AI weekly summary", "Top movers", "Pain points by category", "Supporting metrics", 'id="src-heading"'].map((s) => out.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("Slow reviews led.");
  });
  it("shows real movement and the top-movers lists only when the comparison was fair", async () => {
    setup(reportFor("comparable"));
    const out = await render();
    expect(out).toMatch(ARROWS);
    expect(out).toContain("Largest increases");
    expect(out).toContain("Newly emerging");
    expect(out).toContain("Largest decreases");
    expect(out).toContain("Unresolved to watch");
    expect(out).toContain("Compared with 25 Sept – 1 Oct");
  });
  it.each(["incomparable", "no_prior", "legacy"] as const)("shows NO arrows, percentages or movers for a %s report, even though the saved points contain them", async (r) => {
    setup(reportFor(r));
    const out = await render();
    expect(out).not.toMatch(ARROWS);
    expect(out).not.toMatch(/\(\+\d+%\)|\(−\d+%\)/);
    expect(out).not.toContain("Largest increases");
    expect(out).toContain("Biggest pain points");
    expect(out).toContain("Not compared");
    expect(out).toContain("6 of 10 flagged unresolved"); // counts are intact
  });
  it("explains an incomparable report with a visible warning and its reasons in the data notes", async () => {
    setup(reportFor("incomparable"));
    const out = await render();
    expect(out).toContain("alert warn");
    expect(out).toContain("GitHub was tracked in only one of the two periods");
  });
  it("passes the requested week to the data layer", async () => {
    setup(reportFor("comparable"));
    await render("2026-10-02");
    expect(data.getReport).toHaveBeenLastCalledWith("2026-10-02");
  });
  it("renders the weekly volume chart only when there are at least two weekly reports", async () => {
    setup(reportFor("comparable"));
    const item = (w: string) => ({ weekStart: w, kind: "ist", mentions: 5, reliability: "comparable" });
    data.listReports.mockResolvedValue([item("2026-10-02")]);
    expect(await render()).toContain("appears once there are two reports");
    data.listReports.mockResolvedValue([item("2026-10-02"), item("2026-09-25")]);
    expect(await render()).toContain('data-testid="volume"');
  });
  it("404s a malformed week and an unknown week BEFORE streaming (a real 404), but not a known one or a database error", async () => {
    setup(reportFor("comparable"));
    await expect(Home({ searchParams: Promise.resolve({ week: "not-a-date" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(Home({ searchParams: Promise.resolve({ week: "2026-1-2" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    data.hasReport.mockResolvedValue(false);
    await expect(Home({ searchParams: Promise.resolve({ week: "2026-01-02" }) })).rejects.toThrow("NEXT_NOT_FOUND"); // well-formed but unknown
    data.hasReport.mockResolvedValue(true);
    await expect(Home({ searchParams: Promise.resolve({ week: "2026-10-02" }) })).resolves.toBeTruthy();
    await expect(Home({ searchParams: Promise.resolve({}) })).resolves.toBeTruthy();
    data.hasReport.mockRejectedValue(new Error("db down"));
    await expect(Home({ searchParams: Promise.resolve({ week: "2026-10-02" }) })).resolves.toBeTruthy(); // not a false 404
  });
  it("has a friendly first-run state and a database-down state that leaks nothing", async () => {
    setup(null);
    expect(await render()).toContain("No report yet");
    setup(new Error("db down at db.secret.supabase.co"));
    const out = await render();
    expect(out).toContain("couldn&#x27;t load the report");
    expect(out).not.toContain("db down");
    expect(out).not.toContain("supabase");
  });
  it("still renders the report when only the optional chart data fails", async () => {
    setup(reportFor("comparable"));
    data.listReports.mockRejectedValue(new Error("boom"));
    expect(await render()).toContain("Slow reviews");
  });

  it("report mode follows the requested order and omits movement sections when trends are withheld", async () => {
    setup(reportFor("comparable"));
    const out = await render("2026-10-02", "report");
    const order = ["Key changes", "Newly emerging pain points", "Rising and declining issues", "Unresolved problems", "Pain points by category", "Source coverage and limitations"].map((s) => out.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out.indexOf("AI weekly summary")).toBeLessThan(order[0]);
    expect(out).toContain("Largest increase: Slow reviews");
    setup(reportFor("incomparable"));
    const w = await render("2026-10-02", "report");
    expect(w).not.toContain("Rising and declining issues");
    expect(w).not.toMatch(ARROWS);
    expect(w).toContain("Changes are not shown for this report");
  });
});

describe("Weekly Reports page", async () => {
  const { default: Reports } = await import("@/app/reports/page");
  const item = (over: object = {}) => ({ weekStart: "2026-10-02", kind: "ist", periodLabel: "Fri 2 Oct – Thu 8 Oct 2026 (IST)", narrative: "Slow reviews led.", mentions: 16, painPoints: 3, reliability: "incomparable", delivery: "sent", version: 2, sourcesOk: 1, sourcesTotal: 2, emerging: null, rising: null, declining: null, ...over });
  const legacy = () => item({ weekStart: "2026-09-29", kind: "legacy", periodLabel: "Week of Tue 29 Sept 2026 (earlier format)", reliability: "legacy", delivery: "unknown", version: null, sourcesTotal: 0 });
  it("lists reports with their data-quality state and a link to open each; earlier-format weeks are separate", async () => {
    data.listReports.mockResolvedValue([item(), legacy()]);
    const out = html(await Reports());
    expect(out).toContain("Trends withheld");
    expect(out).toContain('href="/reports/2026-10-02"');
    expect(out).toContain('href="/?week=2026-10-02"');
    expect(out).toContain("1/2");
    expect(out.indexOf("Weekly period reports")).toBeLessThan(out.indexOf("Earlier-format reports"));
    expect(out).toContain("never compared with the weeks above");
  });
  it("handles empty and failing data", async () => {
    data.listReports.mockResolvedValue([]);
    expect(html(await Reports())).toContain("No reports yet");
    data.listReports.mockRejectedValue(new Error("x"));
    expect(html(await Reports())).toContain("couldn&#x27;t load the reports");
  });
});

describe("History page", async () => {
  const { default: History } = await import("@/app/history/page");
  const item = (over: object = {}) => ({ weekStart: "2026-10-02", kind: "ist", periodLabel: "Fri 2 Oct – Thu 8 Oct 2026 (IST)", narrative: "n", mentions: 16, painPoints: 3, reliability: "comparable", delivery: "sent", version: 1, sourcesOk: 4, sourcesTotal: 4, emerging: 2, rising: 3, declining: 1, ...over });
  it("compares weeks, showing a dash (never zero) where a report was not compared", async () => {
    data.listReports.mockResolvedValue([item(), item({ weekStart: "2026-09-25", periodLabel: "Fri 25 Sept – Thu 1 Oct 2026 (IST)", reliability: "no_prior", emerging: null, rising: null, declining: null })]);
    data.getHistory.mockResolvedValue({ series: ["A · x"], rows: [{ week: "2026-09-25", label: "25 Sep", state: "no_prior", "A · x": 1 }, { week: "2026-10-02", label: "2 Oct", state: "comparable", "A · x": 4 }], legacyOnly: false });
    const out = html(await History());
    expect(out).toContain("Weekly mention volume");
    expect(out).toContain('data-testid="volume"');
    expect(out).toContain("Week-over-week comparison");
    expect(out).toMatch(/<b class="num">2<\/b><span>New<\/span>/);
    expect(out).toMatch(/<span class="faint" title="Not compared">–<\/span><span>Rising<\/span>/);
    expect(out).toContain('data-testid="chart"');
    expect(out).toContain('href="/reports/2026-10-02"');
  });
  it("needs two weeks before drawing charts and says so", async () => {
    data.listReports.mockResolvedValue([item()]);
    data.getHistory.mockResolvedValue({ series: ["A · x"], rows: [{ week: "2026-10-02", label: "2 Oct", state: "legacy", "A · x": 1 }], legacyOnly: false });
    const out = html(await History());
    expect(out).toContain("needs at least two reports");
    expect(out).not.toContain('data-testid="volume"');
    expect(out).toContain("at least two weeks");
  });
  it("keeps earlier-format weeks apart and warns when only they can be charted", async () => {
    data.listReports.mockResolvedValue([item({ weekStart: "2026-09-29", kind: "legacy", periodLabel: "Week of Tue 29 Sept 2026 (earlier format)", reliability: "legacy" })]);
    data.getHistory.mockResolvedValue({ series: ["A · x"], rows: [{ week: "2026-09-29", label: "29 Sep", state: "legacy", "A · x": 1 }, { week: "2026-10-06", label: "6 Oct", state: "legacy", "A · x": 2 }], legacyOnly: true });
    const out = html(await History());
    expect(out).toContain("Earlier-format weeks only");
    expect(out).toContain("Not charted or compared");
  });
  it("handles empty and failing data", async () => {
    data.listReports.mockResolvedValue([]); data.getHistory.mockResolvedValue({ series: [], rows: [], legacyOnly: false });
    expect(html(await History())).toContain("No history yet");
    data.listReports.mockRejectedValue(new Error("x"));
    expect(html(await History())).toContain("couldn&#x27;t load the history");
  });
});

describe("Evidence Explorer", async () => {
  const { default: Posts } = await import("@/app/posts/page");
  const UUID = "12db9f28-c7de-4600-adc8-3d23f714012d";
  const post = (id: string, source: string, over: object = {}) => ({ id, source, title: `Title ${id}`, body: "b".repeat(500), url: `https://x.test/${id}`, author: "ann", posted_at: "2026-10-05T10:00:00Z", unresolved: true, sentiment: "negative", ...over });
  const ok = { posts: [post("1", "hn"), post("2", "github", { unresolved: false })], total: 5, bySource: { hn: 3, github: 2 }, topicName: "CI/CD automation", periodLabel: "Fri 2 Oct – Thu 8 Oct 2026 (IST)" };
  const call = (q: Record<string, string | undefined>) => Posts({ searchParams: Promise.resolve(q) });
  const sel = { topic: UUID, theme: "Flaky tests", week: "2026-10-02" };
  const setup = () => { data.hasReport.mockResolvedValue(true); data.getReport.mockResolvedValue(reportFor("comparable")); data.getPostsFor.mockReset(); };

  it("offers a chooser of the week's pain points when nothing is selected, and does not query posts", async () => {
    setup();
    for (const q of [{}, { topic: "nope", theme: "x", week: "2026-10-02" }, { topic: UUID, week: "2026-10-02" }]) {
      const out = html(await call(q));
      expect(out).toContain("Find the posts behind a finding");
      expect(out).toContain('href="/posts?topic=a&amp;theme=Slow%20reviews&amp;week=2026-10-02"');
    }
    expect(data.getPostsFor).not.toHaveBeenCalled();
  });
  it("404s a malformed or unknown week", async () => {
    setup();
    await expect(call({ ...sel, week: "oct" })).rejects.toThrow("NEXT_NOT_FOUND");
    data.hasReport.mockResolvedValue(false);
    await expect(call(sel)).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("shows the period, per-source counts and the posts; links open safely and name the original", async () => {
    setup(); data.getPostsFor.mockResolvedValue(ok);
    const out = html(await call(sel));
    expect(out).toContain("Fri 2 Oct – Thu 8 Oct 2026 (IST)");
    expect(out).toContain("Hacker News (3)");
    expect(out).toContain("GitHub (2)");
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("opens the original post in a new tab");
    expect(out).toContain("5 posts");
    expect(out).not.toContain("b".repeat(400)); // snippets are truncated
  });
  it("labels an earlier-format week as such, never with an IST range", async () => {
    setup(); data.getPostsFor.mockResolvedValue({ ...ok, periodLabel: "Week of Tue 6 Oct 2026 (earlier format)" });
    const out = html(await call({ ...sel, week: "2026-10-06" }));
    expect(out).toContain("Week of Tue 6 Oct 2026 (earlier format)");
    expect(out).not.toContain("(IST)");
  });
  it("passes only allow-listed filters to the data layer", async () => {
    setup(); data.getPostsFor.mockResolvedValue(ok);
    await call({ ...sel, theme: "t", source: "github", sentiment: "negative", unresolved: "1" });
    expect(data.getPostsFor).toHaveBeenLastCalledWith(UUID, "t", "2026-10-02", { source: "github", sentiment: "negative", unresolvedOnly: true });
    await call({ ...sel, theme: "t", source: "evil", sentiment: "<script>" });
    expect(data.getPostsFor).toHaveBeenLastCalledWith(UUID, "t", "2026-10-02", { source: undefined, sentiment: undefined, unresolvedOnly: false });
  });
  it("searches within the loaded posts and reports an honest 'x of y' count", async () => {
    setup(); data.getPostsFor.mockResolvedValue(ok);
    const out = html(await call({ ...sel, q: "title 2" }));
    expect(out).toContain("1 of 5 posts match");
    expect(out).toContain("Title 2");
    expect(out).not.toContain("Title 1<");
    expect(out).toContain('value="title 2"');
  });
  it("says so when filters match nothing, and offers to clear them", async () => {
    setup(); data.getPostsFor.mockResolvedValue({ ...ok, posts: [] });
    const out = html(await call({ ...sel, source: "hn" }));
    expect(out).toContain("No posts match these filters");
    expect(out).toContain("Clear filters");
  });
  it("paginates, with page links that keep the filters", async () => {
    setup();
    const many = Array.from({ length: 45 }, (_, i) => post(String(i + 1), "hn"));
    data.getPostsFor.mockResolvedValue({ ...ok, posts: many, total: 45, bySource: { hn: 45 } });
    const p1 = html(await call({ ...sel, source: "hn" }));
    expect(p1.match(/class="card post"/g)).toHaveLength(20);
    expect(p1).toContain("Page 1 of 3");
    expect(p1).toContain("Showing 1–20 of 45");
    expect(p1).toContain("page=2");
    expect(p1).toContain("source=hn");
    const p3 = html(await call({ ...sel, page: "3" }));
    expect(p3.match(/class="card post"/g)).toHaveLength(5);
    expect(p3).toContain("Showing 41–45 of 45");
    expect(html(await call({ ...sel, page: "99" }))).toContain("Page 3 of 3"); // out-of-range page is clamped
  });
  it("states plainly when results are capped by the loading limit", async () => {
    setup(); data.getPostsFor.mockResolvedValue({ ...ok, total: 300 });
    const out = html(await call(sel));
    expect(out).toContain("Only the newest 300 posts");
    setup(); data.getPostsFor.mockResolvedValue({ ...ok, total: 12 });
    expect(html(await call(sel))).not.toContain("Only the newest");
  });
  it("shows a clear error when the posts cannot be loaded, without internals", async () => {
    setup(); data.getPostsFor.mockRejectedValue(new Error("db.secret.supabase.co refused"));
    const out = html(await call(sel));
    expect(out).toContain("couldn&#x27;t load these posts");
    expect(out).not.toContain("supabase");
  });
});

describe("Application shell", async () => {
  const { default: Sidebar } = await import("@/components/Sidebar");
  const { default: MobileBar } = await import("@/components/MobileBar");
  const { default: TopBar } = await import("@/components/TopBar");
  const { NAV, MOBILE_PRIMARY, MOBILE_MORE, activeItem } = await import("@/components/nav");
  it("the sidebar lists every page and marks exactly the active one", async () => {
    for (const [path, label] of [["/", "Overview"], ["/reports/2026-10-02", "Weekly Reports"], ["/posts", "Evidence Explorer"], ["/history", "History"], ["/status", "Pipeline Health"]]) {
      nav.path = path;
      const out = html(<Sidebar />);
      for (const n of NAV) expect(out).toContain(n.label);
      expect(out.match(/aria-current="page"/g)).toHaveLength(1);
      expect(out).toMatch(new RegExp(`aria-current="page"[^>]*>(?:<svg[\\s\\S]*?</svg>)?${label}`));
    }
  });
  it("the mobile bar keeps three destinations and an accessible menu for the rest", () => {
    nav.path = "/";
    const out = html(<MobileBar />);
    expect(MOBILE_PRIMARY.map((n) => n.label)).toEqual(["Overview", "Weekly Reports", "Evidence Explorer"]);
    expect(MOBILE_MORE.map((n) => n.label)).toEqual(["History", "Pipeline Health"]);
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('aria-controls="more-menu"');
    expect(out).toContain('aria-label="More pages and settings"');
    expect(out).not.toContain('id="more-menu"'); // closed by default
  });
  it("the top bar names the current page", () => {
    nav.path = "/history";
    expect(html(<TopBar />)).toContain("History");
    nav.path = "/unknown";
    expect(activeItem("/unknown")).toBeUndefined();
    expect(html(<TopBar />)).toContain("JARVIS");
  });
  it("navigation hrefs are unique and the top-level routes exist", () => {
    expect(new Set(NAV.map((n) => n.href)).size).toBe(NAV.length);
    expect(NAV.map((n) => n.href)).toEqual(["/", "/reports", "/posts", "/history", "/status"]);
  });
});
