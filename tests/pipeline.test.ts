import { describe, expect, it, vi } from "vitest";
import { runDigest } from "@/lib/pipeline";
import { makeHnFetcher } from "@/lib/sources/hn";
import { makeSoFetcher } from "@/lib/sources/stackoverflow";
import { buildBriefPrompt, generateBrief } from "@/lib/brief";
import { buildTrends } from "@/lib/trend";
import { periodFor } from "@/lib/week";
import { MemoryStore, TOPIC, post, seedPreviousReport } from "./helpers";

const NOW = new Date("2026-10-09T03:30:00Z"); // window 2026-10-03 .. 2026-10-09
const classifyAll = (theme = "False positives") => async (prompt: string) => {
  const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
  if (prompt.includes("Friday brief")) return "Narrative from Gemini that is long enough to accept.";
  return JSON.stringify(Array.from({ length: n }, (_, index) => ({ index, theme, sentiment: "negative", unresolved: true })));
};
const hn = (...ids: string[]) => async () => ids.map((id) => post({ source_id: id }));
const so = (...ids: string[]) => async () => ids.map((id) => post({ source: "stackoverflow", source_id: id, is_answered: false }));
const down = (m: string) => async () => { throw new Error(m); };

describe("pipeline", () => {
  it("is idempotent: re-running the same week never double-counts", async () => {
    const store = new MemoryStore();
    const deps = { store, fetchers: { hn: hn("a", "b"), stackoverflow: so("q1") }, callModel: classifyAll(), now: NOW };
    const first = await runDigest(deps);
    const second = await runDigest(deps);
    expect(first.newPosts).toBe(3);
    expect(second.newPosts).toBe(0);
    expect(store.aggregates.get(first.weekStart)![0].count).toBe(3);
  });

  it("keeps working when Hacker News is down", async () => {
    const store = new MemoryStore();
    const s = await runDigest({ store, fetchers: { hn: down("hn 500"), stackoverflow: so("q1") }, callModel: classifyAll(), now: NOW });
    expect(s.newPosts).toBe(1);
    expect(s.warnings.join()).toContain("hn fetch failed");
    expect(store.briefs.size).toBe(1);
  });

  it("keeps working when Stack Overflow is down", async () => {
    const store = new MemoryStore();
    const s = await runDigest({ store, fetchers: { hn: hn("a"), stackoverflow: down("quota") }, callModel: classifyAll(), now: NOW });
    expect(s.newPosts).toBe(1);
    expect(s.warnings.join()).toContain("stackoverflow fetch failed");
  });

  it("still produces a deterministic brief when Gemini is down, and retries classification next run", async () => {
    const store = new MemoryStore();
    const fetchers = { hn: hn("a"), stackoverflow: so() };
    const s = await runDigest({ store, fetchers, callModel: down("gemini 503"), now: NOW });
    expect(s.usedFallbackNarrative).toBe(true);
    expect(s.pending).toBe(1);
    expect(store.briefs.size).toBe(1);
    const retry = await runDigest({ store, fetchers, callModel: classifyAll(), now: NOW });
    expect(retry.classified).toBe(1);
    expect(retry.pending).toBe(0);
    expect(store.aggregates.get(retry.weekStart)![0]).toMatchObject({ theme: "False positives", count: 1 });
  });

  it("falls back when the narrative call fails but classification succeeded", async () => {
    const store = new MemoryStore();
    const model = async (p: string) => { if (p.includes("Friday brief")) throw new Error("boom"); return classifyAll()(p); };
    const s = await runDigest({ store, fetchers: { hn: hn("a"), stackoverflow: so() }, callModel: model, now: NOW });
    expect(s.usedFallbackNarrative).toBe(true);
    expect(store.briefs.values().next().value!.narrative).toContain("False positives");
  });

  it("reports a theme that vanished this week as declined", async () => {
    const store = new MemoryStore();
    // a previous report recorded under the same IST convention with the same source coverage: a valid baseline
    seedPreviousReport(store, {
      weekStart: "2026-09-25", periodStart: "2026-09-24T18:30:00Z",
      rows: [{ topic_id: "t1", theme: "Slow reviews", count: 4, unresolved: 0 }],
      sources: { hn: { status: "ok", posts: 4 }, stackoverflow: { status: "ok", posts: 0 } },
    });
    await runDigest({ store, fetchers: { hn: hn("a"), stackoverflow: so() }, callModel: classifyAll(), now: NOW });
    const points = store.briefs.get("2026-10-02")!.points;
    expect(points.find((p) => p.theme === "Slow reviews")).toMatchObject({ direction: "down", pct: -100, count: 0 });
    expect(points.find((p) => p.theme === "False positives")).toMatchObject({ direction: "new" });
  });

  it("drops posts that fall outside the window or don't match the topic's keywords", async () => {
    const store = new MemoryStore();
    const fetchers = {
      hn: async () => [post({ source_id: "old", posted_at: "2026-09-01T00:00:00Z" }), post({ source_id: "off", title: "cooking", body: "" }), post({ source_id: "ok" })],
      stackoverflow: so(),
    };
    const s = await runDigest({ store, fetchers, callModel: classifyAll(), now: NOW });
    expect(s.newPosts).toBe(1);
  });

  it("a failed email does not fail the run", async () => {
    const s = await runDigest({
      store: new MemoryStore(), fetchers: { hn: hn("a"), stackoverflow: so() }, callModel: classifyAll(), now: NOW,
      sendEmail: async () => { throw new Error("resend 403"); },
    });
    expect(s.email).toBe("failed");
  });
});

describe("grounded narrative", () => {
  it("never includes raw post text in the brief prompt", () => {
    const trends = buildTrends([{ topic_id: "t1", theme: "Slow reviews", count: 3, unresolved: 2 }], [], { t1: "Code review" });
    const prompt = buildBriefPrompt(trends);
    expect(prompt).toContain("Slow reviews");
    expect(prompt).not.toContain("painful");
  });
  it("uses fallback when no model is configured", async () => {
    expect((await generateBrief([], { pending: 0, warnings: [] }, null)).usedFallback).toBe(true);
  });
});

describe("source adapters (mocked fetch)", () => {
  const window = periodFor(new Date("2026-10-09T03:30:00Z"));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("HN: maps stories and comments, filters non-matching, tolerates a failing request", async () => {
    let n = 0;
    const f = vi.fn(async (url: string) => {
      n++;
      if (n === 1) return json({}, 500);
      return json({ hits: [{ objectID: "9", title: "Why code review fails", created_at_i: 1790000000 }, { objectID: "10", title: "unrelated", created_at_i: 1790000000 }] });
    });
    const out = await makeHnFetcher(f, async () => {})(TOPIC, window);
    expect(out.posts.every((p) => p.source === "hn" && p.is_answered === null)).toBe(true);
    expect(out.posts.map((p) => p.source_id)).not.toContain("10");
    expect(out.failed).toBe(0); // a transient 500 is retried and recovered...
    expect(out.retries).toBe(1); // ...and the retry is recorded, not hidden
    expect(f.mock.calls.some(([u]) => String(u).includes("tags=comment"))).toBe(true);
  });

  it("HN: a permanent failure (400) is reported, not retried, and not hidden by the requests that worked", async () => {
    let n = 0;
    const f = vi.fn(async () => (++n === 1 ? json({}, 400) : json({ hits: [{ objectID: "9", title: "code review", created_at_i: 1790000000 }] })));
    const out = await makeHnFetcher(f, async () => {})(TOPIC, window);
    expect(out.failed).toBe(1);
    expect(out.retries).toBeUndefined();
    expect(f.mock.calls.length).toBe(out.requests); // no extra attempt for a permanent error
  });

  it("HN: reports total failure when every request keeps failing after its bounded retries", async () => {
    const f = vi.fn(async () => json({}, 503));
    const r = await makeHnFetcher(f, async () => {})(TOPIC, window);
    expect(r.posts).toEqual([]);
    expect(r.failed).toBe(r.requests);
    expect(f.mock.calls.length).toBe(r.requests * 3); // 1 try + 2 retries each, then give up
  });

  it("SO: carries is_answered through", async () => {
    const f = async () => json({ items: [{ question_id: 5, title: "false positive in code review bot", body: "<p>help</p>", link: "https://so/5", is_answered: false, creation_date: 1790000000 }] });
    const out = await makeSoFetcher(f)(TOPIC, window);
    expect(out.posts[0]).toMatchObject({ source: "stackoverflow", source_id: "5", is_answered: false });
  });
});

