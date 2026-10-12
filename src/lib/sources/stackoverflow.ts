import type { FetchLike, FetchResult, FetchWindow, FetchedPost, Topic } from "../types";
import { matchesKeywords } from "../matching";
import { stripHtml } from "../text";
import { getJson, settleRequests, toResult, type RetryStats } from "./http";

interface SoItem {
  question_id: number;
  title: string;
  body?: string;
  link: string;
  is_answered: boolean;
  creation_date: number;
  owner?: { display_name?: string };
}

const PAGE_SIZE = 30;

/** Stack Overflow via the Stack Exchange API: keyword search (optionally scoped by tag) with is_answered. */
export function makeSoFetcher(fetchImpl: FetchLike = fetch, apiKey?: string, sleep?: (ms: number) => Promise<void>) {
  return async function fetchSo(topic: Topic, window: FetchWindow): Promise<FetchResult> {
    let truncated = false;
    const stats: RetryStats = { retries: 0, waitedMs: 0 };
    const from = Math.floor(window.start.getTime() / 1000);
    const to = Math.floor(window.end.getTime() / 1000) - 1;
    const tagScopes: (string | null)[] = topic.tags.length ? topic.tags : [null];
    const tasks = topic.keywords.flatMap((kw) =>
      tagScopes.map((tag) => async () => {
        const params = new URLSearchParams({
          order: "desc",
          sort: "creation",
          q: kw,
          fromdate: String(from),
          todate: String(to),
          site: "stackoverflow",
          filter: "withbody",
          pagesize: String(PAGE_SIZE),
        });
        if (tag) params.set("tagged", tag);
        if (apiKey) params.set("key", apiKey);
        const data = await getJson<{ items?: SoItem[]; has_more?: boolean; backoff?: number }>(
          `https://api.stackexchange.com/2.3/search/advanced?${params}`,
          fetchImpl,
          {},
          { stats, sleep },
        );
        if (typeof data.has_more === "boolean" ? data.has_more : (data.items ?? []).length >= PAGE_SIZE) truncated = true; // has_more is authoritative
        return (data.items ?? []).map((q): FetchedPost => ({
          source: "stackoverflow",
          source_id: String(q.question_id),
          topic_id: topic.id,
          title: stripHtml(q.title),
          body: stripHtml(q.body),
          url: q.link,
          author: q.owner?.display_name ?? null,
          posted_at: new Date(q.creation_date * 1000).toISOString(),
          is_answered: q.is_answered,
        }));
      }),
    );
    const settled = await settleRequests(tasks);
    return toResult(settled, (p) => matchesKeywords(`${p.title} ${p.body}`, topic.keywords), truncated, stats);
  };
}
