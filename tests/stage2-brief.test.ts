import { describe, expect, it, vi } from "vitest";
import { decideBriefWrite, isFrozen, type BriefDraft, type BriefRecord } from "@/lib/brief-policy";
import { runDigest, type EmailArgs } from "@/lib/pipeline";
import { MemoryStore } from "./helpers";
import { IN_P1, NOW_P1, NOW_P2, P1, deps, downModel, goodModel, hnAt, okSend } from "./stage2-helpers";

const cov = { sources: { hn: { status: "ok" as const, posts: 1 } }, comparison: { state: "no_prior" as const, reasons: [] } };
const draft = (over: Partial<BriefDraft> = {}): BriefDraft => ({ narrative: "N1. N2.", points: [], coverage: cov, pendingCount: 0, usedFallback: false, ...over });
const record = (over: Partial<BriefRecord> = {}): BriefRecord => ({ ...draft(), week_start: P1, version: 1, emailStatus: null, emailedVersion: null, createdAt: "t", ...over });

describe("brief persistence policy (pure)", () => {
  it("creates when nothing is saved", () => expect(decideBriefWrite(null, draft()).action).toBe("create"));
  it("keeps a delivered or being-delivered report, whatever the rerun says", () => {
    for (const emailStatus of ["sent", "sending"] as const) {
      expect(decideBriefWrite(record({ emailStatus }), draft({ narrative: "Different." })).action).toBe("keep");
      expect(isFrozen(record({ emailStatus }))).toBe(true);
    }
  });
  it("does not freeze reports that were never sent or whose send failed", () => {
    expect(isFrozen(record({ emailStatus: null }))).toBe(false);
    expect(isFrozen(record({ emailStatus: "failed" }))).toBe(false);
    expect(isFrozen(null)).toBe(false);
  });
  it("keeps the saved report when the rerun is less complete", () => {
    expect(decideBriefWrite(record({ pendingCount: 0 }), draft({ pendingCount: 3, narrative: "Other." })).action).toBe("keep");
  });
  it("keeps an AI narrative rather than replacing it with the fallback", () => {
    expect(decideBriefWrite(record({ usedFallback: false }), draft({ usedFallback: true, narrative: "Fallback." })).action).toBe("keep");
  });
  it("replaces when the rerun is at least as complete and different; leaves identical content alone", () => {
    expect(decideBriefWrite(record({ pendingCount: 4, usedFallback: true }), draft({ pendingCount: 0, narrative: "Better." })).action).toBe("replace");
    expect(decideBriefWrite(record({ pendingCount: 2 }), draft({ pendingCount: 2, narrative: "Changed." })).action).toBe("replace");
    expect(decideBriefWrite(record(), draft()).action).toBe("unchanged");
  });
  it("a fallback may replace a fallback", () => {
    expect(decideBriefWrite(record({ usedFallback: true }), draft({ usedFallback: true, narrative: "Newer fallback." })).action).toBe("replace");
  });
});

describe("P0: a delivered report is never silently overwritten", () => {
  it("a rerun after delivery keeps the narrative, version and delivery metadata", async () => {
    const store = new MemoryStore();
    const send = okSend();
    const first = await runDigest(deps(store, { sendEmail: send }));
    const delivered = { ...store.briefs.get(P1)! };
    expect(first).toMatchObject({ email: "sent", brief: { action: "create", version: 1 } });

    const model = async (p: string) => (p.includes("intro line") ? "A completely different narrative. Honestly." : goodModel()(p));
    const rerun = await runDigest(deps(store, { sendEmail: send, callModel: model, fetchers: { hn: hnAt(["a", IN_P1], ["more", IN_P1]) } }));

    expect(rerun.brief).toMatchObject({ action: "keep", version: 1 });
    expect(store.briefs.get(P1)!.narrative).toBe(delivered.narrative);
    expect(store.briefs.get(P1)!.version).toBe(1);
    expect(store.emails.get(P1)).toMatchObject({ status: "sent", emailedVersion: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(rerun.email).toBe("already_sent");
  });

  it("late data still reaches the aggregates, but not the delivered brief snapshot", async () => {
    const store = new MemoryStore();
    await runDigest(deps(store, { sendEmail: okSend() }));
    await runDigest(deps(store, { sendEmail: okSend(), fetchers: { hn: hnAt(["a", IN_P1], ["late", IN_P1]) } }));
    expect(store.aggregates.get(P1)![0].count).toBe(2);
    expect(store.briefs.get(P1)!.points[0].count).toBe(1); // what was delivered
  });

  it("does not even call the model for a narrative it would discard", async () => {
    const store = new MemoryStore();
    await runDigest(deps(store, { sendEmail: okSend() }));
    let narrativeCalls = 0;
    const model = async (p: string) => { if (p.includes("intro line")) narrativeCalls++; return goodModel()(p); };
    await runDigest(deps(store, { callModel: model, sendEmail: okSend(), fetchers: { hn: hnAt(["a", IN_P1], ["x", IN_P1]) } }));
    expect(narrativeCalls).toBe(0);
  });

  it("a report that is mid-delivery is also frozen", async () => {
    const store = new MemoryStore();
    await runDigest(deps(store));
    store.emails.set(P1, { status: "sending", claimedAt: Date.now() });
    const s = await runDigest(deps(store, { fetchers: { hn: hnAt(["a", IN_P1], ["x", IN_P1]) } }));
    expect(s.brief.action).toBe("keep");
  });
});

describe("P0: a stale or partial rerun cannot replace a better completed report", () => {
  it("a rerun with Gemini down keeps the AI narrative", async () => {
    const store = new MemoryStore();
    const first = await runDigest(deps(store));
    expect(first.usedFallbackNarrative).toBe(false);
    const aiNarrative = store.briefs.get(P1)!.narrative;
    const rerun = await runDigest(deps(store, { callModel: null }));
    expect(rerun.brief.action).toBe("keep");
    expect(store.briefs.get(P1)!.narrative).toBe(aiNarrative);
    expect(rerun.usedFallbackNarrative).toBe(false); // reports what is actually saved
  });

  it("a rerun that could not classify new data keeps the complete report", async () => {
    const store = new MemoryStore();
    await runDigest(deps(store));
    const rerun = await runDigest(deps(store, { callModel: downModel, fetchers: { hn: hnAt(["a", IN_P1], ["new", IN_P1]) } }));
    expect(rerun.pending).toBe(1);
    expect(rerun.brief.action).toBe("keep");
    expect(store.briefs.get(P1)!.pendingCount).toBe(0);
  });

  it("a more complete rerun replaces an earlier partial report and bumps the version", async () => {
    const store = new MemoryStore();
    const partial = await runDigest(deps(store, { callModel: downModel }));
    expect(partial).toMatchObject({ pending: 1, brief: { action: "create", version: 1 }, usedFallbackNarrative: true });
    const better = await runDigest(deps(store));
    expect(better.brief).toMatchObject({ action: "replace", version: 2 });
    expect(store.briefs.get(P1)).toMatchObject({ version: 2, pendingCount: 0, usedFallback: false });
  });

  it("an identical rerun changes nothing, not even the version", async () => {
    const store = new MemoryStore();
    await runDigest(deps(store));
    const again = await runDigest(deps(store));
    expect(again.brief).toMatchObject({ action: "unchanged", version: 1 });
  });

  it("compare-and-set: of two writers that both read version 1, only one wins", async () => {
    const store = new MemoryStore();
    await store.saveBrief(P1, draft(), null);
    const a = await store.saveBrief(P1, draft({ narrative: "A." }), 1);
    const b = await store.saveBrief(P1, draft({ narrative: "B." }), 1);
    expect([a.saved, b.saved]).toEqual([true, false]);
    expect(store.briefs.get(P1)!.narrative).toBe("A.");
    expect((await store.saveBrief(P1, draft(), null)).saved).toBe(false); // a second creator also loses
  });

  it("the pipeline treats a lost race as 'keep' and uses what is stored", async () => {
    const store = new MemoryStore();
    await runDigest(deps(store, { callModel: downModel })); // v1, partial
    const original = store.saveBrief.bind(store);
    store.saveBrief = async (w, d, v) => { await original(w, { ...d, narrative: "Racer's version. Wins." }, v); return original(w, d, v); };
    const s = await runDigest(deps(store));
    expect(s.brief.action).toBe("keep");
    expect(store.briefs.get(P1)!.narrative).toBe("Racer's version. Wins.");
  });
});

describe("P0: the dashboard and the email are the same saved report version", () => {
  it("the email is built from the saved brief, version included", async () => {
    const store = new MemoryStore();
    const seen: EmailArgs[] = [];
    await runDigest(deps(store, { sendEmail: async (a) => { seen.push(a); return "sent"; } }));
    const saved = store.briefs.get(P1)!;
    expect(seen[0]).toMatchObject({ weekStart: P1, version: saved.version, narrative: saved.narrative });
    expect(seen[0].points).toEqual(saved.points);
    expect(seen[0].comparison).toEqual(saved.coverage.comparison);
    expect(store.emails.get(P1)).toMatchObject({ emailedVersion: saved.version });
  });

  it("after a genuinely failed send, a better rerun is what gets retried, as a new version", async () => {
    const store = new MemoryStore();
    const versions: number[] = [];
    const fail = vi.fn(async () => { throw new Error("resend 500"); });
    await runDigest(deps(store, { callModel: downModel, sendEmail: fail })); // v1 (fallback), send fails
    expect(store.emails.get(P1)?.status).toBe("failed");
    const retry = await runDigest(deps(store, { sendEmail: async (a) => { versions.push(a.version); return { status: "sent", messageId: "m1" }; } }));
    expect(retry).toMatchObject({ email: "sent", brief: { action: "replace", version: 2 } });
    expect(versions).toEqual([2]);
    expect(store.emails.get(P1)).toMatchObject({ status: "sent", emailedVersion: 2, messageId: "m1" });
  });

  it("a failed send with nothing better to say retries the same version", async () => {
    const store = new MemoryStore();
    const versions: number[] = [];
    await runDigest(deps(store, { sendEmail: async () => { throw new Error("boom"); } }));
    await runDigest(deps(store, { sendEmail: async (a) => { versions.push(a.version); return "sent"; } }));
    expect(versions).toEqual([1]);
  });

  it("records the provider message id without breaking the plain 'sent' result", async () => {
    const store = new MemoryStore();
    await runDigest(deps(store, { sendEmail: async () => ({ status: "sent", messageId: "msg_1" }) }));
    expect(store.emails.get(P1)).toMatchObject({ status: "sent", messageId: "msg_1" });
  });
});

describe("P0: backfills never send scheduled emails and never disturb delivery state", () => {
  it("a backfill of a delivered period sends nothing and leaves it untouched", async () => {
    const store = new MemoryStore();
    await runDigest(deps(store, { sendEmail: okSend() }));
    const before = JSON.stringify([store.briefs.get(P1), store.emails.get(P1)]);
    const send = okSend();
    const s = await runDigest(deps(store, { trigger: "backfill", sendEmail: send, now: NOW_P1 }));
    expect(send).not.toHaveBeenCalled();
    expect(s.email).toBe("not_attempted");
    expect(JSON.stringify([store.briefs.get(P1), store.emails.get(P1)])).toBe(before);
  });
  it("a backfill of an undelivered period may update its saved report but still never emails", async () => {
    const store = new MemoryStore();
    await runDigest(deps(store, { callModel: downModel }));
    const send = okSend();
    const s = await runDigest(deps(store, { trigger: "backfill", sendEmail: send }));
    expect(s.brief.action).toBe("replace");
    expect(send).not.toHaveBeenCalled();
    expect(store.emails.get(P1)).toBeUndefined();
  });
  it("a later scheduled run for a new week is unaffected by an earlier week being delivered", async () => {
    const store = new MemoryStore();
    await runDigest(deps(store, { sendEmail: okSend() }));
    const send = okSend();
    const s = await runDigest(deps(store, { now: NOW_P2, sendEmail: send }));
    expect(s.email).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
