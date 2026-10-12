import { describe, expect, it } from "vitest";
import { LATE_GRACE_MS, OVERLAP_MS, advance, emptyCheckpoint, planFetch, type Checkpoint } from "@/lib/checkpoints";

const D = (s: string) => new Date(s);
const P1 = { start: D("2026-10-01T18:30:00Z"), end: D("2026-10-08T18:30:00Z") };   // 2 Oct .. 8 Oct (IST weeks)
const P2 = { start: D("2026-10-08T18:30:00Z"), end: D("2026-10-15T18:30:00Z") };
const P0 = { start: D("2026-09-24T18:30:00Z"), end: D("2026-10-01T18:30:00Z") };
const NOW = D("2026-10-09T00:30:00Z");
const cp = (over: Partial<Checkpoint> = {}): Checkpoint => ({ ...emptyCheckpoint("reddit", "t1"), ...over });
const covered = (w: { start: Date; end: Date }, successAt: Date, over: Partial<Checkpoint> = {}) => cp({ covered_from: w.start.toISOString(), committed_through: w.end.toISOString(), last_success_at: successAt.toISOString(), last_status: "ok", ...over });
const afterClose = (p: { end: Date }) => new Date(p.end.getTime() + LATE_GRACE_MS + 60_000);

describe("planFetch", () => {
  it("fetches the whole period when nothing is committed", () => {
    for (const c of [undefined, cp(), cp({ covered_from: P1.start.toISOString() }), cp({ committed_through: P1.end.toISOString() })]) {
      expect(planFetch(c, P1)).toEqual({ action: "fetch", window: P1, resumed: false });
    }
  });
  it("skips a period that was fetched completely AFTER it closed (plus a grace for late indexing)", () => {
    expect(planFetch(covered(P1, afterClose(P1)), P1)).toEqual({ action: "skip", reason: "already collected completely" });
  });
  it("does not trust a complete fetch made before the period closed or inside the grace window", () => {
    expect(planFetch(covered(P1, new Date(P1.end.getTime() - 1000)), P1).action).toBe("fetch");
    expect(planFetch(covered(P1, new Date(P1.end.getTime() + LATE_GRACE_MS - 1000)), P1).action).toBe("fetch");
  });
  it("resumes from the committed point with an overlap when the period is only partly covered", () => {
    const c = covered({ start: P1.start, end: new Date("2026-10-05T00:00:00Z") }, NOW);
    const p = planFetch(c, P1);
    expect(p).toMatchObject({ action: "fetch", resumed: true });
    if (p.action === "fetch") {
      expect(p.window.start.toISOString()).toBe(new Date(new Date("2026-10-05T00:00:00Z").getTime() - OVERLAP_MS).toISOString());
      expect(p.window.end).toEqual(P1.end);
    }
  });
  it("never resumes earlier than the period start", () => {
    const c = covered({ start: P1.start, end: new Date(P1.start.getTime() + 3_600_000) }, NOW);
    const p = planFetch(c, P1);
    expect(p.action === "fetch" && p.window.start.getTime()).toBe(P1.start.getTime());
  });
  it("fetches in full when the committed range does not reach this period (a gap)", () => {
    expect(planFetch(covered(P0, afterClose(P0)), P2)).toEqual({ action: "fetch", window: P2, resumed: false });
  });
  it("fetches in full when coverage began after this period started (it would miss the start)", () => {
    expect(planFetch(covered({ start: new Date(P1.start.getTime() + 86_400_000), end: P1.end }, afterClose(P1)), P1).action).toBe("fetch");
  });
});

describe("advance: what may move the checkpoint", () => {
  const ok = { status: "ok" as const, truncated: false };
  it("a complete successful fetch commits the window and records attempt and success", () => {
    const n = advance(undefined, "reddit", "t1", P1, ok, NOW);
    expect(n).toMatchObject({ covered_from: P1.start.toISOString(), committed_through: P1.end.toISOString(), last_status: "ok", last_attempt_at: NOW.toISOString(), last_success_at: NOW.toISOString() });
  });
  it("a FAILED fetch records the attempt only: no success, no commit", () => {
    const before = covered(P0, NOW);
    for (const status of ["error", "partial"] as const) {
      const n = advance(before, "reddit", "t1", P1, { status, truncated: false }, new Date(NOW.getTime() + 1000));
      expect(n.committed_through).toBe(before.committed_through);
      expect(n.covered_from).toBe(before.covered_from);
      expect(n.last_success_at).toBe(before.last_success_at);
      expect(n.last_status).toBe(status);
      expect(n.last_attempt_at).toBe(new Date(NOW.getTime() + 1000).toISOString());
    }
  });
  it("a first failed fetch leaves nothing committed", () => {
    const n = advance(undefined, "reddit", "t1", P1, { status: "error", truncated: false }, NOW);
    expect([n.covered_from, n.committed_through, n.last_success_at]).toEqual([null, null, null]);
  });
  it("a fetch that succeeded but hit a page cap is a success, yet commits NOTHING (more data may exist)", () => {
    const n = advance(undefined, "hn", "t1", P1, { status: "ok", truncated: true }, NOW);
    expect(n.last_success_at).toBe(NOW.toISOString());
    expect([n.covered_from, n.committed_through]).toEqual([null, null]);
    const had = covered(P0, NOW);
    expect(advance(had, "hn", "t1", P1, { status: "ok", truncated: true }, NOW).committed_through).toBe(had.committed_through);
  });
  it("extends a contiguous range instead of replacing it", () => {
    const n = advance(covered(P1, NOW), "reddit", "t1", P2, ok, NOW);
    expect([n.covered_from, n.committed_through]).toEqual([P1.start.toISOString(), P2.end.toISOString()]);
  });
  it("a resumed (overlapping) window extends the range and keeps the original start", () => {
    const c = covered({ start: P1.start, end: new Date("2026-10-05T00:00:00Z") }, NOW);
    const w = { start: new Date(new Date("2026-10-05T00:00:00Z").getTime() - OVERLAP_MS), end: P1.end };
    const n = advance(c, "reddit", "t1", w, ok, NOW);
    expect([n.covered_from, n.committed_through]).toEqual([P1.start.toISOString(), P1.end.toISOString()]);
  });
  it("a later disjoint window replaces the range (the old one can no longer be vouched for as contiguous)", () => {
    const n = advance(covered(P0, NOW), "reddit", "t1", { start: new Date(P2.start.getTime() + 86_400_000 * 7), end: new Date(P2.end.getTime() + 86_400_000 * 7) }, ok, NOW);
    expect(n.covered_from).toBe(new Date(P2.start.getTime() + 86_400_000 * 7).toISOString());
  });
  it("an older disjoint backfill never moves the committed range backwards", () => {
    const c = covered(P2, NOW);
    const n = advance(c, "reddit", "t1", P0, ok, new Date(NOW.getTime() + 5000));
    expect([n.covered_from, n.committed_through]).toEqual([c.covered_from, c.committed_through]);
    expect(n.last_attempt_at).toBe(new Date(NOW.getTime() + 5000).toISOString());
  });
  it("does not mutate its input", () => {
    const c = covered(P1, NOW);
    const frozen = JSON.stringify(c);
    advance(c, "reddit", "t1", P2, ok, NOW);
    expect(JSON.stringify(c)).toBe(frozen);
  });
});

describe("recovery after interruption (plan + advance together)", () => {
  const ok = { status: "ok" as const, truncated: false };
  it("a run that died before committing leaves the next run fetching the same window in full", () => {
    let state: Checkpoint | undefined;
    const first = planFetch(state, P1);                 // fetch...
    expect(first.action).toBe("fetch");                 // ...then the process dies: advance() is never called
    expect(planFetch(state, P1)).toEqual(first);
    state = advance(state, "reddit", "t1", P1, ok, afterClose(P1));
    expect(planFetch(state, P1).action).toBe("skip");   // only now is it skippable
  });
  it("a partial failure then a clean retry converges: nothing is skipped in between", () => {
    let state = advance(undefined, "reddit", "t1", P1, { status: "partial", truncated: false }, afterClose(P1));
    expect(planFetch(state, P1).action).toBe("fetch");
    state = advance(state, "reddit", "t1", P1, ok, new Date(afterClose(P1).getTime() + 3_600_000));
    expect(planFetch(state, P1).action).toBe("skip");
  });
  it("a capped source is fetched again every time (it can never be 'complete')", () => {
    let state: Checkpoint | undefined;
    for (let i = 0; i < 3; i++) {
      expect(planFetch(state, P1).action).toBe("fetch");
      state = advance(state, "hn", "t1", P1, { status: "ok", truncated: true }, afterClose(P1));
    }
  });
  it("late-arriving posts: a period fetched too early is re-fetched, one fetched after the grace is not", () => {
    const early = advance(undefined, "reddit", "t1", P1, ok, new Date(P1.end.getTime() + 60_000));
    expect(planFetch(early, P1).action).toBe("fetch");
    const late = advance(undefined, "reddit", "t1", P1, ok, afterClose(P1));
    expect(planFetch(late, P1).action).toBe("skip");
  });
});
