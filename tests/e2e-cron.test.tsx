import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PainPointTable from "@/components/PainPointTable";
import { assessHealth, attentionItems } from "@/lib/health";
import { buildReportView, displayPoints, summarizeRun, type BriefDbRow, type FetchDbRow, type RunDbRow } from "@/lib/report-model";
import { readSchedule } from "@/lib/schedule";
import { periodFor } from "@/lib/week";
import { FIRST_WEEK_SENTENCE, NOT_COMPARED_SENTENCE } from "@/lib/brief";
import vercelConfig from "../vercel.json";
import { MemoryStore, TOPIC } from "./helpers";

/*
 * MOCKED END-TO-END: scheduled trigger -> authenticated cron route -> real source adapters -> real pipeline -> real classification
 * code -> saved report -> real email request builder -> run record -> health assessment -> rendered dashboard.
 * Only the outside world is replaced: the network (a routing fetch stub), the database (the in-memory store that mirrors the
 * SQL semantics), Gemini (a scripted model) and the Resend provider (a capturing stub). This is NOT a live test.
 */
const NOW = new Date("2026-10-09T03:30:00Z"); // a scheduled run on Friday 09:00 IST
const PERIOD = periodFor(NOW);
const inPeriod = (h: number) => new Date(PERIOD.start.getTime() + h * 3_600_000).toISOString();

const store = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/store", async (orig) => ({ ...(await orig<typeof import("@/lib/store")>()), makeSupabaseStore: () => store.current }));
const model = vi.hoisted(() => ({ fn: null as null | ((p: string) => Promise<string>) }));
vi.mock("@/lib/gemini", () => ({ geminiFromEnv: () => model.fn }));

const goodModel = async (prompt: string) => {
  if (prompt.includes("intro line")) {
    if (prompt.includes(FIRST_WEEK_SENTENCE)) return `${FIRST_WEEK_SENTENCE} Slow reviews led the week.`;
    if (prompt.includes(NOT_COMPARED_SENTENCE)) return `${NOT_COMPARED_SENTENCE} Slow reviews led the week.`;
    return "Slow reviews led the week. Nothing else stands out.";
  }
  const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
  return JSON.stringify(Array.from({ length: n }, (_, index) => ({ index, theme: "False positives", sentiment: "negative", unresolved: index % 2 === 0 })));
};

interface World { redditMode: "ok" | "blocked"; resend: "ok" | "reject"; resendCalls: { headers: Record<string, string>; body: { from: string; to: string[]; subject: string; html: string } }[]; fetchCalls: string[] }
const world: World = { redditMode: "ok", resend: "ok", resendCalls: [], fetchCalls: [] };
const json = (b: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: h });

/** Routes every outbound request the app can make to a controlled answer. */
const network = async (url: string, init?: RequestInit): Promise<Response> => {
  world.fetchCalls.push(String(url));
  const u = new URL(String(url));
  if (u.host === "hn.algolia.com") {
    // one matching story and one matching comment, regardless of which keyword is asked (the pipeline dedupes by id)
    const type = u.searchParams.get("tags");
    return json({ hits: [{ objectID: type === "story" ? "hn-s1" : "hn-c1", title: type === "story" ? "code review is painful" : null, story_title: "code review", comment_text: "false positive again", created_at_i: Math.floor(Date.parse(inPeriod(30)) / 1000) }], nbHits: 1 });
  }
  if (u.host === "api.stackexchange.com") return json({ items: [{ question_id: 1, title: "false positive in code review bot", body: "", link: "https://so/1", is_answered: false, creation_date: Math.floor(Date.parse(inPeriod(40)) / 1000) }], has_more: false });
  if (u.host === "api.github.com") return json({ total_count: 1, items: [{ id: 7, title: "code review noise", body: "false positive", html_url: "https://gh/7", created_at: inPeriod(50), user: { login: "u" } }] });
  if (u.host === "www.reddit.com") {
    if (world.redditMode === "blocked") return u.pathname.endsWith(".json") ? json({}, 403) : new Response("", { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999" } });
    if (u.pathname.endsWith(".json")) return json({}, 403);
    return new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>t3_rd1</id><author><name>/u/x</name></author><content type="html">&lt;p&gt;code review is slow&lt;/p&gt;</content><link href="https://www.reddit.com/r/devops/comments/rd1/t/"/><updated>${inPeriod(60)}</updated><title>code review rant</title></entry></feed>`, { status: 200 });
  }
  if (u.host === "api.resend.com") {
    world.resendCalls.push({ headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return world.resend === "ok" ? json({ id: `re_${world.resendCalls.length}` }) : json({ message: "invalid" }, 422);
  }
  throw new Error(`unexpected outbound request: ${url}`);
};

const ENV = { CRON_SECRET: "s3cret", RESEND_API_KEY: "re_test", DIGEST_TO_EMAIL: "test@example.test", APP_URL: "https://example.test" };
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  const s = new MemoryStore([{ ...TOPIC }]);
  store.current = s;
  model.fn = goodModel;
  world.redditMode = "ok"; world.resend = "ok"; world.resendCalls = []; world.fetchCalls = [];
  vi.stubGlobal("fetch", vi.fn(network));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const mem = () => store.current as MemoryStore;
const call = async (qs = "", auth: string | null = "Bearer s3cret") => {
  const { GET } = await import("@/app/api/cron/weekly-digest/route");
  return GET(new Request(`http://localhost/api/cron/weekly-digest${qs}`, { headers: auth ? { authorization: auth } : {} }));
};

/** What the status page would read back for this store's runs, built as data.ts builds it from the database. */
const runViews = (s: MemoryStore) => {
  const rows = s.runs.map((r) => ({ id: r.id, week_start: r.week_start, trigger: r.trigger, status: r.finish?.status ?? "running", started_at: "2026-10-09T03:30:00Z", finished_at: r.finish ? "2026-10-09T03:32:00Z" : null, email_status: r.finish?.email_status ?? null, used_fallback: r.finish?.used_fallback ?? null, error: r.finish?.error ?? null, fetched_total: r.finish?.fetched_total, new_posts: r.finish?.new_posts, classified_ok: r.finish?.classified_ok, classification_failed: r.finish?.classification_failed, warnings: r.finish?.diagnostics ?? r.finish?.warnings ?? [] })) as RunDbRow[];
  const fetches = s.sourceFetches.map((f) => ({ run_id: f.run_id, source: f.source, status: f.status, requests: f.requests, failed_requests: f.failed_requests, fetched: f.fetched, accepted: f.accepted, inserted: f.inserted, truncated: f.truncated, error: f.error, duration_ms: f.duration_ms })) as FetchDbRow[];
  return rows.map((r) => summarizeRun(r, fetches, NOW)).reverse();
};

describe("scheduled trigger -> report -> email -> health (mocked end to end)", () => {
  it("runs the complete chain for the correct reporting period and reconciles every stage", async () => {
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "succeeded", trigger: "scheduled", weekStart: "2026-10-02", email: "sent" });
    // the period: seven complete IST days
    expect(body.periodStart).toBe("2026-10-01T18:30:00.000Z");
    expect(body.periodEnd).toBe("2026-10-08T18:30:00.000Z");

    // sources -> stored posts: one per source (+ a second HN item), deduplicated across the two topic-keyword requests
    const s = mem();
    expect(s.posts.map((p) => `${p.source}:${p.source_id}`).sort()).toEqual(["github:7", "hn:hn-c1", "hn:hn-s1", "reddit:rd1", "stackoverflow:1"]);
    expect(s.posts.every((p) => new Date(p.posted_at) >= PERIOD.start && new Date(p.posted_at) < PERIOD.end)).toBe(true);

    // classification reconciles with persisted records and with the aggregates and the report
    const themed = s.posts.filter((p) => p.theme !== null);
    expect(themed.length).toBe(5);
    expect(body.classified).toBe(themed.length);
    expect(body.pending).toBe(0);
    const agg = s.aggregates.get("2026-10-02")!;
    expect(agg.reduce((n, c) => n + c.count, 0)).toBe(themed.length);
    const brief = s.briefs.get("2026-10-02")!;
    expect(brief.version).toBe(1);
    expect(brief.usedFallback).toBe(false);
    expect(brief.points.reduce((n, p) => n + p.count, 0)).toBe(themed.length);
    expect(brief.narrative).toContain("Slow reviews led the week.");

    // email: exactly one request, to the configured recipient, built from the SAVED version, with the version-scoped idempotency key
    expect(world.resendCalls).toHaveLength(1);
    const mail = world.resendCalls[0];
    expect(mail.headers["idempotency-key"]).toBe("dev-pulse-brief-2026-10-02-v1");
    expect(mail.body.to).toEqual(["test@example.test"]);
    expect(mail.body.from).toBe("JARVIS <onboarding@resend.dev>");
    expect(mail.body.subject).toBe("JARVIS: developer pain points, week of 2026-10-02");
    expect(mail.body.html).toContain(brief.narrative);
    expect(mail.body.html).toContain("Fri 2 Oct – Thu 8 Oct 2026 (IST)");
    expect(s.emails.get("2026-10-02")).toMatchObject({ status: "sent", emailedVersion: 1, messageId: "re_1" });

    // run record and the diagnostics that prove each stage
    const run = s.runs[0];
    expect(run.finish).toMatchObject({ status: "succeeded", email_status: "sent", classified_ok: 5, classification_failed: 0, used_fallback: false });
    expect(run.finish!.diagnostics!.map((d) => d.code)).toEqual(expect.arrayContaining(["REPORT_SAVED", "EMAIL_SUBMITTED"]));
    expect(s.sourceFetches.filter((f) => f.source === "reddit")[0]).toMatchObject({ status: "ok", requests: 1, failed_requests: 0, fetched: 1 });

    // health reads that run back as working, every stage verified, with the weekly schedule active
    const health = assessHealth({ runs: runViews(s), schedule: readSchedule(vercelConfig), now: NOW });
    expect(health.level).toBe("ok");
    expect(health.lastSuccessful?.id).toBe(run.id);
    expect(Object.fromEntries(health.stages.map((x) => [x.key, x.state]))).toEqual({ collect: "ok", classify: "ok", summary: "ok", persist: "ok", email: "ok" });
    expect(attentionItems(health)).toEqual([]);
  });

  it("the dashboard shows exactly what was stored and emailed", async () => {
    await call();
    const s = mem();
    const b = s.briefs.get("2026-10-02")!;
    const e = s.emails.get("2026-10-02")!;
    const row: BriefDbRow = { week_start: "2026-10-02", narrative: b.narrative, top_pain_points: b.points, created_at: b.createdAt, coverage: b.coverage, version: b.version, email_status: "sent", email_sent_at: "2026-10-09T03:31:00Z", emailed_version: e.emailedVersion ?? null };
    const rp = s.reports.get("2026-10-02")!;
    const view = buildReportView(row, { week_start: "2026-10-02", period_start: rp.period_start, period_end: rp.period_end, coverage: rp.coverage }, ["2026-10-02"]);
    expect(view.stats.mentions).toBe(5);
    const html = renderToStaticMarkup(<PainPointTable points={displayPoints(view)} weekStart="2026-10-02" />);
    expect(html).toContain(">5<"); // the largest (only) pain point's count on the page equals the stored aggregate
    expect(html).toContain("False positives");
    expect(world.resendCalls[0].body.html).toContain("5 mentions matched to tracked themes");
    expect(view.delivery).toMatchObject({ status: "sent", version: 1 });
  });

  it("a repeated trigger changes nothing: no second email, no new report version, same stored posts", async () => {
    await call();
    const s = mem();
    const postsBefore = s.posts.length;
    const briefBefore = JSON.stringify(s.briefs.get("2026-10-02"));
    const again = await (await call()).json();
    expect(again).toMatchObject({ ok: true, email: "already_sent", brief: { action: "keep", version: 1 } });
    expect(world.resendCalls).toHaveLength(1);
    expect(s.posts.length).toBe(postsBefore);
    expect(JSON.stringify(s.briefs.get("2026-10-02"))).toBe(briefBefore);
    expect(s.emails.get("2026-10-02")).toMatchObject({ status: "sent", messageId: "re_1" });
  });

  it("a trigger that arrives while a run is in progress is told so (202) and does no work", async () => {
    const s = mem();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    model.fn = async (p) => { await gate; return goodModel(p); }; // hold the first run open at classification
    const first = call();
    await vi.waitFor(() => expect(s.runs.length).toBe(1)); // the first run has registered itself
    const second = await call();
    release();
    const res1 = await first;
    expect(res1.status).toBe(200);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ ok: true, skipped: "run_in_progress" });
    expect(s.runs).toHaveLength(1);
    expect(world.resendCalls).toHaveLength(1);
  });
  it("two triggers that truly collide may both start, but the outcome is still exactly one report, one version and one email", async () => {
    const s = mem();
    const [a, b] = await Promise.all([call(), call()]); // no gap: both pass the in-progress check
    expect([a.status, b.status].every((x) => x === 200 || x === 202)).toBe(true);
    expect(world.resendCalls).toHaveLength(1);
    expect(s.briefs.get("2026-10-02")!.version).toBe(1);
    expect(s.emails.get("2026-10-02")?.status).toBe("sent");
    expect(new Set(s.posts.map((p) => `${p.source}:${p.source_id}`)).size).toBe(s.posts.length); // no duplicate posts
  });

  it("rejects an unauthenticated request before any outbound call or store access", async () => {
    const before = world.fetchCalls.length;
    expect((await call("", null)).status).toBe(401);
    expect((await call("", "Bearer wrong")).status).toBe(401);
    expect(world.fetchCalls.length).toBe(before);
    expect(mem().runs).toHaveLength(0);
  });

  it("a backfill (asOf) never sends email", async () => {
    const body = await (await call("?asOf=2026-10-09")).json();
    expect(body).toMatchObject({ ok: true, trigger: "backfill", email: "not_attempted" });
    expect(world.resendCalls).toHaveLength(0);
    expect(mem().emails.size).toBe(0);
  });
});

describe("failures at each boundary are handled and surfaced (mocked)", () => {
  it("Reddit blocked: the run completes with the other sources, is partial, never reports Reddit as zero, and health says why", async () => {
    world.redditMode = "blocked";
    const body = await (await call()).json();
    expect(body.status).toBe("partial");
    expect(body.sources.reddit).toMatchObject({ status: "error" });
    expect(body.sources.hn.status).toBe("ok");
    expect(mem().posts.filter((p) => p.source !== "reddit").length).toBe(4); // other sources' data is intact
    expect(body.diagnostics.map((d: { code: string }) => d.code)).toContain("SOURCE_RATE_LIMITED");
    expect(world.resendCalls).toHaveLength(1); // a partial source does not block the report
    const health = assessHealth({ runs: runViews(mem()), schedule: readSchedule(vercelConfig), now: NOW });
    expect(health.level).toBe("degraded");
    expect(health.timelines.find((t) => t.source === "reddit")!.latest.state).toBe("failed");
    expect(attentionItems(health)[0]).toMatchObject({ id: "src:reddit", level: "bad" });
    expect(health.lastSuccessful).toBeNull(); // a partial run is not reported as a success
  });

  it("Gemini unavailable: posts stay pending, the summary falls back to a template, the report still saves, status is partial", async () => {
    model.fn = null;
    const body = await (await call()).json();
    expect(body).toMatchObject({ status: "partial", pending: 5, usedFallbackNarrative: true });
    expect(body.diagnostics.map((d: { code: string }) => d.code)).toEqual(expect.arrayContaining(["CLASSIFY_NO_MODEL", "SUMMARY_FALLBACK", "REPORT_SAVED"]));
    expect(mem().briefs.get("2026-10-02")!.usedFallback).toBe(true);
    const health = assessHealth({ runs: runViews(mem()), schedule: readSchedule(vercelConfig), now: NOW });
    expect(health.level).toBe("degraded");
    expect(health.stages.find((x) => x.key === "summary")!.state).toBe("warn");
  });

  it("the email provider rejects: the report is saved and the week stays retryable; the next trigger sends exactly one", async () => {
    world.resend = "reject";
    const first = await (await call()).json();
    expect(first).toMatchObject({ status: "partial", email: "failed" });
    expect(mem().emails.get("2026-10-02")?.status).toBe("failed");
    expect(mem().briefs.get("2026-10-02")!.version).toBe(1);
    world.resend = "ok";
    const second = await (await call()).json();
    expect(second.email).toBe("sent");
    expect(world.resendCalls).toHaveLength(2);
    expect(world.resendCalls[1].headers["idempotency-key"]).toBe(world.resendCalls[0].headers["idempotency-key"]); // same version, same key
    expect(mem().briefs.get("2026-10-02")!.version).toBe(1);
  });

  it("the database failing mid-run: 500, sanitized, the failure is recorded, and nothing was emailed", async () => {
    mem().fail.saveBrief = new Error("db down at https://db.secret.supabase.co?apikey=ZZZ999");
    const res = await call();
    const text = JSON.stringify(await res.json());
    expect(res.status).toBe(500);
    expect(text).not.toMatch(/ZZZ999|https:\/\//);
    expect(mem().runs[0].finish?.status).toBe("failed");
    expect(mem().runs[0].finish!.diagnostics!.map((d) => d.code)).toContain("RUN_FAILED");
    expect(world.resendCalls).toHaveLength(0);
    const h = assessHealth({ runs: runViews(mem()), schedule: readSchedule(vercelConfig), now: NOW });
    expect(h.level).toBe("attention");
  });

  it("the database unreachable at the start: clean JSON 500 and no outbound calls", async () => {
    mem().fail.getActiveTopics = new Error("connect ECONNREFUSED 10.0.0.1:5432");
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.1");
    expect(world.fetchCalls.filter((u) => !u.includes("api.resend.com"))).toEqual([]);
  });

  it("every source down: the report is still saved from stored data, honestly marked, with no fabricated posts", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (/resend/.test(String(url)) ? network(url, init) : json({}, 500))));
    // 500s are retried with real waits in production; make them instant here
    const real = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: () => void) => real(fn, 0)) as typeof setTimeout);
    const body = await (await call()).json();
    expect(body.status).toBe("partial");
    expect(mem().posts).toHaveLength(0);
    expect(Object.values(body.sources).every((c) => (c as { status: string }).status === "error")).toBe(true);
    const h = assessHealth({ runs: runViews(mem()), schedule: readSchedule(vercelConfig), now: NOW });
    expect(h.level).toBe("attention");
    expect(h.reasons.some((r) => /Every source failed/.test(r.text))).toBe(true);
  }, 30_000);
});
