import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { runDigest, type Deps, type EmailArgs } from "@/lib/pipeline";
import { problemsFrom } from "@/lib/insights-view";
import ProblemCard from "@/components/ProblemCard";
import { buildFridayBrief } from "@/lib/friday-brief";
import { renderFridayHtml } from "@/lib/email";
import { MemoryStore, TOPIC, post } from "./helpers";

/*
 * ISOLATED FIXTURES, not production data: fixture posts and a fixture model stand in for the sources and the AI, so the whole chain
 * collect -> clean/dedupe -> classify -> group -> rank -> save report -> email -> dashboard view is exercised in one test.
 */
const NOW = new Date("2026-10-09T03:30:00Z"); // Friday 09:00 IST: the period just ended is 2026-10-02 .. 2026-10-08
const WEEK = "2026-10-02";
const IN = (d: number) => `2026-10-0${d}T10:00:00Z`;
const titleOf = (prompt: string, i: number) => prompt.split("\n").find((l) => l.startsWith(`[${i}]`)) ?? "";
const goodModel = (excerptFor: (line: string) => string | null = () => "code review") => async (prompt: string) => {
  if (prompt.includes("intro line")) return "Slow reviews led the week.";
  const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
  return JSON.stringify(Array.from({ length: n }, (_, index) => ({ index, relevant: true, theme: "Slow reviews", problem: "Reviews take days.", kind: "existing_problem", resolution: "open", confidence: 0.85, excerpt: excerptFor(titleOf(prompt, index)), reason: "r", sentiment: "negative" })));
};
const hn = async () => [
  post({ source_id: "h1", posted_at: IN(3), title: "code review takes days on our team", url: "https://news.test/1", author: "ann" }),
  post({ source_id: "h2", posted_at: IN(4), title: "code review queue never empties for us", url: "https://news.test/2", author: "bob" }),
  post({ source_id: "h3", posted_at: IN(5), title: "code review comments arrive far too late", url: "https://news.test/3", author: "cy" }),
  post({ source_id: "h4", posted_at: IN(5), title: "code review comments arrive far too late", url: "https://news.test/3b", author: "cy" }), // exact repeat: same author, same title
];
const gh = async () => [post({ source: "github", source_id: "g1", posted_at: IN(6), title: "code review bot is too noisy here", url: "https://github.test/1", author: "dee" })];
const sent = () => vi.fn(async (_a: EmailArgs) => ({ status: "sent" as const, messageId: "m1" }));
const deps = (store: MemoryStore, over: Partial<Deps> = {}): Deps => ({ store, now: NOW, callModel: goodModel(), fetchers: { hn, github: gh }, sleep: async () => {}, invokedBy: "vercel-cron", ...over });

describe("the whole workflow on fixtures", () => {
  it("collects, dedupes, classifies, ranks, SAVES the report BEFORE emailing, and the dashboard view reads the same saved data", async () => {
    const store = new MemoryStore();
    const email = vi.fn(async (a: EmailArgs) => { expect(store.briefs.has(WEEK)).toBe(true); return { status: "sent" as const, messageId: "m1" }; }); // saved first
    const s = await runDigest(deps(store, { sendEmail: email }));

    // collection -> store: urls, authors, dates, source ids are kept
    expect(s.weekStart).toBe(WEEK);
    expect(store.posts.map((p) => p.source_id).sort()).toEqual(["g1", "h1", "h2", "h3", "h4"]);
    expect(store.posts.find((p) => p.source_id === "h1")).toMatchObject({ url: "https://news.test/1", author: "ann", posted_at: IN(3), source: "hn" });
    // classification -> store: theme, confidence, excerpt, resolution
    expect(store.posts.every((p) => p.theme === "Slow reviews" && p.excerpt === "code review" && p.confidence === 0.85)).toBe(true);
    expect(s.classified).toBe(5);
    expect(s.diagnostics.find((d) => d.code === "RUN_INVOKED")).toMatchObject({ detail: { by: "vercel-cron" } });

    // ranking -> saved, sealed analysis
    const saved = await store.getBrief(WEEK);
    const a = saved!.analysis!;
    const p = a.painPoints.find((x) => x.theme === "Slow reviews")!;
    expect(p.rawPosts).toBe(5);
    expect(p.discussions).toBe(4); // the exact repeat is not an independent discussion
    expect(a.top).toContain(p.key);
    expect(p.links.every((l) => l.url && l.excerpt)).toBe(true);

    // email: exactly once, from the saved version
    expect(email).toHaveBeenCalledTimes(1);
    expect(s.email).toBe("sent");
    expect(store.emails.get(WEEK)?.status).toBe("sent");

    // dashboard view of the saved analysis, and the email body, carry the same evidence
    const view = problemsFrom(a, WEEK).supported[0];
    expect(view).toMatchObject({ rank: 1, discussions: 4, supported: true });
    const card = renderToStaticMarkup(<ProblemCard p={view} />);
    expect(card).toContain("https://news.test/"); expect(card).toContain("Suggested next step");
    const brief = buildFridayBrief({ weekStart: WEEK, periodLabel: "p", analysis: a, narrative: saved!.narrative, usedFallback: saved!.usedFallback });
    expect(renderFridayHtml(brief, "https://app.test")).toContain("Slow reviews");
  });

  it("a second run for the same period neither re-sends nor rewrites the delivered report", async () => {
    const store = new MemoryStore();
    const email = sent();
    await runDigest(deps(store, { sendEmail: email }));
    const before = JSON.stringify(await store.getBrief(WEEK));
    const again = await runDigest(deps(store, { sendEmail: email, now: new Date(NOW.getTime() + 3_600_000) }));
    expect(email).toHaveBeenCalledTimes(1);
    expect(again.email).toBe("already_sent");
    expect(JSON.stringify(await store.getBrief(WEEK))).toBe(before);
  });

  it("a Friday run with no AI configured saves the report but WITHHOLDS the email, and is not shown as fully successful", async () => {
    const store = new MemoryStore();
    const email = sent();
    const s = await runDigest(deps(store, { callModel: null, sendEmail: email }));
    expect(email).not.toHaveBeenCalled();
    expect(s.email).not.toBe("sent");
    expect(s.status).not.toBe("succeeded");
    expect(s.diagnostics.map((d) => d.code)).toContain("EMAIL_WITHHELD");
  });

  it("an AI that fails every call leaves posts unclassified, ranks nothing, and does not claim success", async () => {
    const store = new MemoryStore();
    const email = sent();
    const s = await runDigest(deps(store, { callModel: async () => { throw new Error("503 upstream"); }, sendEmail: email }));
    expect(store.posts.every((p) => p.theme === null)).toBe(true);
    expect(s.status).not.toBe("succeeded");
    expect(email).not.toHaveBeenCalledWith(expect.objectContaining({ brief: expect.objectContaining({ observed: expect.objectContaining({ top: expect.arrayContaining([expect.anything()]) }) }) }));
  });

  it("an excerpt that is not in the post is not accepted as evidence, so nothing is ranked on it", async () => {
    const store = new MemoryStore();
    await runDigest(deps(store, { callModel: goodModel(() => "a quote that appears nowhere in the post"), sendEmail: sent() }));
    const a = (await store.getBrief(WEEK))!.analysis!;
    const p = a.painPoints.find((x) => x.theme === "Slow reviews");
    expect(p?.evidence.withExcerpt ?? 0).toBe(0);
    expect(a.top).toEqual([]);
  });

  it("a source that fails is reported as a gap, never as zero posts, and the other source still produces a report", async () => {
    const store = new MemoryStore();
    const s = await runDigest(deps(store, { fetchers: { hn, github: async () => { throw new Error("github down"); } }, sendEmail: sent() }));
    expect(s.sources.github?.status).toBe("error");
    expect(s.sources.hn?.status).toBe("ok");
    expect(s.status).not.toBe("succeeded");
    expect((await store.getBrief(WEEK))!.coverage?.sources.github?.status).toBe("error");
  });

  it("the period is the seven complete IST days before Friday, wherever in the Friday the run starts", async () => {
    for (const t of ["2026-10-09T00:30:00Z", "2026-10-09T01:29:00Z", "2026-10-09T18:00:00Z"]) {
      const s = await runDigest(deps(new MemoryStore(), { now: new Date(t) }));
      expect(s.weekStart).toBe(WEEK);
      expect(s.periodStart).toBe("2026-10-01T18:30:00.000Z"); expect(s.periodEnd).toBe("2026-10-08T18:30:00.000Z");
    }
  });

  it("an empty week still saves a report and says nothing was found, ranking nothing", async () => {
    const store = new MemoryStore();
    const s = await runDigest(deps(store, { fetchers: { hn: async () => [] }, sendEmail: sent() }));
    const a = (await store.getBrief(WEEK))!.analysis!;
    expect(a.painPoints).toEqual([]); expect(a.top).toEqual([]);
    expect(s.newPosts).toBe(0);
  });
});
