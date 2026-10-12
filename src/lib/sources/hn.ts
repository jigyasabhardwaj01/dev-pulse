import type { FetchLike, FetchWindow, FetchedPost, Topic } from "../types";
import { matchesKeywords } from "../matching";
import { stripHtml } from "../text";
import { getJson, settleAll } from "./http";

interface HnHit {
  objectID: string;
  title?: string | null;
  story_title?: string | null;
  story_text?: string | null;
  comment_text?: string | null;
  author?: string | null;
  created_at_i: number;
}

const HITS_PER_PAGE = 40;

/** Hacker News via Algolia: stories AND comments (comments are where agreement piles up). */
export function makeHnFetcher(fetchImpl: FetchLike = fetch) {
  return async function fetchHn(topic: Topic, window: FetchWindow): Promise<FetchedPost[]> {
    const from = Math.floor(window.start.getTime() / 1000);
    const to = Math.floor(window.end.getTime() / 1000);
    const tasks = topic.keywords.flatMap((kw) =>
      (["story", "comment"] as const).map((type) => async () => {
        const params = new URLSearchParams({
          query: kw,
          tags: type,
          numericFilters: `created_at_i>=${from},created_at_i<${to}`,
          hitsPerPage: String(HITS_PER_PAGE),
        });
        const data = await getJson<{ hits: HnHit[] }>(
          `https://hn.algolia.com/api/v1/search_by_date?${params}`,
          fetchImpl,
        );
        return data.hits.map((h): FetchedPost => ({
          source: "hn",
          source_id: h.objectID,
          topic_id: topic.id,
          title: type === "story" ? (h.title ?? "") : (h.story_title ?? ""),
          body: stripHtml(type === "story" ? h.story_text : h.comment_text),
          url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          author: h.author ?? null,
          posted_at: new Date(h.created_at_i * 1000).toISOString(),
          is_answered: null,
        }));
      }),
    );
    const posts = await settleAll(tasks);
    return posts.filter((p) => matchesKeywords(`${p.title} ${p.body}`, topic.keywords));
  };
}
