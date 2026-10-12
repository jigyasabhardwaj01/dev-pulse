import { describe, expect, it } from "vitest";
import { assessComparison, comparisonNote, mergeCoverage, summarizeStatuses, type Coverage } from "@/lib/coverage";
import { renderBriefHtml } from "@/lib/email";
import { buildTrends } from "@/lib/trend";
import { makeOpenRouterCaller } from "@/lib/openrouter";
import { sanitizeError } from "@/lib/text";
import { orderTopics } from "@/lib/store";

const ok = (posts: number) => ({ status: "ok" as const, posts });
const cov = (c: Coverage) => c;

describe("assessComparison: fair vs unfair comparisons", () => {
  it("no previous record under this convention = no_prior", () => {
    expect(assessComparison(cov({ hn: ok(10) }), null).state).toBe("no_prior");
  });
  it("same sources, all ok = comparable", () => {
    expect(assessComparison(cov({ hn: ok(10), github: ok(5) }), cov({ hn: ok(8), github: ok(6) })).state).toBe("comparable");
  });
  it("a source tracked in only one period is incomparable (the GitHub-only-this-week case)", () => {
    const r = assessComparison(cov({ hn: ok(100), github: ok(42) }), cov({ hn: ok(150) }));
    expect(r.state).toBe("incomparable");
    expect(r.reasons.join()).toMatch(/GitHub was tracked in only one/);
  });
  it("a source whose fetch status differs between the periods is incomparable", () => {
    const r = assessComparison(cov({ hn: ok(10), github: { status: "error", posts: 0 } }), cov({ hn: ok(10), github: ok(9) }));
    expect(r.state).toBe("incomparable");
    expect(r.reasons.join()).toMatch(/status differed/);
  });
  it("a partial fetch against a complete one is incomparable", () => {
    expect(assessComparison(cov({ hn: { status: "partial", posts: 5 } }), cov({ hn: ok(9) })).state).toBe("incomparable");
  });
  it("a source that failed identically in both periods does not by itself make the comparison unfair", () => {
    const e = { status: "error" as const, posts: 0 };
    expect(assessComparison(cov({ hn: ok(10), reddit: e }), cov({ hn: ok(12), reddit: e })).state).toBe("comparable");
  });
  it("an ok source with a material share in one period and nothing in the other is incomparable", () => {
    expect(assessComparison(cov({ hn: ok(50), github: ok(0) }), cov({ hn: ok(50), github: ok(40) })).state).toBe("incomparable");
  });
  it("a negligible source appearing or vanishing is not material", () => {
    expect(assessComparison(cov({ hn: ok(100), stackoverflow: ok(0) }), cov({ hn: ok(100), stackoverflow: ok(1) })).state).toBe("comparable");
  });
  it("produces plain-language qualifications, and none for a fair comparison", () => {
    expect(comparisonNote({ state: "comparable", reasons: [] })).toBeNull();
    expect(comparisonNote(null)).toBeNull();
    expect(comparisonNote({ state: "no_prior", reasons: [] })).toMatch(/start next week/);
    expect(comparisonNote({ state: "incomparable", reasons: ["GitHub was tracked in only one of the two periods"] })).toMatch(/not shown.*GitHub/);
  });
});

describe("coverage bookkeeping", () => {
  it("summarizes per-topic statuses into one per source", () => {
    expect(summarizeStatuses(["ok", "ok"])).toBe("ok");
    expect(summarizeStatuses(["error", "error"])).toBe("error");
    expect(summarizeStatuses(["ok", "error"])).toBe("partial");
    expect(summarizeStatuses(["ok", "partial"])).toBe("partial");
  });
  it("a failed rerun does not discredit data a successful run already stored; counts follow current data", () => {
    const merged = mergeCoverage(cov({ github: ok(30) }), cov({ github: { status: "error", posts: 31 } }));
    expect(merged.github).toEqual({ status: "ok", posts: 31 });
  });
  it("a later successful rerun upgrades an earlier failure", () => {
    expect(mergeCoverage(cov({ reddit: { status: "error", posts: 0 } }), cov({ reddit: ok(4) })).reddit).toEqual({ status: "ok", posts: 4 });
  });
  it("never invents a source that was not attempted", () => {
    expect(Object.keys(mergeCoverage(null, cov({ hn: ok(1) })))).toEqual(["hn"]);
  });
});

describe("email data-quality qualification", () => {
  const trends = buildTrends([{ topic_id: "t", theme: "Slow reviews", count: 3, unresolved: 0 }], [], { t: "Code review" })
    .map((t) => ({ ...t, direction: "unavailable" as const, pct: null }));
  it("shows the note and never a trend arrow or percentage when trends are not compared", () => {
    const html = renderBriefHtml("2026-10-02", "Intro. Two.", trends, null, { state: "incomparable", reasons: ["GitHub was tracked in only one of the two periods"] });
    expect(html).toContain("Data note:");
    expect(html).toContain("GitHub was tracked in only one");
    expect(html).toContain("trend not compared");
    expect(html).not.toMatch(/[▲▼]|%/);
    expect(html).toContain("3 mentions"); // totals are preserved
  });
  it("shows no note for a fair comparison", () => {
    expect(renderBriefHtml("w", "a b.", trends, null, { state: "comparable", reasons: [] })).not.toContain("Data note");
  });
});

describe("deterministic topic order", () => {
  const t = (id: string, created_at?: string) => ({ id, created_at });
  it("sorts by created_at then id, whatever order they arrive in", () => {
    const a = [t("b", "2026-01-02"), t("a", "2026-01-03"), t("c", "2026-01-02")];
    const expected = ["b", "c", "a"];
    expect(orderTopics(a).map((x) => x.id)).toEqual(expected);
    expect(orderTopics([...a].reverse()).map((x) => x.id)).toEqual(expected);
  });
  it("falls back to id when created_at is missing or equal, and does not mutate its input", () => {
    const input = [t("z"), t("a")];
    expect(orderTopics(input).map((x) => x.id)).toEqual(["a", "z"]);
    expect(input.map((x) => x.id)).toEqual(["z", "a"]);
  });
});

describe("secret-safe error text", () => {
  it("redacts keys, bearer tokens and query strings", () => {
    const s = sanitizeError(new Error("failed https://api.stackexchange.com/2.3/search?key=SECRET123&q=x with Bearer abc.def-123 and token=ZZZ"));
    expect(s).not.toMatch(/SECRET123|abc\.def|ZZZ|q=x/);
    expect(s).toContain("api.stackexchange.com");
  });
  it("truncates long messages", () => {
    expect(sanitizeError("word ".repeat(300), 100).length).toBe(100);
    expect(sanitizeError("x".repeat(1000), 100)).toBe("[redacted]"); // one long opaque string is a token, not text
    // IP addresses, JWT-shaped keys and long opaque tokens never survive, whatever the surrounding text
    const t = sanitizeError(new Error("connect ECONNREFUSED 10.0.0.1:5432 then 2001 at 192.168.1.20 with eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.sig and abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"));
    for (const bad of ["10.0.0.1", "5432", "192.168.1.20", "eyJhbGci", "abcdefghijklmnopqrstuvwxyz0123456789"]) expect(t).not.toContain(bad);
    expect(t).toContain("[address]");
    expect(sanitizeError("HTTP 429 for www.reddit.com")).toBe("HTTP 429 for www.reddit.com"); // service host names are kept
    expect(sanitizeError("fetched 2026-10-09 in 12.5s")).toBe("fetched 2026-10-09 in 12.5s"); // numbers that are not addresses are untouched
  });
});

describe("AI time budget", () => {
  it("does not call the API when the deadline has already passed", async () => {
    let called = 0;
    const call = makeOpenRouterCaller({ apiKey: "k", model: "google/gemini-3.7-flash", fetchImpl: async () => { called++; return new Response("{}"); } });
    await expect(call("p", { deadline: Date.now() - 1 })).rejects.toThrow(/time budget/);
    expect(called).toBe(0);
  });
});

describe("a source switched off on purpose (not collected)", () => {
  const prev = { hn: { status: "ok", posts: 90 }, github: { status: "ok", posts: 9 }, reddit: { status: "partial", posts: 1 } } as never;
  const cur = { hn: { status: "ok", posts: 80 }, github: { status: "ok", posts: 10 } } as never;
  it("a small previous share does not block the comparison, but is stated as a caveat", async () => {
    const { assessComparison } = await import("@/lib/coverage");
    const c = assessComparison(cur, prev, { reddit: "no credentials" });
    expect(c.state).toBe("comparable");
    expect(c.caveats?.join(" ")).toMatch(/Reddit was not collected this period; it supplied 1%/);
  });
  it("without the declaration the same absence still blocks (unchanged behaviour)", async () => {
    const { assessComparison } = await import("@/lib/coverage");
    expect(assessComparison(cur, prev).state).toBe("incomparable");
  });
  it("a material previous share blocks trends even when the source was switched off", async () => {
    const { assessComparison } = await import("@/lib/coverage");
    const big = { hn: { status: "ok", posts: 50 }, reddit: { status: "ok", posts: 50 } } as never;
    const c = assessComparison({ hn: { status: "ok", posts: 50 } } as never, big, { reddit: "no credentials" });
    expect(c.state).toBe("incomparable");
  });
});
