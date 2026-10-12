import { describe, expect, it, vi } from "vitest";
import { runDigest, type Deps, type EmailArgs } from "@/lib/pipeline";
import { FIRST_WEEK_SENTENCE, NOT_COMPARED_SENTENCE } from "@/lib/brief";
import { LATE_GRACE_MS, OVERLAP_MS } from "@/lib/checkpoints";
import type { FetchResult, FetchWindow, Topic } from "@/lib/types";
import type { WatchTerm } from "@/lib/watchlist";
import { MemoryStore, TOPIC, post } from "./helpers";

const NOW = new Date("2026-10-09T03:30:00Z"); // Fri 09:00 IST; period 2026-10-02 .. 2026-10-09
const WEEK = "2026-10-02";
const IN = "2026-10-05T10:00:00Z";
const model = (over: Record<string, unknown> = {}) => async (prompt: string) => {
  if (prompt.includes("intro line")) {
    if (prompt.includes(FIRST_WEEK_SENTENCE)) return `${FIRST_WEEK_SENTENCE} Slow reviews led the week.`;
    if (prompt.includes(NOT_COMPARED_SENTENCE)) return `${NOT_COMPARED_SENTENCE} Slow reviews led the week.`;
    return "Slow reviews led the week. Nothing else stands out.";
  }
  const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
  return JSON.stringify(Array.from({ length: n }, (_, index) => ({ index, relevant: true, theme: "False positives", problem: "Noisy bot comments.", kind: "existing_problem", resolution: "open", confidence: 0.85, excerpt: "code review", reason: "r", sentiment: "negative", ...over })));
};
const ok = (...ids: string[]) => async () => ids.map((id) => post({ source_id: id, posted_at: IN, title: `code review thread ${id} is long enough` }));
const result = (over: Partial<FetchResult> = {}): FetchResult => ({ posts: [], requests: 3, failed: 0, errors: [], truncated: false, ...over });
const base = (store: MemoryStore, over: Partial<Deps> = {}): Deps => ({ store, now: NOW, callModel: model(), fetchers: { hn: ok("a") }, sleep: async () => {}, ...over });
const T = (over: Partial<WatchTerm> & Pick<WatchTerm, "term">): WatchTerm => ({ id: `w-${over.term}`, topic_id: "t1", kind: "include", status: "active", applies_to: null, ...over });
const sent = () => vi.fn(async (_a: EmailArgs) => ({ status: "sent" as const, messageId: "m1" }));

describe("the watchlist drives collection and filtering", () => {
  it("queries only the ACTIVE include terms: paused terms are not sent to the sources", async () => {
    const store = new MemoryStore();
    store.watch.terms = [T({ term: "code review" }), T({ term: "false positive", status: "paused" })];
    const seen: Topic[] = [];
    await runDigest(base(store, { fetchers: { hn: async (t) => { seen.push(t); return []; } } }));
    expect(seen[0].keywords).toEqual(["code review"]);
  });
  it("a topic with no watch terms uses its legacy keywords (existing installations keep working)", async () => {
    const seen: Topic[] = [];
    await runDigest(base(new MemoryStore(), { fetchers: { hn: async (t) => { seen.push(t); return []; } } }));
    expect(seen[0].keywords).toEqual(TOPIC.keywords);
  });
  it("applies exclusions after collection, records which terms matched, and reports how many posts were removed", async () => {
    const store = new MemoryStore();
    store.watch.terms = [T({ term: "code review" }), T({ term: "job posting", kind: "exclude" })];
    const fetch = async () => [
      post({ source_id: "keep", posted_at: IN, title: "code review is slow here today" }),
      post({ source_id: "drop", posted_at: IN, title: "Job posting: code review engineer wanted" }),
    ];
    const s = await runDigest(base(store, { fetchers: { hn: fetch } }));
    expect(store.posts.map((p) => p.source_id)).toEqual(["keep"]);
    expect(store.posts[0]).toMatchObject({ matched_terms: ["code review"], flags: expect.arrayContaining(["title_match"]) });
    expect(s.diagnostics.find((d) => d.code === "WATCH_FILTERED")).toMatchObject({ severity: "info", detail: { excluded: 1, belowSensitivity: 0 } });
  });
  it("the sensitivity mode changes which posts are collected from the very same source data", async () => {
    const fetch = async () => [
      post({ source_id: "title", posted_at: IN, title: "code review is painful today ok" }),
      post({ source_id: "bodyonly", posted_at: IN, title: "Weekly open discussion thread", body: "we do code review sometimes" }),
    ];
    const run = async (mode: "strict" | "balanced" | "early") => {
      const store = new MemoryStore();
      store.watch = { sensitivity: mode, terms: [T({ term: "code review" })] };
      await runDigest(base(store, { fetchers: { hn: fetch } }));
      return store.posts.map((p) => p.source_id).sort();
    };
    expect(await run("strict")).toEqual(["title"]);
    expect(await run("balanced")).toEqual(["bodyonly", "title"]);
    expect(await run("early")).toEqual(["bodyonly", "title"]);
  });
  it("early discovery admits plural variants that the other modes reject, even though the adapters pre-filter", async () => {
    const fetch = async () => [post({ source_id: "plural", posted_at: IN, title: "our code reviews take forever to finish" })];
    const collected = async (mode: "balanced" | "early") => { const s = new MemoryStore(); s.watch = { sensitivity: mode, terms: [T({ term: "code review" })] }; await runDigest(base(s, { fetchers: { hn: fetch } })); return s.posts.length; };
    expect(await collected("balanced")).toBe(0);
    expect(await collected("early")).toBe(1);
  });
  it("the model is told the sensitivity mode, so each mode really gives a different instruction", async () => {
    const prompts: string[] = [];
    for (const mode of ["strict", "balanced", "early"] as const) {
      const store = new MemoryStore();
      store.watch = { sensitivity: mode, terms: [T({ term: "code review" })] };
      await runDigest(base(store, { callModel: async (p) => { if (p.includes("SENSITIVITY")) prompts.push(p.match(/SENSITIVITY: [A-Z ]+/)![0]); return model()(p); } }));
    }
    expect(prompts).toEqual(["SENSITIVITY: STRICT", "SENSITIVITY: BALANCED", "SENSITIVITY: EARLY DISCOVERY"]);
  });
});

describe("reproducibility: the configuration is sealed with the run and the report", () => {
  it("stores the effective watchlist and sensitivity on the run and on the saved report", async () => {
    const store = new MemoryStore();
    store.watch = { sensitivity: "strict", terms: [T({ term: "code review" }), T({ term: "false positive", status: "paused" }), T({ term: "hiring", kind: "exclude" })] };
    await runDigest(base(store));
    const snap = store.briefs.get(WEEK)!.configSnapshot!;
    expect(snap).toMatchObject({ sensitivity: "strict", topics: [{ id: "t1", includes: ["code review"], paused: ["false positive"], excludes: [{ term: "hiring", appliesTo: null }] }] });
    expect(store.runs[0].finish!.config_snapshot).toEqual(snap);
  });
  it("changing the watchlist after delivery does NOT change what the delivered report claims to have monitored", async () => {
    const store = new MemoryStore();
    store.watch = { sensitivity: "balanced", terms: [T({ term: "code review" })] };
    await runDigest(base(store, { sendEmail: sent() }));
    const sealed = JSON.stringify(store.briefs.get(WEEK));
    store.watch = { sensitivity: "early", terms: [T({ term: "code review" }), T({ term: "brand new term" })] };
    const again = await runDigest(base(store, { sendEmail: sent() }));
    expect(again.brief.action).toBe("keep");
    expect(JSON.stringify(store.briefs.get(WEEK))).toBe(sealed);
    expect(store.briefs.get(WEEK)!.configSnapshot!.sensitivity).toBe("balanced");
    expect(store.runs[1].finish!.config_snapshot!.sensitivity).toBe("early"); // the NEW run records what IT used
  });
  it("before delivery, a changed configuration is a changed report: it becomes a new version with the new snapshot", async () => {
    const store = new MemoryStore();
    store.watch = { sensitivity: "balanced", terms: [T({ term: "code review" })] };
    await runDigest(base(store));
    store.watch = { sensitivity: "strict", terms: [T({ term: "code review" })] };
    const again = await runDigest(base(store));
    expect(again.brief).toMatchObject({ action: "replace", version: 2 });
    expect(store.briefs.get(WEEK)!.configSnapshot!.sensitivity).toBe("strict");
  });
  it("an unchanged configuration does not bump the version (the capture time is not part of the comparison)", async () => {
    const store = new MemoryStore();
    await runDigest(base(store));
    const again = await runDigest(base(store, { now: new Date(NOW.getTime() + 3_600_000) }));
    expect(again.brief.action).toBe("unchanged");
    expect(store.briefs.get(WEEK)!.version).toBe(1);
  });
});

describe("checkpoints: collection is incremental and recoverable", () => {
  const key = "hn|t1";
  it("commits the window only after a complete, uncapped, successful fetch whose data was stored", async () => {
    const store = new MemoryStore();
    await runDigest(base(store));
    expect(store.checkpoints.get(key)).toMatchObject({ last_status: "ok", covered_from: "2026-10-01T18:30:00.000Z", committed_through: "2026-10-08T18:30:00.000Z" });
  });
  it("a failing source records the attempt but commits nothing, and the next run fetches the SAME window in full", async () => {
    const store = new MemoryStore();
    const windows: FetchWindow[] = [];
    const flaky = async (_t: Topic, w: FetchWindow) => { windows.push(w); return result({ requests: 3, failed: 3, errors: ["HTTP 500 for x"] }); };
    await runDigest(base(store, { fetchers: { hn: flaky } }));
    expect(store.checkpoints.get(key)).toMatchObject({ last_status: "error", last_success_at: null, committed_through: null });
    await runDigest(base(store, { fetchers: { hn: flaky } }));
    expect(windows[1].start).toEqual(windows[0].start);
    expect(windows[1].end).toEqual(windows[0].end);
  });
  it("a partial or capped fetch does not advance the commit; a capped one still counts as a success", async () => {
    const partial = new MemoryStore();
    await runDigest(base(partial, { fetchers: { hn: async () => result({ requests: 3, failed: 1, errors: ["HTTP 500 for x"], posts: [post({ posted_at: IN })] }) } }));
    expect(partial.checkpoints.get(key)).toMatchObject({ last_status: "partial", committed_through: null });
    const capped = new MemoryStore();
    await runDigest(base(capped, { fetchers: { hn: async () => result({ truncated: true, posts: [post({ posted_at: IN })] }) } }));
    expect(capped.checkpoints.get(key)).toMatchObject({ last_status: "ok", committed_through: null });
    expect(capped.checkpoints.get(key)!.last_success_at).not.toBeNull();
  });
  it("an interrupted run (storing the posts failed) commits NOTHING, so no data can be skipped later", async () => {
    const store = new MemoryStore();
    store.fail.insertPosts = new Error("db down");
    await expect(runDigest(base(store))).rejects.toThrow("db down");
    expect(store.checkpoints.size).toBe(0);
    store.fail.insertPosts = undefined;
    const windows: FetchWindow[] = [];
    await runDigest(base(store, { fetchers: { hn: async (_t, w) => { windows.push(w); return [post({ posted_at: IN })]; } } }));
    expect(windows).toHaveLength(1);            // fetched again, in full
    expect(store.posts).toHaveLength(1);
  });
  it("a checkpoint that cannot be saved does not fail the run, and the next run simply fetches again", async () => {
    const store = new MemoryStore();
    store.fail.saveCheckpoints = new Error("db blip");
    const s = await runDigest(base(store));
    expect(s.status).not.toBe("failed");
    expect(s.diagnostics.map((d) => d.code)).toContain("MONITORING_FAILED");
    expect(store.checkpoints.size).toBe(0);
  });
  it("unreadable checkpoints fall back to fetching everything (safe), with a diagnostic", async () => {
    const store = new MemoryStore();
    store.fail.getCheckpoints = new Error("db blip");
    const s = await runDigest(base(store));
    expect(s.newPosts).toBe(1);
    expect(s.diagnostics.find((d) => d.code === "MONITORING_FAILED")!.message).toContain("fetched in full");
  });
  it("a period that was completely fetched long after it closed is skipped, and the skip is visible", async () => {
    const store = new MemoryStore();
    const fetch = vi.fn(async () => [post({ posted_at: IN })]);
    await runDigest(base(store, { fetchers: { hn: fetch }, now: new Date(NOW.getTime() + LATE_GRACE_MS + 1000) }));
    const again = await runDigest(base(store, { fetchers: { hn: fetch }, now: new Date(NOW.getTime() + LATE_GRACE_MS + 2000) }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(again.diagnostics.find((d) => d.code === "SOURCE_SKIPPED")).toMatchObject({ severity: "info", source: "hn" });
    expect(again.sources.hn?.status).toBe("ok");
  });
  it("a fresh rerun inside the first day is NOT skipped: late-arriving posts are still collected", async () => {
    const store = new MemoryStore();
    await runDigest(base(store, { fetchers: { hn: ok("a") } }));
    const again = await runDigest(base(store, { fetchers: { hn: ok("a", "late") } }));
    expect(again.newPosts).toBe(1);
    expect(store.posts.map((p) => p.source_id).sort()).toEqual(["a", "late"]);
  });
  it("resumes from the committed point with an overlap, never earlier than the period start", async () => {
    const store = new MemoryStore();
    const through = new Date("2026-10-05T00:00:00Z");
    store.checkpoints.set(key, { source: "hn", topic_id: "t1", last_attempt_at: NOW.toISOString(), last_success_at: NOW.toISOString(), covered_from: "2026-10-01T18:30:00.000Z", committed_through: through.toISOString(), last_status: "ok" });
    let seen: FetchWindow | null = null;
    await runDigest(base(store, { fetchers: { hn: async (_t, w) => { seen = w; return []; } } }));
    expect(seen!.start.toISOString()).toBe(new Date(through.getTime() - OVERLAP_MS).toISOString());
    expect(seen!.end.toISOString()).toBe("2026-10-08T18:30:00.000Z");
  });
  it("posts that arrive twice (the overlap) are stored once", async () => {
    const store = new MemoryStore();
    store.checkpoints.set(key, { source: "hn", topic_id: "t1", last_attempt_at: null, last_success_at: null, covered_from: "2026-10-01T18:30:00.000Z", committed_through: "2026-10-05T00:00:00.000Z", last_status: "ok" });
    await runDigest(base(store, { fetchers: { hn: ok("dup", "dup") } }));
    await runDigest(base(store, { fetchers: { hn: ok("dup") } }));
    expect(store.posts).toHaveLength(1);
  });
  it("each source and topic has its own checkpoint, so one failing source never holds back the others", async () => {
    const store = new MemoryStore();
    await runDigest(base(store, { fetchers: { hn: ok("a"), reddit: async () => result({ requests: 1, failed: 1, errors: ["HTTP 429 for x"] }) } }));
    expect(store.checkpoints.get("hn|t1")!.committed_through).not.toBeNull();
    expect(store.checkpoints.get("reddit|t1")).toMatchObject({ last_status: "error", committed_through: null });
  });
});

describe("classification v2 is stored with the evidence it rests on", () => {
  it("persists confidence, problem, excerpt, kind, resolution and the version on each classified post", async () => {
    const store = new MemoryStore();
    await runDigest(base(store));
    expect(store.posts[0]).toMatchObject({ theme: "False positives", relevant: true, confidence: 0.85, problem: "Noisy bot comments.", excerpt: "code review", post_kind: "existing_problem", resolution: "open", unresolved: true, classification_version: 2 });
  });
  it("noise is stored as 'other' and kept out of the pain-point analysis", async () => {
    const store = new MemoryStore();
    const s = await runDigest(base(store, { callModel: model({ relevant: false }) }));
    expect(store.posts[0]).toMatchObject({ theme: "other", relevant: false });
    expect(store.briefs.get(WEEK)!.analysis!.painPoints).toEqual([]);
    expect(s.classified).toBe(1); // it WAS classified (so it is not asked again)
  });
  it("records why posts could not be classified, with a stable code", async () => {
    const store = new MemoryStore();
    await runDigest(base(store, { callModel: async (p) => (p.includes("intro line") ? "Slow reviews led the week. Nothing else stands out." : "this is not json") }));
    expect(store.posts[0].theme).toBeNull();
    expect([...store.classificationFailures.values()]).toEqual(["model_error"]);
  });
  it("a successfully classified post is never sent to the model again", async () => {
    const store = new MemoryStore();
    await runDigest(base(store));
    const calls: string[] = [];
    await runDigest(base(store, { callModel: async (p) => { calls.push(p); return model()(p); } }));
    expect(calls.filter((p) => p.includes("untrusted content"))).toEqual([]);
  });
  it("strict mode drops low-confidence results to noise, balanced keeps them, and early labels them", async () => {
    const run = async (mode: "strict" | "balanced" | "early") => {
      const store = new MemoryStore();
      store.watch = { sensitivity: mode, terms: [T({ term: "code review" })] };
      await runDigest(base(store, { callModel: model({ confidence: 0.4 }) }));
      return store.posts[0];
    };
    expect(await run("strict")).toMatchObject({ theme: "other", relevant: false });
    expect(await run("balanced")).toMatchObject({ theme: "other", relevant: false }); // 0.4 is under balanced's 0.5
    expect(await run("early")).toMatchObject({ theme: "False positives", relevant: true });
  });
});

describe("the weekly analysis is sealed with the report", () => {
  const evidenceFetch = (n: number) => async () => Array.from({ length: n }, (_, i) => post({ source: i % 2 ? "hn" : "reddit", source_id: `e${i}`, posted_at: IN, title: `code review frustration number ${i} in this thread`, author: `dev${i}` }));
  it("saves aggregation, a ranked top list with evidence links, and an unavailable baseline when history is short", async () => {
    const store = new MemoryStore();
    const s = await runDigest(base(store, { fetchers: { hn: evidenceFetch(4) } }));
    const a = store.briefs.get(WEEK)!.analysis!;
    expect(a.totals).toMatchObject({ relevantDiscussions: 4, painPoints: 1 });
    expect(a.top).toHaveLength(1);
    expect(a.painPoints[0].links.length).toBeGreaterThan(0);
    expect(a.baseline).toMatchObject({ available: false });
    expect(a.baseline.reason).toContain("Only 0 of the 4");
    expect(s.brief.action).toBe("create");
  });
  it("a delivered report's analysis is frozen even when late data changes the live counts", async () => {
    const store = new MemoryStore();
    await runDigest(base(store, { fetchers: { hn: evidenceFetch(3) }, sendEmail: sent() }));
    const sealed = JSON.stringify(store.briefs.get(WEEK)!.analysis);
    await runDigest(base(store, { fetchers: { hn: evidenceFetch(6) }, sendEmail: sent() }));
    expect(JSON.stringify(store.briefs.get(WEEK)!.analysis)).toBe(sealed);
    expect(store.aggregates.get(WEEK)![0].count).toBe(6);            // the aggregates still learn about it...
    expect(store.briefs.get(WEEK)!.analysis!.totals.relevantDiscussions).toBe(3); // ...the sealed report does not
  });
  it("the email is built from the SAVED analysis: the brief it carries matches the stored report exactly", async () => {
    const store = new MemoryStore();
    const send = sent();
    await runDigest(base(store, { fetchers: { hn: evidenceFetch(4) }, sendEmail: send }));
    const args = send.mock.calls[0][0];
    const saved = store.briefs.get(WEEK)!;
    expect(args.version).toBe(saved.version);
    expect(args.brief!.weekStart).toBe(WEEK);
    expect(args.brief!.interpretation.executiveSummary).toBe(saved.narrative);
    expect(args.brief!.observed.totals).toEqual(saved.analysis!.totals);
    expect(args.brief!.observed.top.map((t) => t.theme)).toEqual(saved.analysis!.top.map((k) => saved.analysis!.painPoints.find((p) => p.key === k)!.theme));
  });
  it("builds a four-week baseline only after four comparable weeks, across a six-Friday history", async () => {
    const store = new MemoryStore();
    const fridays = ["2026-09-04", "2026-09-11", "2026-09-18", "2026-09-25", "2026-10-02", "2026-10-09"];
    const baselineAt: boolean[] = [];
    for (const w of fridays) {
      const now = new Date(`${w}T03:30:00Z`);
      const start = new Date(`${w}T00:00:00+05:30`).getTime() - 6 * 86_400_000; // inside the period that ends at this Friday 00:00 IST
      await runDigest(base(store, { now, fetchers: { hn: async () => [post({ source_id: `w${w}`, posted_at: new Date(start + 3_600_000).toISOString(), title: `code review thread of ${w} here` })] } }));
      const week = [...store.briefs.keys()].sort().at(-1)!;
      baselineAt.push(store.briefs.get(week)!.analysis!.baseline.available);
    }
    expect(baselineAt).toEqual([false, false, false, false, true, true]);
  });
  it("a week whose source coverage differs breaks the baseline (honestly unavailable, not averaged over)", async () => {
    const store = new MemoryStore();
    const fridays = ["2026-09-04", "2026-09-11", "2026-09-18", "2026-09-25", "2026-10-02"];
    for (const w of fridays) {
      const now = new Date(`${w}T03:30:00Z`);
      const inside = new Date(new Date(`${w}T00:00:00+05:30`).getTime() - 5 * 86_400_000).toISOString();
      const flakyWeek = w === "2026-09-18";
      await runDigest(base(store, { now, fetchers: { hn: async () => [post({ source_id: `w${w}`, posted_at: inside, title: `code review thread of ${w} here` })], ...(flakyWeek ? {} : { reddit: async () => [post({ source: "reddit", source_id: `r${w}`, posted_at: inside, title: `code review reddit thread ${w} here` })] }) } }));
    }
    const last = store.briefs.get("2026-09-25")!; // the report for the period that ended 2026-10-02
    expect(last.analysis!.baseline.available).toBe(false);
  });
});
