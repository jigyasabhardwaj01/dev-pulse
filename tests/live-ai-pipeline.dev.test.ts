import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { runDigest, type EmailArgs } from "@/lib/pipeline";
import { DEFAULT_MODEL, makeOpenRouterCaller } from "@/lib/openrouter";
import { problemsFrom } from "@/lib/insights-view";
import { MemoryStore, post } from "./helpers";

/*
 * Developer tool, skipped unless LIVE_AI is set and OPENROUTER_API_KEY is in the environment. REAL OpenRouter calls on ISOLATED FIXTURE
 * posts held in memory: nothing reaches the production database and no email is sent. It proves the model's classification output
 * survives the pipeline, the excerpt check and the ranking, using the same code the Friday run uses.
 */
const IN = (d: number) => `2026-10-0${d}T10:00:00Z`;
const FIX = [
  ["Our code review queue never empties", "PRs sit for days before anyone looks. Reviewers are overloaded and authors keep pinging for a first look."],
  ["Code review takes forever on a small team", "Every pull request waits two or three days for review, which blocks our releases."],
  ["Why is code review so slow at big companies?", "I wait days for a first review comment and context is lost by the time it arrives."],
  ["Automated code review bot leaves noisy comments", "The review bot posts dozens of false positives on every pull request and we ignore it now."],
  ["Code review bot false positives are exhausting", "Our code review tool flags correct code as wrong and nobody trusts its comments any more."],
  ["Best pizza places in Mumbai", "Looking for good pizza, code review is not relevant here."],
] as const;

describe("live AI on fixtures (dev tool)", () => {
  it.skipIf(!process.env.LIVE_AI || !process.env.OPENROUTER_API_KEY)("classifies, summarises and ranks fixture posts end to end", async () => {
    const stats: unknown[] = [];
    const call = makeOpenRouterCaller({ apiKey: process.env.OPENROUTER_API_KEY!, model: DEFAULT_MODEL, onResult: (s) => stats.push(s) });
    const store = new MemoryStore();
    const email = vi.fn(async (_a: EmailArgs) => ({ status: "sent" as const, messageId: "fixture" }));
    const s = await runDigest({
      store, now: new Date("2026-10-09T03:30:00Z"), callModel: call, sleep: async () => {}, sendEmail: email, invokedBy: "manual",
      fetchers: { hn: async () => FIX.map(([title, body], i) => post({ source_id: `f${i}`, posted_at: IN(3 + (i % 4)), title, body, url: `https://news.test/${i}`, author: `author${i}` })) },
    });
    const saved = await store.getBrief("2026-10-02");
    const a = saved!.analysis!;
    const { supported, early } = problemsFrom(a, "2026-10-02");
    const out = {
      model: DEFAULT_MODEL, status: s.status, classified: s.classified, usedFallbackSummary: s.usedFallbackNarrative, email: s.email,
      posts: store.posts.map((p) => ({ title: p.title.slice(0, 40), relevant: p.relevant, theme: p.theme, confidence: p.confidence, excerpt: p.excerpt?.slice(0, 60) ?? null, resolution: p.resolution })),
      narrative: saved!.narrative, ranked: supported.map((p) => ({ theme: p.theme, discussions: p.discussions, confidence: p.confidence.label, quote: p.evidence[0]?.excerpt?.slice(0, 60) })), early: early.map((p) => p.theme),
      calls: stats.length, providers: [...new Set((stats as { provider?: string }[]).map((x) => x.provider))], costUsd: (stats as { costUsd?: number }[]).reduce((t, x) => t + (x.costUsd ?? 0), 0),
    };
    if (process.env.LIVE_AI_OUT) writeFileSync(process.env.LIVE_AI_OUT, JSON.stringify(out, null, 2));
    expect(s.classified).toBeGreaterThan(0);
    expect(s.usedFallbackNarrative).toBe(false);
    expect(out.providers.every((p) => /google/i.test(String(p)))).toBe(true);
  }, 240_000);
});
