import { describe, expect, it, vi } from "vitest";
import { runDigest } from "@/lib/pipeline";
import { makeGeminiCaller } from "@/lib/gemini";
import { makeHnFetcher } from "@/lib/sources/hn";
import { makeSoFetcher } from "@/lib/sources/stackoverflow";
import { buildBriefPrompt, generateBrief } from "@/lib/brief";
import { buildTrends } from "@/lib/trend";
import { MemoryStore, TOPIC, post } from "./helpers";

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
    store.aggregates.set("2026-09-26", [{ topic_id: "t1", theme: "Slow reviews", count: 4, unresolved: 0 }]);
    await runDigest({ store, fetchers: { hn: hn("a"), stackoverflow: so() }, callModel: classifyAll(), now: NOW });
    const points = store.briefs.get("2026-10-03")!.points;
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
  const window = { start: new Date("2026-10-03T00:00:00Z"), end: new Date("2026-10-10T00:00:00Z"), weekStart: "2026-10-03", prevWeekStart: "2026-09-26" };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("HN: maps stories and comments, filters non-matching, tolerates a failing request", async () => {
    let n = 0;
    const f = vi.fn(async (url: string) => {
      n++;
      if (n === 1) return json({}, 500);
      return json({ hits: [{ objectID: "9", title: "Why code review fails", created_at_i: 1790000000 }, { objectID: "10", title: "unrelated", created_at_i: 1790000000 }] });
    });
    const out = await makeHnFetcher(f)(TOPIC, window);
    expect(out.every((p) => p.source === "hn" && p.is_answered === null)).toBe(true);
    expect(out.map((p) => p.source_id)).not.toContain("10");
    expect(f.mock.calls.some(([u]) => String(u).includes("tags=comment"))).toBe(true);
  });

  it("HN: throws when every request fails", async () => {
    await expect(makeHnFetcher(async () => json({}, 503))(TOPIC, window)).rejects.toThrow();
  });

  it("SO: carries is_answered through", async () => {
    const f = async () => json({ items: [{ question_id: 5, title: "false positive in code review bot", body: "<p>help</p>", link: "https://so/5", is_answered: false, creation_date: 1790000000 }] });
    const out = await makeSoFetcher(f)(TOPIC, window);
    expect(out[0]).toMatchObject({ source: "stackoverflow", source_id: "5", is_answered: false });
  });
});

describe("gemini caller", () => {
  it("retries 429 then succeeds, sends the key in a header", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })));
    const call = makeGeminiCaller({ apiKey: "k", model: "m", fetchImpl: f, retryDelayMs: 1 });
    expect(await call("p")).toBe("hi");
    expect(f).toHaveBeenCalledTimes(2);
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ "x-goog-api-key": "k" });
    expect(String(f.mock.calls[0][0])).toContain("/models/m:generateContent");
  });
  it("throws after exhausting retries and on empty output", async () => {
    await expect(makeGeminiCaller({ apiKey: "k", model: "m", fetchImpl: async () => new Response("", { status: 503 }), retryDelayMs: 1 })("p")).rejects.toThrow("503");
    await expect(makeGeminiCaller({ apiKey: "k", model: "m", fetchImpl: async () => new Response(JSON.stringify({ candidates: [] })), retryDelayMs: 1 })("p")).rejects.toThrow("empty");
  });
});
