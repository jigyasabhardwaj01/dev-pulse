import { describe, expect, it, vi } from "vitest";
import { memoryTeamStore } from "./team-helpers";
import { deriveAnalysis, DERIVE_METHOD_VERSION } from "@/lib/derive-analysis";
import { analysisFor } from "@/lib/analysis-source";
import { castVote, decide, setItemState, shortlist, withdrawItem, type PainPointLookup } from "@/lib/team";
import { latestSavedBrief } from "@/lib/pack-service";
import type { Session } from "@/lib/auth";
import type { EvidencePost } from "@/lib/analysis";

const owner: Session = { email: "owner@team.test", role: "owner" };
const a: Session = { email: "a@team.test", role: "member" };
const b: Session = { email: "b@team.test", role: "member" };
const START = "2026-10-01T18:30:00.000Z", END = "2026-10-08T18:30:00.000Z";

const post = (i: number, o: Partial<EvidencePost> = {}): EvidencePost => ({ id: `p${i}`, source: i % 2 ? "hn" : "github", topic_id: "t1", theme: "Slow reviews", title: `Distinct legacy discussion number ${i}`, url: `https://x.test/${i}`, author: null, posted_at: "2026-10-03T10:00:00Z", confidence: null, excerpt: null, resolution: null, unresolved: true, flags: [], ...o });
const COV = { sources: { hn: { status: "ok", posts: 9 }, github: { status: "ok", posts: 4 }, reddit: { status: "ok", posts: 0 }, stackoverflow: { status: "ok", posts: 0 } }, comparison: { state: "no_prior", reasons: [] } };

function fakeStore(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const brief = { version: 1, emailStatus: "sent", narrative: "N", usedFallback: false, analysis: null, points: [], coverage: COV, pendingCount: 0 };
  const store = {
    getBrief: async (w: string) => { calls.push("getBrief"); return w === "2026-10-02" ? brief : null; },
    getReportPeriod: async (w: string) => (w === "2026-10-02" ? { week_start: w, period_start: START, period_end: END, coverage: COV } : null),
    getAggregates: async () => [{ topic_id: "t1", theme: "Slow reviews", count: 6, unresolved: 6 }],
    getActiveTopics: async () => [{ id: "t1", name: "Code review" }],
    getEvidencePosts: async () => { calls.push("getEvidencePosts"); return Array.from({ length: 6 }, (_, i) => post(i)); },
    getPriorWeeks: async () => [],
    listReportPeriods: async () => [{ week_start: "2026-10-02" }],
    ...over,
  };
  return { store: store as never, calls, brief };
}

describe("derive analysis for a saved report that has none", () => {
  it("only the owner may derive; members get 403 and nothing is written", async () => {
    const t = memoryTeamStore(); const f = fakeStore();
    expect(await deriveAnalysis(f.store, t.store, a, "2026-10-02")).toMatchObject({ ok: false, status: 403 });
    expect(t.state.derived).toHaveLength(0);
  });
  it("derives an immutable analysis with provenance, from stored data only, leaving the delivered report untouched", async () => {
    const t = memoryTeamStore(); const f = fakeStore();
    const before = JSON.stringify(f.brief);
    const r = await deriveAnalysis(f.store, t.store, owner, "2026-10-02", new Date("2026-10-12T14:00:00Z"));
    expect(r).toMatchObject({ ok: true, created: true });
    const d = t.state.derived[0];
    expect(d).toMatchObject({ week_start: "2026-10-02", method_version: DERIVE_METHOD_VERSION, created_by: "owner@team.test" });
    expect(d.provenance).toMatchObject({ method: "derived-from-saved-evidence-v1", derivedBy: "owner@team.test", reportVersion: 1, reportEmailStatus: "sent", evidencePosts: 6, legacyClassification: true });
    expect(d.provenance.notes.join(" ")).toMatch(/not part of the delivered report/);
    expect(d.analysis.painPoints.map((p) => p.theme)).toEqual(["Slow reviews"]);
    expect(JSON.stringify(f.brief)).toBe(before); // report version, narrative, email status: all as delivered
    expect(t.state.events.at(-1)).toMatchObject({ action: "analysis_derived" });
  });
  it("legacy posts (no excerpt, no confidence) cannot be ranked: the analysis says so instead of inventing a top list", async () => {
    const t = memoryTeamStore();
    await deriveAnalysis(fakeStore().store, t.store, owner, "2026-10-02");
    const an = t.state.derived[0].analysis;
    expect(an.top).toEqual([]);
    expect(an.limitations.join(" ")).toMatch(/before classification v2|enough supporting evidence/);
  });
  it("is idempotent: a second call returns the stored analysis and writes nothing", async () => {
    const t = memoryTeamStore(); const f = fakeStore();
    await deriveAnalysis(f.store, t.store, owner, "2026-10-02");
    const again = await deriveAnalysis(f.store, t.store, owner, "2026-10-02");
    expect(again).toMatchObject({ ok: true, created: false });
    expect(t.state.derived).toHaveLength(1);
  });
  it("refuses when there is nothing safe to derive from: no report, a sealed one, no counts, no evidence, bad input", async () => {
    const t = memoryTeamStore();
    expect(await deriveAnalysis(fakeStore().store, t.store, owner, "2026-01-02")).toMatchObject({ status: 404 });
    expect(await deriveAnalysis(fakeStore().store, t.store, owner, "nope")).toMatchObject({ status: 400 });
    expect(await deriveAnalysis(fakeStore().store, t.store, owner, undefined)).toMatchObject({ status: 400 });
    const sealed = fakeStore({ getBrief: async () => ({ version: 2, analysis: { painPoints: [] } }) });
    expect(await deriveAnalysis(sealed.store, t.store, owner, "2026-10-02")).toMatchObject({ status: 409 });
    expect(await deriveAnalysis(fakeStore({ getAggregates: async () => [] }).store, t.store, owner, "2026-10-02")).toMatchObject({ status: 409 });
    expect(await deriveAnalysis(fakeStore({ getEvidencePosts: async () => [] }).store, t.store, owner, "2026-10-02")).toMatchObject({ status: 409 });
    expect(t.state.derived).toHaveLength(0);
  });
  it("keeps the report's own comparison: a comparison that was not fair then is not made fair now", async () => {
    const t = memoryTeamStore();
    await deriveAnalysis(fakeStore().store, t.store, owner, "2026-10-02");
    expect(t.state.derived[0].analysis.painPoints[0].trend.comparable).toBe(false);
  });
  it("never calls anything that collects data, classifies or emails: the store it is given has no such methods", async () => {
    const t = memoryTeamStore();
    const narrow = fakeStore().store as Record<string, unknown>;
    for (const m of ["claimEmail", "markEmailSent", "saveBrief", "saveAggregates", "startRun", "saveClassifications", "saveCheckpoints"]) expect(m in narrow).toBe(false);
    await expect(deriveAnalysis(narrow as never, t.store, owner, "2026-10-02")).resolves.toMatchObject({ ok: true });
  });
});

describe("which analysis backs a report", () => {
  it("sealed beats derived, derived beats none, and a missing table reads as none", async () => {
    const t = memoryTeamStore();
    const none = await analysisFor({ getBrief: async () => ({ analysis: null }) } as never, t.store, "w");
    expect(none.kind).toBe("none");
    expect((await analysisFor({ getBrief: async () => ({ analysis: { painPoints: [] } }) } as never, t.store, "w")).kind).toBe("sealed");
    await deriveAnalysis(fakeStore().store, t.store, owner, "2026-10-02");
    expect((await analysisFor(fakeStore().store, t.store, "2026-10-02")).kind).toBe("derived");
    const broken = { getDerivedAnalysis: async () => { throw new Error("relation does not exist"); } } as never;
    expect((await analysisFor({ getBrief: async () => ({ analysis: null }) } as never, broken, "w")).kind).toBe("none");
    expect((await analysisFor({ getBrief: async () => null } as never, t.store, "w")).kind).toBe("none");
  });
  it("the pack's report context uses a derived analysis when that is all there is", async () => {
    const t = memoryTeamStore();
    expect(await latestSavedBrief(t.store, fakeStore().store)).toBeNull();
    await deriveAnalysis(fakeStore().store, t.store, owner, "2026-10-02");
    expect((await latestSavedBrief(t.store, fakeStore().store))?.weekStart).toBe("2026-10-02");
  });
});

describe("unshortlist", () => {
  const lookup: PainPointLookup = async () => ({ links: [], discussions: 3 });
  const mk = async () => { const t = memoryTeamStore(); const r = await shortlist(t.store, a, lookup, { weekStart: "2026-10-02", topicId: "t1", theme: "Slow reviews", reason: "why" }); return { ...t, id: (r as { item: { id: string } }).item.id }; };
  it("the shortlister and the owner can withdraw; another member cannot", async () => {
    const t = await mk();
    expect(await withdrawItem(t.store, b, t.id)).toMatchObject({ ok: false, status: 403 });
    expect(await withdrawItem(t.store, a, t.id)).toMatchObject({ ok: true, item: { state: "withdrawn" } });
    const t2 = await mk();
    expect(await withdrawItem(t2.store, owner, t2.id)).toMatchObject({ ok: true });
  });
  it("keeps the row and audit trail, clears its votes, and records how many", async () => {
    const t = await mk();
    await setItemState(t.store, owner, t.id, "open_for_votes");
    await castVote(t.store, a, t.id, "park"); await castVote(t.store, b, t.id, "prioritise");
    await withdrawItem(t.store, a, t.id);
    expect(t.state.items).toHaveLength(1);
    expect(t.state.votes).toHaveLength(0);
    expect(t.state.events.at(-1)).toMatchObject({ action: "withdrawn", detail: { from: "open_for_votes", votesDiscarded: 2 } });
  });
  it("withdrawing twice is harmless; voting on a withdrawn item is closed", async () => {
    const t = await mk();
    await withdrawItem(t.store, a, t.id);
    expect(await withdrawItem(t.store, a, t.id)).toMatchObject({ ok: true });
    expect(await castVote(t.store, b, t.id, "park")).toMatchObject({ ok: false, status: 409 });
    expect(await setItemState(t.store, owner, t.id, "open_for_votes")).toMatchObject({ ok: true }); // owner may reopen it deliberately
  });
  it("a decided item cannot be withdrawn", async () => {
    const t = await mk();
    await decide(t.store, owner, t.id, { outcome: "parked", rationale: "later" });
    expect(await withdrawItem(t.store, owner, t.id)).toMatchObject({ ok: false, status: 409 });
  });
  it("shortlisting the same theme again reopens the SAME item with the new reason (still one row per theme)", async () => {
    const t = await mk();
    await withdrawItem(t.store, a, t.id);
    const again = await shortlist(t.store, b, lookup, { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: "new evidence" });
    expect(again).toMatchObject({ ok: true, created: true, item: { id: t.id, state: "under_review", reason: "new evidence" } });
    expect(t.state.items).toHaveLength(1);
  });
  it("an unknown item is 404", async () => {
    const t = memoryTeamStore();
    expect(await withdrawItem(t.store, owner, "00000000-0000-4000-8000-999999999999")).toMatchObject({ status: 404 });
  });
});
