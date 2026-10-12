import { vi } from "vitest";
import { FIRST_WEEK_SENTENCE, NOT_COMPARED_SENTENCE } from "@/lib/brief";
import type { Deps } from "@/lib/pipeline";
import type { FetchResult } from "@/lib/types";
import { MemoryStore, post } from "./helpers";

/** Period 1: Fri 2026-10-02 00:00 IST .. Fri 2026-10-09 00:00 IST. Period 2 is the following week. */
export const NOW_P1 = new Date("2026-10-09T03:30:00Z");
export const NOW_P2 = new Date("2026-10-16T03:30:00Z");
export const P1 = "2026-10-02";
export const P2 = "2026-10-09";
export const IN_P1 = "2026-10-05T10:00:00Z";
export const IN_P2 = "2026-10-12T10:00:00Z";

/** A well-behaved model: answers every numbered post, and obeys the mode-specific opening sentence of the brief. */
export const goodModel = (theme = "False positives") => async (prompt: string) => {
  if (prompt.includes("intro line")) {
    if (prompt.includes(FIRST_WEEK_SENTENCE)) return `${FIRST_WEEK_SENTENCE} Slow reviews led the week.`;
    if (prompt.includes(NOT_COMPARED_SENTENCE)) return `${NOT_COMPARED_SENTENCE} Slow reviews led the week.`;
    return "Slow reviews led the week. Nothing else stands out.";
  }
  const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
  return JSON.stringify(Array.from({ length: n }, (_, index) => ({ index, theme, sentiment: "negative", unresolved: true })));
};

/** Fails classification calls (as during an outage) but lets the brief fall back. */
export const downModel = async () => { throw new Error("gemini 503"); };

export const result = (over: Partial<FetchResult> = {}): FetchResult => ({ posts: [], requests: 3, failed: 0, errors: [], truncated: false, ...over });

export const hnAt = (...specs: [id: string, postedAt: string][]) => async () =>
  specs.map(([id, at]) => post({ source_id: id, posted_at: at }));

export const deps = (store: MemoryStore, over: Partial<Deps> = {}): Deps => ({
  store, now: NOW_P1, callModel: goodModel(), fetchers: { hn: hnAt(["a", IN_P1]) }, ...over,
});

export const okSend = () => vi.fn(async () => "sent" as const);
export const promptPostCount = (p: string) => (p.match(/^\[\d+\]/gm) ?? []).length;
