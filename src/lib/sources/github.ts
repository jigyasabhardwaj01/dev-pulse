import type { FetchLike, FetchWindow, FetchedPost, Topic } from "../types";
import { matchesKeywords } from "../matching";
import { stripHtml, truncate } from "../text";
import { getJson, settleAll } from "./http";

interface GhSearch {
  items?: {
    id: number;
    title: string;
    body?: string | null;
    html_url: string;
    created_at: string;
    user?: { login?: string } | null;
  }[];
}

// GitHub search allows at most 5 AND/OR/NOT operators per query, so OR at most 5 keywords per request.
const KEYWORDS_PER_QUERY = 5;
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * GitHub Issues search. Works with no token (low rate limit); GITHUB_TOKEN, if given, raises it.
 * Contract: never throws, returns [] on any failure (rate limit included).
 */
export function makeGithubFetcher(fetchImpl: FetchLike = fetch, token?: string) {
  return async function fetchGithub(topic: Topic, window: FetchWindow): Promise<FetchedPost[]> {
    try {
      const keywords = topic.keywords.map((k) => k.trim()).filter(Boolean);
      const from = day(window.start);
      const to = day(new Date(window.end.getTime() - 1));
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      };
      if (token) headers.authorization = `Bearer ${token}`;

      const tasks: (() => Promise<FetchedPost[]>)[] = [];
      for (let i = 0; i < keywords.length; i += KEYWORDS_PER_QUERY) {
        const terms = keywords.slice(i, i + KEYWORDS_PER_QUERY).map((k) => `"${k}"`).join(" OR ");
        tasks.push(async () => {
          const params = new URLSearchParams({
            q: `(${terms}) is:issue created:${from}..${to}`,
            sort: "created",
            order: "desc",
            per_page: "30",
          });
          const data = await getJson<GhSearch>(`https://api.github.com/search/issues?${params}`, fetchImpl, headers);
          return (data.items ?? []).map((it): FetchedPost => ({
            source: "github",
            source_id: String(it.id),
            topic_id: topic.id,
            title: stripHtml(it.title),
            body: truncate(stripHtml(it.body), 2000),
            url: it.html_url,
            author: it.user?.login ?? null,
            posted_at: new Date(it.created_at).toISOString(),
            is_answered: null,
          }));
        });
      }
      const posts = await settleAll(tasks);
      return posts.filter((p) => matchesKeywords(`${p.title} ${p.body}`, topic.keywords));
    } catch (err) {
      console.warn(`github fetch failed for "${topic.name}": ${(err as Error).message}`);
      return [];
    }
  };
}
