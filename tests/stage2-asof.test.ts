import { describe, expect, it, vi } from "vitest";
import { isRealCalendarDate, istToday, MIN_ASOF, planRun } from "@/lib/run-plan";
import { periodFor } from "@/lib/week";

const NOW = new Date("2026-10-12T05:00:00Z"); // Mon 2026-10-12 10:30 IST

describe("asOf: exact format and real calendar date", () => {
  it.each(["2026-10-05", "2026-02-28", "2028-02-29", "2024-02-29", "2000-02-29", "2026-12-31", "2020-01-01"])("accepts %s", (d) => {
    expect(isRealCalendarDate(d)).toBe(true);
  });
  it.each([
    "2026-02-30", "2026-02-29", "2027-02-29", "2100-02-29", "2026-04-31", "2026-06-31", "2026-13-01", "2026-00-10", "2026-10-00", "2026-10-32",
  ])("rejects the impossible date %s (no silent rollover)", (d) => {
    expect(isRealCalendarDate(d)).toBe(false);
    expect(planRun(d, NOW)).toMatchObject({ status: 400 });
  });
  it.each([
    "", " ", "2026-1-5", "2026-10-5", "26-10-05", " 2026-10-05", "2026-10-05 ", "20261005", "2026/10/05", "2026-10-05T00:00:00Z",
    "2026-10-05\n", "2026-10-05;DROP TABLE briefs", "yesterday", "NaN", "-2026-10-05", "２０２６-１０-０５", "2026-10-05'",
  ])("rejects the malformed value %j", (d) => {
    expect(isRealCalendarDate(d)).toBe(false);
    expect(planRun(d, NOW)).toMatchObject({ status: 400 });
  });
  it("leap years: 2028 yes, 2027 no, 2100 no (century), 2000 yes", () => {
    expect([2028, 2027, 2100, 2000].map((y) => isRealCalendarDate(`${y}-02-29`))).toEqual([true, false, false, true]);
  });
});

describe("asOf: future and ancient dates", () => {
  it("accepts today (IST) and any earlier real date", () => {
    expect(istToday(NOW)).toBe("2026-10-12");
    expect(planRun("2026-10-12", NOW)).toMatchObject({ trigger: "backfill", allowEmail: false });
    expect(planRun("2026-10-02", NOW)).toMatchObject({ trigger: "backfill" });
  });
  it("rejects tomorrow and any later date with a 400", () => {
    for (const d of ["2026-10-13", "2026-12-31", "2027-06-01", "2099-01-01"]) {
      expect(planRun(d, NOW)).toMatchObject({ status: 400, error: expect.stringMatching(/future/) });
    }
  });
  it("uses the IST calendar, not UTC, to decide what 'today' is", () => {
    const lateIst = new Date("2026-10-12T18:29:00Z"); // 23:59 IST on Oct 12 (still Oct 12 in IST, Oct 12 in UTC)
    expect(planRun("2026-10-12", lateIst)).toMatchObject({ trigger: "backfill" });
    expect(planRun("2026-10-13", lateIst)).toMatchObject({ status: 400 });
    const afterMidnightIst = new Date("2026-10-12T18:31:00Z"); // 00:01 IST on Oct 13 (still Oct 12 in UTC)
    expect(istToday(afterMidnightIst)).toBe("2026-10-13");
    expect(planRun("2026-10-13", afterMidnightIst)).toMatchObject({ trigger: "backfill" });
  });
  it("rejects dates before the supported minimum", () => {
    expect(MIN_ASOF).toBe("2020-01-01");
    expect(planRun("2019-12-31", NOW)).toMatchObject({ status: 400 });
    expect(planRun("2020-01-01", NOW)).toMatchObject({ trigger: "backfill" });
  });
  it("rejects the parameter given more than once", () => {
    expect(planRun(["2026-10-02", "2026-10-09"], NOW)).toMatchObject({ status: 400 });
  });
});

describe("asOf: valid backfills are unaffected", () => {
  it("is a backfill, never emails, and selects a deterministic period", () => {
    const p = planRun("2026-10-09", NOW);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p).toMatchObject({ trigger: "backfill", allowEmail: false });
    expect(periodFor(p.now).weekStart).toBe("2026-10-02"); // an IST Friday selects the week ending that morning
    const again = planRun("2026-10-09", new Date("2027-03-01T00:00:00Z"));
    expect("error" in again ? null : periodFor(again.now).weekStart).toBe("2026-10-02"); // independent of when it is run
  });
  it("no asOf means a scheduled run that may email", () => {
    expect(planRun(null, NOW)).toEqual({ now: NOW, trigger: "scheduled", allowEmail: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The route handler: auth, validation and wiring, with the pipeline and external services replaced.
const runDigest = vi.fn(async (d: { trigger?: string }) => ({ status: "succeeded", trigger: d.trigger, weekStart: "2026-10-02", fetched: 0, newPosts: 0, classified: 0, pending: 0, backlogRemaining: 0, email: "not_attempted", brief: { action: "keep", version: 1, reason: "x" }, sources: {}, diagnostics: [] }));
const hasActiveRun = vi.fn(async (_w: string, _ms: number) => false);
vi.mock("@/lib/pipeline", () => ({ runDigest: (d: never) => runDigest(d) }));
vi.mock("@/lib/store", () => ({ makeSupabaseStore: () => ({ hasActiveRun }) }));
vi.mock("@/lib/gemini", () => ({ geminiFromEnv: () => async () => "x" }));
vi.mock("@/lib/email", () => ({ sendBriefEmail: vi.fn(async () => "sent") }));

describe("route handler /api/cron/weekly-digest", async () => {
  const { GET } = await import("@/app/api/cron/weekly-digest/route");
  const call = (qs = "", auth: string | null = "Bearer s3cret") =>
    GET(new Request(`http://localhost/api/cron/weekly-digest${qs}`, { headers: auth ? { authorization: auth } : {} }));
  const withSecret = (v: string | undefined, fn: () => Promise<void>) => async () => {
    const old = process.env.CRON_SECRET;
    if (v === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = v;
    runDigest.mockClear();
    try { await fn(); } finally { if (old === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = old; }
  };

  it("401 without or with a wrong token, and never runs the pipeline", withSecret("s3cret", async () => {
    expect((await call("", null)).status).toBe(401);
    expect((await call("", "Bearer nope")).status).toBe(401);
    expect((await call("", "s3cret")).status).toBe(401);
    expect(runDigest).not.toHaveBeenCalled();
  }));
  it("fails closed when CRON_SECRET is not configured", withSecret(undefined, async () => {
    expect((await call("", "Bearer undefined")).status).toBe(401);
    expect((await call("", "Bearer ")).status).toBe(401);
    expect(runDigest).not.toHaveBeenCalled();
  }));
  it("400 for invalid asOf values, before any work is done", withSecret("s3cret", async () => {
    for (const q of ["?asOf=2026-02-30", "?asOf=2099-01-01", "?asOf=banana", "?asOf=", "?asOf=2026-10-02&asOf=2026-10-09"]) {
      const res = await call(q);
      expect(res.status, q).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.any(String) });
    }
    expect(runDigest).not.toHaveBeenCalled();
  }));
  it("a valid asOf is a backfill with no email sender", withSecret("s3cret", async () => {
    const res = await call("?asOf=2026-10-02");
    expect(res.status).toBe(200);
    const arg = runDigest.mock.calls[0][0] as unknown as { trigger: string; sendEmail?: unknown; now: Date };
    expect(arg.trigger).toBe("backfill");
    expect(arg.sendEmail).toBeUndefined();
    expect(arg.now.toISOString()).toBe("2026-10-02T06:30:00.000Z"); // noon IST
  }));
  it("no asOf is a scheduled run with an email sender", withSecret("s3cret", async () => {
    await call("");
    const arg = runDigest.mock.calls[0][0] as unknown as { trigger: string; sendEmail?: unknown };
    expect(arg.trigger).toBe("scheduled");
    expect(typeof arg.sendEmail).toBe("function");
  }));
  it("500 with a SANITIZED error when the pipeline throws: no URLs, keys or tokens leak", withSecret("s3cret", async () => {
    runDigest.mockRejectedValueOnce(new Error("db down at https://db.secret.supabase.co/rest?apikey=ABCDEF123456 Bearer tok.en.value"));
    const res = await call("");
    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('"ok":false');
    for (const bad of ["ABCDEF123456", "tok.en.value", "https://", "apikey"]) expect(body).not.toContain(bad);
  }));
  it("a trigger for a period that is already running is skipped with 202 and does no work", withSecret("s3cret", async () => {
    hasActiveRun.mockResolvedValueOnce(true);
    const res = await call("");
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, skipped: "run_in_progress" });
    expect(runDigest).not.toHaveBeenCalled();
    const [week, windowMs] = hasActiveRun.mock.calls.at(-1)!;
    expect(week).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(windowMs).toBe(6 * 60_000);
  }));
  it("the in-progress check is made for the period being run (a backfill checks its own period)", withSecret("s3cret", async () => {
    await call("?asOf=2026-10-02");
    expect(hasActiveRun.mock.calls.at(-1)![0]).toBe("2026-09-25");
  }));
  it("if the in-progress check itself fails, the run proceeds (the report and email guards still prevent duplicate outcomes)", withSecret("s3cret", async () => {
    hasActiveRun.mockRejectedValueOnce(new Error("db blip"));
    const res = await call("");
    expect(res.status).toBe(200);
    expect(runDigest).toHaveBeenCalledTimes(1);
  }));
  it("returns 200 with the run's own status for a partial run, and a clean, small log line with no secrets", withSecret("s3cret", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    runDigest.mockResolvedValueOnce({ status: "partial", trigger: "scheduled", weekStart: "2026-10-09", fetched: 5, newPosts: 3, classified: 3, pending: 0, backlogRemaining: 0, email: "sent", brief: { action: "create", version: 1, reason: "x" }, sources: { reddit: { status: "partial", posts: 1 } }, diagnostics: [{ code: "SOURCE_PARTIAL", severity: "warning" }, { code: "REPORT_SAVED", severity: "info" }] } as never);
    const res = await call("");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "partial" });
    const line = String(log.mock.calls.at(-1)![0]);
    expect(JSON.parse(line)).toMatchObject({ event: "weekly_digest", outcome: "partial", email: "sent", sources: { reddit: "partial" }, diagnostics: ["SOURCE_PARTIAL"] });
    expect(line).not.toMatch(/s3cret|Bearer|apikey/i);
    log.mockRestore();
  }));
  it("never touches the store or the pipeline for an unauthenticated request", withSecret("s3cret", async () => {
    hasActiveRun.mockClear();
    await call("", null);
    expect(hasActiveRun).not.toHaveBeenCalled();
    expect(runDigest).not.toHaveBeenCalled();
  }));
  it("two simultaneous triggers: only the first runs while the second sees it in progress", withSecret("s3cret", async () => {
    let active = false;
    hasActiveRun.mockImplementation(async () => active);
    runDigest.mockImplementationOnce(async (d) => { active = true; await new Promise((r) => setTimeout(r, 20)); active = false; return { status: "succeeded", trigger: d.trigger, weekStart: "2026-10-02", fetched: 0, newPosts: 0, classified: 0, pending: 0, backlogRemaining: 0, email: "sent", brief: { action: "create", version: 1, reason: "x" }, sources: {}, diagnostics: [] }; });
    const first = call("");
    await new Promise((r) => setTimeout(r, 5));
    const second = await call("");
    expect(second.status).toBe(202);
    expect((await first).status).toBe(200);
    expect(runDigest).toHaveBeenCalledTimes(1);
    hasActiveRun.mockReset(); hasActiveRun.mockResolvedValue(false);
  }));
});
