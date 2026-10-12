import { describe, expect, it } from "vitest";
import { BASELINE_WEEKS, THREAD_CAP, TOP_N, WEIGHTS, analyse, computeBaseline, shiftWeek, type AnalysisInput, type EvidencePost, type PriorWeek } from "@/lib/analysis";
import type { Coverage } from "@/lib/coverage";
import { buildTrends } from "@/lib/trend";
import type { ThemeCount } from "@/lib/types";

let seq = 0;
const ev = (over: Partial<EvidencePost> = {}): EvidencePost => {
  const n = ++seq;
  return { id: `p${n}`, source: "hn", topic_id: "t1", theme: "Slow reviews", title: `Distinct discussion title number ${n}`, url: `https://x.test/${n}`, author: `author${n}`, posted_at: `2026-10-0${(n % 7) + 1}T10:00:00Z`, confidence: 0.8, excerpt: "supporting words", resolution: "open", unresolved: true, flags: [], ...over };
};
const many = (n: number, over: (i: number) => Partial<EvidencePost> = () => ({})) => Array.from({ length: n }, (_, i) => ev(over(i)));
const COV: Coverage = { hn: { status: "ok", posts: 100 }, stackoverflow: { status: "ok", posts: 20 }, reddit: { status: "ok", posts: 30 }, github: { status: "ok", posts: 25 } };
const names = { t1: "Code review", t2: "CI/CD" };
const base = (over: Partial<AnalysisInput> = {}): AnalysisInput => ({ weekStart: "2026-10-09", posts: [], trends: [], topicNames: names, coverage: COV, comparison: "comparable", prior: [], ...over });
const tc = (theme: string, count: number, topic_id = "t1"): ThemeCount => ({ topic_id, theme, count, unresolved: 0 });
const priorWeek = (n: number, counts: ThemeCount[] = [], over: Partial<PriorWeek> = {}): PriorWeek => ({ weekStart: shiftWeek("2026-10-09", -n), counts, coverage: COV, ...over });
const four = (counts: (n: number) => ThemeCount[] = () => []) => [1, 2, 3, 4].map((n) => priorWeek(n, counts(n)));
const trendsOf = (cur: ThemeCount[], prev: ThemeCount[]) => buildTrends(cur, prev, names);
const find = (a: ReturnType<typeof analyse>, theme: string, topic = "t1") => a.painPoints.find((p) => p.theme === theme && p.topic_id === topic)!;

describe("aggregation", () => {
  it("counts discussions, sources, first/last seen and the resolution breakdown from real posts", () => {
    const posts = [
      ev({ source: "hn", posted_at: "2026-10-03T10:00:00Z", resolution: "open" }), ev({ source: "github", posted_at: "2026-10-05T10:00:00Z", resolution: "uncertain" }),
      ev({ source: "reddit", posted_at: "2026-10-07T10:00:00Z", resolution: "resolved" }), ev({ source: "hn", posted_at: "2026-10-04T10:00:00Z", resolution: "open" }),
    ];
    const a = analyse(base({ posts, trends: trendsOf([tc("Slow reviews", 4)], []) }));
    const p = find(a, "Slow reviews");
    expect(p).toMatchObject({ discussions: 4, rawPosts: 4, distinctSources: 3, sources: { hn: 2, github: 1, reddit: 1 }, firstSeen: "2026-10-03T10:00:00Z", lastSeen: "2026-10-07T10:00:00Z", resolution: { open: 2, uncertain: 1, resolved: 1 }, topic_name: "Code review" });
    expect(a.totals).toMatchObject({ relevantDiscussions: 4, painPoints: 1, unresolved: 2, uncertain: 1 });
  });
  it("'other' is not a pain point", () => {
    expect(analyse(base({ posts: [ev({ theme: "other" })] })).painPoints).toEqual([]);
  });
  it("the same theme name under two topics is two pain points (a pain point may appear in more than one category)", () => {
    const a = analyse(base({ posts: [ev({ topic_id: "t1" }), ev({ topic_id: "t1" }), ev({ topic_id: "t2" })] }));
    expect(a.painPoints.map((p) => `${p.topic_id}:${p.discussions}`).sort()).toEqual(["t1:2", "t2:1"]);
    expect(new Set(a.painPoints.map((p) => p.key)).size).toBe(2);
  });
  it("legacy posts with no resolution field are never assumed resolved", () => {
    const a = analyse(base({ posts: [ev({ resolution: null, unresolved: true }), ev({ resolution: null, unresolved: false }), ev({ resolution: null, unresolved: null })] }));
    expect(find(a, "Slow reviews").resolution).toEqual({ open: 1, uncertain: 2, resolved: 0 });
  });
  it("keeps up to five evidence links, preferring ones with a verified excerpt and higher confidence", () => {
    const posts = [...many(6, () => ({ excerpt: null, confidence: 0.9 })), ev({ excerpt: "quote", confidence: 0.55, title: "The one with an excerpt" })];
    const links = find(analyse(base({ posts })), "Slow reviews").links;
    expect(links).toHaveLength(5);
    expect(links[0].title).toBe("The one with an excerpt");
    expect(links.every((l) => l.url?.startsWith("https://"))).toBe(true);
  });
});

describe("duplicates and viral threads cannot distort the picture", () => {
  it("many comments under one thread are ONE discussion, capped at 1.25 for ranking", () => {
    const posts = many(40, () => ({ title: "Everyone is arguing about code review bots in this thread", author: null }));
    const p = find(analyse(base({ posts })), "Slow reviews");
    expect(p).toMatchObject({ discussions: 1, rawPosts: 40, effectiveDiscussions: THREAD_CAP });
  });
  it("a viral thread does not outrank a theme discussed in several independent threads", () => {
    const viral = many(60, () => ({ theme: "Slow reviews", title: "One huge thread about slow reviews everywhere" }));
    const broad = many(4, () => ({ theme: "Review tone", source: "github" }));
    const a = analyse(base({ posts: [...viral, ...broad] }));
    expect(find(a, "Review tone").score).toBeGreaterThan(find(a, "Slow reviews").score);
    expect(a.top[0]).toContain("Review tone");
  });
  it("the same author posting the same title is counted once, even across sources", () => {
    const dup = { title: "Our code review bot never stops flagging safe code", author: "Sam" };
    const a = analyse(base({ posts: [ev({ ...dup, source: "hn" }), ev({ ...dup, source: "reddit" }), ev({ ...dup, author: "sam", source: "github" })] }));
    expect(find(a, "Slow reviews").discussions).toBe(1);
  });
  it("threads are per source: the same title in two sources is two discussions", () => {
    const t = { title: "Is anyone else fed up with false positive review bots", author: null };
    const a = analyse(base({ posts: [ev({ ...t, source: "hn" }), ev({ ...t, source: "reddit" })] }));
    expect(find(a, "Slow reviews").discussions).toBe(2);
  });
  it("short or missing titles are never merged (each is its own discussion)", () => {
    const a = analyse(base({ posts: many(5, () => ({ title: "", author: null })) }));
    expect(find(a, "Slow reviews").discussions).toBe(5);
  });
});

describe("authors are never invented", () => {
  it("counts distinct authors when most posts have one", () => {
    const a = analyse(base({ posts: [ev({ author: "A" }), ev({ author: "a" }), ev({ author: "B" }), ev({ author: null })] }));
    expect(find(a, "Slow reviews").authors).toBe(2);
  });
  it("reports null when fewer than half the posts have an author, and says so in the limitations", () => {
    const a = analyse(base({ posts: [ev({ author: "A" }), ev({ author: null }), ev({ author: null }), ev({ author: null })] }));
    const p = find(a, "Slow reviews");
    expect(p.authors).toBeNull();
    expect(p.authorsKnownPosts).toBe(1);
    expect(a.limitations.join(" ")).toContain("without an author");
    expect(p.factors.find((f) => f.name === "breadth")!.note).toContain("authors unknown");
  });
});

describe("evidence strength", () => {
  const str = (posts: EvidencePost[]) => find(analyse(base({ posts })), "Slow reviews").evidence.strength;
  it("strong needs 3+ threads, 2+ sources, 2+ verified excerpts and decent confidence", () => {
    expect(str([ev({ source: "hn" }), ev({ source: "reddit" }), ev({ source: "github" })])).toBe("strong");
    expect(str([ev(), ev(), ev()])).toBe("moderate");                                   // one source only
    expect(str([ev({ source: "hn", confidence: 0.4 }), ev({ source: "reddit", confidence: 0.4 }), ev({ source: "github", confidence: 0.4 })])).toBe("moderate");
  });
  it("one discussion, or none with an excerpt, is limited", () => {
    expect(str([ev()])).toBe("limited");
    expect(str([ev({ excerpt: null }), ev({ excerpt: null })])).toBe("limited");
  });
  it("early signals dominate -> limited, and the item is not eligible for the top list", () => {
    const posts = [ev({ flags: ["early_signal"] }), ev({ flags: ["early_signal"] }), ev({ flags: ["early_signal"] })];
    const a = analyse(base({ posts }));
    expect(find(a, "Slow reviews")).toMatchObject({ eligibleForTop: false, evidence: { strength: "limited", earlySignals: 3 } });
    expect(a.top).toEqual([]);
    expect(a.limitations.join(" ")).toContain("early signals");
  });
});

describe("trend status", () => {
  const status = (cur: number, prev: number, comparison: AnalysisInput["comparison"] = "comparable") => {
    const posts = many(cur);
    const a = analyse(base({ posts, comparison, trends: trendsOf([tc("Slow reviews", cur)], prev ? [tc("Slow reviews", prev)] : []) }));
    return find(a, "Slow reviews");
  };
  it("new, rising, declining, steady use a minimum change of 2 and 25%", () => {
    expect(status(5, 0).status).toBe("new");
    expect(status(8, 4).status).toBe("rising");
    expect(status(5, 4).status).toBe("steady");        // +1 is below the minimum change
    expect(status(3, 8).status).toBe("declining");
    expect(status(12, 10).status).toBe("steady");      // +2 but under 25% of 10
  });
  it("is 'unavailable' with no numbers when the comparison is not fair", () => {
    for (const c of ["incomparable", "no_prior"] as const) {
      const p = status(6, 3, c);
      expect(p.status).toBe("unavailable");
      expect(p.trend).toMatchObject({ comparable: false, delta: 0, pct: null, direction: "unavailable" });
    }
  });
  it("a theme present last week and absent now is not a ranked pain point (it has no evidence this week)", () => {
    const a = analyse(base({ posts: [], trends: trendsOf([], [tc("Gone", 4)]) }));
    expect(a.painPoints).toEqual([]);
  });
});

describe("baseline: only with four comparable preceding weeks", () => {
  it("is unavailable with fewer than four weeks, and says how many exist", () => {
    for (const n of [0, 1, 2, 3]) {
      const { baseline, means } = computeBaseline("2026-10-09", COV, [1, 2, 3, 4].slice(0, n).map((i) => priorWeek(i)));
      expect(baseline).toMatchObject({ available: false, weeks: 0 });
      expect(baseline.reason).toContain(`Only ${n} of the 4`);
      expect(means.size).toBe(0);
    }
  });
  it("is available with four consecutive comparable weeks, and is the mean (missing themes count as zero)", () => {
    const { baseline, means } = computeBaseline("2026-10-09", COV, four((n) => (n === 1 ? [tc("Slow reviews", 8)] : n === 2 ? [tc("Slow reviews", 4)] : [])));
    expect(baseline).toMatchObject({ available: true, weeks: BASELINE_WEEKS, reason: null });
    expect(means.get("t1|Slow reviews")).toBe(3);
  });
  it("a missing week (a gap) makes it unavailable", () => {
    const prior = [1, 2, 4, 5].map((n) => priorWeek(n));
    expect(computeBaseline("2026-10-09", COV, prior).baseline.available).toBe(false);
  });
  it("a week with different source coverage makes it unavailable", () => {
    const prior = four();
    prior[2] = { ...prior[2], coverage: { ...COV, reddit: { status: "error", posts: 0 } } };
    const { baseline } = computeBaseline("2026-10-09", COV, prior);
    expect(baseline.available).toBe(false);
    expect(baseline.reason).toContain("different source coverage");
  });
  it("legacy weeks and weeks without recorded coverage never count", () => {
    const a = four(); a[0] = { ...a[0], legacy: true };
    expect(computeBaseline("2026-10-09", COV, a).baseline.available).toBe(false);
    const b = four(); b[1] = { ...b[1], coverage: null };
    expect(computeBaseline("2026-10-09", COV, b).baseline.available).toBe(false);
  });
  it("is unavailable when this report has no recorded coverage", () => {
    expect(computeBaseline("2026-10-09", null, four()).baseline.reason).toContain("no recorded source coverage");
  });
  it("shiftWeek moves by exactly seven days, across month and year ends", () => {
    expect(shiftWeek("2026-10-09", -1)).toBe("2026-10-02");
    expect(shiftWeek("2026-10-02", -4)).toBe("2026-09-04");
    expect(shiftWeek("2026-12-25", 1)).toBe("2027-01-01");
  });
  it("feeds the change and persistence factors only when it exists, and never invents a four-week average", () => {
    const posts = many(6);
    const without = find(analyse(base({ posts, trends: trendsOf([tc("Slow reviews", 6)], [tc("Slow reviews", 6)]), prior: [priorWeek(1, [tc("Slow reviews", 6)])] })), "Slow reviews");
    expect(without.baseline).toBeNull();
    const withB = find(analyse(base({ posts, trends: trendsOf([tc("Slow reviews", 6)], [tc("Slow reviews", 6)]), prior: four((n) => [tc("Slow reviews", n === 1 ? 6 : 2)]) })), "Slow reviews");
    expect(withB.baseline).toMatchObject({ mean: 3, weeks: 4, vsBaseline: 3 });
    expect(withB.persistence).toEqual({ weeksPresent: 4, of: 4 });
    expect(withB.factors.find((f) => f.name === "change")!.note).toContain("vs the 4-week mean");
  });
  it("the analysis reports whether a baseline existed", () => {
    expect(analyse(base({ posts: many(2) })).baseline.available).toBe(false);
    expect(analyse(base({ posts: many(2), prior: four() })).baseline.available).toBe(true);
  });
});

describe("ranking is explicit, explained and defensible", () => {
  it("weights sum to one and every ranked item shows each factor with its contribution", () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    const a = analyse(base({ posts: many(3) }));
    const p = a.painPoints[0];
    expect(p.factors.map((f) => f.name)).toEqual(["frequency", "change", "persistence", "breadth", "unresolved", "strength"]);
    expect(p.factors.every((f) => f.note.length > 5 && f.value >= 0 && f.value <= 1)).toBe(true);
    expect(p.score).toBeCloseTo(p.factors.reduce((s, f) => s + f.contribution, 0), 1);
    expect(p.score).toBeGreaterThan(0);
    expect(p.score).toBeLessThanOrEqual(100);
  });
  it("frequency is log-scaled: doubling the evidence does not double the score", () => {
    const a = analyse(base({ posts: [...many(8, () => ({ theme: "A" })), ...many(4, () => ({ theme: "B" }))] }));
    const fa = find(a, "A").factors[0].value, fb = find(a, "B").factors[0].value;
    expect(fa).toBe(1);
    expect(fb).toBeGreaterThan(0.5);
  });
  it("the model's own confidence cannot dominate: one 1.0-confidence post loses to five 0.5-confidence discussions", () => {
    const a = analyse(base({ posts: [ev({ theme: "Confident", confidence: 1 }), ...many(5, () => ({ theme: "Broad", confidence: 0.5, source: "github" }))] }));
    expect(find(a, "Broad").score).toBeGreaterThan(find(a, "Confident").score);
    const w = WEIGHTS.strength * 100;
    expect(w).toBeLessThanOrEqual(5);
  });
  it("open problems outrank resolved ones with the same frequency", () => {
    const a = analyse(base({ posts: [...many(3, () => ({ theme: "Open one", resolution: "open" })), ...many(3, () => ({ theme: "Done one", resolution: "resolved" }))] }));
    expect(find(a, "Open one").score).toBeGreaterThan(find(a, "Done one").score);
  });
  it("a growing pain point outranks a flat one when the comparison is fair, and not when it is unfair", () => {
    const posts = [...many(4, () => ({ theme: "Rising" })), ...many(4, () => ({ theme: "Flat" }))];
    const trends = trendsOf([tc("Rising", 4), tc("Flat", 4)], [tc("Rising", 1), tc("Flat", 4)]);
    const fair = analyse(base({ posts, trends }));
    expect(find(fair, "Rising").score).toBeGreaterThan(find(fair, "Flat").score);
    const unfair = analyse(base({ posts, trends, comparison: "incomparable" }));
    expect(find(unfair, "Rising").score).toBe(find(unfair, "Flat").score);
  });
  it("persistence rewards a pain point seen in earlier comparable weeks", () => {
    const posts = [...many(3, () => ({ theme: "Persistent" })), ...many(3, () => ({ theme: "Newcomer" }))];
    const a = analyse(base({ posts, prior: four((n) => [tc("Persistent", n)]), trends: trendsOf([tc("Persistent", 3), tc("Newcomer", 3)], [tc("Persistent", 1)]) }));
    expect(find(a, "Persistent").persistence).toEqual({ weeksPresent: 4, of: 4 });
    expect(find(a, "Newcomer").persistence).toEqual({ weeksPresent: 0, of: 4 });
  });
  it("the top list holds at most three, only eligible items, ranked by score", () => {
    const posts = [5, 4, 3, 2, 1].flatMap((n, i) => many(n, () => ({ theme: `Theme ${i}`, source: i % 2 ? "reddit" : "hn" })));
    const a = analyse(base({ posts }));
    expect(a.top).toHaveLength(TOP_N);
    expect(a.top.map((k) => k.split("|")[1])).toEqual(["Theme 0", "Theme 1", "Theme 2"]);
    expect(a.painPoints.find((p) => p.theme === "Theme 4")!.eligibleForTop).toBe(false); // a single discussion is not enough
  });
  it("says so honestly when fewer than three pain points have enough evidence", () => {
    const a = analyse(base({ posts: [...many(3, () => ({ theme: "Solid" })), ev({ theme: "Thin" }), ev({ theme: "Thinner" })] }));
    expect(a.top).toHaveLength(1);
    expect(a.limitations.join(" ")).toContain("Only 1 pain point has enough supporting evidence");
  });
  it("ties break deterministically (more discussions, then theme name)", () => {
    const a = analyse(base({ posts: [ev({ theme: "Beta" }), ev({ theme: "Alpha" })] }));
    expect(a.painPoints.map((p) => p.theme)).toEqual(["Alpha", "Beta"]);
  });
});

describe("determinism and sealing", () => {
  it("the same input gives byte-identical output regardless of post order, and survives a JSON round trip", () => {
    const posts = many(12, (i) => ({ theme: i % 3 ? "A" : "B", source: ["hn", "reddit", "github"][i % 3] }));
    const a = analyse(base({ posts }));
    const b = analyse(base({ posts: [...posts].reverse() }));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
  it("does not mutate its input", () => {
    const posts = many(5);
    const frozen = JSON.stringify(posts);
    analyse(base({ posts }));
    expect(JSON.stringify(posts)).toBe(frozen);
  });
  it("contains no timestamps of its own, so identical content is recognised as unchanged", () => {
    const a = JSON.stringify(analyse(base({ posts: many(2) })));
    expect(a).not.toMatch(/generatedAt|createdAt|capturedAt/);
  });
});

describe("limitations tell the truth about coverage", () => {
  it("names failed, partial and capped sources", () => {
    const coverage: Coverage = { hn: { status: "ok", posts: 50, truncated: true }, reddit: { status: "error", posts: 0 }, github: { status: "partial", posts: 3 }, stackoverflow: { status: "ok", posts: 4 } };
    const l = analyse(base({ posts: many(3), coverage, pendingPosts: 7 })).limitations.join(" | ");
    expect(l).toContain("Reddit could not be collected");
    expect(l).toContain("GitHub was only partly collected");
    expect(l).toContain("Hacker News returned only the newest results");
    expect(l).toContain("7 collected posts were still waiting");
  });
  it("explains a missing comparison", () => {
    expect(analyse(base({ posts: many(3), comparison: "no_prior" })).limitations.join(" ")).toContain("no earlier week");
    expect(analyse(base({ posts: many(3), comparison: "incomparable" })).limitations.join(" ")).toContain("coverage differs");
  });
  it("an empty week is a valid, honest analysis", () => {
    const a = analyse(base());
    expect(a).toMatchObject({ painPoints: [], top: [], totals: { relevantDiscussions: 0, painPoints: 0 } });
  });
});

describe("the sealed analysis must be storable in Postgres jsonb (regression: derive/save failed with 'unsupported Unicode escape sequence')", () => {
  it("stripNul removes U+0000 wherever it appears in a document, and leaves clean documents untouched", async () => {
    const { stripNul } = await import("@/lib/json-safe");
    const dirty = { a: "x\u0000y", list: [{ t: "\u0000start" }, "ok"], n: 3 };
    expect(JSON.stringify(dirty)).toContain("\\u0000");
    expect(stripNul(dirty)).toEqual({ a: "xy", list: [{ t: "start" }, "ok"], n: 3 });
    const clean = { a: 1 };
    expect(stripNul(clean)).toBe(clean);
  });
  it("keys and the top list use a jsonb-safe separator", () => {
    const a = analyse(base({ posts: many(3), trends: trendsOf([tc("Slow reviews", 3)], []) }));
    expect(a.painPoints[0].key).toBe("t1|Slow reviews");
    expect(JSON.stringify(a)).not.toContain("\\u0000");
  });
});
