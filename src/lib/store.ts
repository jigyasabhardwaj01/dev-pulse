import { createClient } from "@supabase/supabase-js";
import type { Classification, StoredPost, ThemeCount, ThemeTrend, Topic } from "./types";

export interface Store {
  getActiveTopics(): Promise<Topic[]>;
  getExistingKeys(posts: { source: string; source_id: string }[]): Promise<Set<string>>;
  insertPosts(posts: Omit<StoredPost, "id" | "theme" | "sentiment" | "unresolved">[]): Promise<void>;
  getUnclassifiedPosts(from: Date, to: Date): Promise<StoredPost[]>;
  saveClassifications(items: Classification[]): Promise<void>;
  getClassifiedPosts(from: Date, to: Date): Promise<Pick<StoredPost, "topic_id" | "theme" | "unresolved">[]>;
  getAggregates(weekStart: string): Promise<ThemeCount[]>;
  saveAggregates(weekStart: string, rows: ThemeCount[]): Promise<void>;
  saveBrief(weekStart: string, narrative: string, painPoints: ThemeTrend[]): Promise<void>;
}

export function supabaseFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  return createClient(url, key, { auth: { persistSession: false } });
}

type Db = ReturnType<typeof supabaseFromEnv>;
const PAGE = 1000;
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

function ok<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`supabase ${what}: ${res.error.message}`);
  return res.data as T;
}

async function paged<T>(run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string) {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = ok(await run(from, from + PAGE - 1), what);
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

export function makeSupabaseStore(db: Db = supabaseFromEnv()): Store {
  return {
    async getActiveTopics() {
      const rows = ok(await db.from("topics").select("*").eq("active", true), "topics");
      return rows as Topic[];
    },

    async getExistingKeys(posts) {
      const keys = new Set<string>();
      for (const source of new Set(posts.map((p) => p.source))) {
        const ids = posts.filter((p) => p.source === source).map((p) => p.source_id);
        for (const part of chunk(ids, 200)) {
          const rows = ok(await db.from("raw_posts").select("source_id").eq("source", source).in("source_id", part), "existing keys");
          rows.forEach((r: { source_id: string }) => keys.add(`${source}:${r.source_id}`));
        }
      }
      return keys;
    },

    async insertPosts(posts) {
      for (const part of chunk(posts, 200)) {
        // ignoreDuplicates makes a concurrent/repeated run harmless even if the pre-check raced
        ok(await db.from("raw_posts").upsert(part, { onConflict: "source,source_id", ignoreDuplicates: true }), "insert posts");
      }
    },

    async getUnclassifiedPosts(from, to) {
      return paged<StoredPost>(
        (a, b) => db.from("raw_posts").select("*").is("theme", null)
          .gte("posted_at", from.toISOString()).lt("posted_at", to.toISOString()).order("posted_at").range(a, b),
        "unclassified posts",
      );
    },

    async saveClassifications(items) {
      const now = new Date().toISOString();
      for (const part of chunk(items, 25)) {
        await Promise.all(part.map(async (c) =>
          ok(await db.from("raw_posts").update({
            theme: c.theme, sentiment: c.sentiment, unresolved: c.unresolved, classified_at: now,
          }).eq("id", c.id), "save classification")));
      }
    },

    async getClassifiedPosts(from, to) {
      return paged(
        (a, b) => db.from("raw_posts").select("topic_id, theme, unresolved").not("theme", "is", null)
          .gte("posted_at", from.toISOString()).lt("posted_at", to.toISOString()).order("posted_at").range(a, b),
        "classified posts",
      ) as Promise<Pick<StoredPost, "topic_id" | "theme" | "unresolved">[]>;
    },

    async getAggregates(weekStart) {
      const rows = ok(await db.from("weekly_aggregates").select("topic_id, theme, mention_count, unresolved_count").eq("week_start", weekStart), "aggregates");
      return rows.map((r: { topic_id: string; theme: string; mention_count: number; unresolved_count: number }) => ({
        topic_id: r.topic_id, theme: r.theme, count: r.mention_count, unresolved: r.unresolved_count,
      }));
    },

    async saveAggregates(weekStart, rows) {
      if (!rows.length) return;
      ok(await db.from("weekly_aggregates").upsert(
        rows.map((r) => ({ week_start: weekStart, topic_id: r.topic_id, theme: r.theme, mention_count: r.count, unresolved_count: r.unresolved })),
        { onConflict: "week_start,topic_id,theme" },
      ), "save aggregates");
    },

    async saveBrief(weekStart, narrative, painPoints) {
      ok(await db.from("briefs").upsert({ week_start: weekStart, narrative, top_pain_points: painPoints }, { onConflict: "week_start" }), "save brief");
    },
  };
}
