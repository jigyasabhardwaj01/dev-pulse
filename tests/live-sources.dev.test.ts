import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";
import { makeHnFetcher } from "@/lib/sources/hn";
import { makeSoFetcher } from "@/lib/sources/stackoverflow";
import { makeRedditFetcher } from "@/lib/sources/reddit";
import { makeGithubFetcher } from "@/lib/sources/github";
import { periodFor } from "@/lib/week";
import { matchesKeywords } from "@/lib/matching";
import type { FetchResult, Topic } from "@/lib/types";

/** Developer tool, skipped unless LIVE_SOURCES is set. Calls the real public APIs once and records honest per-source health. */
const base = { category: null, active: true } as const;
const TOPICS: Topic[] = [
  { ...base, id: "code-review", name: "Code review", keywords: ["code review", "pull request review", "automated code review", "false positive", "review bot"], canonical_themes: [], tags: ["code-review"] },
  { ...base, id: "cicd", name: "CI/CD automation", keywords: ["github actions", "ci/cd", "continuous integration", "flaky tests", "ci pipeline"], canonical_themes: [], tags: ["github-actions", "continuous-integration"] },
];

describe("live source health (dev tool)", () => {
  it.skipIf(!process.env.LIVE_SOURCES)("probes every source", async () => {
    const period = periodFor(new Date());
    const out: Record<string, unknown> = { period: { start: period.start.toISOString(), end: period.end.toISOString() }, results: [] };
    const run = async (source: string, topic: Topic, f: (t: Topic, w: typeof period) => Promise<FetchResult | unknown>) => {
      const t0 = Date.now();
      try {
        const r = (await f(topic, period)) as FetchResult;
        const inWindow = r.posts.filter((p) => { const t = new Date(p.posted_at).getTime(); return t >= period.start.getTime() && t < period.end.getTime(); });
        const relevant = inWindow.filter((p) => matchesKeywords(`${p.title} ${p.body}`, topic.keywords));
        (out.results as unknown[]).push({
          source, topic: topic.name, status: r.requests > 0 && r.failed >= r.requests ? "ERROR" : r.failed > 0 ? "PARTIAL" : "ok",
          requests: r.requests, failed: r.failed, errors: r.errors, truncated: r.truncated,
          returned: r.posts.length, inPeriod: inWindow.length, relevant: relevant.length, ms: Date.now() - t0,
          days: [...new Set(relevant.map((p) => p.posted_at.slice(0, 10)))].sort(),
        });
      } catch (e) {
        (out.results as unknown[]).push({ source, topic: topic.name, status: "THREW", error: (e as Error).message, ms: Date.now() - t0 });
      }
    };
    for (const t of TOPICS) {
      await run("hn", t, makeHnFetcher());
      await run("stackoverflow", t, makeSoFetcher(fetch, process.env.STACKEXCHANGE_KEY));
      await run("github", t, makeGithubFetcher(fetch, process.env.GITHUB_TOKEN));
    }
    await run("reddit", TOPICS[0], makeRedditFetcher());
    writeFileSync(process.env.LIVE_OUT!, JSON.stringify(out, null, 2));
  }, 240_000);
});
