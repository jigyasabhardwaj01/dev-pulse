import { describe, expect, it } from "vitest";
import { comparisonStatus, computeKpis, movement, previousWeekKey, readCoverage, selectMovers, shortRange, sourceRows } from "@/lib/insights";
import { displayPoints } from "@/lib/report-model";
import { summarizeReport } from "@/lib/view";
import type { ThemeTrend } from "@/lib/types";
import type { Coverage } from "@/lib/coverage";

const tp = (over: Partial<ThemeTrend>): ThemeTrend => ({ topic_id: "t1", topic_name: "Code review", theme: "X", count: 5, previous: 5, direction: "flat", pct: 0, unresolved_count: 0, unresolved: false, ...over });

describe("movement wording", () => {
  it("quotes counts and only quotes a percentage when the baseline is meaningful", () => {
    expect(movement(tp({ direction: "up", previous: 1, count: 7, pct: 600 })).label).toBe("+6");           // baseline 1: no percentage
    expect(movement(tp({ direction: "up", previous: 10, count: 15, pct: 50 })).label).toBe("+5 (+50%)");
    expect(movement(tp({ direction: "down", previous: 6, count: 1, pct: -83.3 })).label).toBe("−5 (−83.3%)");
    expect(movement(tp({ direction: "down", previous: 4, count: 1, pct: -75 })).label).toBe("−3");
    expect(movement(tp({ direction: "up", previous: 1, count: 7, pct: 600 })).counts).toBe("1 → 7");
  });
  it("new items have no percentage and no invented baseline other than zero", () => {
    const m = movement(tp({ direction: "new", previous: 0, count: 3, pct: null }));
    expect(m).toMatchObject({ kind: "new", label: "New", counts: "0 → 3" });
  });
  it("withheld trends are 'Not compared', never a direction", () => {
    const m = movement(tp({ direction: "unavailable", pct: null }));
    expect(m.kind).toBe("na");
    expect(m.counts).toBe("");
    expect(m.label).toBe("Not compared");
  });
  it("handles dropped-to-zero and no change", () => {
    expect(movement(tp({ direction: "down", previous: 8, count: 0, pct: -100 })).label).toBe("Dropped to 0");
    expect(movement(tp({ direction: "flat", previous: 5, count: 5 })).label).toBe("No change");
  });
});

describe("top movers", () => {
  const pts = [
    tp({ theme: "A", direction: "up", previous: 1, count: 7, unresolved_count: 5 }),
    tp({ theme: "B", direction: "up", previous: 3, count: 9, unresolved_count: 8 }),
    tp({ theme: "C", direction: "new", previous: 0, count: 3, pct: null, unresolved_count: 2 }),
    tp({ theme: "D", direction: "down", previous: 6, count: 1, unresolved_count: 1 }),
    tp({ theme: "E", direction: "flat", previous: 13, count: 13, unresolved_count: 5 }),
  ];
  it("ranks increases by absolute change, and lists new, decreasing and unresolved items", () => {
    const m = selectMovers(pts);
    expect(m.comparable).toBe(true);
    expect(m.increases.map((x) => x.theme)).toEqual(["B", "A"]); // +6 each; ties broken by count
    expect(m.emerging.map((x) => x.theme)).toEqual(["C"]);
    expect(m.decreases.map((x) => x.theme)).toEqual(["D"]);
    expect(m.unresolved.map((x) => x.theme)).toEqual(["B", "E", "A"]);
    expect(m.biggest[0].theme).toBe("E");
  });
  it("yields no movement lists when trends are withheld, but still offers biggest and unresolved", () => {
    const w = pts.map((p) => ({ ...p, direction: "unavailable" as const, pct: null }));
    const m = selectMovers(w);
    expect(m.comparable).toBe(false);
    expect(m.increases).toEqual([]); expect(m.emerging).toEqual([]); expect(m.decreases).toEqual([]);
    expect(m.biggest.length).toBe(3);
    expect(m.unresolved.length).toBe(3);
  });
  it("works through displayPoints for an incomparable report", () => {
    const m = selectMovers(displayPoints({ points: pts, reliability: "incomparable" }));
    expect(m.comparable).toBe(false);
  });
});

describe("KPIs", () => {
  const pts = [tp({ theme: "A", count: 9, previous: 3, direction: "up", unresolved_count: 8 }), tp({ theme: "B", count: 3, previous: 0, direction: "new", pct: null, unresolved_count: 1 })];
  it("shows the baseline and the emerging count only for a fair comparison", () => {
    const k = computeKpis(pts, summarizeReport(pts, undefined));
    expect(k).toMatchObject({ mentions: 12, previousMentions: 3, painPoints: 2, emerging: 1, unresolvedMentions: 9, unresolvedPainPoints: 1 });
  });
  it("hides baseline and emerging when trends are withheld (null, not zero)", () => {
    const w = displayPoints({ points: pts, reliability: "no_prior" });
    const k = computeKpis(w, summarizeReport(w, undefined));
    expect(k.previousMentions).toBeNull();
    expect(k.emerging).toBeNull();
    expect(k.mentions).toBe(12);
  });
});

describe("periods", () => {
  it("names the previous period and a compact range", () => {
    expect(previousWeekKey("2026-10-02")).toBe("2026-09-25");
    expect(previousWeekKey("garbage")).toBeNull();
    expect(shortRange("2026-10-02")).toBe("2 Oct – 8 Oct");
    expect(comparisonStatus("comparable", "2026-10-02").label).toBe("Compared with 25 Sept – 1 Oct");
    expect(comparisonStatus("no_prior", "2026-10-02").tone).toBe("info");
    expect(comparisonStatus("incomparable", "2026-10-02").tone).toBe("warn");
    expect(comparisonStatus("legacy", "2026-10-02").label).toBe("Earlier format");
  });
});

describe("coverage reading", () => {
  const cov: Coverage = { hn: { status: "ok", posts: 164, truncated: true }, github: { status: "ok", posts: 23, truncated: true }, reddit: { status: "partial", posts: 0 }, stackoverflow: { status: "ok", posts: 1 } };
  const caveats = [
    "Hacker News results hit the page limit this period, so its counts may be understated",
    "GitHub results hit the page limit this period, so its counts may be understated",
    "Hacker News results hit the page limit in the previous period, so its counts may be understated",
    "GitHub results hit the page limit in the previous period, so its counts may be understated",
  ];
  it("collapses four repeated page-limit lines into one note and says which period it affects", () => {
    const r = readCoverage(cov, { state: "comparable", reasons: [], caveats }, "comparable");
    const cap = r.notes.filter((n) => /page limit/.test(n.text));
    expect(cap).toHaveLength(1);
    expect(cap[0]).toMatchObject({ scope: "both" });
    expect(cap[0].text).toBe("Hacker News and GitHub hit the page limit in both this and the previous period, so their counts may be understated.");
  });
  it("a partly collected source raises a visible warning and is never described as zero posts", () => {
    const r = readCoverage(cov, { state: "comparable", reasons: [], caveats }, "comparable");
    expect(r.level).toBe("warn");
    expect(r.headline).toContain("Reddit partly collected");
    expect(r.notes.some((n) => /Reddit was only partly collected/.test(n.text))).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/zero posts?\b(?!;)/);
  });
  it("a failed source is called failed, and says its posts are missing rather than zero", () => {
    const r = readCoverage({ reddit: { status: "error", posts: 0 } }, { state: "comparable", reasons: [] }, "comparable");
    expect(r.level).toBe("warn");
    expect(r.notes[0].text).toMatch(/failed to return data/);
    expect(r.notes[0].text).toMatch(/not zero posts/);
  });
  it("withheld trends are a warning with the stored reasons", () => {
    const r = readCoverage({ hn: { status: "ok", posts: 5 } }, { state: "incomparable", reasons: ["Reddit tracked only this period"] }, "incomparable");
    expect(r.level).toBe("warn");
    expect(r.headline).toMatch(/Trends withheld/);
    expect(r.notes[0].text).toContain("Reddit tracked only this period");
  });
  it("is silent when there is nothing to qualify, and informational for a first report", () => {
    expect(readCoverage({ hn: { status: "ok", posts: 5 } }, { state: "comparable", reasons: [] }, "comparable")).toMatchObject({ level: "none", headline: null, notes: [] });
    expect(readCoverage({ hn: { status: "ok", posts: 5 } }, { state: "no_prior", reasons: [] }, "no_prior").level).toBe("info");
  });
});

describe("source rows", () => {
  it("separates failure, partial, healthy-with-zero and capped", () => {
    const rows = sourceRows({ hn: { status: "ok", posts: 100, truncated: true }, so: undefined as never, stackoverflow: { status: "ok", posts: 0 }, reddit: { status: "error", posts: 0 }, github: { status: "partial", posts: 10 } } as Coverage);
    const by = Object.fromEntries(rows.filter(Boolean).map((r) => [r.source, r]));
    expect(by.reddit).toMatchObject({ status: "error", posts: null, share: null });
    expect(by.reddit.state).toBe("Failed: no data collected");
    expect(by.stackoverflow.state).toBe("Collected: no posts in this period");
    expect(by.stackoverflow.posts).toBe(0);
    expect(by.github.state).toMatch(/Partly collected: 10 posts/);
    expect(by.hn.capped).toBe(true);
    expect(by.hn.share).toBeCloseTo(100 / 110);
  });
});
