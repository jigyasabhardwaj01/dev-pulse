import { describe, expect, it, vi } from "vitest";
import { makeRedditFetcher, parseRedditAtom, DEFAULT_USER_AGENT } from "@/lib/sources/reddit";
import { makeGithubFetcher } from "@/lib/sources/github";
import { runDigest } from "@/lib/pipeline";
import { MemoryStore, TOPIC, post } from "./helpers";

const window = { start: new Date("2026-10-03T00:00:00Z"), end: new Date("2026-10-10T00:00:00Z"), weekStart: "2026-10-03", prevWeekStart: "2026-09-26" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const listing = (...ids: string[]) => ({ data: { children: ids.map((id) => ({ data: { id, title: `code review rant ${id}`, selftext: "body", permalink: `/r/x/${id}/`, author: "u", created_utc: 1790000000 } })) } });

describe("reddit", () => {
  it("searches each subreddit with a real User-Agent and maps posts with is_answered null", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(listing("abc")));
    const out = await makeRedditFetcher(f, undefined, 0)(TOPIC, window);
    const urls = f.mock.calls.map(([u]) => String(u));
    for (const sub of ["programming", "ExperiencedDevs", "devops"]) expect(urls.some((u) => u.includes(`/r/${sub}/search.json`))).toBe(true);
    expect(urls[0]).toContain("restrict_sr=1");
    expect(urls[0]).toContain("sort=new");
    expect(urls[0]).toContain("t=week");
    const headers = (f.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["user-agent"]).toBe(DEFAULT_USER_AGENT);
    expect(out[0]).toMatchObject({ source: "reddit", source_id: "abc", is_answered: null, url: "https://www.reddit.com/r/x/abc/" });
  });
  const atom = `<?xml version="1.0"?><feed><entry><id>t3_xyz9</id><author><name>/u/someone</name></author>
    <content type="html">&lt;div&gt;the code review bot &amp;amp; me&lt;/div&gt;</content>
    <link href="https://www.reddit.com/r/devops/comments/xyz9/t/"/><updated>2026-10-08T10:00:00+00:00</updated><title>Code review is slow</title></entry></feed>`;
  it("parses Atom entries", () => {
    expect(parseRedditAtom(atom, "t1")[0]).toMatchObject({
      source: "reddit", source_id: "xyz9", title: "Code review is slow", author: "someone",
      url: "https://www.reddit.com/r/devops/comments/xyz9/t/", posted_at: "2026-10-08T10:00:00.000Z", is_answered: null,
    });
    expect(parseRedditAtom(atom, "t1")[0].body).toContain("code review bot & me");
  });
  it("falls back to RSS when the JSON endpoint is blocked (403), still logged-out", async () => {
    const f = vi.fn(async (u: string, _i?: RequestInit) => (u.includes("search.json") ? json({}, 403) : new Response(atom, { status: 200 })));
    const out = await makeRedditFetcher(f, undefined, 0)(TOPIC, window);
    expect(out.length).toBe(3); // one match per subreddit
    expect(f.mock.calls.some(([u]) => u.includes("search.rss"))).toBe(true);
    // after the first refusal the remaining subreddits skip the blocked .json endpoint
    expect(f.mock.calls.filter(([u]) => u.includes("search.json")).length).toBe(1);
  });
  it("returns [] when everything fails (429 / network), never throws", async () => {
    expect(await makeRedditFetcher(async () => json({}, 429), undefined, 0)(TOPIC, window)).toEqual([]);
    expect(await makeRedditFetcher(async () => { throw new Error("ECONNRESET"); }, undefined, 0)(TOPIC, window)).toEqual([]);
  });
  it("keeps results from subreddits that worked when one fails", async () => {
    let n = 0;
    const out = await makeRedditFetcher(async () => (++n === 1 ? json({}, 429) : json(listing(`id${n}`))), undefined, 0)(TOPIC, window);
    expect(out.length).toBe(2);
  });
  it("drops results that do not actually match a keyword", async () => {
    const f = async () => json({ data: { children: [{ data: { id: "z", title: "cooking", selftext: "", permalink: "/p", created_utc: 1790000000 } }] } });
    expect(await makeRedditFetcher(f, undefined, 0)(TOPIC, window)).toEqual([]);
  });
});

describe("github", () => {
  const issues = { items: [{ id: 77, title: "False positive in code review bot", body: "<b>it</b> flags correct code", html_url: "https://github.com/o/r/issues/1", created_at: "2026-10-08T10:00:00Z", user: { login: "dev" } }] };
  it("works with no token: no Authorization header, issue-only dated query", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(issues));
    const out = await makeGithubFetcher(f)(TOPIC, window);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(decodeURIComponent(String(url).replace(/\+/g, " "))).toContain("is:issue created:2026-10-03..2026-10-09");
    expect(String(url)).toContain("api.github.com/search/issues");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(out[0]).toMatchObject({ source: "github", source_id: "77", is_answered: null, author: "dev" });
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
  it("returns [] on rate limit or outage, never throws", async () => {
    expect(await makeGithubFetcher(async () => json({ message: "rate limit" }, 403))(TOPIC, window)).toEqual([]);
    expect(await makeGithubFetcher(async () => { throw new Error("offline"); })(TOPIC, window)).toEqual([]);
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
        reddit: makeRedditFetcher(async () => json({}, 429), undefined, 0),
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
    expect(store.aggregates.get("2026-10-03")![0].count).toBe(2);
  });
});
