import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/auth";

const mocks = vi.hoisted(() => ({ session: null as unknown, watch: vi.fn(), review: vi.fn(), pack: vi.fn() }));
vi.mock("@/lib/session", () => ({ currentSession: async () => mocks.session }));
vi.mock("@/lib/team-data", async (orig) => ({ ...(await orig<typeof import("@/lib/team-data")>()), loadWatchlist: mocks.watch, loadReview: mocks.review, loadPack: mocks.pack }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/" }));

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const owner: Session = { email: "owner@team.test", role: "owner" };
const member: Session = { email: "a@team.test", role: "member" };

const term = (o: object) => ({ id: "w1", topic_id: "t1", term: "code review", kind: "include", status: "active", applies_to: null, matches: 5, activity: "producing", scopeLabel: null, ...o });
const watchView = () => ({
  sensitivity: "balanced",
  topics: [{ id: "t1", name: "Code review", legacy: false, legacyKeywords: [], includes: [term({}), term({ id: "w2", term: "build", activity: "none", matches: 0 }), term({ id: "w3", term: "pr queue", status: "paused", activity: "paused" })], excludes: [term({ id: "x1", term: "meme", kind: "exclude", applies_to: "w1", scopeLabel: "code review", matches: 2 })] }],
  changes: [{ id: 1, at: "2026-10-12T05:00:00Z", actor: "owner@team.test", action: "add", subject: "include:build", before: null, after: null }],
});

describe("Watchlist page", async () => {
  const { default: Watchlist } = await import("@/app/watchlist/page");
  beforeEach(() => { mocks.watch.mockResolvedValue(watchView()); });
  const page = async () => html(await Watchlist());

  it("anonymous: read-only, no edit controls, no actor emails, an invitation to sign in", async () => {
    mocks.session = null;
    const out = await page();
    expect(out).toContain("code review"); expect(out).toContain("Producing evidence"); expect(out).toContain("Ambiguous");
    expect(out).toContain("Excluding"); expect(out).toContain("only for “code review”");
    expect(out).toContain("Sign in to edit");
    expect(out).not.toContain("owner@team.test");
    expect(out).not.toContain("<button");
    expect(out).not.toContain('type="radio"');
  });
  it("a member sees it read-only too, with the actor visible", async () => {
    mocks.session = member;
    const out = await page();
    expect(out).toContain("Only the owner can edit");
    expect(out).toContain("owner@team.test");
    expect(out).not.toContain("<button");
  });
  it("the owner gets add, pause/resume, remove and the three modes, each with an accessible name", async () => {
    mocks.session = owner;
    const out = await page();
    expect(out).toContain("Add a term to Code review");
    expect(out).toMatch(/Pause<span class="sr-only"> “code review”/);
    expect(out).toMatch(/Resume<span class="sr-only"> “pr queue”/);
    expect(out).toContain("Strict"); expect(out).toContain("Balanced"); expect(out).toContain("Early discovery");
    expect(out.match(/type="radio"/g)).toHaveLength(3);
    expect(out).toContain("applies from the next run");
  });
  it("a database failure is an honest error, not an empty watchlist", async () => {
    mocks.session = owner; mocks.watch.mockRejectedValue(new Error("down"));
    const out = await page();
    expect(out).toContain("couldn&#x27;t load the watchlist");
    expect(out).not.toContain("Watching for");
  });
  it("a topic still on legacy keywords says so", async () => {
    mocks.session = null;
    const v = watchView(); v.topics[0] = { ...v.topics[0], legacy: true, legacyKeywords: ["ci slow"], includes: [], excludes: [] };
    mocks.watch.mockResolvedValue(v);
    expect(await page()).toContain("built-in keywords are used: ci slow");
  });
});

const card = (o: { state?: string; votes?: object; current?: object | null; history?: object[]; voters?: object[]; mine?: string | null } = {}): any => ({
  view: { item: { id: "i1", topic_id: "t1", theme: "Slow reviews", state: o.state ?? "under_review", reason: "PRs wait days", first_week: "2026-10-09", created_by: "a@team.test", created_at: "", updated_at: "" }, tally: o.votes ?? { prioritise: 2, park: 1, total: 3 }, mine: o.mine ?? null, voters: o.voters, current: o.current ?? null, history: o.history ?? [] },
  topicName: "Code review", ai: { rank: 1, discussions: 6, week: "2026-10-09" },
});

describe("Review page", async () => {
  const { default: Review } = await import("@/app/review/page");
  const page = async () => html(await Review());

  it("anonymous: asks for sign-in and shows no team data", async () => {
    mocks.session = null;
    const out = await page();
    expect(out).toContain("Sign in to review");
    expect(out).not.toContain("Slow reviews");
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("member: sees the three sources of truth separately, can vote only when open, and has NO owner controls or voter names", async () => {
    mocks.session = member;
    mocks.review.mockResolvedValue([card({ state: "open_for_votes", mine: "park" })]);
    const out = await page();
    expect(out).toContain("AI ranking (from the saved report)"); expect(out).toContain("Ranked #1 of the top 3 (6 discussions)");
    expect(out).toContain("Team votes (advice only)"); expect(out).toContain("Prioritise 2");
    expect(out).toContain("Owner decision"); expect(out).toContain("No decision yet");
    expect(out).toContain('aria-label="Your vote"'); expect(out).toContain('aria-pressed="true"'); expect(out).toContain("Withdraw vote");
    expect(out).not.toContain("Owner controls"); expect(out).not.toContain("Record decision");
  });
  it("member: no vote buttons while voting is closed", async () => {
    mocks.session = member;
    mocks.review.mockResolvedValue([card({ state: "under_review" })]);
    expect(await page()).not.toContain('aria-label="Your vote"');
  });
  it("owner: gets controls and sees who voted", async () => {
    mocks.session = owner;
    mocks.review.mockResolvedValue([card({ state: "open_for_votes", voters: [{ voter: "a@team.test", choice: "park" }] })]);
    const out = await page();
    expect(out).toContain("Owner controls"); expect(out).toContain("Record decision"); expect(out).toContain("Close voting");
    expect(out).toContain("a@team.test: park");
    expect(out).toContain("Rationale (required");
  });
  it("shows the current decision with its rationale and the tally at the time, and keeps superseded ones as history", async () => {
    mocks.session = owner;
    mocks.review.mockResolvedValue([card({ state: "prioritised", current: { id: 2, outcome: "prioritised", decided_by: "owner@team.test", decided_at: "2026-10-12T05:00:00Z", rationale: "Unblocks release", followup: true, vote_snapshot: { prioritise: 0, park: 3, total: 3 } }, history: [{ id: 1, outcome: "parked", decided_by: "owner@team.test", decided_at: "2026-10-11T05:00:00Z", rationale: "Later" }] })]);
    const out = await page();
    expect(out).toContain("Unblocks release"); expect(out).toContain("Votes at the time: prioritise 0, park 3");
    expect(out).toContain("Follow-up needed"); expect(out).toContain("Earlier decisions (1)"); expect(out).toContain("(superseded)");
    expect(out).toContain("Decided");
  });
  it("empty and error states are explicit", async () => {
    mocks.session = member;
    mocks.review.mockResolvedValue([]);
    expect(await page()).toContain("Nothing shortlisted yet");
    mocks.review.mockRejectedValue(new Error("db"));
    expect(await page()).toContain("couldn&#x27;t load the review list");
  });
  it("escapes hostile text in themes, reasons and rationales", async () => {
    mocks.session = member;
    const c = card(); c.view.item.theme = "<img src=x onerror=alert(1)>"; c.view.item.reason = "<script>x</script>";
    mocks.review.mockResolvedValue([c]);
    const out = await page();
    expect(out).not.toContain("<img src=x"); expect(out).not.toContain("<script>x");
  });
});

describe("Monday pack page", async () => {
  const { default: Pack } = await import("@/app/pack/page");
  const page = async () => html(await Pack());
  const pack = (o: object = {}) => ({ version: 1, builtAt: "", weekStart: "2026-10-09", periodLabel: "Fri 9 Oct – Thu 15 Oct", state: "ready", message: "1 item prioritised by the owner.", committed: [{ itemId: "i1", theme: "Slow reviews", topicId: "t1", outcome: "prioritised", decidedBy: "owner@team.test", decidedAt: "2026-10-12T05:00:00Z", rationale: "Unblocks release", followup: false, votes: { prioritise: 1, park: 2, total: 3 }, firstWeek: "2026-10-09" }], notPursued: [], followups: [], reportContext: { top: [{ rank: 1, theme: "Slow reviews", observed: "6 discussions" }], limitations: ["Reddit was partial"] }, suggestions: { label: "Suggestions for discussion (not findings, and not approved work)", items: ["Check one example"] }, disclaimer: "Votes informed the discussion; they did not decide it.", ...o });

  it("anonymous: sign-in prompt only", async () => {
    mocks.session = null;
    expect(await page()).toContain("Sign in to see the pack");
  });
  it("no pack yet: honest, nothing committed; the owner gets a build button, a member does not", async () => {
    mocks.pack.mockResolvedValue({ row: null, pack: null, freshness: "none" });
    mocks.session = owner;
    const o = await page();
    expect(o).toContain("No pack has been built yet"); expect(o).toContain("nothing is committed for the coming week"); expect(o).toContain("Build pack");
    mocks.session = member;
    const m = await page();
    expect(m).toContain("Only the owner can build or refresh the pack"); expect(m).not.toContain("Build pack");
  });
  it("a pack separates committed (human) from AI suggestions, and says when it is stale", async () => {
    mocks.session = owner;
    mocks.pack.mockResolvedValue({ row: { created_at: "2026-10-12T06:00:00Z", created_by: "owner@team.test" }, pack: pack(), freshness: "stale_decisions" });
    const out = await page();
    expect(out).toContain("Committed (decided by the owner)"); expect(out).toContain("Unblocks release");
    expect(out).toContain("Out of date: decisions have changed"); expect(out).toContain("Refresh pack");
    expect(out).toContain("AI-written prompts. Nobody has approved these."); expect(out).toContain("not approved work");
    expect(out).toContain("Limitations (1)");
  });
  it("a pack with no decisions never claims committed work", async () => {
    mocks.session = member;
    mocks.pack.mockResolvedValue({ row: { created_at: "2026-10-12T06:00:00Z", created_by: "owner@team.test" }, pack: pack({ state: "no_decisions", message: "No decisions have been recorded yet. Nothing is committed for the coming week; the suggestions below are prompts only.", committed: [] }), freshness: "current" });
    const out = await page();
    expect(out).toContain("Nothing is committed for the coming week");
    expect(out).not.toContain("Unblocks release");
  });
  it("a load failure is an error state", async () => {
    mocks.session = owner; mocks.pack.mockRejectedValue(new Error("db"));
    expect(await page()).toContain("couldn&#x27;t load the pack");
  });
});

describe("Sign-in page", async () => {
  const { default: SignIn } = await import("@/app/signin/page");
  const page = async (q: object = {}) => html(await SignIn({ searchParams: Promise.resolve(q) }));
  it("anonymous without a token: the email form", async () => { mocks.session = null; const o = await page(); expect(o).toContain("Email me a sign-in link"); expect(o).toContain('type="email"'); });
  it("with a token: a POST confirmation form (the link alone does nothing)", async () => {
    mocks.session = null;
    const o = await page({ token: "abc.def" });
    expect(o).toContain('method="post"'); expect(o).toContain('action="/api/auth/verify"'); expect(o).toContain("Confirm sign-in");
  });
  it("signed in: shows who and a sign-out form; errors are worded", async () => {
    mocks.session = member;
    const o = await page({ error: "invalid" });
    expect(o).toContain("a@team.test"); expect(o).toContain("Sign out"); expect(o).toContain("invalid, expired or already used");
  });
});
