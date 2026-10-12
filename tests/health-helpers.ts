import type { RunSourceView, RunView } from "@/lib/report-model";

export const NOW = new Date("2026-10-13T06:00:00Z");

/** A source in one run. Defaults to a clean fetch with records. */
export const src = (source: string, over: Partial<RunSourceView> = {}): RunSourceView => ({
  source, status: "ok", fetched: 10, accepted: 8, inserted: 5, truncated: false, reason: null,
  topics: { total: 3, ok: 3, partial: 0, error: 0 }, requests: 3, failedRequests: 0, requestsKnown: true, maxDurationMs: 500, ...over,
});

export const allClean = (): RunSourceView[] => ["hn", "stackoverflow", "reddit", "github"].map((s) => src(s));

export const run = (over: Partial<RunView> = {}): RunView => ({
  id: "r1", weekStart: "2026-10-02", periodLabel: "Fri 2 Oct – Thu 8 Oct 2026 (IST)", trigger: "scheduled", status: "succeeded",
  startedAt: "2026-10-13T05:00:00Z", finishedAt: "2026-10-13T05:02:00Z", durationSec: 120,
  emailStatus: "sent", usedFallback: false, problem: null, stuck: false, classified: 40, unclassified: 0, newPosts: 43, fetchedTotal: 120, warningCount: 0, diagnostics: [],
  sources: allClean(), ...over,
});

export const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
