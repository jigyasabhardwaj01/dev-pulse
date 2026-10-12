import type { FetchedPost, ModelCaller, Source, SourceFetcher, StoredPost, ThemeTrend, Topic } from "./types";
import type { Store } from "./store";
import { windowFor } from "./week";
import { matchesKeywords } from "./matching";
import { dedupePosts } from "./dedupe";
import { classifyTopicPosts, countThemes } from "./classify";
import { buildTrends, rankPainPoints } from "./trend";
import { generateBrief } from "./brief";

export interface Deps {
  store: Store;
  fetchers: Partial<Record<Source, SourceFetcher>>;
  /** null when Gemini is not configured: classification is skipped and the brief uses the fallback */
  callModel: ModelCaller | null;
  sendEmail?: (args: { weekStart: string; narrative: string; points: ThemeTrend[] }) => Promise<"sent" | "skipped">;
  now?: Date;
}

export interface RunSummary {
  weekStart: string;
  topics: number;
  fetched: number;
  newPosts: number;
  classified: number;
  pending: number;
  trends: number;
  usedFallbackNarrative: boolean;
  email: "sent" | "skipped" | "failed";
  warnings: string[];
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runDigest(deps: Deps): Promise<RunSummary> {
  const { store, fetchers, callModel } = deps;
  const window = windowFor(deps.now ?? new Date());
  const warnings: string[] = [];

  // 2. topics
  const topics = await store.getActiveTopics();
  const topicNames = Object.fromEntries(topics.map((t) => [t.id, t.name]));

  // 3. fetch every (topic, source) independently; one dead source never blocks the others
  const sources = Object.keys(fetchers) as Source[];
  const jobs = topics.flatMap((t) => sources.map((src) => ({ t, src })));
  const settled = await Promise.allSettled(jobs.map(({ t, src }) => fetchers[src]!(t, window)));
  const fetchedPosts: FetchedPost[] = [];
  settled.forEach((r, i) => {
    const { t, src } = jobs[i];
    if (r.status === "rejected") {
      warnings.push(`${src} fetch failed for "${t.name}": ${errMsg(r.reason)}`);
      return;
    }
    const topic = topics.find((x) => x.id === t.id) as Topic;
    for (const p of r.value) {
      const at = new Date(p.posted_at).getTime();
      if (at < window.start.getTime() || at >= window.end.getTime()) continue;
      if (!matchesKeywords(`${p.title} ${p.body}`, topic.keywords)) continue;
      fetchedPosts.push(p);
    }
  });

  // 4-5. dedupe against stored (source, source_id), then insert
  const existing = await store.getExistingKeys(fetchedPosts);
  const fresh = dedupePosts(fetchedPosts, existing);
  await store.insertPosts(fresh);

  // 6. classify everything in the window that is still unclassified (includes earlier misses)
  const unclassified = await store.getUnclassifiedPosts(window.start, window.end);
  let classified = 0;
  let pending = unclassified.length;
  if (unclassified.length && !callModel) {
    warnings.push("GEMINI not configured: classification skipped");
  } else if (unclassified.length && callModel) {
    pending = 0;
    for (const topic of topics) {
      const posts: StoredPost[] = unclassified.filter((p) => p.topic_id === topic.id);
      if (!posts.length) continue;
      try {
        const out = await classifyTopicPosts(topic, posts, callModel);
        await store.saveClassifications(out.results);
        classified += out.results.length;
        pending += out.missing.length;
        warnings.push(...out.warnings);
      } catch (e) {
        pending += posts.length;
        warnings.push(`classification aborted for "${topic.name}": ${errMsg(e)}`);
      }
    }
  }

  // 7-8. aggregate from stored classifications (idempotent: re-runs recompute, never accumulate)
  const classifiedPosts = await store.getClassifiedPosts(window.start, window.end);
  const current = countThemes(classifiedPosts, topics);
  const previous = await store.getAggregates(window.prevWeekStart);
  const trends = buildTrends(current, previous, topicNames);
  await store.saveAggregates(window.weekStart, current);

  // 9-10. narrative (grounded in aggregates only), save, email
  const points = rankPainPoints(trends, 40); // dashboard shows all; the email caps itself
  const { narrative, usedFallback } = await generateBrief(trends, { pending, warnings }, callModel);
  await store.saveBrief(window.weekStart, narrative, points);

  let email: RunSummary["email"] = "skipped";
  if (deps.sendEmail) {
    try {
      email = await deps.sendEmail({ weekStart: window.weekStart, narrative, points });
    } catch (e) {
      email = "failed";
      warnings.push(`email failed: ${errMsg(e)}`);
    }
  }

  return {
    weekStart: window.weekStart,
    topics: topics.length,
    fetched: fetchedPosts.length,
    newPosts: fresh.length,
    classified,
    pending,
    trends: trends.length,
    usedFallbackNarrative: usedFallback,
    email,
    warnings,
  };
}
