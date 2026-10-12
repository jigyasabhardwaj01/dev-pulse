import { describe, expect, it } from "vitest";
import vercelConfig from "../vercel.json";
import { ago, assessHealth, attentionItems, formatReadTime, historyInsights, readSource, scheduleText, sourceTimelines, tally } from "@/lib/health";
import { describeCron, nextWeeklyRun, readSchedule, type ScheduleState } from "@/lib/schedule";
import { NOW, ago as daysAgo, allClean, run, src } from "./health-helpers";

const PAUSED: ScheduleState = { state: "paused", crons: [] };
const WEEKLY: ScheduleState = { state: "configured", crons: [{ path: "/api/cron/weekly-digest", schedule: "30 3 * * 5" }] };
const UNKNOWN: ScheduleState = { state: "unknown", crons: null };
const assess = (runs: ReturnType<typeof run>[], schedule: ScheduleState = PAUSED) => assessHealth({ runs, schedule, now: NOW });
const reddit = (over: Parameters<typeof src>[1]) => allClean().map((s) => (s.source === "reddit" ? src("reddit", over) : s));

describe("reading one source", () => {
  it("a successful fetch with records is 'records'", () => {
    const r = readSource(src("hn"), "hn");
    expect(r.state).toBe("records");
    expect(r.headline).toBe("Succeeded: 10 posts");
  });
  it("a successful fetch with zero results is 'zero', a real result and not a failure", () => {
    const r = readSource(src("stackoverflow", { fetched: 0, accepted: 0, inserted: 0 }), "stackoverflow");
    expect(r.state).toBe("zero");
    expect(r.consequence).toContain("zero is a real result");
  });
  it("some requests failed and some posts were collected is 'partial', and says counts may be understated", () => {
    const r = readSource(src("reddit", { status: "partial", fetched: 22, failedRequests: 2, requests: 3, reason: "Rate limited by the source", topics: { total: 3, ok: 0, partial: 1, error: 2 } }), "reddit");
    expect(r.state).toBe("partial");
    expect(r.headline).toBe("2 of 3 requests failed (rate limited by the source)");
    expect(r.consequence).toContain("22 posts were collected");
    expect(r.consequence).toContain("understated");
  });
  it("some requests succeeded but found nothing while others failed is still 'partial' (not total failure, not healthy)", () => {
    const r = readSource(src("reddit", { status: "error", fetched: 0, accepted: 0, inserted: 0, requests: 9, failedRequests: 7, reason: "Rate limited by the source" }), "reddit");
    expect(r.state).toBe("partial");
    expect(r.headline).toContain("7 of 9 requests failed");
    expect(r.consequence).toContain("may be hiding real posts");
  });
  it("every request failing is 'failed' and is described as a gap, not zero posts", () => {
    const r = readSource(src("reddit", { status: "error", fetched: 0, requests: 3, failedRequests: 3, reason: "Timed out" }), "reddit");
    expect(r.state).toBe("failed");
    expect(r.headline).toBe("All 3 requests failed (timed out)");
    expect(r.consequence).toContain("not zero posts");
  });
  it("falls back to the stored status when a run recorded no request counts", () => {
    expect(readSource(src("reddit", { status: "error", requestsKnown: false, requests: 0, fetched: 0 }), "reddit").state).toBe("failed");
    expect(readSource(src("reddit", { status: "partial", requestsKnown: false, requests: 0 }), "reddit").state).toBe("partial");
    expect(readSource(src("hn", { requestsKnown: false, requests: 0 }), "hn").state).toBe("records");
  });
  it("a page-limited fetch is still a success, flagged as capped", () => {
    const r = readSource(src("hn", { truncated: true }), "hn");
    expect(r.state).toBe("records");
    expect(r.capped).toBe(true);
    expect(r.consequence).toContain("page limit");
  });
  it("a source with no record is 'not checked' if it was seen before, else 'unknown'; neither is zero or success", () => {
    expect(readSource(undefined, "github", { checkedBefore: true }).state).toBe("not_checked");
    const u = readSource(undefined, "github");
    expect(u.state).toBe("unknown");
    expect(u.consequence).toContain("unknown");
  });
});

describe("overall health", () => {
  it("a clean successful run is Working", () => {
    const h = assess([run()]);
    expect(h).toMatchObject({ level: "ok", headline: "Working" });
    expect(h.tally).toEqual({ clean: 4, partial: 0, failed: 0, notChecked: 0, unknown: 0 });
    expect(attentionItems(h)).toEqual([]);
  });
  it("page-limit caps are shown as limits and do not stop it being Working", () => {
    const h = assess([run({ sources: allClean().map((s) => (s.source === "hn" ? src("hn", { truncated: true }) : s)) })]);
    expect(h.level).toBe("ok");
    expect(h.headline).toBe("Working, with limits");
    expect(attentionItems(h).map((i) => i.id)).toEqual(["capped"]);
  });
  it("partial source failure with records downgrades to 'Completed with gaps', never green", () => {
    const h = assess([run({ status: "partial", sources: reddit({ status: "partial", fetched: 5, requests: 3, failedRequests: 1, reason: "Rate limited by the source" }) })]);
    expect(h.level).toBe("degraded");
    expect(h.headline).toBe("Completed with gaps");
    expect(h.summary).toMatch(/finished with issues|partly collected/);
    expect(h.tally.partial).toBe(1);
  });
  it("a complete failure of one source is degraded; of every source is attention", () => {
    const bad = (s: string) => src(s, { status: "error", fetched: 0, requests: 3, failedRequests: 3 });
    expect(assess([run({ status: "partial", sources: allClean().map((s) => (s.source === "reddit" ? bad("reddit") : s)) })]).level).toBe("degraded");
    const all = assess([run({ status: "partial", sources: ["hn", "stackoverflow", "reddit", "github"].map(bad) })]);
    expect(all.level).toBe("attention");
    expect(all.reasons.some((r) => /Every source failed/.test(r.text))).toBe(true);
  });
  it("a success with zero results from a healthy source stays Working", () => {
    const h = assess([run({ sources: allClean().map((s) => (s.source === "stackoverflow" ? src("stackoverflow", { fetched: 0, accepted: 0, inserted: 0 }) : s)) })]);
    expect(h.level).toBe("ok");
  });
  it("latest run failed with an older success: attention, and the older success is still reported as the last successful run", () => {
    const old = run({ id: "old", startedAt: daysAgo(3), finishedAt: daysAgo(3) });
    const h = assess([run({ id: "new", status: "failed", sources: [] }), old]);
    expect(h.level).toBe("attention");
    expect(h.lastSuccessful?.id).toBe("old");
    expect(h.reasons.some((r) => r.level === "note" && /earlier run did succeed/.test(r.text))).toBe(true);
    expect(attentionItems(h)[0]).toMatchObject({ id: "failed", level: "bad" });
  });
  it("'partial' is not 'successful': with only partial runs there is no last successful run, but there is a last completed one", () => {
    const h = assess([run({ status: "partial", id: "a" }), run({ status: "partial", id: "b", startedAt: daysAgo(1) })]);
    expect(h.lastSuccessful).toBeNull();
    expect(h.lastCompleted?.id).toBe("a");
  });
  it("a stuck run needs attention; a run in progress is 'not enough information', not healthy", () => {
    const stuck = assess([run({ status: "running", stuck: true, finishedAt: null, durationSec: null, sources: [] })]);
    expect(stuck.level).toBe("attention");
    expect(attentionItems(stuck)[0].id).toBe("stuck");
    const live = assess([run({ status: "running", finishedAt: null, durationSec: null, sources: [] })]);
    expect(live.level).toBe("unknown");
    expect(live.headline).toBe("Not enough information");
  });
  it("missing source telemetry is degraded and unverified, never healthy", () => {
    const h = assess([run({ sources: [] })]);
    expect(h.level).toBe("degraded");
    expect(h.stages.find((s) => s.key === "collect")).toMatchObject({ state: "unknown", headline: "Not recorded" });
  });
  it("a known source with no recorded status makes the result unknown, not Working", () => {
    const h = assess([run({ sources: allClean().filter((s) => s.source !== "github") })]);
    expect(h.level).toBe("unknown");
    expect(h.reasons.some((r) => /GitHub/.test(r.text) && /unknown/.test(r.text))).toBe(true);
    expect(h.tally.unknown).toBe(1);
  });
  it("a source seen in an earlier run but absent from the latest one is 'not checked' and degrades", () => {
    const h = assess([run({ sources: allClean().filter((s) => s.source !== "github") }), run({ id: "old", startedAt: daysAgo(2) })]);
    expect(h.level).toBe("degraded");
    expect(h.tally.notChecked).toBe(1);
  });
  it("an unrecognised run status is Unknown and never treated as healthy", () => {
    const h = assess([run({ status: "banana" })]);
    expect(h.level).toBe("unknown");
    expect(h.reasons[0].text).toContain("does not recognise");
  });
  it("no runs at all is Unknown", () => {
    const h = assess([]);
    expect(h).toMatchObject({ level: "unknown", latest: null, lastSuccessful: null });
    expect(h.reasons[0].text).toBe("No pipeline runs are recorded.");
  });
  it("unclassified posts, a template summary and a failed email each degrade a successful run", () => {
    expect(assess([run({ unclassified: 3 })]).level).toBe("degraded");
    expect(assess([run({ usedFallback: true })]).level).toBe("degraded");
    expect(assess([run({ emailStatus: "failed" })]).level).toBe("degraded");
  });
  it("an unconfirmed email delivery needs attention and appears as an action item without any retry control", () => {
    const h = assess([run({ emailStatus: "unconfirmed" })]);
    expect(h.level).toBe("attention");
    const item = attentionItems(h).find((i) => i.id === "email")!;
    expect(item.level).toBe("bad");
    expect(item.next).toContain("Check the inbox");
    expect(h.stages.find((s) => s.key === "email")).toMatchObject({ state: "bad", headline: "Delivery unconfirmed" });
  });
  it("a fetch success is not taken as proof of the later stages", () => {
    const h = assess([run({ classified: null, usedFallback: false, emailStatus: null })]);
    const by = Object.fromEntries(h.stages.map((s) => [s.key, s]));
    expect(by.collect.state).toBe("ok");
    expect(by.classify.state).toBe("unknown");
    expect(by.email.state).toBe("unknown");
  });
  it("a backfill's email stage is 'Not attempted' and neutral", () => {
    const e = assess([run({ trigger: "backfill", emailStatus: "not_attempted" })]).stages.find((s) => s.key === "email")!;
    expect(e).toMatchObject({ state: "neutral", headline: "Not attempted", detail: "Backfills never send email." });
  });
});

const dg = (code: string, over: Record<string, unknown> = {}) => ({ code, severity: "info" as const, stage: "persist" as const, message: `m ${code}`, at: "2026-10-13T05:01:00Z", ...over });

describe("stages backed by structured diagnostics", () => {
  const stage = (r: ReturnType<typeof run>, key: string) => assess([r]).stages.find((s) => s.key === key)!;
  it("Save is verified only by a recorded REPORT_SAVED, with the action and version", () => {
    expect(stage(run({ diagnostics: [dg("REPORT_SAVED", { detail: { action: "create", version: 2 } })] }), "persist")).toMatchObject({ state: "ok", headline: "Version 2 created" });
    expect(stage(run({ diagnostics: [dg("REPORT_SAVED", { detail: { action: "keep", version: 1 } })] }), "persist").headline).toBe("Version 1 kept");
  });
  it("a run with diagnostics but no REPORT_SAVED is 'Not confirmed' (warn), not assumed saved", () => {
    expect(stage(run({ diagnostics: [dg("SOURCE_CAPPED", { stage: "collect" })] }), "persist")).toMatchObject({ state: "warn", headline: "Not confirmed" });
  });
  it("a run from before diagnostics existed is 'Not recorded' (unknown), and a failed or running run is 'Not verified'", () => {
    expect(stage(run({ diagnostics: [] }), "persist")).toMatchObject({ state: "unknown", headline: "Not recorded" });
    expect(stage(run({ status: "failed", diagnostics: [dg("RUN_FAILED", { stage: "run" })] }), "persist")).toMatchObject({ state: "unknown", headline: "Not verified" });
    expect(stage(run({ status: "running", finishedAt: null }), "persist").headline).toBe("Not verified");
  });
  it("a legacy run's missing save step does not degrade health", () => {
    expect(assess([run({ diagnostics: [] })]).level).toBe("ok");
  });
  it("there are five stages, in pipeline order", () => {
    expect(assess([run()]).stages.map((s) => s.key)).toEqual(["collect", "classify", "summary", "persist", "email"]);
  });
  it("retries and rate-limit waiting come from the latest run's diagnostics, per source", () => {
    const h = assess([run({ diagnostics: [
      dg("SOURCE_RETRIED", { stage: "collect", source: "hn", detail: { retries: 2, waitedMs: 1500 } }),
      dg("SOURCE_THROTTLED", { stage: "collect", source: "reddit", detail: { retries: 0, waitedMs: 58000 } }),
    ] })]);
    const by = Object.fromEntries(h.timelines.map((t) => [t.source, t]));
    expect(by.hn).toMatchObject({ retries: 2, waitedMs: 1500 });
    expect(by.reddit).toMatchObject({ retries: 0, waitedMs: 58000 });
    expect(by.github).toMatchObject({ retries: 0, waitedMs: 0 });
  });
  it("error diagnostics that no other field reflects degrade health and become attention items with their remedy", () => {
    const h = assess([run({ diagnostics: [dg("CLASSIFY_NO_MODEL", { severity: "error", stage: "classify", message: "Classification was skipped.", remedy: "Set GEMINI_API_KEY." }), dg("REPORT_SAVED")] })]);
    expect(h.level).toBe("degraded");
    const item = attentionItems(h).find((i) => i.id === "diag:CLASSIFY_NO_MODEL")!;
    expect(item).toMatchObject({ level: "bad", where: "Classify", next: "Set GEMINI_API_KEY." });
    expect(item.effect).toContain("unclassified");
  });
  it("info and warning diagnostics alone never degrade a run that otherwise succeeded", () => {
    expect(assess([run({ diagnostics: [dg("REPORT_SAVED"), dg("SOURCE_RETRIED", { stage: "collect", source: "hn", detail: { retries: 1, waitedMs: 500 } })] })]).level).toBe("ok");
  });
});

describe("schedule and freshness", () => {
  it("the deployed vercel.json registers exactly one weekly cron for the authenticated digest route", () => {
    const crons = (vercelConfig as { crons: { path: string; schedule: string }[] }).crons;
    expect(crons).toEqual([{ path: "/api/cron/weekly-digest", schedule: "30 3 * * 5" }]); // Fridays 03:30 UTC = 09:00 IST
    expect(readSchedule(vercelConfig).state).toBe("configured");
    expect(new Set(crons.map((c) => c.path)).size).toBe(crons.length); // never registered twice
    expect(crons.every((c) => !c.path.includes("?"))).toBe(true);       // no query: a plain run, never a backfill (asOf)
  });
  it("reads configured, paused and unknown schedules, and rejects malformed ones", () => {
    expect(readSchedule({ crons: [] })).toEqual({ state: "paused", crons: [] });
    expect(readSchedule({ crons: [{ path: "/x", schedule: "30 3 * * 5" }] }).state).toBe("configured");
    for (const bad of [undefined, null, {}, { crons: "x" }, { crons: [{ path: 1 }] }, { crons: [{ path: "/x", schedule: "* * * * *" }, 5] }]) expect(readSchedule(bad).state).toBe("unknown");
  });
  it("describes only the documented weekly cron in words", () => {
    expect(describeCron("30 3 * * 5")).toContain("Fridays 09:00 IST");
    expect(describeCron("0 0 * * *")).toBe("cron 0 0 * * *");
  });
  it("paused: the page says Paused and does not judge how old the last run is, even when it is ancient", () => {
    const h = assess([run({ startedAt: daysAgo(60), finishedAt: daysAgo(60) })], PAUSED);
    expect(h.freshness.state).toBe("not_assessed");
    expect(h.level).toBe("ok"); // not stale: cadence is not defined while paused
    expect(scheduleText(PAUSED)).toMatchObject({ label: "Paused", tone: "warn" });
  });
  it("configured weekly: a completed scheduled run within 8 days is fresh, older is stale and needs attention", () => {
    expect(assess([run({ finishedAt: daysAgo(7) })], WEEKLY).freshness.state).toBe("fresh");
    const stale = assess([run({ finishedAt: daysAgo(9), startedAt: daysAgo(9) })], WEEKLY);
    expect(stale.freshness.state).toBe("stale");
    expect(stale.level).toBe("attention");
    expect(stale.freshness.text).toContain("more than 8 days ago");
  });
  it("a PARTIAL scheduled run still proves the scheduler is working (fresh); the partial result is judged by the other rules", () => {
    const h = assess([run({ status: "partial" })], WEEKLY);
    expect(h.freshness.state).toBe("fresh");
    expect(h.level).toBe("degraded");
  });
  it("only scheduled runs count for freshness: a recent backfill does not hide a stale schedule", () => {
    const h = assess([run({ trigger: "backfill", finishedAt: daysAgo(0) }), run({ id: "s", trigger: "scheduled", finishedAt: daysAgo(10), startedAt: daysAgo(10) })], WEEKLY);
    expect(h.freshness.state).toBe("stale");
  });
  it("scheduled runs that only ever failed leave the schedule stale (no completed run)", () => {
    const h = assess([run({ status: "failed", sources: [], finishedAt: daysAgo(1) })], WEEKLY);
    expect(h.freshness.state).toBe("stale");
    expect(h.level).toBe("attention");
  });
  it("a newly configured schedule with only backfills so far is 'pending its first run', which is a note and not an alarm", () => {
    const h = assess([run({ trigger: "backfill", status: "partial" })], WEEKLY);
    expect(h.freshness.state).toBe("pending");
    expect(h.level).not.toBe("attention");
    expect(h.reasons.some((r) => r.level === "note" && /first scheduled run has not happened/.test(r.text))).toBe(true);
  });
  it("once a scheduled run exists, the schedule is no longer 'pending'", () => {
    expect(assess([run({ trigger: "scheduled", status: "partial" })], WEEKLY).freshness.state).toBe("fresh");
  });
  it("shows the next due time for the documented weekly cron, from the schedule itself", () => {
    expect(scheduleText(WEEKLY, new Date("2026-10-12T12:00:00Z")).next?.toISOString()).toBe("2026-10-16T03:30:00.000Z");
    expect(scheduleText(PAUSED, NOW).next).toBeNull();
    expect(scheduleText(WEEKLY).next).toBeNull();
  });
  it("computes the next Friday 03:30 UTC correctly around the boundary, and refuses other expressions", () => {
    const iso = (s: string) => nextWeeklyRun("30 3 * * 5", new Date(s))!.toISOString();
    expect(iso("2026-10-16T03:29:59Z")).toBe("2026-10-16T03:30:00.000Z"); // a second before: still today
    expect(iso("2026-10-16T03:30:00Z")).toBe("2026-10-23T03:30:00.000Z"); // exactly due: the next one
    expect(iso("2026-10-16T09:00:00Z")).toBe("2026-10-23T03:30:00.000Z");
    expect(iso("2026-10-17T00:00:00Z")).toBe("2026-10-23T03:30:00.000Z"); // Saturday
    expect(iso("2026-12-31T23:59:59Z")).toBe("2027-01-01T03:30:00.000Z"); // across a year end (a Friday)
    expect(nextWeeklyRun("0 0 * * *", NOW)).toBeNull();
  });
  it("an unreadable schedule is Unknown, never assumed active or paused", () => {
    expect(assess([run()], UNKNOWN).freshness.state).toBe("unknown");
    expect(scheduleText(UNKNOWN).label).toBe("Unknown");
    expect(scheduleText(WEEKLY).label).toBe("Configured");
    expect(scheduleText(WEEKLY).detail).toContain("final authority");
  });
});

describe("attention items", () => {
  it("de-duplicates, puts action items first, and explains effect and next step", () => {
    const h = assess([run({ status: "partial", unclassified: 2, sources: allClean().map((s) => s.source === "reddit" ? src("reddit", { status: "error", fetched: 0, requests: 9, failedRequests: 7, reason: "Rate limited by the source" }) : s.source === "hn" || s.source === "github" ? src(s.source, { truncated: true }) : s) })]);
    const items = attentionItems(h);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items[0].id).toBe("src:reddit");
    expect(items[0].next).toContain("OAuth credentials");
    expect(items[0].effect).toContain("hiding real posts");
    const capped = items.filter((i) => i.id === "capped");
    expect(capped).toHaveLength(1);
    expect(capped[0].where).toBe("Hacker News, GitHub");
    expect(items.map((i) => i.level)).toEqual([...items.map((i) => i.level)].sort((a, b) => ({ bad: 0, warn: 1, info: 2 } as const)[a] - ({ bad: 0, warn: 1, info: 2 } as const)[b]));
  });
  it("a non-rate-limit source problem gets the generic next step, not the Reddit-specific one", () => {
    const h = assess([run({ status: "partial", sources: reddit({ status: "partial", fetched: 1, requests: 3, failedRequests: 1, reason: "Timed out" }) })]);
    expect(attentionItems(h)[0].next).not.toContain("OAuth");
  });
});

describe("history", () => {
  const partialReddit = (id: string, days: number, dur = 100) => run({ id, status: "partial", startedAt: daysAgo(days), durationSec: dur, sources: reddit({ status: "partial", fetched: 2, requests: 3, failedRequests: 1 }) });
  it("one observation produces no insight and no trend", () => {
    expect(historyInsights([run()])).toEqual({ noSuccessStreak: 0, recurring: [], duration: null });
  });
  it("repeated source problems and a no-success streak are reported once there are two observations", () => {
    const i = historyInsights([partialReddit("a", 0), partialReddit("b", 1)]);
    expect(i.noSuccessStreak).toBe(2);
    expect(i.recurring).toEqual([{ source: "reddit", name: "Reddit", runs: 2, of: 2, streak: 2 }]);
    expect(i.duration).toBeNull(); // two durations are not a trend
  });
  it("a duration range appears only with at least three recorded durations, and is a range, not a trend claim", () => {
    expect(historyInsights([partialReddit("a", 0, 120), partialReddit("b", 1, 80), partialReddit("c", 2, 100)]).duration).toEqual({ latestSec: 120, minSec: 80, maxSec: 120, of: 3 });
  });
  it("an older success ends the streak", () => {
    expect(historyInsights([partialReddit("a", 0), run({ id: "ok", startedAt: daysAgo(1) })]).noSuccessStreak).toBe(0);
  });
  it("per-source timelines separate the latest attempt from the last clean fetch", () => {
    const tl = sourceTimelines([partialReddit("a", 0), partialReddit("b", 1)]);
    const r = tl.find((x) => x.source === "reddit")!;
    expect(r.lastCleanAt).toBeNull();
    expect(r.problemStreak).toBe(2);
    expect(r.lastAttemptAt).toBe(daysAgo(0));
    expect(tl.find((x) => x.source === "hn")!.lastCleanAt).toBe(daysAgo(0));
    expect(tally(tl)).toMatchObject({ clean: 3, partial: 1 });
  });
  it("an old clean fetch is not hidden by a newer failure: both are reported", () => {
    const tl = sourceTimelines([partialReddit("a", 0), run({ id: "b", startedAt: daysAgo(5) })]);
    const r = tl.find((x) => x.source === "reddit")!;
    expect(r.latest.state).toBe("partial");
    expect(r.lastCleanAt).toBe(daysAgo(5));
  });
});

describe("read time", () => {
  it("is shown in IST with seconds, so a reload visibly advances it", () => {
    expect(formatReadTime(new Date("2026-10-13T06:00:42Z"))).toBe("13 Oct 2026 11:30:42 IST");
    expect(formatReadTime(new Date("2026-10-13T06:00:43Z"))).not.toBe(formatReadTime(new Date("2026-10-13T06:00:42Z")));
  });
});

describe("relative time", () => {
  it("words ages plainly and tolerates bad input", () => {
    expect(ago("2026-10-13T05:59:40Z", NOW)).toBe("just now");
    expect(ago("2026-10-13T05:15:00Z", NOW)).toBe("45 min ago");
    expect(ago("2026-10-13T00:00:00Z", NOW)).toBe("6 h ago");
    expect(ago("2026-10-10T06:00:00Z", NOW)).toBe("3 days ago");
    expect(ago("2026-10-14T06:00:00Z", NOW)).toBe("just now");
    expect(ago(null, NOW)).toBe("");
    expect(ago("not a date", NOW)).toBe("");
  });
});
