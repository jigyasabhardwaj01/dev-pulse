import type { Store } from "@/lib/store";
import type { Classification, FetchedPost, StoredPost, ThemeCount, ThemeTrend, Topic } from "@/lib/types";

export const TOPIC: Topic = {
  id: "t1", name: "Code review", keywords: ["code review", "false positive"],
  canonical_themes: ["False positives", "Slow reviews"], tags: [], category: null, active: true,
};

export const post = (over: Partial<FetchedPost> = {}): FetchedPost => ({
  source: "hn", source_id: "1", topic_id: "t1", title: "code review is painful", body: "",
  url: null, author: null, posted_at: "2026-10-08T10:00:00Z", is_answered: null, ...over,
});

export class MemoryStore implements Store {
  posts: StoredPost[] = [];
  aggregates = new Map<string, ThemeCount[]>();
  briefs = new Map<string, { narrative: string; points: ThemeTrend[] }>();
  constructor(public topics: Topic[] = [TOPIC]) {}
  async getActiveTopics() { return this.topics.filter((t) => t.active); }
  async getExistingKeys() { return new Set(this.posts.map((p) => `${p.source}:${p.source_id}`)); }
  async insertPosts(posts: FetchedPost[]) {
    for (const p of posts) {
      if (this.posts.some((x) => x.source === p.source && x.source_id === p.source_id)) continue;
      this.posts.push({ ...p, id: `id-${this.posts.length}`, theme: null, sentiment: null, unresolved: null });
    }
  }
  async getUnclassifiedPosts() { return this.posts.filter((p) => p.theme === null); }
  async saveClassifications(items: Classification[]) {
    for (const c of items) Object.assign(this.posts.find((p) => p.id === c.id)!, c, { id: c.id });
  }
  async getClassifiedPosts() { return this.posts.filter((p) => p.theme !== null); }
  async getAggregates(week: string) { return this.aggregates.get(week) ?? []; }
  async saveAggregates(week: string, rows: ThemeCount[]) { this.aggregates.set(week, rows); }
  async saveBrief(week: string, narrative: string, points: ThemeTrend[]) { this.briefs.set(week, { narrative, points }); }
}
