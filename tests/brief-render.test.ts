import { describe, expect, it, vi } from "vitest";
import { buildBriefPrompt, buildFallbackNarrative, computeFacts, FIRST_WEEK_SENTENCE, generateBrief, sanitizeNarrative } from "@/lib/brief";
import { groupPainPoints, mentionsLine } from "@/lib/grouping";
import { renderBriefHtml } from "@/lib/email";
import { buildTrends, isMostlyUnresolved } from "@/lib/trend";

const names = { cr: "Code review", ci: "CI/CD automation" };
const c = (topic_id: string, theme: string, count: number, unresolved = 0) => ({ topic_id, theme, count, unresolved });
const FORBIDDEN = /\bnull\b|categorized as|baseline/i;

const firstWeek = buildTrends([c("cr", "Slow reviews", 13, 7), c("cr", "AI review quality", 4, 1), c("ci", "Flaky tests", 5, 1)], [], names);
const normalWeek = buildTrends(
  [c("cr", "Slow reviews", 13, 6), c("ci", "Flaky tests", 2, 0), c("ci", "CI cost", 1, 0)],
  [c("cr", "Slow reviews", 5, 0), c("ci", "Flaky tests", 3, 0)],
  names,
);

describe("unresolved flag", () => {
  it("is 'more than half', not 'at least half'", () => {
    expect(isMostlyUnresolved(4, 2)).toBe(false);
    expect(isMostlyUnresolved(4, 3)).toBe(true);
    expect(isMostlyUnresolved(0, 0)).toBe(false);
  });
});

describe("grouping", () => {
  const groups = groupPainPoints(normalWeek);
  it("groups by category and sorts categories and items by mentions desc", () => {
    expect(groups.map((g) => g.category)).toEqual(["Code review", "CI/CD automation"]);
    expect(groups[1].items.map((i) => i.theme)).toEqual(["Flaky tests", "CI cost"]);
  });
  it("formats the mentions line", () => {
    expect(mentionsLine({ count: 13, unresolved_count: 6 })).toBe("13 mentions · 6 flagged unresolved");
    expect(mentionsLine({ count: 1, unresolved_count: 0 })).toBe("1 mention · 0 flagged unresolved");
  });
  it("recomputes the flag from counts (stale stored flags are ignored)", () => {
    const stale = [{ ...firstWeek[0], unresolved: false, unresolved_count: 9, count: 10 }];
    expect(groupPainPoints(stale)[0].items[0].mostlyUnresolved).toBe(true);
  });
});

describe("email", () => {
  const html = renderBriefHtml("2026-10-06", "Short intro. Second sentence.", normalWeek, "https://dev.example");
  it("shows each category once, not as a prefix on every item", () => {
    expect(html.match(/Code review/g)).toHaveLength(1);
    expect(html.match(/CI\/CD automation/g)).toHaveLength(1);
    expect(html).not.toMatch(/Code review ·/);
  });
  it("has the mentions line, a link to the dashboard, and no leaked field names", () => {
    expect(html).toContain("13 mentions · 6 flagged unresolved");
    expect(html).toContain('href="https://dev.example"');
    expect(html).not.toMatch(FORBIDDEN);
  });
  it("flags mostly-unresolved items only", () => {
    expect(html).not.toContain("mostly unresolved"); // 6 of 13 is not more than half
    const flagged = renderBriefHtml("w", "x y.", firstWeek, null);
    expect(flagged.match(/mostly unresolved/g)).toHaveLength(1); // 7 of 13
    expect(flagged).not.toContain("View the full dashboard");
  });
  it("caps the email at 10 items and points to the dashboard for the rest", () => {
    const many = buildTrends(Array.from({ length: 14 }, (_, i) => c("cr", `Theme ${i}`, 20 - i)), [], names);
    const h = renderBriefHtml("w", "a b.", many, "https://d.example");
    expect(h.match(/<li /g)).toHaveLength(10);
    expect(h).toContain("+ 4 more pain points on the dashboard.");
    expect(h).toContain("14 pain points");
  });
  it("escapes html in model text", () => {
    expect(renderBriefHtml("w", "<script>x</script>", [], null)).not.toContain("<script>");
  });
});

describe("narrative", () => {
  it("fallback: first week says so in plain language, no trend talk, no leaks", () => {
    const t = buildFallbackNarrative(firstWeek);
    expect(t).toContain(FIRST_WEEK_SENTENCE);
    expect(t).toContain("Slow reviews");
    expect(t).not.toMatch(FORBIDDEN);
    expect(t.match(/[.!?](\s|$)/g)!.length).toBeLessThanOrEqual(3);
  });
  it("fallback: normal week names the biggest mover and counts new pain points separately", () => {
    const t = buildFallbackNarrative(normalWeek);
    expect(t).toContain('"Slow reviews" moved the most, up from 5 to 13');
    expect(t).toContain("1 pain point is new this week.");
    expect(t).not.toMatch(FORBIDDEN);
  });
  it("facts detect cold start and the biggest mover", () => {
    expect(computeFacts(firstWeek).firstWeek).toBe(true);
    const f = computeFacts(normalWeek);
    expect(f.firstWeek).toBe(false);
    expect(f.biggestMover).toMatchObject({ theme: "Slow reviews", direction: "up", was: 5 });
    expect(f.newCount).toBe(1);
  });
  it("prompt carries both cold-start cases, the hard rules, and only aggregates", () => {
    const first = buildBriefPrompt(firstWeek);
    expect(first).toContain(FIRST_WEEK_SENTENCE);
    expect(first).toMatch(/never write the words "null", "categorized as", or "baseline"/i);
    expect(first).toMatch(/no recommendations/i);
    const normal = buildBriefPrompt(normalWeek);
    expect(normal).toContain("how many pain points are new");
    expect(normal).not.toContain(FIRST_WEEK_SENTENCE.replace(/[;]/g, ""));
  });
  it("sanitizer rejects leaked words, recommendations, bullets, and a missing cold-start sentence", () => {
    expect(sanitizeNarrative("It has a null change. Another sentence.", false)).toBeNull();
    expect(sanitizeNarrative("Flaky is up. Compared to the baseline it grew.", false)).toBeNull();
    expect(sanitizeNarrative("It was categorized as new. Fine.", false)).toBeNull();
    expect(sanitizeNarrative("Slow reviews rose. You should prioritize it.", false)).toBeNull();
    expect(sanitizeNarrative("- a\n- b\n- c", false)).toBeNull();
    expect(sanitizeNarrative("Slow reviews led. Nothing else moved.", true)).toBeNull();
  });
  it("sanitizer trims to 3 sentences and strips markdown", () => {
    expect(sanitizeNarrative("**One.** Two. Three. Four. Five.", false)).toBe("One. Two. Three.");
  });
  it("generateBrief retries once on a rule-breaking answer, then falls back", async () => {
    const bad = vi.fn().mockResolvedValue("The baseline is null. And so on.");
    const r = await generateBrief(normalWeek, { pending: 0, warnings: [] }, bad);
    expect(bad).toHaveBeenCalledTimes(2);
    expect(r.usedFallback).toBe(true);
    expect(r.narrative).not.toMatch(FORBIDDEN);
    const good = vi.fn().mockResolvedValue("Slow reviews moved the most. 1 pain point is new this week.");
    expect((await generateBrief(normalWeek, { pending: 0, warnings: [] }, good)).usedFallback).toBe(false);
  });
});
