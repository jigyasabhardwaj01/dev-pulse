import { describe, expect, it } from "vitest";
import { runDigest, type Deps } from "@/lib/pipeline";
import { sendBriefEmail } from "@/lib/email";
import { analysisFor } from "@/lib/analysis-source";
import { buildFridayBrief } from "@/lib/friday-brief";
import { buildPack, packFreshness } from "@/lib/pack";
import { castVote, decide, decisionsDigest, setItemState, shortlist, viewItem, type PainPointLookup } from "@/lib/team";
import { addTerm, setSensitivity } from "@/lib/watch-service";
import { formatPeriod } from "@/lib/view";
import type { Session } from "@/lib/auth";
import { MemoryStore, post } from "./helpers";
import { memoryTeamStore } from "./team-helpers";

/*
 * The whole path with real application logic and mocked providers (sources, model, Resend):
 * watchlist -> collection -> classification -> weekly analysis -> saved report -> email -> shortlist -> votes -> owner decision -> pack.
 * This is a MOCK-BASED test: it proves the pieces fit together, not that any live provider works.
 */
const owner: Session = { email: "owner@team.test", role: "owner" };
const a: Session = { email: "a@team.test", role: "member" };
const b: Session = { email: "b@team.test", role: "member" };
const NOW = new Date("2026-10-09T00:30:00Z"); // Fri 06:00 IST
const WEEK = "2026-10-02";
const IN = (d: number) => `2026-10-0${d}T10:00:00Z`;

const model = async (prompt: string) => {
  if (prompt.includes("intro line")) return "Reviews are noisy this week. Little else stands out.";
  const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
  return JSON.stringify(Array.from({ length: n }, (_, index) => ({ index, relevant: true, theme: "False positives", problem: "Noisy bot comments.", kind: "existing_problem", resolution: "open", confidence: 0.85, excerpt: "review bot", reason: "r", sentiment: "negative" })));
};

describe("watchlist → … → Monday pack (mocked providers)", () => {
  it("carries one reporting period and one report version from collection to the pack", async () => {
    const store = new MemoryStore();
    const team = memoryTeamStore();

    // 1. the owner configures the watchlist through the real service (audited)
    const added = await addTerm(team.store, owner, ["t1"], { topicId: "t1", term: "review bot", kind: "include" });
    expect(added.ok).toBe(true);
    await setSensitivity(team.store, owner, "balanced");
    store.watch = { sensitivity: await team.store.getSensitivity(), terms: (await team.store.getTerms()).map((t) => ({ ...t })) };

    // 2. a scheduled run collects, classifies, analyses, saves and emails
    const emails: { subject: string; html: string; key: string }[] = [];
    const resend = (async (_u: string, i: RequestInit) => { const body = JSON.parse(String(i.body)); emails.push({ subject: body.subject, html: body.html, key: (i.headers as Record<string, string>)["idempotency-key"] }); return new Response(JSON.stringify({ id: "m1" }), { status: 200 }); }) as never;
    const deps: Deps = {
      store, now: NOW, callModel: model, sleep: async () => {}, trigger: "scheduled",
      fetchers: { hn: async () => ["comments on generated files", "approvals stuck behind noisy warnings", "style nitpicks drowning real defects", "false alarms every single morning"].map((t, i0) => { const i = i0 + 1; return post({ source_id: `h${i}`, posted_at: IN(i + 2), title: `review bot ${t}`, url: `https://news.test/${i}`, author: `u${i}` }); }) },
      sendEmail: (args) => sendBriefEmail(args, { RESEND_API_KEY: "k", DIGEST_TO_EMAIL: "owner@team.test", APP_URL: "https://app.test" } as never, resend),
    };
    const summary = await runDigest(deps);
    expect(summary.weekStart).toBe(WEEK);
    expect(summary).toMatchObject({ newPosts: 4, classified: 4, pending: 0, email: "sent", brief: { version: 1 } });

    // 3. the saved report carries a sealed analysis and the email was built from THAT saved version
    const saved = (await store.getBrief(WEEK))!;
    expect(saved.analysis?.painPoints.map((p) => p.theme)).toEqual(["False positives"]);
    expect(saved.analysis?.top).toHaveLength(1); // 4 discussions with verified excerpts: rankable
    expect(emails).toHaveLength(1);
    expect(emails[0].key).toBe(`dev-pulse-brief-${WEEK}-v${saved.version}`);
    expect(emails[0].html).toContain("Top pain points (observed)");
    expect(emails[0].html).toContain("False positives");
    expect(emails[0].html).toContain(`https://app.test/reports/${WEEK}`);
    expect(emails[0].html).toContain("not findings"); // suggestions are labelled
    expect(saved.emailStatus).toBe("sent");

    // 4. a repeated trigger changes nothing: no second email, no new version
    const again = await runDigest(deps);
    expect(again.email).toBe("already_sent");
    expect(emails).toHaveLength(1);
    expect((await store.getBrief(WEEK))?.version).toBe(saved.version);

    // 5. a member shortlists a real pain point from the sealed analysis; an invented one is refused
    const lookup: PainPointLookup = async (w, t, theme) => {
      const an = await analysisFor(store as never, team.store, w);
      const p = an.kind === "none" ? undefined : an.analysis.painPoints.find((x) => x.topic_id === t && x.theme === theme);
      return p ? { links: p.links, discussions: p.discussions } : null;
    };
    expect(await shortlist(team.store, a, lookup, { weekStart: WEEK, topicId: "t1", theme: "Invented", reason: "invented theme" })).toMatchObject({ ok: false, status: 404 });
    const sl = await shortlist(team.store, a, lookup, { weekStart: WEEK, topicId: "t1", theme: "False positives", reason: "Our bot does this" });
    expect(sl).toMatchObject({ ok: true, created: true });
    const id = (sl as { item: { id: string } }).item.id;

    // 6. owner opens voting; two members vote (one changes their mind); a duplicate vote is just a change
    await setItemState(team.store, owner, id, "open_for_votes");
    await castVote(team.store, a, id, "prioritise"); await castVote(team.store, b, id, "park"); await castVote(team.store, b, id, "park");
    expect(team.state.votes).toHaveLength(2);

    // 7. the owner decides, against the vote; AI ranking, votes and decision stay separate and auditable
    const dec = await decide(team.store, owner, id, { outcome: "prioritised", rationale: "Cheap to fix and visible", followup: true });
    expect(dec).toMatchObject({ ok: true, tally: { prioritise: 1, park: 1, total: 2 } });
    const view = await viewItem(team.store, owner, (await team.store.getItem(id))!);
    expect(view.current).toMatchObject({ outcome: "prioritised", decided_by: "owner@team.test", vote_snapshot: { prioritise: 1, park: 1 } });
    expect(view.item.state).toBe("prioritised");

    // 8. the Monday pack comes from the SAME saved report week and the final decision, with suggestions kept apart
    const an = await analysisFor(store as never, team.store, WEEK);
    expect(an.kind).toBe("sealed");
    const brief = buildFridayBrief({ weekStart: WEEK, periodLabel: formatPeriod(WEEK), analysis: (an as unknown as { analysis: never }).analysis, narrative: saved.narrative, usedFallback: saved.usedFallback });
    const { pack, digest } = buildPack({ now: NOW, brief, items: await team.store.listItems(), decisions: await team.store.listDecisions() });
    expect(pack).toMatchObject({ state: "ready", weekStart: WEEK });
    expect(pack.committed.map((c) => c.theme)).toEqual(["False positives"]);
    expect(pack.committed[0]).toMatchObject({ decidedBy: "owner@team.test", rationale: "Cheap to fix and visible", followup: true });
    expect(pack.suggestions.label).toMatch(/not approved work/);
    expect(packFreshness({ digest, weekStart: WEEK }, decisionsDigest(await team.store.listDecisions()), WEEK)).toBe("current");

    // 9. a later decision makes the saved pack visibly stale instead of silently wrong
    await decide(team.store, owner, id, { outcome: "parked", rationale: "Deferred" });
    expect(packFreshness({ digest, weekStart: WEEK }, decisionsDigest(await team.store.listDecisions()), WEEK)).toBe("stale_decisions");

    // 10. the next reporting cycle compares against this one only when coverage allows (here: the first week, so no trend is asserted)
    expect(saved.coverage.comparison.state).not.toBe("comparable");
  });
});
