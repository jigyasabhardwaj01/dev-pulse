import type { FetchLike, FetchResult, FetchWindow, FetchedPost, Topic } from "../types";
import { matchesKeywords } from "../matching";
import { stripHtml, truncate } from "../text";
import { HttpError, parseRetryAfter, settleRequests, toResult } from "./http";

export const SUBREDDITS = ["programming", "ExperiencedDevs", "devops"];
export const DEFAULT_USER_AGENT = "DevPulse/1.0 (by /u/devpulse_placeholder)";

interface RedditListing {
  data?: {
    children?: {
      data: {
        id: string;
        title?: string;
        selftext?: string;
        permalink?: string;
        author?: string;
        created_utc: number;
      };
    }[];
  };
}

/** Minimal Atom reader for Reddit's search.rss (used when the .json endpoint is blocked). */
export function parseRedditAtom(xml: string, topicId: string): FetchedPost[] {
  const un = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
  const tag = (block: string, name: string) => block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "";
  const out: FetchedPost[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = un(tag(e, "id")).replace(/^t3_/, "").trim();
    const when = new Date(un(tag(e, "updated")) || un(tag(e, "published")));
    if (!id || Number.isNaN(when.getTime())) continue;
    out.push({
      source: "reddit",
      source_id: id,
      topic_id: topicId,
      title: stripHtml(un(tag(e, "title"))),
      body: truncate(stripHtml(un(tag(e, "content"))), 2000),
      url: e.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? null,
      author: un(tag(tag(e, "author"), "name")).replace(/^\/u\//, "") || null,
      posted_at: when.toISOString(),
      is_answered: null,
    });
  }
  return out;
}

/** What the unauthenticated Atom endpoint returns per request, whatever `limit` is asked for (measured: 25 entries). */
export const RSS_PAGE = 25;
/** JSON and OAuth listings return up to 100 per request. */
export const JSON_PAGE = 100;
const DAY = 86_400_000;

/**
 * Reddit only offers coarse time buckets. Choose the smallest one that still reaches the period start;
 * the pipeline then discards anything outside the exact period. A Friday run is just over 7 days after
 * the period began, so a plain "week" bucket would miss its first hours.
 */
export function timeBucket(ageMs: number): string {
  const d = ageMs / DAY;
  return d <= 6.9 ? "week" : d <= 29 ? "month" : d <= 360 ? "year" : "all";
}

const quote = (k: string) => (/\s|\//.test(k) ? `"${k}"` : k);

export interface RedditOptions {
  /** App-only OAuth (a "script" or "web" app's client id and secret). When both are present the authenticated API is used. */
  clientId?: string;
  clientSecret?: string;
  /** Injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Total time the fetcher may spend waiting for Reddit's rate limit across the whole run. Default 125 s. */
  waitBudgetMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const num = (v: string | null) => { const n = v === null ? NaN : Number.parseFloat(v); return Number.isFinite(n) ? n : null; };

/**
 * Reddit search for one topic across all tracked subreddits in ONE request (multireddit syntax: r/a+b+c).
 *
 * Why it looks like this (measured against the live service):
 *  - The public `.json` endpoint is refused outright (HTTP 403 block page) for server networks.
 *  - The public Atom endpoint works but its allowance is about ONE request per minute: it answers with
 *    `x-ratelimit-remaining: 0` and `x-ratelimit-reset: <seconds>` straight away. A fixed short gap just produces 429s.
 *  - So: one request per topic instead of one per subreddit, requests are serialised, and the advertised reset is honoured.
 *    The waiting is capped by a budget; when it runs out the remaining topics fail visibly as rate-limited (never as zero posts).
 *  - With OAuth credentials the authenticated API (100 requests/minute, JSON, 100 results) is used instead.
 * Failures are reported in the result, so an outage or a limit is distinguishable from "no matches".
 */
export function makeRedditFetcher(
  fetchImpl: FetchLike = fetch,
  userAgent: string = process.env.REDDIT_USER_AGENT || DEFAULT_USER_AGENT,
  options: number | RedditOptions = {},
  nowMs: () => number = Date.now,
) {
  const opts: RedditOptions = typeof options === "number" ? {} : options;
  const sleep = opts.sleep ?? realSleep;
  const oauth = Boolean(opts.clientId && opts.clientSecret);
  let budget = opts.waitBudgetMs ?? 125_000;
  let nextAt = 0;           // no request may start before this instant (set from Reddit's own headers)
  let jsonBlocked = false;  // once the public .json is refused, go straight to the Atom feed for the rest of the run
  let token: { value: string; expiresAt: number } | null = null;

  // One request at a time: the allowance is shared by every topic.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => { const run = queue.then(fn); queue = run.catch(() => undefined); return run; };

  /** Per-call tally, so concurrent topics do not report each other's waiting. */
  interface Tally { retries: number; waited: number }
  const gate = async (t: Tally) => {
    const wait = Math.max(0, nextAt - nowMs());
    if (wait <= 0) return;
    if (wait > budget) throw new HttpError("rate limit budget exhausted (HTTP 429) for www.reddit.com", 429);
    await sleep(wait);
    budget -= wait; t.waited += wait;
  };
  /** Learn the next allowed time from Reddit's headers. A `Retry-After: 0` (sent on block pages) means nothing and is ignored. */
  const learn = (res: Response) => {
    const ra = parseRetryAfter(res.headers.get("retry-after"));
    const remaining = num(res.headers.get("x-ratelimit-remaining"));
    const reset = num(res.headers.get("x-ratelimit-reset"));
    if (ra !== null && ra > 0) nextAt = nowMs() + ra;
    else if (remaining !== null && remaining < 1 && reset !== null) nextAt = nowMs() + Math.ceil(reset) * 1000 + 250;
  };
  const request = async (url: string, init: RequestInit, host: string, t: Tally): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      await gate(t);
      let res: Response;
      try {
        res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
      } catch (e) {
        const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
        throw new HttpError(`request failed (${timedOut ? "timeout" : "network error"}) for ${host}`, null);
      }
      learn(res);
      if (res.status === 429 && attempt === 0) {
        if (nextAt <= nowMs()) nextAt = nowMs() + 30_000; // no hint given: assume half a minute
        t.retries++;
        continue; // the gate waits (within budget) or fails visibly
      }
      return res;
    }
  };

  const getToken = async (force = false): Promise<string> => {
    if (!force && token && token.expiresAt > nowMs() + 30_000) return token.value;
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
    let res: Response;
    try {
      res = await fetchImpl("https://www.reddit.com/api/v1/access_token", {
        method: "POST", headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent },
        body: "grant_type=client_credentials", signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new HttpError(`request failed (${(e as Error)?.name === "TimeoutError" ? "timeout" : "network error"}) for www.reddit.com`, null);
    }
    // 401/403 here means the credentials themselves are wrong: a permanent condition, reported as such and never retried.
    if (res.status === 401 || res.status === 403) throw new HttpError(`Reddit rejected the API credentials (HTTP ${res.status}) for www.reddit.com`, res.status);
    if (!res.ok) throw new HttpError(`HTTP ${res.status} for www.reddit.com`, res.status);
    let body: { access_token?: string; expires_in?: number };
    try { body = (await res.json()) as typeof body; } catch { throw new HttpError("unexpected response (not JSON) for www.reddit.com", res.status); }
    if (!body.access_token) throw new HttpError("unexpected response (no access token) for www.reddit.com", res.status);
    token = { value: body.access_token, expiresAt: nowMs() + (body.expires_in ?? 3600) * 1000 };
    return token.value;
  };

  return async function fetchReddit(topic: Topic, window: FetchWindow): Promise<FetchResult> {
    const keywords = topic.keywords.map((k) => k.trim()).filter(Boolean);
    if (!keywords.length) return { posts: [], requests: 0, failed: 0, errors: [], truncated: false };
    const tally: Tally = { retries: 0, waited: 0 };
    let truncated = false;
    const q = keywords.map(quote).join(" OR ");
    const multi = SUBREDDITS.join("+");
    const params = (limit: number) => new URLSearchParams({ q, restrict_sr: "1", sort: "new", t: timeBucket(nowMs() - window.start.getTime()), limit: String(limit), raw_json: "1" });
    const mapJson = (data: RedditListing): FetchedPost[] => {
      const rows = data.data?.children ?? [];
      if (rows.length >= JSON_PAGE) truncated = true;
      return rows.map(({ data: d }): FetchedPost => ({
        source: "reddit", source_id: d.id, topic_id: topic.id, title: stripHtml(d.title), body: truncate(stripHtml(d.selftext), 2000),
        url: d.permalink ? `https://www.reddit.com${d.permalink}` : null, author: d.author ?? null,
        posted_at: new Date(d.created_utc * 1000).toISOString(), is_answered: null,
      }));
    };
    const readListing = async (res: Response, host: string): Promise<RedditListing> => {
      try { return (await res.json()) as RedditListing; } catch { throw new HttpError(`unexpected response (not JSON) for ${host}`, res.status); }
    };

    const task = () => serial(async (): Promise<FetchedPost[]> => {
      if (oauth) {
        for (let attempt = 0; ; attempt++) {
          const t = await getToken(attempt > 0);
          const res = await request(`https://oauth.reddit.com/r/${multi}/search?${params(JSON_PAGE)}`, { headers: { authorization: `Bearer ${t}`, "user-agent": userAgent, accept: "application/json" } }, "oauth.reddit.com", tally);
          if (res.status === 401 && attempt === 0) { token = null; continue; } // expired token: refresh once
          if (!res.ok) throw new HttpError(`HTTP ${res.status} for oauth.reddit.com`, res.status);
          return mapJson(await readListing(res, "oauth.reddit.com"));
        }
      }
      let jsonErr: HttpError | null = null;
      if (!jsonBlocked) {
        const res = await request(`https://www.reddit.com/r/${multi}/search.json?${params(JSON_PAGE)}`, { headers: { accept: "application/json", "user-agent": userAgent } }, "www.reddit.com", tally);
        if (res.ok) return mapJson(await readListing(res, "www.reddit.com"));
        if (res.status === 429) throw new HttpError("HTTP 429 for www.reddit.com", 429); // same allowance as the Atom feed: do not spend it again
        jsonErr = new HttpError(`HTTP ${res.status} for www.reddit.com`, res.status);
        jsonBlocked = res.status === 401 || res.status === 403;
      }
      // The public JSON search is refused from many networks; the Atom form of the same public search still answers.
      const rss = await request(`https://www.reddit.com/r/${multi}/search.rss?${params(JSON_PAGE)}`, { headers: { "user-agent": userAgent } }, "www.reddit.com", tally);
      if (!rss.ok) throw (rss.status === 429 ? new HttpError("HTTP 429 for www.reddit.com", 429) : jsonErr ?? new HttpError(`HTTP ${rss.status} for www.reddit.com`, rss.status));
      const xml = await rss.text();
      // A 200 that is not an Atom feed (e.g. a block page) must count as a failure, not as "no results".
      if (!/<feed[\s>]/.test(xml)) throw new HttpError("unexpected response (not an Atom feed) for www.reddit.com", rss.status);
      const posts = parseRedditAtom(xml, topic.id);
      if (posts.length >= RSS_PAGE) truncated = true;
      return posts;
    });

    const settled = await settleRequests([task]);
    const result = toResult(settled, (p) => matchesKeywords(`${p.title} ${p.body}`, topic.keywords), truncated);
    return tally.retries > 0 || tally.waited > 0 ? { ...result, retries: tally.retries, waitedMs: tally.waited } : result;
  };
}
