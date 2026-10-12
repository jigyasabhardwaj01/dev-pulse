import type { Classification, ModelCaller, Sentiment, StoredPost, Topic } from "./types";
import { OTHER_THEME } from "./types";
import { truncate } from "./text";

const SENTIMENTS: Sentiment[] = ["negative", "neutral", "positive"];
export const BATCH_SIZE = 15;

/** Closed vocabulary: anything that is not exactly (case-insensitively) a canonical theme becomes "other". */
export function enforceTheme(raw: unknown, canonical: string[]): string {
  if (typeof raw !== "string") return OTHER_THEME;
  const wanted = raw.trim().toLowerCase();
  const hit = canonical.find((t) => t.trim().toLowerCase() === wanted);
  return hit ?? OTHER_THEME;
}

/** Stack Overflow has an objective signal (is_answered); never ask the model to guess it. */
export function resolveUnresolved(post: Pick<StoredPost, "source" | "is_answered">, modelGuess: unknown): boolean {
  if (post.source === "stackoverflow" && post.is_answered !== null) return !post.is_answered;
  return modelGuess === true;
}

export function buildClassifyPrompt(topic: Topic, posts: StoredPost[]): string {
  const themes = topic.canonical_themes.map((t) => `- ${t}`).join("\n");
  const items = posts
    .map((p, i) => `[${i}] (${p.source}) ${truncate(p.title, 200)}\n${truncate(p.body, 600)}`)
    .join("\n\n");
  return `You classify developer-community posts about "${topic.name}".

For each post choose exactly ONE theme from this closed list, copied verbatim:
${themes}
If none fits, use "${OTHER_THEME}". Never invent a new theme.

Also give:
- sentiment: "negative", "neutral" or "positive" about the problem/tool discussed
- unresolved: true if the author describes a problem that has no satisfactory solution or existing tool yet, false if it is solved, answered or merely a discussion

Return a JSON array with one object per post: {"index": <number>, "theme": <string>, "sentiment": <string>, "unresolved": <boolean>}.

Posts:
${items}`;
}

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

export interface ClassifyOutcome {
  results: Classification[];
  missing: StoredPost[]; // left unclassified so a later run retries them
  warnings: string[];
}

export interface ClassifyOptions {
  /**
   * Called with each validated batch's results as soon as the batch completes, so finished work is
   * persisted before the next batch starts. If it throws, that batch is treated as not classified
   * (its posts stay eligible for retry) and the topic stops, since the store itself is failing.
   */
  onBatch?: (results: Classification[]) => Promise<void>;
  /** Return false to stop starting new batches (time budget). Remaining posts stay unclassified. */
  canStart?: () => boolean;
  /** Epoch ms after which a model call must not run past. */
  deadline?: number;
}

/** Classifies one topic's posts in batches. Failures and omissions degrade to "retry later". */
export async function classifyTopicPosts(
  topic: Topic,
  posts: StoredPost[],
  callModel: ModelCaller,
  opts: ClassifyOptions = {},
): Promise<ClassifyOutcome> {
  const outcome: ClassifyOutcome = { results: [], missing: [], warnings: [] };

  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    const batch = posts.slice(i, i + BATCH_SIZE);
    if (opts.canStart && !opts.canStart()) {
      const rest = posts.slice(i);
      outcome.missing.push(...rest);
      outcome.warnings.push(`time budget reached: ${rest.length} "${topic.name}" post(s) left for the next run`);
      break;
    }
    let parsed: unknown;
    try {
      parsed = parseJson(await callModel(buildClassifyPrompt(topic, batch), { json: true, deadline: opts.deadline }));
    } catch (err) {
      outcome.missing.push(...batch);
      outcome.warnings.push(`classification failed for "${topic.name}" batch of ${batch.length}: ${(err as Error).message}`);
      continue;
    }

    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { results?: unknown }).results)
        ? (parsed as { results: unknown[] }).results
        : null;
    if (!rows) {
      outcome.missing.push(...batch);
      outcome.warnings.push(`unexpected classification shape for "${topic.name}"`);
      continue;
    }

    const done = new Set<number>();
    const batchResults: Classification[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const idx = typeof r.index === "number" ? r.index : Number(r.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length || done.has(idx)) continue;
      const post = batch[idx];
      // Malformed records are NOT stored: a missing/blank theme, or a missing "unresolved" flag where the model is the
      // only source for it, would otherwise become a permanent (and wrong) classification. They stay retryable.
      if (typeof r.theme !== "string" || !r.theme.trim()) continue;
      if (post.source !== "stackoverflow" && typeof r.unresolved !== "boolean") continue;
      done.add(idx);
      batchResults.push({
        id: post.id,
        theme: enforceTheme(r.theme, topic.canonical_themes),
        sentiment: SENTIMENTS.includes(r.sentiment as Sentiment) ? (r.sentiment as Sentiment) : "neutral",
        unresolved: resolveUnresolved(post, r.unresolved),
      });
    }
    if (opts.onBatch && batchResults.length) {
      try {
        await opts.onBatch(batchResults);
      } catch (err) {
        outcome.missing.push(...batch);
        outcome.warnings.push(`could not save "${topic.name}" batch, will retry next run: ${(err as Error).message}`);
        const rest = posts.slice(i + BATCH_SIZE);
        outcome.missing.push(...rest);
        break; // the store is failing; do not burn more model calls
      }
    }
    outcome.results.push(...batchResults);
    const skipped = batch.filter((_, idx) => !done.has(idx));
    if (skipped.length) {
      outcome.missing.push(...skipped);
      outcome.warnings.push(`${skipped.length} post(s) missing or malformed in "${topic.name}" classification response; will retry`);
    }
  }
  return outcome;
}

/** Counts classified posts per (topic, theme). Themes no longer in the topic's vocabulary fold into "other". */
export function countThemes(
  posts: Pick<StoredPost, "topic_id" | "theme" | "unresolved">[],
  topics: Pick<Topic, "id" | "canonical_themes">[],
) {
  const vocab = new Map(topics.map((t) => [t.id, t.canonical_themes]));
  const counts = new Map<string, { topic_id: string; theme: string; count: number; unresolved: number }>();
  for (const p of posts) {
    if (!p.theme) continue;
    const theme = enforceTheme(p.theme, vocab.get(p.topic_id) ?? []);
    const k = `${p.topic_id}\u0000${theme}`;
    const c = counts.get(k) ?? { topic_id: p.topic_id, theme, count: 0, unresolved: 0 };
    c.count += 1;
    if (p.unresolved) c.unresolved += 1;
    counts.set(k, c);
  }
  return [...counts.values()];
}

/**
 * Counts classified posts per (topic, theme) exactly as they were classified, without folding themes that have since
 * left a topic's vocabulary. Used to bring an EARLIER period's counts up to date with posts classified late, so that
 * a later vocabulary edit never rewrites that period's history.
 */
export function countStoredThemes(posts: Pick<StoredPost, "topic_id" | "theme" | "unresolved">[]) {
  const counts = new Map<string, { topic_id: string; theme: string; count: number; unresolved: number }>();
  for (const p of posts) {
    if (!p.theme) continue;
    const k = `${p.topic_id}\u0000${p.theme}`;
    const c = counts.get(k) ?? { topic_id: p.topic_id, theme: p.theme, count: 0, unresolved: 0 };
    c.count += 1;
    if (p.unresolved) c.unresolved += 1;
    counts.set(k, c);
  }
  return [...counts.values()];
}
