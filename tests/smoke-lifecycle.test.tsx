import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PainPointGroups from "@/components/PainPointGroups";
import { runDigest, type EmailArgs } from "@/lib/pipeline";
import { renderBriefHtml } from "@/lib/email";
import { buildReportView, displayPoints, type BriefDbRow } from "@/lib/report-model";
import { periodFor } from "@/lib/week";
import { planRun } from "@/lib/run-plan";
import { MemoryStore, post } from "./helpers";
import { goodModel, downModel, result } from "./stage2-helpers";

/**
 * SMOKE: the whole backend as it would run over several Fridays, against the in-memory store, checking at every step
 * that what the dashboard would show, what is saved and what is emailed are the same thing.
 */
const FRIDAYS = ["2026-10-09T03:30:00Z", "2026-10-16T03:30:00Z", "2026-10-23T03:30:00Z", "2026-10-30T03:30:00Z"].map((d) => new Date(d));
const at = (week: number, day = 1) => new Date(periodFor(FRIDAYS[week]).start.getTime() + day * 86_400_000 + 3_600_000).toISOString();
const ARROWS = /[▲▼]/;

/** What the dashboard would load for a week, built from the store exactly as data.ts does from the database. */
function dashboardView(store: MemoryStore, weekStart: string) {
  const b = store.briefs.get(weekStart)!;
  const e = store.emails.get(weekStart);
  const row: BriefDbRow = {
    week_start: weekStart, narrative: b.narrative, top_pain_points: b.points, created_at: b.createdAt, coverage: b.coverage, version: b.version,
    email_status: e?.status ?? null, email_sent_at: e?.status === "sent" ? "2026-01-01T00:00:00Z" : null, emailed_version: e?.emailedVersion ?? null,
  };
  const rp = store.reports.get(weekStart)!;
  return buildReportView(row, { week_start: weekStart, period_start: rp.period_start, period_end: rp.period_end, coverage: rp.coverage }, [...store.reports.keys()].sort().reverse());
}

describe("smoke: four Fridays end to end", () => {
  it("runs the full lifecycle with consistent reports, honest trends and safe retries", async () => {
    const store = new MemoryStore();
    const sent: EmailArgs[] = [];
    const send = vi.fn(async (a: EmailArgs) => { sent.push(a); return { status: "sent" as const, messageId: `m${sent.length}` }; });
    const hn = (week: number, n: number) => async () => Array.from({ length: n }, (_, i) => post({ source_id: `w${week}-${i}`, posted_at: at(week, i % 6) }));
    const github = (week: number, n: number) => async () => result({ posts: Array.from({ length: n }, (_, i) => post({ source: "github", source_id: `g${week}-${i}`, posted_at: at(week, i % 6) })) });
    const run = (week: number, over: object = {}) => runDigest({ store, now: FRIDAYS[week], callModel: goodModel(), sendEmail: send, fetchers: { hn: hn(week, 4) }, ...over });

    // WEEK 1 (Fri 9 Oct): first ever report on this format, Gemini is down.
    const w1 = await run(0, { callModel: downModel });
    expect(w1).toMatchObject({ weekStart: "2026-10-02", status: "partial", pending: 4, comparison: { state: "no_prior" }, usedFallbackNarrative: true });
    expect(w1.email).toBe("sent"); // a degraded report is still delivered once, with a template narrative
    expect(sent[0].version).toBe(1);

    // WEEK 2 (Fri 16 Oct): Gemini is back. Week-1's stranded posts are recovered into week 1; week 2 compares against it.
    const w2 = await run(1);
    expect(w2.recoveredFromEarlierPeriods).toBe(4);
    expect(store.aggregates.get("2026-10-02")![0].count).toBe(4); // corrected after the fact
    expect(w2.comparison.state).toBe("comparable");
    expect(store.briefs.get("2026-10-02")!.version).toBe(1); // week 1's delivered report is untouched...
    expect(store.briefs.get("2026-10-02")!.usedFallback).toBe(true); // ...even though a better one could now be written
    expect(w2.email).toBe("sent");

    // WEEK 3 (Fri 23 Oct): GitHub joins this week only. Counts are kept, but no trend may be claimed.
    const w3 = await run(2, { fetchers: { hn: hn(2, 4), github: github(2, 6) } });
    expect(w3.comparison.state).toBe("incomparable");
    const v3 = dashboardView(store, w3.weekStart);
    expect(displayPoints(v3).every((p) => p.direction === "unavailable")).toBe(true);
    expect(renderToStaticMarkup(<PainPointGroups points={displayPoints(v3)} weekStart={w3.weekStart} />)).not.toMatch(ARROWS);
    expect(v3.stats.mentions).toBe(10); // 4 HN + 6 GitHub, all counted

    // WEEK 4 (Fri 30 Oct): same sources again; the email provider fails once, then the retry succeeds.
    const flaky = vi.fn().mockRejectedValueOnce(new Error("resend 500")).mockImplementation(send);
    const w4a = await run(3, { fetchers: { hn: hn(3, 4), github: github(3, 6) }, sendEmail: flaky });
    expect(w4a.comparison.state).toBe("comparable");
    expect(w4a.email).toBe("failed");
    expect(store.emails.get(w4a.weekStart)?.status).toBe("failed"); // this week's send failed and is retryable
    expect(store.emails.get(w3.weekStart)?.status).toBe("sent"); // the earlier week was delivered and is untouched

    const before = sent.length;
    const w4b = await run(3, { fetchers: { hn: hn(3, 4), github: github(3, 6) }, sendEmail: flaky });
    expect(w4b.email).toBe("sent");
    expect(sent.length).toBe(before + 1);
    expect((await run(3, { fetchers: { hn: hn(3, 4), github: github(3, 6) }, sendEmail: flaky })).email).toBe("already_sent");

    // CONSISTENCY across every delivered week: the dashboard model, the saved brief and the emailed content agree.
    for (const args of sent) {
      const saved = store.briefs.get(args.weekStart)!;
      const view = dashboardView(store, args.weekStart);
      expect(args.version).toBe(saved.version);
      expect(args.narrative).toBe(saved.narrative);
      expect(args.narrative).toBe(view.narrative);
      expect(args.points).toEqual(saved.points);
      expect(store.emails.get(args.weekStart)).toMatchObject({ status: "sent", emailedVersion: args.version });
      const mail = renderBriefHtml(args.weekStart, args.narrative, args.points, "https://dev.example", args.comparison);
      if (args.comparison.state !== "comparable") expect(mail).not.toMatch(ARROWS);
    }

    // every run was recorded, none left running, no secrets in anything persisted
    expect(store.runs.length).toBeGreaterThanOrEqual(6);
    expect(store.runs.every((r) => r.finish && r.finish.status !== "running")).toBe(true);
    expect(JSON.stringify([store.runs, store.sourceFetches])).not.toMatch(/Bearer|re_[A-Za-z0-9]{10}|key=/);
    // no duplicate posts anywhere, ever
    const keys = store.posts.map((p) => `${p.source}:${p.source_id}`);
    expect(new Set(keys).size).toBe(keys.length);
    // aggregates never exceed what was stored
    for (const [week, rows] of store.aggregates) {
      const total = rows.reduce((s, r) => s + r.count, 0);
      const rp = store.reports.get(week)!;
      const stored = store.posts.filter((p) => p.theme && p.posted_at >= rp.period_start && p.posted_at < rp.period_end).length;
      expect(total).toBeLessThanOrEqual(stored);
    }
  });

  it("backfills of valid past dates work and can never email; invalid ones are refused before any work", async () => {
    const store = new MemoryStore();
    const send = vi.fn(async () => "sent" as const);
    const plan = planRun("2026-10-09", new Date("2026-10-12T05:00:00Z"));
    expect("error" in plan).toBe(false);
    if ("error" in plan) return;
    const s = await runDigest({ store, now: plan.now, trigger: plan.trigger, sendEmail: plan.allowEmail ? send : undefined, callModel: goodModel(), fetchers: { hn: async () => [post({ posted_at: "2026-10-05T10:00:00Z" })] } });
    expect(s).toMatchObject({ trigger: "backfill", weekStart: "2026-10-02", email: "not_attempted" });
    expect(send).not.toHaveBeenCalled();
    for (const bad of ["2026-02-30", "2099-01-01", "x"]) expect(planRun(bad, new Date("2026-10-12T05:00:00Z"))).toMatchObject({ status: 400 });
  });
});
