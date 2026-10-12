import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { analyse, type EvidencePost } from "@/lib/analysis";
import { problemsFrom, problemHref, TOP_SHOWN } from "@/lib/insights-view";
import { aiStatus, collectionStatus, reportStatus } from "@/lib/status-plain";
import { planMarkdown, toPlanItem, type Plan } from "@/lib/plan-data";
import { checkRate, resetRateLimits, type Limit } from "@/lib/rate-limit";
import { memoryTeamStore } from "./team-helpers";

const mocks = vi.hoisted(() => ({ insights: vi.fn(), problem: vi.fn(), review: vi.fn(), plan: vi.fn(), runs: vi.fn(), team: null as unknown }));
vi.mock("@/lib/insights-data", () => ({ loadInsights: mocks.insights, loadProblem: mocks.problem }));
vi.mock("@/lib/team-data", async (orig) => ({ ...(await orig<typeof import("@/lib/team-data")>()), loadReview: mocks.review }));
vi.mock("@/lib/plan-data", async (orig) => ({ ...(await orig<typeof import("@/lib/plan-data")>()), loadPlan: mocks.plan }));
vi.mock("@/lib/session", () => ({ currentSession: async () => ({ email: "visitor", role: "owner" }) }));
vi.mock("@/lib/page-guard", () => ({ requireKnownWeek: async () => {} }));
vi.mock("@/lib/data", async (orig) => ({ ...(await orig<typeof import("@/lib/data")>()), getRecentRuns: mocks.runs }));
vi.mock("@/lib/team-store", async (orig) => ({ ...(await orig<typeof import("@/lib/team-store")>()), makeSupabaseTeamStore: () => mocks.team }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ refresh: () => {} }), usePathname: () => "/" }));

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
let seq = 0;
const ev = (over: Partial<EvidencePost> = {}): EvidencePost => {
  const n = ++seq;
  return { id: `p${n}`, source: "hn", topic_id: "t1", theme: "Slow reviews", title: `Distinct discussion title number ${n}`, url: `https://x.test/${n}`, author: `author${n}`, posted_at: `2026-10-0${(n % 7) + 1}T10:00:00Z`, confidence: 0.8, excerpt: "pull requests wait days for a first look", resolution: "open", unresolved: true, flags: [], ...over };
};
const COV = { hn: { status: "ok" as const, posts: 10 }, stackoverflow: { status: "ok" as const, posts: 5 }, reddit: { status: "ok" as const, posts: 5 }, github: { status: "ok" as const, posts: 5 } };
const analysis = (posts: EvidencePost[], comparison: "comparable" | "no_prior" = "no_prior") => analyse({ weekStart: "2026-10-02", posts, trends: [], topicNames: { t1: "Code review", t2: "CI/CD" }, coverage: COV, comparison, prior: [] });
const themes = (n: number) => Array.from({ length: n }, (_, i) => [ev({ theme: `Problem ${i}` }), ev({ theme: `Problem ${i}` }), ev({ theme: `Problem ${i}` })]).flat();

describe("plain-English problems", () => {
  it("ranks only problems with enough evidence, at most five, numbered 1..n", () => {
    const { supported, early } = problemsFrom(analysis([...themes(7), ev({ theme: "Lonely" })]), "2026-10-02");
    expect(supported).toHaveLength(TOP_SHOWN);
    expect(supported.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(supported.every((p) => p.supported)).toBe(true);
    expect(early.find((p) => p.theme === "Lonely")).toMatchObject({ supported: false, rank: null, notRankedBecause: expect.stringContaining("Only one discussion") });
    expect(early.every((p) => p.rank === null)).toBe(true);
  });
  it("never ranks posts that have no verified excerpt (older stored posts)", () => {
    const { supported, early } = problemsFrom(analysis([ev({ excerpt: null }), ev({ excerpt: null }), ev({ excerpt: null })]), "2026-10-02");
    expect(supported).toEqual([]);
    expect(early[0].notRankedBecause).toMatch(/No supporting quote/);
  });
  it("says the trend cannot be compared when it cannot, and never invents a rise or fall", () => {
    const p = problemsFrom(analysis(themes(1), "no_prior"), "2026-10-02").supported[0];
    expect(p.trend).toMatchObject({ kind: "unknown", label: "Not enough data to compare" });
  });
  it("describes who, why it matters and confidence only from stored numbers", () => {
    const p = problemsFrom(analysis(themes(1)), "2026-10-02").supported[0];
    expect(p.who).toBe("Developers working with Code review");
    expect(p.whyItMatters).toMatch(/3 separate discussions/);
    expect(p.whyItMatters).toMatch(/3 of the 3 discussions look unresolved/);
    expect(["High confidence", "Medium confidence", "Low confidence"]).toContain(p.confidence.label);
    expect(p.evidence.every((l) => l.url)).toBe(true);
  });
  it("counts replies in one thread once, and says so", () => {
    const same = Array.from({ length: 4 }, (_, i) => ev({ title: "One shared thread about slow reviews", author: `a${i}` }));
    const p = problemsFrom(analysis([...same, ev()]), "2026-10-02").all[0];
    expect(p.discussions).toBe(2);
    expect(p.repeats).toBe(3);
  });
  it("builds a link that carries week, topic and theme", () => {
    expect(problemHref({ week: "2026-10-02", topicId: "t1", theme: "A & B" })).toBe("/explore/problem?week=2026-10-02&topic=t1&theme=A%20%26%20B");
  });
});

const run = (o: object = {}): any => ({ id: "r", status: "succeeded", startedAt: "2026-10-12T10:00:00Z", finishedAt: "2026-10-12T10:01:00Z", classified: 12, unclassified: 0, newPosts: 12, usedFallback: false, emailStatus: null, sources: [{ source: "hn", status: "ok" }, { source: "stackoverflow", status: "ok" }, { source: "github", status: "ok" }], diagnostics: [], ...o });
describe("honest status lines", () => {
  it("collection success is not AI success: a run that collected fine but recorded no classification says so", () => {
    expect(collectionStatus(run()).tone).toBe("ok");
    expect(aiStatus(run({ classified: null }), null)).toMatchObject({ tone: "neutral", headline: "AI analysis not recorded" });
  });
  it("a run with nothing new says the AI had nothing to do, not that it worked", () => {
    const s = aiStatus(run({ classified: 0, newPosts: 0 }), null);
    expect(s.headline).toBe("Nothing new needed AI analysis");
    expect(s.tone).toBe("neutral");
    expect(s.detail).toMatch(/not a test of the AI/);
  });
  it("partial and failed sources are named, never counted as zero posts", () => {
    const s = collectionStatus(run({ sources: [{ source: "hn", status: "ok" }, { source: "github", status: "error" }, { source: "stackoverflow", status: "partial" }] }));
    expect(s.tone).toBe("warn");
    expect(s.detail).toMatch(/GitHub did not answer/); expect(s.detail).toMatch(/Stack Overflow answered only in part/);
    expect(collectionStatus(run({ status: "failed" })).tone).toBe("bad");
    expect(collectionStatus(null).headline).toBe("No check recorded yet");
  });
  it("waiting classifications, a template summary and a failed run are each reported", () => {
    expect(aiStatus(run({ unclassified: 4 }), null).tone).toBe("warn");
    expect(aiStatus(run({ usedFallback: true }), null).headline).toMatch(/template/);
    expect(aiStatus(run({ status: "failed" }), null).tone).toBe("bad");
    expect(aiStatus(run(), null)).toMatchObject({ tone: "ok", headline: "AI sorted 12 discussions" });
  });
  it("the report line reflects delivery", () => {
    const r: any = { periodLabel: "Fri 2 Oct – Thu 8 Oct 2026", version: 1, delivery: { status: "sent" } };
    expect(reportStatus(r).detail).toContain("It was emailed.");
    expect(reportStatus({ ...r, delivery: { status: "failed" } }).tone).toBe("warn");
    expect(reportStatus(null).headline).toBe("No report yet");
  });
});

const insightsData = (over: object = {}) => {
  const a = analysis(themes(2));
  return { report: { weekStart: "2026-10-02", periodLabel: "Fri 2 Oct – Thu 8 Oct 2026", narrative: "A short summary.", usedFallback: false, generatedAt: "2026-10-09T01:00:00Z", version: 1, delivery: { status: "sent", sentAt: "2026-10-09T01:00:00Z", version: 1 } }, analysis: { kind: "sealed", analysis: a }, run: run(), runKnown: true, ...problemsFrom(a, "2026-10-02"), limitations: ["Reddit was not collected."], ...over };
};

describe("Insights page", async () => {
  const { default: Insights } = await import("@/app/page");
  const page = async () => html(await Insights({ searchParams: Promise.resolve({}) }));
  beforeEach(() => { mocks.insights.mockResolvedValue(insightsData()); });
  it("answers what, why and what next, in plain words", async () => {
    const out = await page();
    expect(out).toContain("What developers are struggling with");
    expect(out).toContain("Top problems this week");
    expect(out).toContain("Who runs into it"); expect(out).toContain("Supporting discussions"); expect(out).toContain("How sure are we"); expect(out).toContain("Compared with last week");
    expect(out).toContain("What you can do next");
    expect(out).toContain('href="https://x.test/'); expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("Explore &amp; decide");
  });
  it("shows collection, AI and report status separately, with the last check time", async () => {
    const out = await page();
    expect(out).toContain("New discussions"); expect(out).toContain("AI analysis"); expect(out).toContain("Your Friday email"); expect(out).toContain("Action required");
    expect(out).toContain("Last checked");
  });
  it("uses no technical vocabulary on the front page", async () => {
    // with the deployment correctly configured nothing technical needs to be shown; a missing setting is named only in "Action required"
    const keys = ["OPENROUTER_API_KEY", "RESEND_API_KEY", "DIGEST_TO_EMAIL", "CRON_SECRET"];
    const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, { OPENROUTER_API_KEY: "k", RESEND_API_KEY: "k", DIGEST_TO_EMAIL: "me@team.test", CRON_SECRET: "k" });
    try { expect((await page()).replace(/<[^>]+>/g, " ")).not.toMatch(/pipeline|database|supabase|cron|jsonb|checkpoint|diagnostic|idempoten|env/i); }
    finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });
  it("labels a template summary honestly", async () => {
    mocks.insights.mockResolvedValue(insightsData({ report: { ...insightsData().report, usedFallback: true } }));
    expect(await page()).toContain("standard template");
  });
  it("nothing ranked: says why, lists early signals, ranks nothing", async () => {
    const a = analysis([ev({ excerpt: null }), ev({ excerpt: null }), ev({ excerpt: null })]);
    mocks.insights.mockResolvedValue(insightsData({ analysis: { kind: "derived", analysis: a }, ...problemsFrom(a, "2026-10-02") }));
    const out = await page();
    expect(out).toContain("No problem has enough evidence to be ranked");
    expect(out).toContain("Early signals");
    expect(out).not.toMatch(/aria-label="Number 1"/);
  });
  it("a report with no analysis explains it instead of showing an empty success", async () => {
    mocks.insights.mockResolvedValue(insightsData({ analysis: { kind: "none" }, supported: [], early: [], all: [] }));
    expect(await page()).toContain("This report has no problem analysis");
  });
  it("unreadable run history is called out, not hidden", async () => {
    mocks.insights.mockResolvedValue(insightsData({ run: null, runKnown: false }));
    const out = await page();
    expect(out).toContain("Run history could not be read"); expect(out).toContain("No check recorded yet");
  });
  it("no report yet and a database failure are explicit states", async () => {
    mocks.insights.mockResolvedValue(insightsData({ report: null }));
    expect(await page()).toContain("No report yet");
    mocks.insights.mockImplementation(async () => { throw new Error("down"); });
    let out = "";
    try { out = await page(); } catch (e) { out = `THREW ${(e as Error).stack}`; }
    expect(out).toContain("couldn&#x27;t load this week&#x27;s insights"); expect(out).not.toContain("Top problems");
  });
  it("escapes hostile text from the sources", async () => {
    const a = analysis(themes(1).map((p) => ({ ...p, excerpt: "<script>alert(1)</script>", title: "<img src=x onerror=1>" })));
    mocks.insights.mockResolvedValue(insightsData({ analysis: { kind: "sealed", analysis: a }, ...problemsFrom(a, "2026-10-02") }));
    const out = await page();
    expect(out).not.toContain("<script>alert"); expect(out).not.toContain("<img src=x");
  });
});

describe("Explore page", async () => {
  const { default: Explore } = await import("@/app/explore/page");
  const card = (state: string) => ({ view: { item: { id: "i1", topic_id: "t1", theme: "Problem 0", state, reason: "r", first_week: "2026-10-02", created_by: "v", created_at: "", updated_at: "" } }, topicName: "Code review", ai: { rank: 1, discussions: 3, week: "2026-10-02" } });
  beforeEach(() => { mocks.insights.mockResolvedValue(insightsData()); mocks.review.mockResolvedValue([]); });
  it("explains the three steps, separates JARVIS suggestions from decisions and offers a working compare form", async () => {
    const out = html(await Explore());
    expect(out).toContain("Read"); expect(out).toContain("Shortlist"); expect(out).toContain("Decide");
    expect(out).toContain("JARVIS only suggests"); expect(out).toContain("a decision is always made by a person");
    expect(out).toContain('action="/explore/compare"'); expect(out).toContain('name="k"'); expect(out).toContain("Compare the ones I ticked");
    expect(out).toContain("Not shortlisted");
  });
  it("shows where each problem stands in plain words", async () => {
    mocks.review.mockResolvedValue([card("prioritised")]);
    const out = html(await Explore());
    expect(out).toContain("Work on this");
  });
  it("error and empty states", async () => {
    mocks.insights.mockRejectedValue(new Error("x"));
    expect(html(await Explore())).toContain("couldn&#x27;t load the problems");
    mocks.insights.mockResolvedValue(insightsData({ all: [], supported: [], early: [], analysis: { kind: "none" } }));
    expect(html(await Explore())).toContain("saved before JARVIS grouped discussions");
  });
});

describe("Problem page", async () => {
  const { default: ProblemPage } = await import("@/app/explore/problem/page");
  const sp = (o: object) => Promise.resolve({ week: "2026-10-02", topic: "t1", theme: "Problem 0", ...o }) as Promise<Record<string, string>>;
  let team: ReturnType<typeof memoryTeamStore>;
  beforeEach(() => {
    team = memoryTeamStore(); mocks.team = team.store;
    const a = analysis(themes(1)); const problem = problemsFrom(a, "2026-10-02").all[0];
    mocks.problem.mockResolvedValue({ kind: "ok", problem, posts: [{ id: "x1", source: "hn", title: "Why are reviews slow", body: "", url: "https://news.test/1", author: "a", posted_at: "2026-10-03T10:00:00Z", unresolved: true, sentiment: null }], postsFailed: false, analysisKind: "sealed", week: "2026-10-02" });
  });
  it("not shortlisted: the next step is to shortlist, labelled as the user's step, and the AI suggestion is labelled", async () => {
    const out = html(await ProblemPage({ searchParams: sp({}) }));
    expect(out).toContain("Suggested by JARVIS"); expect(out).toContain("It is not a decision");
    expect(out).toContain("Your team decides"); expect(out).toContain("Step 1: shortlist it"); expect(out).toContain("Shortlist this problem");
    expect(out).toContain("Evidence: what people actually wrote"); expect(out).toContain("https://news.test/1");
    expect(out).not.toContain("Record decision");
  });
  it("shortlisted: decision form with plain choices; votes are advice only", async () => {
    await team.store.createItem({ topic_id: "t1", theme: "Problem 0", reason: "we hit this", first_week: "2026-10-02", created_by: "v" });
    const out = html(await ProblemPage({ searchParams: sp({}) }));
    expect(out).toContain("Step 2: record a decision"); expect(out).toContain("Work on this"); expect(out).toContain("Not now"); expect(out).toContain("Already handled"); expect(out).toContain("Not a problem for us");
    expect(out).toContain("Advice from teammates"); expect(out).toContain("Votes are advice only"); expect(out).toContain("Remove from shortlist");
    expect(out).toContain("we hit this");
  });
  it("decided: shows the human decision separately and offers to change it", async () => {
    const { item } = await team.store.createItem({ topic_id: "t1", theme: "Problem 0", reason: "we hit this", first_week: "2026-10-02", created_by: "v" });
    await team.store.recordDecision({ item_id: item.id, outcome: "prioritised", decided_by: "v", rationale: "Blocks release", evidence: {}, vote_snapshot: { prioritise: 0, park: 0, total: 0 }, followup: false });
    const out = html(await ProblemPage({ searchParams: sp({}) }));
    expect(out).toContain("Blocks release"); expect(out).toContain("Change the decision"); expect(out).toContain("Weekly Action Plan");
    expect(out).not.toContain("Remove from shortlist");
  });
  it("404 for bad parameters or an unknown problem; honest states for failures", async () => {
    await expect(ProblemPage({ searchParams: sp({ week: "nope" }) })).rejects.toThrow(/NOT_FOUND|404/);
    mocks.problem.mockResolvedValue({ kind: "not_found" });
    await expect(ProblemPage({ searchParams: sp({}) })).rejects.toThrow(/NOT_FOUND|404/);
    mocks.problem.mockResolvedValue({ kind: "no_analysis" });
    expect(html(await ProblemPage({ searchParams: sp({}) }))).toContain("no problem analysis");
    mocks.problem.mockRejectedValue(new Error("db"));
    expect(html(await ProblemPage({ searchParams: sp({}) }))).toContain("couldn&#x27;t load this problem");
  });
  it("says so when the full discussion list cannot be loaded, without losing the verified quotes", async () => {
    const cur = await mocks.problem();
    mocks.problem.mockResolvedValue({ ...cur, posts: [], postsFailed: true });
    const out = html(await ProblemPage({ searchParams: sp({}) }));
    expect(out).toContain("full list could not be loaded"); expect(out).toContain("pull requests wait days");
  });
});

describe("Weekly Action Plan", async () => {
  const { default: PlanPage } = await import("@/app/plan/page");
  const item = (o: object = {}) => ({ itemId: "i1", theme: "Slow reviews", topicId: "t1", category: "Code review", week: "2026-10-02", why: "we hit this", discussions: 3, outcome: "prioritised", rationale: "Blocks release", decidedAt: "2026-10-12T05:00:00Z", followup: false, nextStep: "Check one example.", ...o });
  const plan = (o: Partial<Plan> = {}): Plan => ({ week: "2026-10-02", periodLabel: "Fri 2 Oct – Thu 8 Oct 2026", summary: "A short summary.", summaryIsTemplate: false, focus: [item()], considering: [item({ itemId: "i2", theme: "Flaky CI", outcome: null, rationale: null, decidedAt: null })], notNow: [item({ itemId: "i3", theme: "Docs", outcome: "parked", rationale: "Later" })], suggested: [], ...o });
  it("shows why selected, the team decision, the suggested next step (labelled generated), and export actions", async () => {
    mocks.plan.mockResolvedValue(plan());
    const out = html(await PlanPage());
    expect(out).toContain("Why it was selected"); expect(out).toContain("we hit this"); expect(out).toContain("Blocks release");
    expect(out).toContain("Team decision"); expect(out).toContain("Suggested next step"); expect(out).toContain("Generated suggestion. Nobody has agreed to it.");
    expect(out).toContain('href="/api/plan/export"'); expect(out).toContain("Print or save as PDF"); expect(out).toContain('href="/reports/2026-10-02"');
    expect(out).toContain("Waiting for a decision (1)"); expect(out).toContain("Set aside (1)");
  });
  it("nothing chosen: honest empty state, never invented work", async () => {
    mocks.plan.mockResolvedValue(plan({ focus: [], considering: [], notNow: [] }));
    const out = html(await PlanPage());
    expect(out).toContain("Nothing has been chosen yet"); expect(out).not.toContain("Work on this (");
  });
  it("database failure is an error state", async () => {
    mocks.plan.mockRejectedValue(new Error("x"));
    expect(html(await PlanPage())).toContain("couldn&#x27;t load the plan");
  });
  it("the Markdown export carries the same content and labels generated text", () => {
    const md = planMarkdown(plan());
    expect(md).toContain("# JARVIS weekly action plan"); expect(md).toContain("### Slow reviews"); expect(md).toContain("Why it was selected: we hit this");
    expect(md).toContain("Team decision: Work on this"); expect(md).toContain("Blocks release"); expect(md).toContain("Suggested next step (generated, not agreed)");
    expect(planMarkdown(plan({ focus: [], considering: [], notNow: [], summary: null, week: null, periodLabel: null }))).toContain("Nothing has been chosen for the coming week yet.");
  });
  it("toPlanItem turns decisions into next steps without inventing owners or dates", () => {
    const c: any = { view: { item: { id: "i", topic_id: "t", theme: "X", reason: "r", first_week: "w" }, current: { outcome: "prioritised", rationale: "y", decided_at: "d", followup: true } }, topicName: "T", ai: { discussions: 2 } };
    expect(toPlanItem(c).nextStep).toMatch(/follow-up/);
    expect(toPlanItem({ ...c, view: { ...c.view, current: null } }).nextStep).toBe("Read the evidence, then record a decision.");
    expect(toPlanItem(c).nextStep).not.toMatch(/by Monday|owner:/i);
  });
});

describe("Settings page", async () => {
  const { default: Settings } = await import("@/app/settings/page");
  it("lists sources with their last check, and Reddit as not collected unless it is genuinely switched on", async () => {
    mocks.runs.mockResolvedValue([run()]);
    delete process.env.REDDIT_PUBLIC_ENABLED; delete process.env.REDDIT_CLIENT_ID;
    const out = html(await Settings());
    expect(out).toContain("Hacker News"); expect(out).toContain("Answered fully"); expect(out).toContain("Not collected");
    for (const l of ["/watchlist", "/reports", "/posts", "/history", "/status"]) expect(out).toContain(`href="${l}"`);
  });
  it("run history failing is shown as not checked, not as healthy", async () => {
    mocks.runs.mockRejectedValue(new Error("x"));
    expect(html(await Settings())).toContain("Not checked yet");
  });
});

describe("rate limiting", () => {
  const L: Limit = { name: "t", max: 2, windowMs: 1000 };
  beforeEach(() => { resetRateLimits(); });
  it("allows max per window, blocks the next, and recovers after the window", () => {
    expect(checkRate(L, "a", 0).ok).toBe(true); expect(checkRate(L, "a", 10).ok).toBe(true);
    const r = checkRate(L, "a", 20);
    expect(r).toMatchObject({ ok: false, retryAfterSec: 1 });
    expect(checkRate(L, "b", 20).ok).toBe(true);
    expect(checkRate(L, "a", 1500).ok).toBe(true);
  });
});
