import { describe, expect, it } from "vitest";
import { BACKLOG_LOOKBACK_DAYS, growOnly, runDigest } from "@/lib/pipeline";
import { BATCH_SIZE } from "@/lib/classify";
import type { Topic } from "@/lib/types";
import { MemoryStore, TOPIC, post } from "./helpers";
import { IN_P1, IN_P2, NOW_P1, NOW_P2, P1, P2, deps, downModel, goodModel, hnAt, promptPostCount } from "./stage2-helpers";

const ids = (prefix: string, n: number, at: string): [string, string][] => Array.from({ length: n }, (_, i) => [`${prefix}${i}`, at]);

describe("P0: a failed classification in one period is recovered by a later run", () => {
  it("strands posts in period 1 when Gemini is down, then a later run classifies them under period 1", async () => {
    const store = new MemoryStore();
    const fetchers = { hn: hnAt(...ids("p1-", 3, IN_P1), ...ids("p2-", 2, IN_P2)) };

    const first = await runDigest(deps(store, { now: NOW_P1, callModel: downModel, fetchers }));
    expect(first).toMatchObject({ weekStart: P1, newPosts: 3, classified: 0, pending: 3 });
    expect(store.posts.every((p) => p.theme === null)).toBe(true);

    const prompts: string[] = [];
    const spy = async (p: string) => { if (!p.includes("intro line")) prompts.push(p); return goodModel()(p); };
    const second = await runDigest(deps(store, { now: NOW_P2, callModel: spy, fetchers }));

    expect(second.weekStart).toBe(P2);
    expect(second.recoveredFromEarlierPeriods).toBe(3);
    expect(second).toMatchObject({ classified: 5, pending: 0, backlogRemaining: 0 });
    expect(store.posts.every((p) => p.theme === "False positives")).toBe(true);
    expect(store.posts).toHaveLength(5); // no duplicate rows
    // each recovered post is counted in ITS OWN period, never in the later one
    expect(store.aggregates.get(P1)![0].count).toBe(3);
    expect(store.aggregates.get(P2)![0].count).toBe(2);
  });

  it("the later period compares against the CORRECTED earlier period", async () => {
    const store = new MemoryStore();
    const fetchers = { hn: hnAt(...ids("p1-", 3, IN_P1), ...ids("p2-", 6, IN_P2)) };
    await runDigest(deps(store, { now: NOW_P1, callModel: downModel, fetchers }));
    expect(store.aggregates.get(P1) ?? []).toEqual([]); // nothing was countable yet
    const s = await runDigest(deps(store, { now: NOW_P2, fetchers }));
    expect(s.comparison.state).toBe("comparable");
    expect(store.briefs.get(P2)!.points[0]).toMatchObject({ count: 6, previous: 3, direction: "up", pct: 100 });
  });

  it("does not reclassify records that already succeeded", async () => {
    const store = new MemoryStore();
    const fetchers = { hn: hnAt(...ids("p1-", 2, IN_P1)) };
    await runDigest(deps(store, { now: NOW_P1, callModel: goodModel(), fetchers }));
    const prompts: string[] = [];
    const spy = async (p: string) => { if (!p.includes("intro line")) prompts.push(p); return goodModel()(p); };
    const second = await runDigest(deps(store, { now: NOW_P2, callModel: spy, fetchers: { hn: hnAt(...ids("p1-", 2, IN_P1), ["new", IN_P2]) } }));
    expect(prompts).toHaveLength(1);
    expect(promptPostCount(prompts[0])).toBe(1); // only the new post
    expect(second.recoveredFromEarlierPeriods).toBe(0);
  });

  it("recovers across several periods and keeps each post's topic", async () => {
    const t2: Topic = { ...TOPIC, id: "t2", name: "CI/CD", keywords: ["code review"], canonical_themes: ["Flaky tests"], created_at: "2026-02-01T00:00:00Z" };
    const t1: Topic = { ...TOPIC, created_at: "2026-01-01T00:00:00Z" };
    const store = new MemoryStore([t1, t2]);
    const fetchers = { hn: async (t: Topic) => [post({ source_id: `x-${t.id}`, topic_id: t.id, posted_at: IN_P1 })] };
    await runDigest(deps(store, { now: NOW_P1, callModel: downModel, fetchers }));
    await runDigest(deps(store, { now: NOW_P2, callModel: goodModel("False positives"), fetchers }));
    const byTopic = Object.fromEntries(store.posts.map((p) => [p.topic_id, p.theme]));
    expect(Object.keys(byTopic).sort()).toEqual(["t1", "t2"]);
    expect(store.aggregates.get(P1)!.map((a) => a.topic_id).sort()).toEqual(["t1", "t2"]);
  });

  it("works through the current period first when time is short", async () => {
    const store = new MemoryStore();
    const fetchers = { hn: hnAt(...ids("old-", BATCH_SIZE, IN_P1), ...ids("new-", BATCH_SIZE, IN_P2)) };
    await runDigest(deps(store, { now: NOW_P1, callModel: downModel, fetchers }));
    let t = 0;
    const model = async (p: string) => { if (!p.includes("intro line")) t += 20_000; return goodModel()(p); };
    // 100 s budget, 90 s reserved: a new batch may start only before t = 10 s, i.e. exactly one batch
    const s = await runDigest(deps(store, { now: NOW_P2, callModel: model, clock: () => t, budgetMs: 100_000, fetchers }));
    const done = store.posts.filter((p) => p.theme !== null).map((p) => p.source_id);
    expect(done).toHaveLength(BATCH_SIZE);
    expect(done.every((id) => id.startsWith("new-"))).toBe(true); // this period was served first
    expect(s).toMatchObject({ pending: 0, backlogRemaining: BATCH_SIZE, status: "partial" });
  });

  it("leaves posts older than the lookback alone", async () => {
    const store = new MemoryStore();
    const ancient = new Date(Date.parse("2026-10-01T18:30:00Z") - (BACKLOG_LOOKBACK_DAYS + 7) * 86_400_000).toISOString();
    await store.insertPosts([post({ source_id: "ancient", posted_at: ancient })]);
    let calls = 0;
    const spy = async (p: string) => { if (!p.includes("intro line")) calls++; return goodModel()(p); };
    await runDigest(deps(store, { now: NOW_P1, callModel: spy, fetchers: { hn: hnAt() } }));
    expect(calls).toBe(0);
    expect(store.posts[0].theme).toBeNull();
  });

  it("creates no counts for an earlier period that was never reported", async () => {
    const store = new MemoryStore();
    await store.insertPosts([post({ source_id: "legacy-era", posted_at: "2026-09-10T10:00:00Z" })]);
    await runDigest(deps(store, { now: NOW_P1, fetchers: { hn: hnAt() } }));
    expect(store.posts[0].theme).toBe("False positives"); // still classified: it is retryable data
    expect([...store.aggregates.keys()]).not.toContain("2026-09-04");
    expect([...store.aggregates.keys()].every((k) => store.reports.has(k))).toBe(true); // counts exist only for reported periods
  });
});

describe("P0: malformed model results stay retryable and are never stored", () => {
  const withRows = (rows: object[]) => async (p: string) => (p.includes("intro line") ? goodModel()(p) : JSON.stringify(rows));

  it("a record without a theme is not stored as 'other'; the next run classifies it properly", async () => {
    const store = new MemoryStore();
    const fetchers = { hn: hnAt(["a", IN_P1], ["b", IN_P1]) };
    const s1 = await runDigest(deps(store, {
      fetchers,
      callModel: withRows([{ index: 0, theme: "False positives", sentiment: "negative", unresolved: false }, { index: 1, sentiment: "negative", unresolved: true }]),
    }));
    expect(s1).toMatchObject({ classified: 1, pending: 1 });
    expect(store.posts.find((p) => p.source_id === "b")!.theme).toBeNull();
    expect(store.posts.some((p) => p.theme === "other")).toBe(false);

    const s2 = await runDigest(deps(store, { fetchers }));
    expect(s2).toMatchObject({ classified: 1, pending: 0 });
    expect(store.posts.find((p) => p.source_id === "b")!.theme).toBe("False positives");
  });

  it.each([
    ["blank theme", { index: 0, theme: "  ", sentiment: "negative", unresolved: true }],
    ["non-string theme", { index: 0, theme: 7, sentiment: "negative", unresolved: true }],
    ["missing unresolved flag (non Stack Overflow source)", { index: 0, theme: "False positives", sentiment: "negative" }],
    ["non-boolean unresolved flag", { index: 0, theme: "False positives", sentiment: "negative", unresolved: "yes" }],
  ])("keeps a record with a %s retryable", async (_n, row) => {
    const store = new MemoryStore();
    const s = await runDigest(deps(store, { callModel: withRows([row]) }));
    expect(s.pending).toBe(1);
    expect(store.posts[0].theme).toBeNull();
  });

  it("an out-of-vocabulary theme is still a VALID answer and is stored as 'other' (closed vocabulary)", async () => {
    const store = new MemoryStore();
    await runDigest(deps(store, { callModel: withRows([{ index: 0, theme: "Invented", sentiment: "neutral", unresolved: false }]) }));
    expect(store.posts[0].theme).toBe("other");
  });

  it("a Stack Overflow record needs no model 'unresolved' (it comes from is_answered)", async () => {
    const store = new MemoryStore();
    const so = async () => [post({ source: "stackoverflow", source_id: "q", posted_at: IN_P1, is_answered: true })];
    await runDigest(deps(store, { fetchers: { stackoverflow: so }, callModel: withRows([{ index: 0, theme: "Slow reviews", sentiment: "negative" }]) }));
    expect(store.posts[0]).toMatchObject({ theme: "Slow reviews", unresolved: false });
  });
});

describe("P0: retries never double-count, and earlier periods only ever grow", () => {
  it("running the same period again and again leaves aggregates unchanged", async () => {
    const store = new MemoryStore();
    const fetchers = { hn: hnAt(...ids("a", 4, IN_P1)) };
    await runDigest(deps(store, { fetchers }));
    const snapshot = JSON.stringify(store.aggregates.get(P1));
    for (let i = 0; i < 3; i++) await runDigest(deps(store, { fetchers }));
    expect(JSON.stringify(store.aggregates.get(P1))).toBe(snapshot);
    expect(store.posts).toHaveLength(4);
  });

  it("a later run never lowers an earlier period's counts, even if its posts are gone", async () => {
    const store = new MemoryStore();
    await runDigest(deps(store, { fetchers: { hn: hnAt(...ids("a", 4, IN_P1)) } }));
    store.posts.length = 0; // e.g. posts pruned or topic deleted since
    await runDigest(deps(store, { now: NOW_P2, fetchers: { hn: hnAt() } }));
    expect(store.aggregates.get(P1)![0].count).toBe(4);
  });

  it("growOnly adds, never lowers, never removes", () => {
    const base = [{ topic_id: "t", theme: "A", count: 5, unresolved: 2 }, { topic_id: "t", theme: "B", count: 1, unresolved: 0 }];
    expect(growOnly(base, [{ topic_id: "t", theme: "A", count: 3, unresolved: 1 }]).changed).toBe(false);
    const grown = growOnly(base, [{ topic_id: "t", theme: "A", count: 7, unresolved: 2 }, { topic_id: "t", theme: "C", count: 1, unresolved: 1 }]);
    expect(grown.changed).toBe(true);
    expect(Object.fromEntries(grown.rows.map((r) => [r.theme, r.count]))).toEqual({ A: 7, B: 1, C: 1 });
    expect(growOnly(base, []).changed).toBe(false);
    expect(growOnly(base, []).rows).toHaveLength(2);
  });

  it("a partial failure then a full retry converges to the same counts as a clean run", async () => {
    const fetchers = { hn: hnAt(...ids("a", BATCH_SIZE + 4, IN_P1)) };
    const clean = new MemoryStore();
    await runDigest(deps(clean, { fetchers }));

    const flaky = new MemoryStore();
    let calls = 0;
    const model = async (p: string) => {
      if (!p.includes("intro line") && ++calls === 2) throw new Error("gemini 503");
      return goodModel()(p);
    };
    await runDigest(deps(flaky, { fetchers, callModel: model }));
    await runDigest(deps(flaky, { fetchers }));
    expect(flaky.aggregates.get(P1)).toEqual(clean.aggregates.get(P1));
    expect(flaky.posts).toHaveLength(BATCH_SIZE + 4);
  });
});
