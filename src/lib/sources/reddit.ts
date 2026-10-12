import type { FetchLike, FetchWindow, FetchedPost, Topic } from "../types";
import { matchesKeywords } from "../matching";
import { stripHtml, truncate } from "../text";
import { getJson, settleAll } from "./http";

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

const quote = (k: string) => (/\s|\//.test(k) ? `"${k}"` : k);

/**
 * Reddit public search (no login). One OR-combined keyword query per subreddit keeps request volume
 * inside Reddit's unauthenticated rate limit; keyword matching is re-checked locally afterwards.
 * Contract: never throws, returns [] on any failure.
 */
export function makeRedditFetcher(
  fetchImpl: FetchLike = fetch,
  userAgent: string = process.env.REDDIT_USER_AGENT || DEFAULT_USER_AGENT,
  gapMs = 6000,
) {
  // Reddit's unauthenticated limit is strict: space every request out, across all topics, through one queue.
  let queue: Promise<unknown> = Promise.resolve();
  const paced = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(() => (gapMs ? new Promise((r) => setTimeout(r, gapMs)) : undefined)).then(fn);
    queue = run.catch(() => undefined);
    return run;
  };
  let jsonBlocked = false; // once .json is refused, skip straight to RSS for the rest of the run
  return async function fetchReddit(topic: Topic, _window: FetchWindow): Promise<FetchedPost[]> {
    try {
      const keywords = topic.keywords.map((k) => k.trim()).filter(Boolean);
      if (!keywords.length) return [];
      const q = keywords.map(quote).join(" OR ");
      const mapJson = (data: RedditListing): FetchedPost[] =>
        (data.data?.children ?? []).map(({ data: d }): FetchedPost => ({
          source: "reddit",
          source_id: d.id,
          topic_id: topic.id,
          title: stripHtml(d.title),
          body: truncate(stripHtml(d.selftext), 2000),
          url: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
          author: d.author ?? null,
          posted_at: new Date(d.created_utc * 1000).toISOString(),
          is_answered: null,
        }));
      const tasks = SUBREDDITS.map((sub) => () => paced(async (): Promise<FetchedPost[]> => {
        const params = new URLSearchParams({ q, restrict_sr: "1", sort: "new", t: "week", limit: "25", raw_json: "1" });
        let jsonErr: unknown = null;
        if (!jsonBlocked) {
          try {
            return mapJson(await getJson<RedditListing>(`https://www.reddit.com/r/${sub}/search.json?${params}`, fetchImpl, { "user-agent": userAgent }));
          } catch (e) {
            jsonErr = e;
            jsonBlocked = /HTTP 40[13]/.test((e as Error).message);
          }
        }
        // Reddit often refuses unauthenticated .json from some networks; the RSS form of the same public search still works.
        const rss = await fetchImpl(`https://www.reddit.com/r/${sub}/search.rss?${params}`, {
          headers: { "user-agent": userAgent },
          signal: AbortSignal.timeout(15_000),
        });
        if (!rss.ok) throw jsonErr ?? new Error(`HTTP ${rss.status} for www.reddit.com`);
        return parseRedditAtom(await rss.text(), topic.id);
      }));
      const posts = await settleAll(tasks);
      return posts.filter((p) => matchesKeywords(`${p.title} ${p.body}`, topic.keywords));
    } catch (err) {
      console.warn(`reddit fetch failed for "${topic.name}": ${(err as Error).message}`);
      return [];
    }
  };
}
