import { describe, expect, it } from "vitest";
import { analyse, type EvidencePost } from "@/lib/analysis";
import { buildFridayBrief, BRIEF_DISCLAIMER } from "@/lib/friday-brief";
import { renderFridayHtml, safeHref, sendBriefEmail } from "@/lib/email";
import { buildTrends } from "@/lib/trend";
import type { Coverage } from "@/lib/coverage";

let n = 0;
const ev = (o: Partial<EvidencePost> = {}): EvidencePost => { const i = ++n; return { id: `p${i}`, source: i % 2 ? "hn" : "github", topic_id: "t1", theme: "Slow reviews", title: `Distinct discussion title number ${i}`, url: `https://x.test/${i}`, author: `a${i}`, posted_at: "2026-10-03T10:00:00Z", confidence: 0.8, excerpt: "words", resolution: "open", unresolved: true, flags: [], ...o }; };
const COV: Coverage = { hn: { status: "ok", posts: 10 }, stackoverflow: { status: "ok", posts: 1 }, reddit: { status: "ok", posts: 1 }, github: { status: "ok", posts: 1 } };
const analysis = (posts: EvidencePost[], comparison: "comparable" | "unavailable" = "comparable") =>
  analyse({ weekStart: "2026-10-09", posts, trends: buildTrends([{ topic_id: "t1", theme: "Slow reviews", count: posts.length, unresolved: posts.length }], [], { t1: "Code review" }), topicNames: { t1: "Code review" }, coverage: COV, comparison, prior: [] } as never);
const mk = (posts: EvidencePost[], narrative = "Reviews are slow.") => buildFridayBrief({ weekStart: "2026-10-09", periodLabel: "Fri 9 Oct – Thu 15 Oct", analysis: analysis(posts), narrative, usedFallback: false });

describe("buildFridayBrief", () => {
  it("keeps observed, interpretation and suggestions apart and labels suggestions", () => {
    const b = mk([ev(), ev(), ev()]);
    expect(b.observed.top).toHaveLength(1);
    expect(b.observed.top[0].links.length).toBeGreaterThan(0);
    expect(b.interpretation.executiveSummary).toBe("Reviews are slow.");
    expect(b.suggestions.label).toMatch(/not findings/);
    expect(b.disclaimer).toBe(BRIEF_DISCLAIMER);
  });
  it("says baseline is unavailable instead of inventing one", () => {
    const b = mk([ev(), ev()]);
    expect(b.observed.vsBaseline.available).toBe(false);
    expect(b.observed.vsBaseline.unavailableBecause).toBeTruthy();
    expect(b.observed.vsBaseline.lines).toEqual([]);
  });
  it("ranks nothing when evidence is too thin", () => {
    const b = mk([ev()]);
    expect(b.observed.top).toEqual([]);
  });
  it("is deterministic: same saved analysis, same brief", () => {
    const a = analysis([ev({ id: "a" }), ev({ id: "b" })]);
    const args = { weekStart: "2026-10-09", periodLabel: "x", analysis: a, narrative: "n", usedFallback: true };
    expect(buildFridayBrief(args)).toEqual(buildFridayBrief(args));
  });
});

describe("renderFridayHtml", () => {
  it("renders sections, links and the disclaimer, and escapes hostile text", () => {
    const posts = [ev({ title: "<script>alert(1)</script> hostile", excerpt: "x" }), ev(), ev()];
    const html = renderFridayHtml(mk(posts, "<img src=x onerror=alert(1)> summary"), "https://app.test");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Top pain points (observed)");
    expect(html).toContain("Not available:");
    expect(html).toContain("not findings");
    expect(html).toContain(BRIEF_DISCLAIMER);
    expect(html).toContain("https://app.test/reports/2026-10-09");
  });
  it("never renders unsafe URLs as links", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
    expect(safeHref("https://ok.test/a")).toBe("https://ok.test/a");
    const html = renderFridayHtml(mk([ev({ url: "javascript:alert(1)" }), ev({ url: "javascript:alert(2)" }), ev({ url: "javascript:alert(3)" })]), null);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("/reports/");
  });
});

describe("sendBriefEmail with a saved brief", () => {
  it("sends the structured brief with the unchanged idempotency key, sender and subject", async () => {
    let init: RequestInit | undefined;
    const f = (async (_u: unknown, i: RequestInit) => { init = i; return new Response(JSON.stringify({ id: "m1" }), { status: 200 }); }) as never;
    const r = await sendBriefEmail({ weekStart: "2026-10-09", version: 3, narrative: "n", points: [], brief: mk([ev(), ev()]) }, { RESEND_API_KEY: "k", DIGEST_TO_EMAIL: "to@x.test" } as never, f);
    expect(r).toEqual({ status: "sent", messageId: "m1" });
    const body = JSON.parse(String(init!.body));
    expect((init!.headers as Record<string, string>)["idempotency-key"]).toBe("dev-pulse-brief-2026-10-09-v3");
    expect(body.from).toBe("JARVIS <onboarding@resend.dev>");
    expect(body.subject).toBe("JARVIS: developer pain points, week of 2026-10-09");
    expect(body.html).toContain("Top pain points (observed)");
  });
});
