import { describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_AGENT, JSON_PAGE, RSS_PAGE, SUBREDDITS, makeRedditFetcher, parseRedditAtom, timeBucket } from "@/lib/sources/reddit";
import { periodFor } from "@/lib/week";
import { TOPIC } from "./helpers";

const window = periodFor(new Date("2026-10-09T03:30:00Z"));
const DAY = 86_400_000;
const NOW = window.start.getTime() + 5 * DAY;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const listing = (...ids: string[]) => ({ data: { children: ids.map((id) => ({ data: { id, title: `code review rant ${id}`, selftext: "body", permalink: `/r/x/${id}/`, author: "u", created_utc: 1790000000 } })) } });
const entry = (id: string) => `<entry><id>t3_${id}</id><author><name>/u/someone</name></author><content type="html">&lt;div&gt;the code review bot&lt;/div&gt;</content><link href="https://www.reddit.com/r/devops/comments/${id}/t/"/><updated>2026-10-08T10:00:00+00:00</updated><title>Code review is slow ${id}</title></entry>`;
const atom = (...ids: string[]) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${ids.map(entry).join("")}</feed>`;
const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };
const make = (f: (u: string, i?: RequestInit) => Promise<Response>, over = {}) => makeRedditFetcher(f as never, undefined, { sleep, ...over }, () => NOW);
const T2 = { ...TOPIC, id: "t2", name: "Second", keywords: ["code review"] };
const T3 = { ...TOPIC, id: "t3", name: "Third", keywords: ["code review"] };

describe("request shape", () => {
  it("makes ONE request per topic across all tracked subreddits, with a descriptive User-Agent", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(listing("abc")));
    const out = await make(f)(TOPIC, window);
    expect(f).toHaveBeenCalledTimes(1);
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain(`/r/${SUBREDDITS.join("+")}/search.json`);
    for (const p of ["restrict_sr=1", "sort=new", "t=week", `limit=${JSON_PAGE}`, "raw_json=1"]) expect(url).toContain(p);
    expect(((f.mock.calls[0][1] as RequestInit).headers as Record<string, string>)["user-agent"]).toBe(DEFAULT_USER_AGENT);
    expect(out).toMatchObject({ failed: 0, requests: 1 });
    expect(out.posts[0]).toMatchObject({ source: "reddit", source_id: "abc", is_answered: null, url: "https://www.reddit.com/r/x/abc/", topic_id: TOPIC.id });
  });
  it("uses a time bucket that reaches the start of the period", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(listing()));
    await makeRedditFetcher(f as never, undefined, { sleep }, () => window.start.getTime() + 7.4 * DAY)(TOPIC, window);
    expect(String(f.mock.calls[0][0])).toContain("t=month");
    expect([timeBucket(5 * DAY), timeBucket(7.4 * DAY), timeBucket(40 * DAY), timeBucket(400 * DAY)]).toEqual(["week", "month", "year", "all"]);
  });
  it("sends no keyword-less request", async () => {
    const f = vi.fn();
    expect(await make(f as never)({ ...TOPIC, keywords: [" ", ""] }, window)).toMatchObject({ requests: 0, failed: 0, posts: [] });
    expect(f).not.toHaveBeenCalled();
  });
  it("drops results that do not actually match a keyword, and a successful search with nothing is not a failure", async () => {
    const miss = async () => json({ data: { children: [{ data: { id: "z", title: "cooking", selftext: "", permalink: "/p", created_utc: 1790000000 } }] } });
    expect(await make(miss)(TOPIC, window)).toMatchObject({ posts: [], failed: 0 });
    expect(await make(async () => json({ data: { children: [] } }))(TOPIC, window)).toMatchObject({ posts: [], failed: 0, errors: [] });
  });
});

describe("the public JSON endpoint is blocked: Atom fallback", () => {
  it("falls back to the Atom feed on 403, and later topics skip the blocked JSON endpoint", async () => {
    const f = vi.fn(async (u: string, _i?: RequestInit) => (u.includes("search.json") ? json({}, 403, { "retry-after": "0" }) : new Response(atom("a1", "a2"), { status: 200 })));
    const fetcher = make(f);
    const a = await fetcher(TOPIC, window);
    const b = await fetcher(T2, window);
    expect(a.posts.map((p) => p.source_id)).toEqual(["a1", "a2"]);
    expect(b.posts.length).toBe(2);
    expect(f.mock.calls.filter(([u]) => u.includes("search.json")).length).toBe(1);
    expect(f.mock.calls.filter(([u]) => u.includes("search.rss")).length).toBe(2);
    expect(a).toMatchObject({ requests: 1, failed: 0 }); // the fallback is part of the same request, not a failure
  });
  it("a Retry-After of 0 (sent on block pages) does not cause any waiting", async () => {
    sleeps.length = 0;
    const f = async (u: string) => (u.includes("search.json") ? json({}, 403, { "retry-after": "0" }) : new Response(atom("a1"), { status: 200 }));
    const fetcher = make(f);
    await fetcher(TOPIC, window); await fetcher(T2, window);
    expect(sleeps).toEqual([]);
  });
  it("a 200 block page on the Atom fallback is a failure, not an empty success", async () => {
    const f = async (u: string) => (u.includes("search.json") ? json({}, 403) : new Response("<html>blocked</html>", { status: 200 }));
    const r = await make(f)(TOPIC, window);
    expect(r).toMatchObject({ posts: [], requests: 1, failed: 1 });
    expect(r.errors.join()).toContain("not an Atom feed");
  });
  it("an empty but valid Atom feed is a successful zero", async () => {
    const f = async (u: string) => (u.includes("search.json") ? json({}, 403) : new Response(atom(), { status: 200 }));
    expect(await make(f)(TOPIC, window)).toMatchObject({ posts: [], failed: 0, errors: [] });
  });
  it("reports the original refusal if the Atom feed fails too", async () => {
    const f = async (u: string) => json({}, u.includes("search.json") ? 403 : 500);
    const r = await make(f)(TOPIC, window);
    expect(r.failed).toBe(1);
    expect(r.errors.join()).toContain("HTTP 403");
  });
  it("parses Atom entries (id, author, html body, link, time)", () => {
    const xml = `<?xml version="1.0"?><feed><entry><id>t3_xyz9</id><author><name>/u/someone</name></author><content type="html">&lt;div&gt;the code review bot &amp;amp; me&lt;/div&gt;</content><link href="https://www.reddit.com/r/devops/comments/xyz9/t/"/><updated>2026-10-08T10:00:00+00:00</updated><title>Code review is slow</title></entry></feed>`;
    const p = parseRedditAtom(xml, "t1")[0];
    expect(p).toMatchObject({ source: "reddit", source_id: "xyz9", title: "Code review is slow", author: "someone", url: "https://www.reddit.com/r/devops/comments/xyz9/t/", posted_at: "2026-10-08T10:00:00.000Z", is_answered: null });
    expect(p.body).toContain("code review bot & me");
  });
  it("skips Atom entries with no id or an unreadable time instead of throwing", () => {
    const bad = `<feed><entry><id></id><updated>2026-10-08T10:00:00+00:00</updated></entry><entry><id>t3_ok</id><updated>garbage</updated></entry></feed>`;
    expect(parseRedditAtom(bad, "t")).toEqual([]);
  });
});

describe("Reddit's own rate-limit headers drive the pacing", () => {
  const limited = (body: string, remaining = "0.0", reset = "44") => new Response(body, { status: 200, headers: { "x-ratelimit-remaining": remaining, "x-ratelimit-reset": reset } });
  const rss = (u: string, body: string, h?: { remaining?: string; reset?: string }) => (u.includes("search.json") ? json({}, 403) : limited(body, h?.remaining, h?.reset));
  it("waits for the advertised reset before the next topic's request, and not before the first", async () => {
    sleeps.length = 0;
    const fetcher = make(async (u) => rss(u, atom("a1")));
    await fetcher(TOPIC, window);
    expect(sleeps).toEqual([]);
    await fetcher(T2, window);
    expect(sleeps).toEqual([44_250]); // reset 44 s + a quarter-second margin
  });
  it("does not wait while the allowance has not run out", async () => {
    sleeps.length = 0;
    const fetcher = make(async (u) => rss(u, atom("a1"), { remaining: "5", reset: "30" }));
    await fetcher(TOPIC, window); await fetcher(T2, window); await fetcher(T3, window);
    expect(sleeps).toEqual([]);
  });
  it("serialises concurrent topics through one queue (the allowance is shared)", async () => {
    let inFlight = 0, peak = 0;
    const f = async (u: string) => { if (u.includes("search.json")) return json({}, 403); inFlight++; peak = Math.max(peak, inFlight); await Promise.resolve(); inFlight--; return limited(atom("a"), "5", "30"); };
    const fetcher = make(f);
    await Promise.all([fetcher(TOPIC, window), fetcher(T2, window), fetcher(T3, window)]);
    expect(peak).toBe(1);
  });
  it("429 with a reset hint: waits once, retries, and succeeds without losing the posts", async () => {
    sleeps.length = 0;
    let n = 0;
    const f = async (u: string) => (u.includes("search.json") ? json({}, 403)
      : ++n === 1 ? new Response("", { status: 429, headers: { "x-ratelimit-remaining": "0.0", "x-ratelimit-reset": "18" } }) : limited(atom("a1", "a2"), "5", "30"));
    const r = await make(f)(TOPIC, window);
    expect(r.posts.length).toBe(2);
    expect(r).toMatchObject({ failed: 0, retries: 1, waitedMs: 18_250 });
    expect(sleeps).toEqual([18_250]);
  });
  it("429 that persists after the one retry fails visibly as rate limited, with no retry loop", async () => {
    const f = vi.fn(async (u: string, _i?: RequestInit) => (u.includes("search.json") ? json({}, 403) : new Response("", { status: 429, headers: { "x-ratelimit-reset": "10", "x-ratelimit-remaining": "0" } })));
    const r = await make(f)(TOPIC, window);
    expect(r).toMatchObject({ posts: [], requests: 1, failed: 1, retries: 1 });
    expect(r.errors.join()).toContain("429");
    expect(f.mock.calls.filter(([u]) => u.includes("search.rss")).length).toBe(2); // first try + exactly one retry
  });
  it("429 with no hint at all assumes half a minute", async () => {
    sleeps.length = 0;
    let n = 0;
    const f = async (u: string) => (u.includes("search.json") ? json({}, 403) : ++n === 1 ? new Response("", { status: 429 }) : limited(atom("a"), "5", "30"));
    await make(f)(TOPIC, window);
    expect(sleeps).toEqual([30_000]);
  });
  it("a Retry-After on a 429 is honoured", async () => {
    sleeps.length = 0;
    let n = 0;
    const f = async (u: string) => (u.includes("search.json") ? json({}, 403) : ++n === 1 ? new Response("", { status: 429, headers: { "retry-after": "12" } }) : limited(atom("a"), "5", "30"));
    await make(f)(TOPIC, window);
    expect(sleeps).toEqual([12_000]);
  });
  it("a JSON-endpoint 429 does not spend the shared allowance on a fallback request", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response("", { status: 429, headers: { "x-ratelimit-reset": "5", "x-ratelimit-remaining": "0" } }));
    const r = await make(f)(TOPIC, window);
    expect(r.failed).toBe(1);
    expect(f.mock.calls.every(([u]) => u.includes("search.json"))).toBe(true);
  });
});

describe("the wait budget keeps Reddit from starving the run", () => {
  it("when the next wait would exceed the budget, that topic fails fast as rate limited, and earlier topics keep their posts", async () => {
    sleeps.length = 0;
    const f = async (u: string) => (u.includes("search.json") ? json({}, 403) : new Response(atom("a1"), { status: 200, headers: { "x-ratelimit-remaining": "0.0", "x-ratelimit-reset": "58" } }));
    const fetcher = make(f, { waitBudgetMs: 70_000 });
    const [a, b, c] = [await fetcher(TOPIC, window), await fetcher(T2, window), await fetcher(T3, window)];
    expect(a).toMatchObject({ failed: 0, posts: [expect.anything()] });
    expect(b).toMatchObject({ failed: 0, waitedMs: 58_250 });
    expect(c).toMatchObject({ posts: [], requests: 1, failed: 1 });
    expect(c.errors.join()).toContain("rate limit budget exhausted");
    expect(sleeps).toEqual([58_250]); // the third wait was refused, not slept
  });
  it("each topic reports only its own waiting, even when all three run concurrently", async () => {
    const f = async (u: string) => (u.includes("search.json") ? json({}, 403) : new Response(atom("a"), { status: 200, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "58" } }));
    const shared = make(f);
    const rs = await Promise.all([TOPIC, T2, T3].map((t) => shared(t, window)));
    expect(rs.map((r) => r.waitedMs ?? 0)).toEqual([0, 58_250, 58_250]);
  });
  it("an exhausted budget is reported as a rate limit, never as zero posts", async () => {
    const f = async (u: string) => (u.includes("search.json") ? json({}, 403) : new Response(atom("a"), { status: 200, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "58" } }));
    const fetcher = make(f, { waitBudgetMs: 0 });
    await fetcher(TOPIC, window);
    const r = await fetcher(T2, window);
    expect(r.failed).toBe(r.requests);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("transport and parsing failures", () => {
  it("reports network errors and timeouts as failures, never as empty successes", async () => {
    for (const [err, text] of [[new TypeError("fetch failed"), "network error"], [Object.assign(new Error("t"), { name: "TimeoutError" }), "timeout"]] as const) {
      const r = await make(async () => { throw err; })(TOPIC, window);
      expect(r).toMatchObject({ posts: [], requests: 1, failed: 1 });
      expect(r.errors.join()).toContain(text);
    }
  });
  it("a malformed JSON body is a failure with a clear message", async () => {
    const r = await make(async () => new Response("<html>oops</html>", { status: 200 }))(TOPIC, window);
    expect(r.failed).toBe(1);
    expect(r.errors.join()).toContain("not JSON");
  });
  it("a listing with no children is a successful zero, and a missing data object does not throw", async () => {
    expect(await make(async () => json({}))(TOPIC, window)).toMatchObject({ posts: [], failed: 0 });
  });
});

describe("page caps are reported, not hidden", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`);
  it("the public Atom feed returns 25 per request, so 25 entries means 'more may exist'", async () => {
    const f = (n: number) => async (u: string) => (u.includes("search.json") ? json({}, 403) : new Response(atom(...many(n)), { status: 200 }));
    expect(RSS_PAGE).toBe(25);
    expect((await make(f(25))(TOPIC, window)).truncated).toBe(true);
    expect((await make(f(24))(TOPIC, window)).truncated).toBe(false);
  });
  it("the JSON listing is capped at 100", async () => {
    const rows = (n: number) => ({ data: { children: many(n).map((id) => ({ data: { id, title: "code review", selftext: "", permalink: "/p", created_utc: 1790000000 } })) } });
    expect((await make(async () => json(rows(100)))(TOPIC, window)).truncated).toBe(true);
    expect((await make(async () => json(rows(99)))(TOPIC, window)).truncated).toBe(false);
  });
});

describe("OAuth (app-only) mode", () => {
  const CREDS = { clientId: "id-123", clientSecret: "sekret-456" };
  const tokenRes = () => json({ access_token: "tok-789", expires_in: 3600 });
  const oauthFetch = (over: { search?: (n: number) => Response; token?: () => Response } = {}) => {
    let searches = 0;
    const f = vi.fn(async (u: string, _i?: RequestInit) => {
      if (u.includes("/api/v1/access_token")) return (over.token ?? tokenRes)();
      searches++;
      return (over.search ?? (() => json(listing("o1"))))(searches);
    });
    return f;
  };
  it("gets a token with Basic auth, then searches the authenticated API with a Bearer token, never the public endpoints", async () => {
    const f = oauthFetch();
    const r = await make(f, CREDS)(TOPIC, window);
    expect(r.posts.map((p) => p.source_id)).toEqual(["o1"]);
    const tokenCall = f.mock.calls.find(([u]) => u.includes("access_token"))!;
    expect((tokenCall[1] as RequestInit).method).toBe("POST");
    expect(((tokenCall[1] as RequestInit).headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("id-123:sekret-456").toString("base64")}`);
    expect(String((tokenCall[1] as RequestInit).body)).toBe("grant_type=client_credentials");
    const search = f.mock.calls.find(([u]) => u.includes("oauth.reddit.com"))!;
    expect(String(search[0])).toContain(`/r/${SUBREDDITS.join("+")}/search?`);
    expect(((search[1] as RequestInit).headers as Record<string, string>).authorization).toBe("Bearer tok-789");
    expect(f.mock.calls.some(([u]) => /www\.reddit\.com\/r\//.test(u))).toBe(false);
  });
  it("fetches the token once for the whole run", async () => {
    const f = oauthFetch();
    const fetcher = make(f, CREDS);
    await fetcher(TOPIC, window); await fetcher(T2, window); await fetcher(T3, window);
    expect(f.mock.calls.filter(([u]) => u.includes("access_token")).length).toBe(1);
  });
  it("refreshes an expired token once on a 401, then succeeds", async () => {
    const f = oauthFetch({ search: (n) => (n === 1 ? json({}, 401) : json(listing("o2"))) });
    const r = await make(f, CREDS)(TOPIC, window);
    expect(r).toMatchObject({ failed: 0 });
    expect(r.posts.map((p) => p.source_id)).toEqual(["o2"]);
    expect(f.mock.calls.filter(([u]) => u.includes("access_token")).length).toBe(2);
  });
  it("rejected credentials are an authentication failure: reported clearly, not retried, and not mistaken for a rate limit", async () => {
    for (const status of [401, 403]) {
      const f = oauthFetch({ token: () => json({ error: "invalid_grant" }, status) });
      const r = await make(f, CREDS)(TOPIC, window);
      expect(r).toMatchObject({ posts: [], requests: 1, failed: 1 });
      expect(r.errors.join()).toContain("rejected the API credentials");
      expect(f.mock.calls.filter(([u]) => u.includes("access_token")).length).toBe(1);
      expect(f.mock.calls.some(([u]) => u.includes("oauth.reddit.com"))).toBe(false);
    }
  });
  it("a search that is still unauthorised after a refresh fails (no loop)", async () => {
    const f = oauthFetch({ search: () => json({}, 401) });
    const r = await make(f, CREDS)(TOPIC, window);
    expect(r.failed).toBe(1);
    expect(f.mock.calls.filter(([u]) => u.includes("oauth.reddit.com")).length).toBe(2);
  });
  it("a token response without a token is a failure", async () => {
    const r = await make(oauthFetch({ token: () => json({}) }), CREDS)(TOPIC, window);
    expect(r.failed).toBe(1);
    expect(r.errors.join()).toContain("no access token");
  });
  it("the credentials and token never appear in results or errors", async () => {
    for (const f of [oauthFetch({ token: () => json({}, 401) }), oauthFetch({ search: () => json({}, 500) }), oauthFetch({ search: () => new Response("<html>", { status: 200 }) })]) {
      const r = await make(f, CREDS)(TOPIC, window);
      const dump = JSON.stringify(r);
      for (const secret of ["sekret-456", "id-123", "tok-789", Buffer.from("id-123:sekret-456").toString("base64")]) expect(dump).not.toContain(secret);
    }
  });
  it("only one half of the credentials means unauthenticated mode, not a half-configured one", async () => {
    const f = vi.fn(async (u: string, _i?: RequestInit) => (u.includes("search.json") ? json(listing("p1")) : json({})));
    await make(f, { clientId: "only-id" })(TOPIC, window);
    expect(f.mock.calls.some(([u]) => u.includes("access_token"))).toBe(false);
    expect(f.mock.calls.some(([u]) => u.includes("www.reddit.com/r/"))).toBe(true);
  });
  it("rate limits still apply to the authenticated API and are honoured by header", async () => {
    sleeps.length = 0;
    let n = 0;
    const f = oauthFetch({ search: () => (++n === 1 ? new Response(JSON.stringify(listing("o1")), { status: 200, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9" } }) : json(listing("o2"))) });
    const fetcher = make(f, CREDS);
    await fetcher(TOPIC, window); await fetcher(T2, window);
    expect(sleeps).toEqual([9250]);
  });
});
