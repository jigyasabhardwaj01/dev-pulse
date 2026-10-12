import { describe, expect, it, vi } from "vitest";
import { makeRedditFetcher } from "@/lib/sources/reddit";
import { makeGithubFetcher } from "@/lib/sources/github";
import { runDigest } from "@/lib/pipeline";
import { periodFor } from "@/lib/week";
import { MemoryStore, TOPIC, post } from "./helpers";

const window = periodFor(new Date("2026-10-09T03:30:00Z")); // 2026-10-02 00:00 IST .. 2026-10-09 00:00 IST
const DAY = 86_400_000;
const FIVE_DAYS = () => window.start.getTime() + 5 * DAY; // pretend "now" is 5 days after the period began
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const listing = (...ids: string[]) => ({ data: { children: ids.map((id) => ({ data: { id, title: `code review rant ${id}`, selftext: "body", permalink: `/r/x/${id}/`, author: "u", created_utc: 1790000000 } })) } });

describe("github", () => {
  const issues = { items: [{ id: 77, title: "False positive in code review bot", body: "<b>it</b> flags correct code", html_url: "https://github.com/o/r/issues/1", created_at: "2026-10-08T10:00:00Z", user: { login: "dev" } }] };
  it("works with no token: no Authorization header, issue-only query bounded by the IST period", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(issues));
    const out = await makeGithubFetcher(f)(TOPIC, window);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    // 2026-10-02 00:00 IST = 2026-10-01 18:30 UTC; the period ends 1 s before 2026-10-09 00:00 IST
    expect(decodeURIComponent(String(url).replace(/\+/g, " "))).toContain("is:issue created:2026-10-01T18:30:00Z..2026-10-08T18:29:59Z");
    expect(String(url)).toContain("api.github.com/search/issues");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(out.posts[0]).toMatchObject({ source: "github", source_id: "77", is_answered: null, author: "dev" });
  });
  it("sends Bearer token when GITHUB_TOKEN is provided", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(issues));
    await makeGithubFetcher(f, "tok")(TOPIC, window);
    expect(((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).authorization).toBe("Bearer tok");
  });
  it("splits more than 5 keywords across requests (GitHub operator limit)", async () => {
    const f = vi.fn(async () => json({ items: [] }));
    await makeGithubFetcher(f)({ ...TOPIC, keywords: ["a", "b", "c", "d", "e", "f"] }, window);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("reports a rate limit or outage as a failure, not as an empty success, and never throws", async () => {
    for (const f of [async () => json({ message: "rate limit" }, 403), async () => { throw new Error("offline"); }]) {
      const r = await makeGithubFetcher(f)(TOPIC, window);
      expect(r.posts).toEqual([]);
      expect(r.failed).toBe(r.requests);
      expect(r.requests).toBeGreaterThan(0);
    }
  });
  it("a successful search with no matches is not a failure", async () => {
    expect(await makeGithubFetcher(async () => json({ items: [] }))(TOPIC, window)).toMatchObject({ posts: [], failed: 0 });
  });
  it("flags results that hit the page cap", async () => {
    const full = { total_count: 400, items: Array.from({ length: 30 }, (_, i) => ({ id: i, title: "code review", body: "", html_url: "u", created_at: "2026-10-05T00:00:00Z" })) };
    expect((await makeGithubFetcher(async () => json(full))(TOPIC, window)).truncated).toBe(true);
  });
});

describe("pipeline with four sources", () => {
  const classify = async (prompt: string) => {
    if (prompt.includes("intro line")) return "Slow reviews led the week. 1 pain point is new this week.";
    const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
    return JSON.stringify(Array.from({ length: n }, (_, index) => ({ index, theme: "Slow reviews", sentiment: "negative", unresolved: true })));
  };
  const NOW = new Date("2026-10-09T03:30:00Z");
  const ok = (source: "reddit" | "github", id: string) => async () => [post({ source, source_id: id })];

  it("completes with Reddit and GitHub unreachable, using the sources that worked", async () => {
    const store = new MemoryStore();
    const s = await runDigest({
      store, callModel: classify, now: NOW,
      fetchers: {
        hn: async () => [post({ source_id: "h1" })],
        stackoverflow: async () => { throw new Error("quota"); },
        reddit: makeRedditFetcher(async () => json({}, 429), undefined, { sleep: async () => {}, waitBudgetMs: 0 }, FIVE_DAYS),
        github: makeGithubFetcher(async () => json({}, 403)),
      },
    });
    expect(s.newPosts).toBe(1);
    expect(store.briefs.size).toBe(1);
  });

  it("stores and dedupes reddit + github posts by (source, source_id)", async () => {
    const store = new MemoryStore();
    const deps = { store, callModel: classify, now: NOW, fetchers: { reddit: ok("reddit", "r1"), github: ok("github", "r1") } };
    expect((await runDigest(deps)).newPosts).toBe(2); // same id, different source: both kept
    expect((await runDigest(deps)).newPosts).toBe(0);
    expect(store.aggregates.get("2026-10-02")![0].count).toBe(2);
  });
});

describe("every adapter reports when more results exist than were retrieved (authoritative signals)", () => {
  const full = (n: number, mk: (i: number) => object) => Array.from({ length: n }, (_, i) => mk(i));
  it("Hacker News: nbHits > hits returned", async () => {
    const { makeHnFetcher } = await import("@/lib/sources/hn");
    const hits = full(40, (i) => ({ objectID: String(i), title: "code review", created_at_i: 1790000000 }));
    expect((await makeHnFetcher(async () => json({ hits, nbHits: 213, nbPages: 6 }))(TOPIC, window)).truncated).toBe(true);
    expect((await makeHnFetcher(async () => json({ hits: hits.slice(0, 12), nbHits: 12, nbPages: 1 }))(TOPIC, window)).truncated).toBe(false);
    expect((await makeHnFetcher(async () => json({ hits: hits.slice(0, 39) }))(TOPIC, window)).truncated).toBe(false); // no signal, under the page size
  });
  it("Stack Overflow: has_more", async () => {
    const { makeSoFetcher } = await import("@/lib/sources/stackoverflow");
    const items = full(7, (i) => ({ question_id: i, title: "code review", body: "", link: "u", is_answered: false, creation_date: 1790000000 }));
    expect((await makeSoFetcher(async () => json({ items, has_more: true }))(TOPIC, window)).truncated).toBe(true);
    expect((await makeSoFetcher(async () => json({ items, has_more: false }))(TOPIC, window)).truncated).toBe(false);
  });
  it("GitHub: total_count > items returned, even when fewer than a full page came back (the case the old row-count guess missed)", async () => {
    const items = full(5, (i) => ({ id: i, title: "code review", body: "", html_url: "u", created_at: "2026-10-05T00:00:00Z" }));
    expect((await makeGithubFetcher(async () => json({ items, total_count: 75145 }))(TOPIC, window)).truncated).toBe(true);
    expect((await makeGithubFetcher(async () => json({ items, total_count: 5 }))(TOPIC, window)).truncated).toBe(false);
    expect((await makeGithubFetcher(async () => json({ items, total_count: 5, incomplete_results: true }))(TOPIC, window)).truncated).toBe(true);
  });
  it("Reddit (no total available): a full page is treated as capped (25 on the public feed, 100 on the JSON/OAuth listing)", async () => {
    const rows = (n: number) => full(n, (i) => ({ data: { id: `r${i}`, title: "code review", selftext: "", permalink: "/p", created_utc: 1790000000 } }));
    const mk = (n: number) => async () => json({ data: { children: rows(n) } });
    const opts = { sleep: async () => {} };
    expect((await makeRedditFetcher(mk(100), undefined, opts, FIVE_DAYS)(TOPIC, window)).truncated).toBe(true);
    expect((await makeRedditFetcher(mk(99), undefined, opts, FIVE_DAYS)(TOPIC, window)).truncated).toBe(false);
  });
});
