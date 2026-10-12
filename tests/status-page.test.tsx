import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AttentionList from "@/components/AttentionList";
import HealthSummary from "@/components/HealthSummary";
import LatestRun from "@/components/LatestRun";
import RunHistory from "@/components/RunHistory";
import { assessHealth, attentionItems } from "@/lib/health";
import type { ScheduleState } from "@/lib/schedule";
import { NOW, ago as daysAgo, allClean, run, src } from "./health-helpers";

const data = vi.hoisted(() => ({ getRecentRuns: vi.fn() }));
vi.mock("@/lib/data", () => data);

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const PAUSED: ScheduleState = { state: "paused", crons: [] };
const WEEKLY: ScheduleState = { state: "configured", crons: [{ path: "/api/cron/weekly-digest", schedule: "30 0 * * 5" }] };

// What the real database looked like after the two backfills: partial runs, Reddit 7 of 9 requests failed, no fully successful run.
const realish = () => {
  const redditLatest = src("reddit", { status: "error", fetched: 0, accepted: 0, inserted: 0, requests: 9, failedRequests: 7, reason: "Rate limited by the source", topics: { total: 3, ok: 0, partial: 2, error: 1 }, maxDurationMs: 54_000 });
  const mk = (id: string, started: string, rd = redditLatest) => run({ id, status: "partial", trigger: "backfill", startedAt: started, finishedAt: started, durationSec: 121, emailStatus: "not_attempted", warningCount: 9, sources: allClean().map((s) => (s.source === "reddit" ? rd : s.source === "hn" || s.source === "github" ? src(s.source, { truncated: true }) : s)) });
  return [mk("latest", daysAgo(0)), mk("older", daysAgo(0.01))];
};

describe("Pipeline Health page", async () => {
  const { default: Status } = await import("@/app/status/page");
  const page = async () => html(await Status());

  it("answers the five questions near the top for the current real-world state", async () => {
    data.getRecentRuns.mockResolvedValue(realish());
    const out = await page();
    expect(out).toContain("Completed with gaps");               // is it working
    expect(out).toContain("Last successful run");               // when did it last succeed
    expect(out).toContain("None recorded");                      //   ...and the honest answer
    expect(out).toContain("Last completed with issues");
    expect(out).toContain("7 of 9 requests failed");             // which source had problems, at request level
    expect(out).toContain("What needs attention");               // is human attention needed
    expect(out).toContain("Scheduled runs");
    expect(out).toContain("Configured");                         // the weekly cron is registered in vercel.json
    expect(out).toContain("Fridays 06:00 IST");
    expect(out.indexOf("Overall")).toBeLessThan(out.indexOf("Latest run"));
    expect(out.indexOf("What needs attention")).toBeLessThan(out.indexOf("Latest run</h2>"));
    expect(out.indexOf("Latest run</h2>")).toBeLessThan(out.indexOf("Recent runs"));
  });
  it("never shows a green 'Working' while a source is partial or failed", async () => {
    data.getRecentRuns.mockResolvedValue(realish());
    const out = await page();
    expect(out).not.toMatch(/health-title[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span>Working/);
    expect(out).toContain("hs-degraded");
  });
  it("separates the run outcome from each source outcome, and names the practical effect", async () => {
    data.getRecentRuns.mockResolvedValue(realish());
    const out = await page();
    expect(out).toContain("Completed with issues");              // run outcome
    expect(out).toContain("Partly collected");                   // Reddit's source outcome
    expect(out).toContain("hiding real posts");                  // effect
    expect(out).toContain("Succeeded: 10 posts");                // a different source in the same run
    expect(out).toContain("Collected successfully, but results hit the page limit");
  });
  it("has expandable technical details with real request and duration figures, and accessible names", async () => {
    data.getRecentRuns.mockResolvedValue(realish());
    const out = await page();
    expect(out).toContain("<details");
    expect(out).toContain("Technical details<span class=\"sr-only\"> for Reddit</span>");
    expect(out).toContain("9 made, 7 failed");
    expect(out).toContain("54 s");
    expect(out).toContain("0 ok · 2 partial · 1 failed (of 3)");
  });
  it("shows the four pipeline stages and does not treat fetch success as proof of the others", async () => {
    data.getRecentRuns.mockResolvedValue([run({ classified: null, emailStatus: null })]);
    const out = await page();
    for (const s of ["Collect", "Classify", "Summary", "Save", "Email"]) expect(out).toContain(`stage-name">${s}`);
    expect(out).toContain("Not recorded");
  });
  it("renders only coarse reasons: no raw error text, hosts, table names or warning text ever reaches the page", async () => {
    const leak = realish();
    leak[0].problem = "The run reported a problem. See the server logs for details.";
    leak[0].sources = leak[0].sources.map((s) => (s.source === "reddit" ? { ...s, reason: "Rate limited by the source" } : s));
    (leak[0] as unknown as { warnings: string[] }).warnings = ['db.secret.supabase.co violates constraint "briefs_pkey"'];
    data.getRecentRuns.mockResolvedValue(leak);
    const out = await page();
    for (const bad of ["supabase", "constraint", "briefs_pkey", "violates", "Bearer", "x-api-key"]) expect(out).not.toContain(bad);
    expect(out).toContain("See the server logs");
    expect(out).toContain("9 warnings were recorded");
    expect(out).not.toContain("Paused");
  });
  it("is read-only: no forms, buttons or actions; the only link-like control is a plain reload", async () => {
    data.getRecentRuns.mockResolvedValue(realish());
    const out = await page();
    expect(out).not.toMatch(/<form|<button|method=|onclick/i);
    expect(out).toContain('<a class="btn" href="/status">Reload</a>');
    expect(out).not.toMatch(/backfill now|run now|resend|retry/i);
  });
  it("has one h1, ordered section headings, a status region, and conveys state in text", async () => {
    data.getRecentRuns.mockResolvedValue(realish());
    const out = await page();
    expect(out.match(/<h1>/g)).toHaveLength(1);
    expect(out).toContain('role="status"');
    expect(out).toContain("(Gaps)");                              // screen-reader word for the overall level, not colour alone
    expect(out.match(/aria-hidden="true"/g)!.length).toBeGreaterThan(0); // decorative icons hidden
    expect(out).toMatch(/<span class="pill warn">Partly collected<\/span>/);
  });
  it("states plainly when the database cannot be read, offering a reload and leaking nothing", async () => {
    data.getRecentRuns.mockRejectedValue(new Error("db.secret.supabase.co refused"));
    const out = await page();
    expect(out).toContain("couldn&#x27;t load run history");
    expect(out).toContain('href="/status"');
    expect(out).not.toContain("supabase");
  });
  it("explains a missing run-history table and an empty history without implying health", async () => {
    data.getRecentRuns.mockResolvedValue(null);
    expect(await page()).toContain("isn&#x27;t available yet");
    data.getRecentRuns.mockResolvedValue([]);
    const out = await page();
    expect(out).toContain("No runs recorded yet");
    expect(out).toContain("health is unknown");
    expect(out).not.toContain("Working");
  });
});

describe("diagnostics on the page", async () => {
  const { default: Status } = await import("@/app/status/page");
  const d = (code: string, severity: "info" | "warning" | "error", over: Record<string, unknown> = {}) => ({ code, severity, stage: "collect" as const, message: `Message for ${code}.`, at: "2026-10-13T05:01:00Z", ...over });
  it("lists diagnostics with stable code, severity, stage, time and next step, errors first", async () => {
    data.getRecentRuns.mockResolvedValue([run({ status: "partial", diagnostics: [d("REPORT_SAVED", "info", { stage: "persist", detail: { action: "create", version: 1 } }), d("SOURCE_RATE_LIMITED", "warning", { source: "reddit", remedy: "Wait for the reset." }), d("CLASSIFY_NO_MODEL", "error", { stage: "classify", remedy: "Set the key." })] })]);
    const out = html(await Status());
    expect(out).toContain("Diagnostics (3)");
    expect(out).toContain("<code>CLASSIFY_NO_MODEL</code>");
    expect(out).toContain("Next: Wait for the reset.");
    expect(out.indexOf("CLASSIFY_NO_MODEL</code>")).toBeLessThan(out.indexOf("SOURCE_RATE_LIMITED</code>"));
    expect(out.indexOf("SOURCE_RATE_LIMITED</code>")).toBeLessThan(out.indexOf("REPORT_SAVED</code>"));
    expect(out).toContain("Version 1 created");              // the Save stage is backed by REPORT_SAVED
  });
  it("shows retries and rate-limit waiting in a source's technical details", async () => {
    data.getRecentRuns.mockResolvedValue([run({ diagnostics: [d("SOURCE_THROTTLED", "info", { source: "reddit", detail: { retries: 0, waitedMs: 58000 } }), d("SOURCE_RETRIED", "info", { source: "hn", detail: { retries: 2, waitedMs: 1500 } })] })]);
    const out = html(await Status());
    expect(out).toContain("Waited for rate limit");
    expect(out).toContain("58 s");
    expect(out).toMatch(/Requests retried<\/dt><dd class="num">2</);
  });
  it("a run from before diagnostics shows only a count of legacy warnings, never their text", async () => {
    data.getRecentRuns.mockResolvedValue([run({ diagnostics: [], warningCount: 9 })]);
    const out = html(await Status());
    expect(out).toContain("9 warnings were recorded for this run (recorded before structured diagnostics)");
    expect(out).not.toContain("Diagnostics (");
    expect(out).toContain("Not recorded"); // Save stage
  });
  it("renders hostile diagnostic text as text, never as markup", async () => {
    data.getRecentRuns.mockResolvedValue([run({ diagnostics: [d("SOURCE_FAILED", "error", { message: "<script>alert(1)</script> & <img src=x onerror=y>" })] })]);
    const out = html(await Status());
    expect(out).not.toContain("<script>alert");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("HealthSummary", () => {
  const view = (runs: ReturnType<typeof run>[], schedule: ScheduleState = PAUSED) => {
    const health = assessHealth({ runs, schedule, now: NOW });
    return html(<HealthSummary health={health} schedule={schedule} now={NOW} />);
  };
  it("a clean success is Working, with the last successful run and its age", () => {
    const out = view([run({ startedAt: "2026-10-13T05:00:00Z", finishedAt: "2026-10-13T05:02:00Z" })]);
    expect(out).toContain("hs-ok");
    expect(out).toMatch(/Working/);
    expect(out).toContain("1 h ago");
    expect(out).toContain("4 clean");
  });
  it("a failed latest run with an older success reports both, and needs attention", () => {
    const out = view([run({ id: "n", status: "failed", sources: [] }), run({ id: "o", startedAt: daysAgo(3), finishedAt: daysAgo(3) })]);
    expect(out).toContain("hs-attention");
    expect(out).toContain("Needs attention");
    expect(out).toContain("Failed");
    expect(out).toContain("3 days ago");
  });
  it("a configured schedule is shown as configured and stale when the last success is too old", () => {
    const out = view([run({ startedAt: daysAgo(9), finishedAt: daysAgo(9) })], WEEKLY);
    expect(out).toContain("Configured");
    expect(out).toContain("Fridays 06:00 IST");
    expect(out).toContain("hs-attention");
    expect(out).toContain("more than 8 days ago");
  });
  it("an unreadable schedule is Unknown, and the page never claims it is active", () => {
    const out = view([run()], { state: "unknown", crons: null });
    expect(out).toContain("<strong>Unknown</strong>");
    expect(out).not.toContain("Configured");
  });
  it("documents how health is decided, and its limits", () => {
    const out = view([run()]);
    expect(out).toContain("How health is decided");
    expect(out).toContain("Needs attention:");
    expect(out).toContain("Completed with gaps:");
    expect(out).toContain("Inbox delivery of email is not observable here");
  });
  it("an unrecognised status reads 'Unknown status' and not healthy", () => {
    const out = view([run({ status: "banana" })]);
    expect(out).toContain("Unknown status");
    expect(out).toContain("hs-unknown");
  });
});

describe("AttentionList, LatestRun, RunHistory", () => {
  it("says so when nothing needs attention", () => {
    const h = assessHealth({ runs: [run()], schedule: PAUSED, now: NOW });
    expect(html(<AttentionList items={attentionItems(h)} />)).toContain("Nothing needs attention");
  });
  it("lists effect and next step for each item, once, with text labels (not colour alone)", () => {
    const h = assessHealth({ runs: realish(), schedule: PAUSED, now: NOW });
    const out = html(<AttentionList items={attentionItems(h)} />);
    expect(out).toContain("Effect:");
    expect(out).toContain("Next:");
    expect(out).toContain('<span class="pill warn">Gap</span><span class="pill neutral">Reddit</span>');
    expect(out).toContain('<span class="pill info">Limit</span>');
    expect(out.match(/Results hit the page limit/g)).toHaveLength(1);   // the two capped sources are one item
    expect(out).toContain("OAuth credentials");
  });
  it("shows a source that was not checked as not checked, never as zero posts", () => {
    const runs = [run({ sources: allClean().filter((s) => s.source !== "github") }), run({ id: "old", startedAt: daysAgo(2) })];
    const out = html(<LatestRun health={assessHealth({ runs, schedule: PAUSED, now: NOW })} now={NOW} />);
    expect(out).toContain("Not checked in the latest run");
    expect(out).toContain("not zero posts");
  });
  it("shows success-with-zero-results as a success", () => {
    const runs = [run({ sources: allClean().map((s) => (s.source === "stackoverflow" ? src("stackoverflow", { fetched: 0, accepted: 0, inserted: 0 }) : s)) })];
    const out = html(<LatestRun health={assessHealth({ runs, schedule: PAUSED, now: NOW })} now={NOW} />);
    expect(out).toContain("Succeeded, no results");
    expect(out).toContain("zero is a real result");
  });
  it("history is compact, flags repeated Reddit problems, and draws no trend from one or two runs", () => {
    const out = html(<RunHistory runs={realish()} />);
    expect(out).toContain("2 runs in a row");
    expect(out).toContain("Reddit</strong> was partial or failed in 2 of 2 runs");
    expect(out).toContain("need at least 3 recorded runs");
    expect(out).toContain("Latest");
    expect(out.match(/class="card report-card run-row"/g)).toHaveLength(2);
  });
  it("history with a single run shows no insight at all", () => {
    const out = html(<RunHistory runs={[run()]} />);
    expect(out).not.toContain("in a row");
    expect(out).not.toContain("class=\"insights\"");
  });
  it("shows missing counts as dashes, not zeros", () => {
    const out = html(<RunHistory runs={[run({ fetchedTotal: null, newPosts: null, classified: null, unclassified: null })]} />);
    expect(out.match(/<b class="num">–<\/b>/g)).toHaveLength(4);
  });
});
