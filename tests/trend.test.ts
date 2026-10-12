import { describe, expect, it } from "vitest";
import { buildTrends, computeTrend, rankPainPoints } from "@/lib/trend";

const names = { t1: "Code review" };
const c = (theme: string, count: number, unresolved = 0) => ({ topic_id: "t1", theme, count, unresolved });

describe("computeTrend", () => {
  it("up / down / flat", () => {
    expect(computeTrend(15, 10)).toEqual({ direction: "up", pct: 50 });
    expect(computeTrend(5, 10)).toEqual({ direction: "down", pct: -50 });
    expect(computeTrend(10, 10)).toEqual({ direction: "flat", pct: 0 });
  });
  it("new theme with no baseline: no divide by zero", () => {
    expect(computeTrend(4, 0)).toEqual({ direction: "new", pct: null });
  });
  it("dropped to zero is -100%", () => {
    expect(computeTrend(0, 7)).toEqual({ direction: "down", pct: -100 });
  });
  it("zero both weeks is flat", () => {
    expect(computeTrend(0, 0)).toEqual({ direction: "flat", pct: 0 });
  });
});

describe("buildTrends", () => {
  it("reports a theme present last week with zero matches now as declined", () => {
    const t = buildTrends([c("A", 3)], [c("A", 3), c("B", 5)], names);
    const b = t.find((x) => x.theme === "B")!;
    expect(b).toMatchObject({ count: 0, previous: 5, direction: "down", pct: -100 });
  });
  it("marks themes without a previous row as new", () => {
    expect(buildTrends([c("A", 3)], [], names)[0]).toMatchObject({ direction: "new", pct: null });
  });
  it("ranks by current count and flags mostly-unresolved themes", () => {
    const t = buildTrends([c("A", 2, 0), c("B", 6, 4)], [], names);
    expect(t.map((x) => x.theme)).toEqual(["B", "A"]);
    expect(t[0].unresolved).toBe(true);
    expect(t[1].unresolved).toBe(false);
  });
  it("excludes 'other' from pain points", () => {
    expect(rankPainPoints(buildTrends([c("other", 9), c("A", 1)], [], names)).map((x) => x.theme)).toEqual(["A"]);
  });
});
