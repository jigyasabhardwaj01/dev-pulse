import type { FetchLike, FetchResult, FetchWindow, FetchedPost, Topic } from "../types";
import { matchAll } from "../matching";
import { stripHtml, truncate } from "../text";
import { getJson, settleRequests, toResult, type RetryStats } from "./http";

interface GhSearch {
  total_count?: number;
  incomplete_results?: boolean;
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
const PER_PAGE = 30;
/** GitHub accepts full UTC timestamps in `created:`; day-only bounds would not match IST period boundaries. */
const stamp = (d: Date) => d.toISOString().slice(0, 19) + "Z";

/**
 * GitHub Issues search. Works with no token (low rate limit); GITHUB_TOKEN, if given, raises it.
 * Failures are reported in the result (never swallowed), so a rate limit is distinguishable from "no matches".
 */
export function makeGithubFetcher(fetchImpl: FetchLike = fetch, token?: string, sleep?: (ms: number) => Promise<void>) {
  return async function fetchGithub(topic: Topic, window: FetchWindow): Promise<FetchResult> {
    let truncated = false;
    const stats: RetryStats = { retries: 0, waitedMs: 0 };
    const keywords = topic.keywords.map((k) => k.trim()).filter(Boolean);
    const from = stamp(window.start);
    const to = stamp(new Date(window.end.getTime() - 1000));
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
          per_page: String(PER_PAGE),
        });
        const data = await getJson<GhSearch>(`https://api.github.com/search/issues?${params}`, fetchImpl, headers, { stats, sleep });
        // Authoritative: the API says how many issues match in total. Guessing from the row count missed real caps.
        const got = (data.items ?? []).length;
        if (data.incomplete_results || (typeof data.total_count === "number" ? data.total_count > got : got >= PER_PAGE)) truncated = true;
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
    // Errors are reported, never swallowed: a failed request must not look like an empty result.
    const settled = await settleRequests(tasks);
    return toResult(settled, (p) => matchAll(`${p.title} ${p.body}`, topic.keywords, true).length > 0, truncated, stats);
  };
}
