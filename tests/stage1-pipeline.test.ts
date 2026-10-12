import { describe, expect, it, vi } from "vitest";
import { runDigest, type Deps } from "@/lib/pipeline";
import { BATCH_SIZE } from "@/lib/classify";
import { EMAIL_LEASE_MS } from "@/lib/store";
import { NOT_COMPARED_SENTENCE, FIRST_WEEK_SENTENCE } from "@/lib/brief";
import type { FetchResult, Topic } from "@/lib/types";
import { MemoryStore, TOPIC, post, seedPreviousReport } from "./helpers";

const NOW = new Date("2026-10-09T03:30:00Z"); // Friday 09:00 IST -> period 2026-10-02 .. 2026-10-09 IST
const WEEK = "2026-10-02";
const PREV_WEEK = "2026-09-25";
const PREV_START = "2026-09-24T18:30:00Z";

/** Classifier that answers every numbered post in the prompt; narrative prompts get a valid intro. */
const classifier = (theme = "False positives") => async (prompt: string) => {
  if (prompt.includes("intro line")) {
    // a well-behaved model obeys the mode-specific opening sentence it is given
    if (prompt.includes(FIRST_WEEK_SENTENCE)) return `${FIRST_WEEK_SENTENCE} Slow reviews led the week.`;
    if (prompt.includes(NOT_COMPARED_SENTENCE)) return `${NOT_COMPARED_SENTENCE} Slow reviews led the week.`;
    return "Slow reviews led the week. Nothing else stands out.";
  }
  const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
  return JSON.stringify(Array.from({ length: n }, (_, index) => ({ index, theme, sentiment: "negative", unresolved: true })));
};
const hnPosts = (...ids: string[]) => async () => ids.map((id) => post({ source_id: id }));
const result = (over: Partial<FetchResult> = {}): FetchResult => ({ posts: [], requests: 3, failed: 0, errors: [], truncated: false, ...over });
const base = (store: MemoryStore, over: Partial<Deps> = {}): Deps => ({
  store, now: NOW, callModel: classifier(), fetchers: { hn: hnPosts("a") }, ...over,
});
const sent = () => vi.fn(async () => "sent" as const);

describe("1. deterministic topic ordering and overlapping matches", () => {
  const mk = (id: string, created_at: string): Topic => ({ ...TOPIC, id, name: id, created_at });
  const A = mk("topic-a", "2026-01-01T00:00:00Z");
  const B = mk("topic-b", "2026-01-02T00:00:00Z");
  // the same upstream post matches BOTH topics' keywords
  const overlap = async (t: Topic) => [post({ source_id: "shared", topic_id: t.id, title: "code review is slow" })];

  it("assigns an overlapping post to the earliest-created topic, whatever order the database returns", async () => {
    for (const order of [[A, B], [B, A]]) {
      const store = new MemoryStore(order);
      await runDigest(base(store, { fetchers: { hn: overlap } }));
      expect(store.posts).toHaveLength(1);
      expect(store.posts[0].topic_id).toBe("topic-a");
    }
  });
  it("classifies topics in the same order every run", async () => {
    const seen: string[][] = [];
    for (const order of [[A, B], [B, A]]) {
      const store = new MemoryStore(order);
      const names: string[] = [];
      const model = async (p: string) => { names.push(p.match(/about "([^"]+)"/)?.[1] ?? ""); return classifier()(p); };
      await runDigest(base(store, { callModel: model, fetchers: { hn: async (t) => [post({ source_id: `p-${t.id}`, topic_id: t.id })] } }));
      seen.push(names.filter(Boolean));
    }
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]).toEqual(["topic-a", "topic-b"]);
  });
});

describe("2-3. scheduled email is sent at most once per reporting week, and a failure stays retryable", () => {
  it("two overlapping scheduled requests send exactly one email", async () => {
    const store = new MemoryStore();
    const send = vi.fn(async () => { await new Promise((r) => setTimeout(r, 15)); return "sent" as const; });
    const [a, b] = await Promise.all([
      runDigest(base(store, { sendEmail: send })),
      runDigest(base(store, { sendEmail: send })),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect([a.email, b.email].sort()).toEqual(["in_progress", "sent"]);
    expect(store.emails.get(WEEK)?.status).toBe("sent");
  });

  it("a later request after success sends nothing", async () => {
    const store = new MemoryStore();
    const send = sent();
    await runDigest(base(store, { sendEmail: send }));
    const again = await runDigest(base(store, { sendEmail: send }));
    expect(again.email).toBe("already_sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not record 'sent' until the provider has accepted the message", async () => {
    const store = new MemoryStore();
    let duringSend: string | null | undefined;
    const send = async () => { duringSend = store.emails.get(WEEK)?.status; return "sent" as const; };
    await runDigest(base(store, { sendEmail: send }));
    expect(duringSend).toBe("sending");
    expect(store.emails.get(WEEK)?.status).toBe("sent");
  });

  it("a failed send is recorded as failed and the next run retries and succeeds", async () => {
    const store = new MemoryStore();
    const bad = vi.fn(async () => { throw new Error("resend 500"); });
    const first = await runDigest(base(store, { sendEmail: bad }));
    expect(first.email).toBe("failed");
    expect(first.status).toBe("partial");
    expect(store.emails.get(WEEK)?.status).toBe("failed");

    const good = sent();
    const retry = await runDigest(base(store, { sendEmail: good }));
    expect(retry.email).toBe("sent");
    expect(good).toHaveBeenCalledTimes(1);
    expect(store.emails.get(WEEK)?.status).toBe("sent");
  });

  it("an unconfigured sender ('skipped') releases the claim instead of burning the week", async () => {
    const store = new MemoryStore();
    expect((await runDigest(base(store, { sendEmail: async () => "skipped" }))).email).toBe("skipped");
    expect(store.emails.get(WEEK)?.status).toBeNull();
    expect((await runDigest(base(store, { sendEmail: sent() }))).email).toBe("sent");
  });

  it("a crashed run's abandoned claim is retaken only after its lease expires", async () => {
    const store = new MemoryStore();
    await runDigest(base(store)); // creates the brief row
    store.emails.set(WEEK, { status: "sending", claimedAt: Date.now() });
    expect((await runDigest(base(store, { sendEmail: sent() }))).email).toBe("in_progress");
    store.emails.set(WEEK, { status: "sending", claimedAt: Date.now() - EMAIL_LEASE_MS - 1000 });
    expect((await runDigest(base(store, { sendEmail: sent() }))).email).toBe("sent");
  });

  it("fails closed: if delivery state cannot be checked, nothing is sent", async () => {
    const store = new MemoryStore();
    store.fail.claimEmail = new Error("db down");
    const send = sent();
    const s = await runDigest(base(store, { sendEmail: send }));
    expect(send).not.toHaveBeenCalled();
    expect(s.email).toBe("failed");
    expect(s.warnings.join()).toMatch(/could not check delivery state/);
  });

  it("an accepted email whose 'sent' mark cannot be saved is still reported as sent, with a warning", async () => {
    const store = new MemoryStore();
    store.fail.markEmailSent = new Error("db blip");
    const s = await runDigest(base(store, { sendEmail: sent() }));
    expect(s.email).toBe("sent");
    expect(s.warnings.join()).toMatch(/could not be recorded as sent/);
  });
});

describe("9. backfills never send scheduled emails", () => {
  it("does not call the sender and does not touch the email state, even if a sender is supplied", async () => {
    const store = new MemoryStore();
    const send = sent();
    const s = await runDigest(base(store, { sendEmail: send, trigger: "backfill" }));
    expect(send).not.toHaveBeenCalled();
    expect(s.email).toBe("not_attempted");
    expect(store.emails.size).toBe(0);
    expect(store.runs[0].trigger).toBe("backfill");
  });
});

describe("4. persisted source health: a failed fetch is not a successful empty fetch", () => {
  const fetchers = {
    hn: async () => result({ posts: [post({ source_id: "h1" })] }), // success with data
    stackoverflow: async () => result(), // success, zero relevant posts
    reddit: async () => result({ requests: 3, failed: 3, errors: ["HTTP 429 for www.reddit.com"] }), // every request failed
    github: async () => result({ requests: 1, failed: 0, truncated: true, posts: [post({ source: "github", source_id: "g1" })] }),
  };

  it("records ok / ok-with-zero / error distinctly, with counts", async () => {
    const store = new MemoryStore();
    const s = await runDigest(base(store, { fetchers }));
    const row = (src: string) => store.sourceFetches.find((r) => r.source === src)!;
    expect(row("hn")).toMatchObject({ status: "ok", fetched: 1, accepted: 1, inserted: 1, error: null });
    expect(row("stackoverflow")).toMatchObject({ status: "ok", fetched: 0, accepted: 0, inserted: 0, error: null });
    expect(row("reddit")).toMatchObject({ status: "error", fetched: 0, failed_requests: 3 });
    expect(row("reddit").error).toContain("429");
    expect(row("github")).toMatchObject({ status: "ok", truncated: true });
    expect(s.sources.reddit?.status).toBe("error");
    expect(s.sources.stackoverflow?.status).toBe("ok");
    expect(store.sourceFetches.every((r) => r.run_id === s.runId)).toBe(true);
  });

  it("one failed source does not erase the other sources' data", async () => {
    const store = new MemoryStore();
    const s = await runDigest(base(store, { fetchers }));
    expect(store.posts.map((p) => p.source).sort()).toEqual(["github", "hn"]);
    expect(s.newPosts).toBe(2);
    expect(store.briefs.size).toBe(1);
  });

  it("a thrown fetcher is recorded as an error row, and a partial failure as partial", async () => {
    const store = new MemoryStore();
    await runDigest(base(store, {
      fetchers: {
        hn: async () => { throw new Error("socket hang up"); },
        stackoverflow: async () => result({ requests: 4, failed: 1, errors: ["HTTP 400 for api.stackexchange.com"], posts: [post({ source: "stackoverflow", source_id: "q1", is_answered: false })] }),
      },
    }));
    expect(store.sourceFetches.find((r) => r.source === "hn")).toMatchObject({ status: "error", failed_requests: 1 });
    expect(store.sourceFetches.find((r) => r.source === "stackoverflow")).toMatchObject({ status: "partial", fetched: 1 });
  });

  it("the run is 'partial' when a source failed and 'succeeded' when everything worked", async () => {
    const s1 = await runDigest(base(new MemoryStore(), { fetchers }));
    expect(s1.status).toBe("partial");
    const s2 = await runDigest(base(new MemoryStore(), { fetchers: { hn: async () => result({ posts: [post()] }) } }));
    expect(s2.status).toBe("succeeded");
  });

  it("stores no secrets: keys, tokens and query strings are redacted from persisted errors", async () => {
    const store = new MemoryStore();
    await runDigest(base(store, {
      fetchers: { hn: async () => { throw new Error("https://x.test/a?key=SECRET123 failed Bearer tok.en-9"); } },
    }));
    const stored = JSON.stringify([store.sourceFetches, store.runs]);
    expect(stored).not.toMatch(/SECRET123|tok\.en/);
  });

  it("stores counts, never post bodies", async () => {
    const store = new MemoryStore();
    await runDigest(base(store, { fetchers: { hn: async () => result({ posts: [post({ source_id: "p", body: "VERY-LONG-PRIVATE-BODY".repeat(10) })] }) } }));
    expect(JSON.stringify([store.sourceFetches, store.runs])).not.toContain("VERY-LONG-PRIVATE-BODY");
  });
});

describe("5. pipeline run failure recording", () => {
  it("records a failed run with the error, flushes source health, and rethrows the original error", async () => {
    const store = new MemoryStore();
    store.fail.insertPosts = new Error("db write failed");
    await expect(runDigest(base(store))).rejects.toThrow("db write failed");
    const run = store.runs[0];
    expect(run.finish).toMatchObject({ status: "failed", error: "db write failed" });
    expect(store.sourceFetches.length).toBeGreaterThan(0); // what was learned before the failure is kept
  });

  it("records a failure that happens late (after posts were stored)", async () => {
    const store = new MemoryStore();
    store.fail.saveBrief = new Error("brief write failed");
    await expect(runDigest(base(store))).rejects.toThrow("brief write failed");
    expect(store.runs[0].finish?.status).toBe("failed");
    expect(store.posts.length).toBe(1); // ingested data is not rolled back
  });

  it("a monitoring failure never conceals the original pipeline error", async () => {
    const store = new MemoryStore();
    store.fail.insertPosts = new Error("db write failed");
    store.fail.startRun = new Error("monitoring is down");
    store.fail.finishRun = new Error("monitoring is down too");
    store.fail.recordSourceFetches = new Error("and so is this");
    await expect(runDigest(base(store))).rejects.toThrow("db write failed");
  });

  it("a monitoring failure does not fail an otherwise healthy run", async () => {
    const store = new MemoryStore();
    store.fail.startRun = new Error("monitoring is down");
    store.fail.finishRun = new Error("monitoring is down");
    const s = await runDigest(base(store));
    expect(s.runId).toBeNull();
    expect(store.briefs.size).toBe(1);
    expect(s.warnings.join()).toMatch(/monitoring: startRun failed/);
  });

  it("records the period, trigger and a completed run", async () => {
    const store = new MemoryStore();
    const s = await runDigest(base(store));
    expect(store.runs[0]).toMatchObject({ week_start: WEEK, trigger: "scheduled" });
    expect(store.runs[0].period_start.toISOString()).toBe("2026-10-01T18:30:00.000Z");
    expect(store.runs[0].period_end.toISOString()).toBe("2026-10-08T18:30:00.000Z");
    expect(store.runs[0].finish).toMatchObject({ status: "succeeded", new_posts: 1, classified_ok: 1, classification_failed: 0, used_fallback: false });
    expect(s.status).toBe("succeeded");
  });
});

describe("6-7. classification is saved per batch and failed batches are retried without duplicates", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

  it("persists each validated batch before starting the next", async () => {
    const store = new MemoryStore();
    const savesAtCall: number[] = [];
    const model = async (p: string) => { if (!p.includes("intro line")) savesAtCall.push(store.saves.length); return classifier()(p); };
    await runDigest(base(store, { callModel: model, fetchers: { hn: hnPosts(...ids(BATCH_SIZE * 2 + 1)) } }));
    expect(savesAtCall.slice(0, 3)).toEqual([0, 1, 2]); // before call k, k batches were already saved
    expect(store.saves).toEqual([BATCH_SIZE, BATCH_SIZE, 1]);
  });

  it("a later batch failing keeps the earlier batch's results and leaves only the failed batch for retry", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const model = async (p: string) => {
      if (p.includes("intro line")) return classifier()(p);
      if (++calls === 2) throw new Error("gemini 503");
      return classifier()(p);
    };
    const s = await runDigest(base(store, { callModel: model, fetchers: { hn: hnPosts(...ids(BATCH_SIZE + 1)) } }));
    expect(store.posts.filter((p) => p.theme !== null)).toHaveLength(BATCH_SIZE);
    expect(s).toMatchObject({ classified: BATCH_SIZE, pending: 1, status: "partial" });
    expect(store.runs[0].finish).toMatchObject({ classified_ok: BATCH_SIZE, classification_failed: 1 });
  });

  it("the retry classifies only what is still unclassified and never double-counts", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const flaky = async (p: string) => {
      if (p.includes("intro line")) return classifier()(p);
      if (++calls === 2) throw new Error("gemini 503");
      return classifier()(p);
    };
    const fetchers = { hn: hnPosts(...ids(BATCH_SIZE + 1)) };
    await runDigest(base(store, { callModel: flaky, fetchers }));

    const prompts: string[] = [];
    const retry = async (p: string) => { if (!p.includes("intro line")) prompts.push(p); return classifier()(p); };
    const second = await runDigest(base(store, { callModel: retry, fetchers }));

    expect(prompts).toHaveLength(1); // one model call, for the single leftover post
    expect((prompts[0].match(/^\[\d+\]/gm) ?? [])).toHaveLength(1);
    expect(second).toMatchObject({ classified: 1, pending: 0, newPosts: 0 });
    expect(store.posts).toHaveLength(BATCH_SIZE + 1); // no duplicate rows
    expect(store.posts.every((p) => p.theme === "False positives")).toBe(true);
    expect(store.aggregates.get(WEEK)![0].count).toBe(BATCH_SIZE + 1);
  });

  it("a partial response is handled per record: the answered posts are saved, the omitted one is retried", async () => {
    const store = new MemoryStore();
    const partial = async (p: string) => {
      if (p.includes("intro line")) return classifier()(p);
      return JSON.stringify([0, 1].map((index) => ({ index, theme: "False positives", sentiment: "negative", unresolved: false })));
    };
    const s = await runDigest(base(store, { callModel: partial, fetchers: { hn: hnPosts("a", "b", "c") } }));
    expect(s).toMatchObject({ classified: 2, pending: 1 });
    expect(store.posts.filter((p) => p.theme === null)).toHaveLength(1);
  });

  it("closed vocabulary still holds with incremental saves", async () => {
    const store = new MemoryStore();
    await runDigest(base(store, { callModel: classifier("Invented label"), fetchers: { hn: hnPosts("a") } }));
    expect(store.posts[0].theme).toBe("other");
  });

  it("if the store fails mid-run, no further model calls are wasted and the posts stay retryable", async () => {
    const store = new MemoryStore();
    store.fail.saveClassifications = new Error("db write failed");
    let modelCalls = 0;
    const model = async (p: string) => { if (!p.includes("intro line")) modelCalls++; return classifier()(p); };
    const s = await runDigest(base(store, { callModel: model, fetchers: { hn: hnPosts(...ids(BATCH_SIZE * 3)) } }));
    expect(modelCalls).toBe(1);
    expect(store.posts.every((p) => p.theme === null)).toBe(true);
    expect(s.pending).toBe(BATCH_SIZE * 3);
    expect(s.warnings.join()).toMatch(/could not save/);
  });

  it("stops starting new batches when the time budget is reached, and leaves time to finish the run", async () => {
    const store = new MemoryStore();
    let t = 0;
    const model = async (p: string) => { if (!p.includes("intro line")) t += 6_000; return classifier()(p); };
    // budget 100 s, 90 s reserved for finishing => classification may start new batches only before t = 10 s
    const s = await runDigest(base(store, { callModel: model, clock: () => t, budgetMs: 100_000, fetchers: { hn: hnPosts(...ids(BATCH_SIZE * 3)) } }));
    expect(store.saves).toEqual([BATCH_SIZE, BATCH_SIZE]); // third batch was not started
    expect(s.pending).toBe(BATCH_SIZE);
    expect(s.warnings.join()).toMatch(/time budget reached/);
    expect(store.briefs.size).toBe(1); // aggregation, brief and run status still completed
    expect(store.runs[0].finish?.status).toBe("partial");
  });
});

describe("10. trends are qualified when source coverage differs", () => {
  const prevRows = [{ topic_id: "t1", theme: "False positives", count: 2, unresolved: 0 }];
  const fetchers = { hn: hnPosts("a", "b", "c", "d"), github: async () => result({ posts: [post({ source: "github", source_id: "g1" })] }) };

  it("a source present only in the current period yields no trend arrows, but keeps every count", async () => {
    const store = new MemoryStore();
    seedPreviousReport(store, { weekStart: PREV_WEEK, periodStart: PREV_START, rows: prevRows, sources: { hn: { status: "ok", posts: 2 } } });
    const s = await runDigest(base(store, { fetchers }));
    expect(s.comparison.state).toBe("incomparable");
    expect(s.comparison.reasons.join()).toMatch(/GitHub was tracked in only one/);
    const points = store.briefs.get(WEEK)!.points;
    expect(points.every((p) => p.direction === "unavailable" && p.pct === null)).toBe(true);
    expect(points[0].count).toBe(5); // totals preserved
    expect(store.aggregates.get(WEEK)![0].count).toBe(5);
    expect(store.briefs.get(WEEK)!.narrative).toContain(NOT_COMPARED_SENTENCE);
    expect(store.reports.get(WEEK)!.coverage.comparison?.state).toBe("incomparable");
    expect(store.reports.get(WEEK)!.coverage.sources.github).toEqual({ status: "ok", posts: 1 });
  });

  it("a source that failed this week (it succeeded last week) is not read as a decline", async () => {
    const store = new MemoryStore();
    seedPreviousReport(store, {
      weekStart: PREV_WEEK, periodStart: PREV_START, rows: prevRows,
      sources: { hn: { status: "ok", posts: 2 }, github: { status: "ok", posts: 9 } },
    });
    const s = await runDigest(base(store, {
      fetchers: { hn: hnPosts("a", "b"), github: async () => result({ requests: 1, failed: 1, errors: ["HTTP 403 for api.github.com"] }) },
    }));
    expect(s.comparison.state).toBe("incomparable");
    expect(s.sources.github?.status).toBe("error"); // an error, not a confirmed zero
    expect(store.briefs.get(WEEK)!.points.length).toBeGreaterThan(0);
    expect(store.briefs.get(WEEK)!.points.every((p) => p.direction === "unavailable")).toBe(true);
  });

  it("with identical, healthy coverage the existing trend maths applies unchanged", async () => {
    const store = new MemoryStore();
    seedPreviousReport(store, { weekStart: PREV_WEEK, periodStart: PREV_START, rows: prevRows, sources: { hn: { status: "ok", posts: 2 } } });
    const s = await runDigest(base(store, { fetchers: { hn: hnPosts("a", "b", "c", "d") } }));
    expect(s.comparison.state).toBe("comparable");
    expect(store.briefs.get(WEEK)!.points[0]).toMatchObject({ count: 4, previous: 2, direction: "up", pct: 100 });
  });

  it("an earlier report on the old (UTC-window) convention is never used as a baseline", async () => {
    const store = new MemoryStore();
    store.aggregates.set(PREV_WEEK, prevRows); // aggregates exist, but no report_periods record
    const s = await runDigest(base(store));
    expect(s.comparison.state).toBe("no_prior");
    expect(store.briefs.get(WEEK)!.points.length).toBeGreaterThan(0);
    expect(store.briefs.get(WEEK)!.points.every((p) => p.previous === 0 && p.direction === "unavailable")).toBe(true);
    expect(store.briefs.get(WEEK)!.narrative).toContain(FIRST_WEEK_SENTENCE);
  });

  it("a report whose period does not line up exactly is not a baseline", async () => {
    const store = new MemoryStore();
    seedPreviousReport(store, { weekStart: PREV_WEEK, periodStart: "2026-09-25T00:00:00Z", rows: prevRows, sources: { hn: { status: "ok", posts: 2 } } });
    expect((await runDigest(base(store))).comparison.state).toBe("no_prior");
  });

  it("a rerun that loses a source does not discredit the coverage already recorded for the period", async () => {
    const store = new MemoryStore();
    seedPreviousReport(store, { weekStart: PREV_WEEK, periodStart: PREV_START, rows: prevRows, sources: { hn: { status: "ok", posts: 2 }, github: { status: "ok", posts: 1 } } });
    await runDigest(base(store, { fetchers }));
    const rerun = await runDigest(base(store, { fetchers: { hn: hnPosts("a", "b", "c", "d"), github: async () => result({ requests: 1, failed: 1, errors: ["HTTP 403"] }) } }));
    expect(rerun.sources.github?.status).toBe("ok"); // GitHub data from the first run is still stored
    expect(rerun.comparison.state).toBe("comparable");
  });

  it("the AI narrative is told not to describe movement when the comparison is unfair", async () => {
    const store = new MemoryStore();
    seedPreviousReport(store, { weekStart: PREV_WEEK, periodStart: PREV_START, rows: prevRows, sources: { hn: { status: "ok", posts: 2 } } });
    const prompts: string[] = [];
    const model = async (p: string) => { if (p.includes("intro line")) prompts.push(p); return classifier()(p); };
    await runDigest(base(store, { callModel: model, fetchers }));
    expect(prompts[0]).toContain(NOT_COMPARED_SENTENCE);
    expect(prompts[0]).not.toContain("biggest_mover");
    expect(prompts[0]).not.toContain("pain_points_new_this_week");
  });
});
