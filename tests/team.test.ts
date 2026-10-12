import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, cookieValue, linkToken, roleOf, rosterFromEnv, sameOrigin, sameOriginJson, sessionFrom, sessionToken, sign, verify } from "@/lib/auth";
import { GENERIC_SENT, confirmLink, requestLink } from "@/lib/auth-flow";
import { castVote, decide, decisionsDigest, setItemState, shortlist, tally, viewItem, withdrawVote, type PainPointLookup } from "@/lib/team";
import { addTerm, editTerm, removeTerm, setSensitivity } from "@/lib/watch-service";
import { buildPack, packFreshness } from "@/lib/pack";
import { MAX_PER_DAY, alertFor, alertHtml, sendFailureAlert, type AlertRun } from "@/lib/alerts";
import { memoryTeamStore } from "./team-helpers";
import type { Session } from "@/lib/auth";
import type { WatchTerm } from "@/lib/watchlist";

const SECRET = "test-secret-with-more-than-16-chars";
const ENV = { SESSION_SECRET: SECRET, DIGEST_TO_EMAIL: "Owner@Team.test", JARVIS_TEAM_EMAILS: "a@team.test, B@team.test,owner@team.test, not-an-email", RESEND_API_KEY: "k", APP_URL: "https://app.test/" } as unknown as NodeJS.ProcessEnv;
const NOW = new Date("2026-10-16T05:00:00Z");
const owner: Session = { email: "owner@team.test", role: "owner" };
const a: Session = { email: "a@team.test", role: "member" };
const b: Session = { email: "b@team.test", role: "member" };
const lookup: PainPointLookup = async (_w, _t, theme) => (theme === "Slow reviews" ? { links: [], discussions: 4 } : null);

describe("roster and roles", () => {
  it("owner defaults to the approved recipient; members come from the list; duplicates, the owner and junk are dropped", () => {
    expect(rosterFromEnv(ENV)).toEqual({ owner: "owner@team.test", members: ["a@team.test", "b@team.test"] });
    expect(rosterFromEnv({ ...ENV, JARVIS_OWNER_EMAIL: "boss@team.test" } as never).owner).toBe("boss@team.test");
    expect(rosterFromEnv({} as never)).toEqual({ owner: null, members: [] });
  });
  it("an address not on the roster has no role; matching ignores case", () => {
    const r = rosterFromEnv(ENV);
    expect(roleOf("OWNER@team.test", r)).toBe("owner");
    expect(roleOf("a@team.test", r)).toBe("member");
    expect(roleOf("stranger@x.test", r)).toBeNull();
  });
});

describe("tokens and sessions", () => {
  it("round-trips a session and derives the role from the roster, not the cookie", () => {
    const c = `${SESSION_COOKIE}=${sessionToken("a@team.test", SECRET, NOW.getTime())}`;
    expect(sessionFrom(c, ENV, NOW.getTime())).toEqual({ email: "a@team.test", role: "member" });
    // the same cookie stops working the moment the person leaves the roster
    expect(sessionFrom(c, { ...ENV, JARVIS_TEAM_EMAILS: "" } as never, NOW.getTime())).toBeNull();
  });
  it("rejects tampering, a wrong secret, an expired token, the wrong kind, and a missing or short secret", () => {
    const t = sessionToken("a@team.test", SECRET, NOW.getTime());
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "s", e: "owner@team.test", x: 9999999999 })).toString("base64url");
    expect(verify(`${forged}.${sig}`, SECRET, "s", NOW.getTime())).toBeNull();
    expect(verify(`${body}.${sig}x`, SECRET, "s", NOW.getTime())).toBeNull();
    expect(verify(t, "another-secret-another-secret", "s", NOW.getTime())).toBeNull();
    expect(verify(t, SECRET, "s", NOW.getTime() + 8 * 24 * 3600_000)).toBeNull();
    expect(verify(t, SECRET, "l", NOW.getTime())).toBeNull(); // a session is not a sign-in link
    expect(verify(linkToken("a@team.test", "n", SECRET, NOW.getTime()), SECRET, "s", NOW.getTime())).toBeNull(); // nor a link a session
    expect(verify(t, undefined, "s", NOW.getTime())).toBeNull();
    expect(verify(t, "short", "s", NOW.getTime())).toBeNull();
    expect(verify("garbage", SECRET, "s", NOW.getTime())).toBeNull();
    expect(sessionFrom(`${SESSION_COOKIE}=${sign({ k: "s", e: "x@x.test", x: 9999999999 }, SECRET)}`, ENV, NOW.getTime())).toBeNull(); // signed but not on the roster
  });
  it("reads only the named cookie", () => {
    expect(cookieValue("x=1; jarvis_session=abc; y=2")).toBe("abc");
    expect(cookieValue("xjarvis_session=abc")).toBeNull();
    expect(cookieValue(null)).toBeNull();
  });
  it("same-origin checks demand an Origin that matches, and JSON for API writes", () => {
    const mk = (origin: string | null, ct = "application/json") => new Request("https://app.test/api/x", { method: "POST", headers: { ...(origin ? { origin } : {}), "content-type": ct } });
    expect(sameOriginJson(mk("https://app.test"), ENV)).toBe(true);
    expect(sameOriginJson(mk("https://evil.test"), ENV)).toBe(false);
    expect(sameOriginJson(mk(null), ENV)).toBe(false);
    expect(sameOriginJson(mk("https://app.test", "text/plain"), ENV)).toBe(false);
    expect(sameOriginJson(mk("https://app.test", "application/x-www-form-urlencoded"), ENV)).toBe(false);
    expect(sameOrigin(mk("https://app.test", "application/x-www-form-urlencoded"), ENV)).toBe(true);
    expect(sameOrigin(mk("https://evil.test"), ENV)).toBe(false);
  });
});

describe("magic-link sign-in", () => {
  const sent = () => { const calls: { to: string[]; html: string }[] = []; const f = (async (_u: unknown, i: RequestInit) => { const b = JSON.parse(String(i.body)); calls.push({ to: b.to, html: b.html }); return new Response("{}", { status: 200 }); }) as never; return { calls, f }; };
  const tokenFrom = (html: string) => decodeURIComponent(/token=([^"]+)"/.exec(html)![1]);

  it("answers identically for roster and non-roster addresses, and only emails the roster", async () => {
    const { store } = memoryTeamStore(); const x = sent();
    const yes = await requestLink(store, "A@team.test", ENV, x.f, NOW);
    const no = await requestLink(store, "stranger@x.test", ENV, x.f, NOW);
    expect(yes).toEqual(no);
    expect(yes.message).toBe(GENERIC_SENT);
    expect(x.calls).toHaveLength(1);
    expect(x.calls[0].to).toEqual(["a@team.test"]);
  });
  it("a link works exactly once", async () => {
    const { store } = memoryTeamStore(); const x = sent();
    await requestLink(store, "a@team.test", ENV, x.f, NOW);
    const t = tokenFrom(x.calls[0].html);
    const cookie = await confirmLink(store, t, ENV, NOW);
    expect(cookie).toBeTruthy();
    expect(sessionFrom(`${SESSION_COOKIE}=${cookie}`, ENV, NOW.getTime())?.email).toBe("a@team.test");
    expect(await confirmLink(store, t, ENV, NOW)).toBeNull(); // replay
  });
  it("an expired link, a forged link and a link for someone removed from the roster all fail", async () => {
    const { store } = memoryTeamStore(); const x = sent();
    await requestLink(store, "a@team.test", ENV, x.f, NOW);
    const t = tokenFrom(x.calls[0].html);
    expect(await confirmLink(store, t, ENV, new Date(NOW.getTime() + 16 * 60_000))).toBeNull();
    expect(await confirmLink(store, t + "x", ENV, NOW)).toBeNull();
    expect(await confirmLink(store, t, { ...ENV, JARVIS_TEAM_EMAILS: "" } as never, NOW)).toBeNull();
  });
  it("is bounded per address, validates input, and is off when not configured", async () => {
    const { store } = memoryTeamStore(); const x = sent();
    for (let i = 0; i < 6; i++) await requestLink(store, "a@team.test", ENV, x.f, NOW);
    expect(x.calls).toHaveLength(3);
    expect((await requestLink(store, "nope", ENV, x.f, NOW)).status).toBe(400);
    expect((await requestLink(store, "a@team.test", { ...ENV, SESSION_SECRET: "" } as never, x.f, NOW)).status).toBe(503);
  });
  it("a provider failure still gives the generic answer and leaks nothing", async () => {
    const { store } = memoryTeamStore();
    const r = await requestLink(store, "a@team.test", ENV, (async () => { throw new Error("boom key=sk-123"); }) as never, NOW);
    expect(r).toEqual({ status: 200, message: GENERIC_SENT });
  });
});

describe("shortlist", () => {
  it("shortlists a real pain point with a reason and records who did it", async () => {
    const { store, state } = memoryTeamStore();
    const r = await shortlist(store, a, lookup, { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: "Our PRs wait days" });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(state.items[0]).toMatchObject({ created_by: "a@team.test", state: "under_review", reason: "Our PRs wait days" });
    expect(state.events[0]).toMatchObject({ actor: "a@team.test", action: "shortlisted" });
  });
  it("never creates a duplicate: repeating returns the same item and says so", async () => {
    const { store, state } = memoryTeamStore();
    const body = { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: "why" };
    const first = await shortlist(store, a, lookup, body);
    const again = await shortlist(store, b, lookup, body);
    expect(again).toMatchObject({ ok: true, created: false });
    expect((again as { item: { id: string } }).item.id).toBe((first as { item: { id: string } }).item.id);
    expect(state.items).toHaveLength(1);
  });
  it("refuses an invented pain point, a missing reason and malformed input", async () => {
    const { store, state } = memoryTeamStore();
    expect(await shortlist(store, a, lookup, { weekStart: "2026-10-09", topicId: "t1", theme: "Made up", reason: "why" })).toMatchObject({ ok: false, status: 404 });
    expect(await shortlist(store, a, lookup, { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: " " })).toMatchObject({ ok: false, status: 400 });
    expect(await shortlist(store, a, lookup, { weekStart: "soon", topicId: "t1", theme: "Slow reviews", reason: "why" })).toMatchObject({ ok: false, status: 400 });
    expect(await shortlist(store, a, lookup, { weekStart: 5, topicId: {}, theme: [], reason: null } as never)).toMatchObject({ ok: false, status: 400 });
    expect(state.items).toHaveLength(0);
  });
});

async function open() {
  const t = memoryTeamStore();
  const r = await shortlist(t.store, a, lookup, { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: "why" });
  const id = (r as { item: { id: string } }).item.id;
  return { ...t, id };
}

describe("voting", () => {
  it("only an owner can open voting; a member cannot", async () => {
    const { store, id } = await open();
    expect(await setItemState(store, a, id, "open_for_votes")).toMatchObject({ ok: false, status: 403 });
    expect(await setItemState(store, owner, id, "open_for_votes")).toMatchObject({ ok: true });
  });
  it("rejects votes while voting is closed, and unknown choices", async () => {
    const { store, id } = await open();
    expect(await castVote(store, a, id, "prioritise")).toMatchObject({ ok: false, status: 409 });
    await setItemState(store, owner, id, "open_for_votes");
    expect(await castVote(store, a, id, "yes please")).toMatchObject({ ok: false, status: 400 });
  });
  it("one vote per person: voting again changes it, withdrawing removes it, and the voter is the session, not the request", async () => {
    const { store, id, state } = await open();
    await setItemState(store, owner, id, "open_for_votes");
    await castVote(store, a, id, "prioritise");
    await castVote(store, b, id, "park");
    const changed = await castVote(store, a, id, "park");
    expect(changed).toMatchObject({ ok: true, tally: { prioritise: 0, park: 2, total: 2 } });
    expect(state.votes).toHaveLength(2);
    expect(await withdrawVote(store, a, id)).toMatchObject({ ok: true, tally: { total: 1 } });
    expect(await withdrawVote(store, a, id)).toMatchObject({ ok: true, tally: { total: 1 } }); // idempotent
    expect(await castVote(store, a, "00000000-0000-4000-8000-999999999999", "park")).toMatchObject({ ok: false, status: 404 });
  });
  it("members see the tally and their own vote only; the owner also sees who voted", async () => {
    const { store, id, state } = await open();
    await setItemState(store, owner, id, "open_for_votes");
    await castVote(store, a, id, "prioritise"); await castVote(store, b, id, "park");
    const item = state.items[0];
    const asMember = await viewItem(store, a, item);
    expect(asMember.voters).toBeUndefined();
    expect(asMember.mine).toBe("prioritise");
    expect(JSON.stringify(asMember)).not.toContain("b@team.test");
    expect((await viewItem(store, owner, item)).voters).toHaveLength(2);
  });
  it("tally counts correctly", () => expect(tally([{ choice: "prioritise" }, { choice: "park" }, { choice: "prioritise" }])).toEqual({ prioritise: 2, park: 1, total: 3 }));
});

describe("owner decisions", () => {
  it("members cannot decide, and nothing changes when they try", async () => {
    const { store, id, state } = await open();
    expect(await decide(store, a, id, { outcome: "prioritised", rationale: "x" })).toMatchObject({ ok: false, status: 403 });
    expect(state.decisions).toHaveLength(0);
    expect(state.items[0].state).toBe("under_review");
  });
  it("needs a valid outcome and a rationale", async () => {
    const { store, id } = await open();
    expect(await decide(store, owner, id, { outcome: "maybe", rationale: "x" })).toMatchObject({ status: 400 });
    expect(await decide(store, owner, id, { outcome: "parked", rationale: "  " })).toMatchObject({ status: 400 });
    expect(await decide(store, owner, "00000000-0000-4000-8000-999999999999", { outcome: "parked", rationale: "x" })).toMatchObject({ status: 404 });
  });
  it("the decision is independent of the votes: 5 against does not stop a prioritise, and the tally is stored for audit", async () => {
    const { store, id, state } = await open();
    await setItemState(store, owner, id, "open_for_votes");
    await castVote(store, a, id, "park"); await castVote(store, b, id, "park");
    const r = await decide(store, owner, id, { outcome: "prioritised", rationale: "Strategic: unblocks the release", followup: true });
    expect(r).toMatchObject({ ok: true, tally: { prioritise: 0, park: 2, total: 2 } });
    expect(state.items[0].state).toBe("prioritised");
    expect(state.decisions[0]).toMatchObject({ outcome: "prioritised", decided_by: "owner@team.test", vote_snapshot: { park: 2 }, followup: true, superseded_at: null });
  });
  it("a changed decision supersedes the old one and keeps it as history; exactly one is current", async () => {
    const { store, id, state } = await open();
    await decide(store, owner, id, { outcome: "parked", rationale: "later" });
    await decide(store, owner, id, { outcome: "prioritised", rationale: "now urgent" });
    expect(state.decisions.filter((d) => !d.superseded_at)).toHaveLength(1);
    expect(state.decisions).toHaveLength(2);
    const v = await viewItem(store, owner, state.items[0]);
    expect(v.current?.outcome).toBe("prioritised");
    expect(v.history.map((d) => d.outcome)).toEqual(["parked"]);
  });
  it("only valid states are settable by the owner directly; final outcomes need a decision", async () => {
    const { store, id } = await open();
    expect(await setItemState(store, owner, id, "prioritised")).toMatchObject({ ok: false, status: 400 });
    expect(await setItemState(store, owner, "00000000-0000-4000-8000-999999999999", "open_for_votes")).toMatchObject({ status: 404 });
  });
  it("the digest changes when a decision changes and ignores superseded ones", () => {
    const d = (id: number, outcome: "parked" | "prioritised", sup: string | null = null) => ({ id, item_id: "i1", outcome, superseded_at: sup });
    const one = decisionsDigest([d(1, "parked")]);
    expect(decisionsDigest([d(1, "parked", "x"), d(2, "prioritised")])).not.toBe(one);
    expect(decisionsDigest([d(2, "prioritised"), d(1, "parked", "x")])).toBe(decisionsDigest([d(1, "parked", "x"), d(2, "prioritised")]));
    expect(decisionsDigest([])).toBe(decisionsDigest([d(1, "parked", "old")]));
  });
});

describe("watchlist service", () => {
  const topics = ["t1", "t2"];
  const T = (o: Partial<WatchTerm>): WatchTerm => ({ id: "x", topic_id: "t1", term: "code review", kind: "include", status: "active", applies_to: null, ...o });
  it("only the owner may change the watchlist", async () => {
    const { store, state } = memoryTeamStore();
    for (const r of [await addTerm(store, a, topics, { topicId: "t1", term: "x y", kind: "include" }), await setSensitivity(store, a, "strict")]) expect(r).toMatchObject({ ok: false, status: 403 });
    expect(state.terms).toHaveLength(0);
    expect(state.changes).toHaveLength(0);
  });
  it("normalises, stores and audits an added term, and returns ambiguity as a warning", async () => {
    const { store, state } = memoryTeamStore();
    const r = await addTerm(store, owner, topics, { topicId: "t1", term: "  Flaky   TESTS ", kind: "include" });
    expect(r).toMatchObject({ ok: true, term: { term: "flaky tests", status: "active" } });
    const amb = await addTerm(store, owner, topics, { topicId: "t1", term: "build", kind: "include" });
    expect((amb as { warnings: string[] }).warnings.length).toBeGreaterThan(0);
    expect(state.changes.map((c) => c.action)).toEqual(["add", "add"]);
    expect(state.changes[0]).toMatchObject({ actor: "owner@team.test", subject: "include:flaky tests" });
  });
  it("blocks duplicates, unknown topics, bad terms and an exclusion that would swallow a watched term", async () => {
    const { store } = memoryTeamStore({ terms: [T({ id: "a", term: "code review" })] });
    expect(await addTerm(store, owner, topics, { topicId: "t1", term: "Code  Review", kind: "include" })).toMatchObject({ ok: false, status: 409 });
    expect(await addTerm(store, owner, topics, { topicId: "zzz", term: "foo bar", kind: "include" })).toMatchObject({ ok: false, status: 404 });
    expect(await addTerm(store, owner, topics, { topicId: "t1", term: "a", kind: "include" })).toMatchObject({ ok: false, status: 400 });
    expect(await addTerm(store, owner, topics, { topicId: "t1", term: "<script>", kind: "include" })).toMatchObject({ ok: false, status: 400 });
    expect(await addTerm(store, owner, topics, { topicId: "t1", term: "review", kind: "exclude" })).toMatchObject({ ok: false, status: 409 });
    expect(await addTerm(store, owner, topics, { topicId: "t1", term: "x y", kind: "weird" })).toMatchObject({ ok: false, status: 400 });
  });
  it("pause and resume are audited; the last active term cannot be paused or removed", async () => {
    const { store, state } = memoryTeamStore({ terms: [T({ id: "a", term: "code review" }), T({ id: "b", term: "pr review" })] });
    expect(await editTerm(store, owner, "a", { status: "paused" })).toMatchObject({ ok: true });
    expect(await editTerm(store, owner, "b", { status: "paused" })).toMatchObject({ ok: false, status: 409 });
    expect(await removeTerm(store, owner, "b")).toMatchObject({ ok: false, status: 409 });
    expect(await editTerm(store, owner, "a", { status: "active" })).toMatchObject({ ok: true });
    expect(state.changes.map((c) => c.action)).toEqual(["pause", "resume"]);
  });
  it("edits, removes (with its scoped exclusions) and records before and after", async () => {
    const { store, state } = memoryTeamStore({ terms: [T({ id: "a", term: "code review" }), T({ id: "b", term: "pr review" }), T({ id: "e", term: "meme", kind: "exclude", applies_to: "a" })] });
    expect(await editTerm(store, owner, "a", { term: "Code Reviews" })).toMatchObject({ ok: true, term: { term: "code reviews" } });
    expect(await editTerm(store, owner, "a", {})).toMatchObject({ status: 400 });
    expect(await editTerm(store, owner, "nope", { status: "paused" })).toMatchObject({ status: 404 });
    expect(await removeTerm(store, owner, "a")).toMatchObject({ ok: true });
    expect(state.terms.map((t) => t.id)).toEqual(["b"]);
    expect(state.changes.at(-1)).toMatchObject({ action: "remove", before: { id: "a" } });
  });
  it("sensitivity is validated and audited only when it changes", async () => {
    const { store, state } = memoryTeamStore();
    expect(await setSensitivity(store, owner, "wild")).toMatchObject({ status: 400 });
    await setSensitivity(store, owner, "strict"); await setSensitivity(store, owner, "strict");
    expect(state.sensitivity).toBe("strict");
    expect(state.changes).toHaveLength(1);
    expect(state.changes[0]).toMatchObject({ action: "sensitivity", before: "balanced", after: "strict" });
  });
});

describe("Monday sprint pack", () => {
  const brief = { weekStart: "2026-10-09", periodLabel: "Fri 9 Oct – Thu 15 Oct", observed: { top: [{ rank: 1, theme: "Slow reviews", observed: "4 discussions" }], limitations: ["Reddit was partial"] }, suggestions: { label: "Suggestions for discussion (not findings, and not approved work)", items: [{ forTheme: null, text: "Check one example" }] } } as never;
  it("is honest when nothing has been decided: no committed work, suggestions only as prompts", async () => {
    const { store } = await open();
    const { pack } = buildPack({ now: NOW, brief, items: await store.listItems(), decisions: [] });
    expect(pack.state).toBe("no_decisions");
    expect(pack.committed).toEqual([]);
    expect(pack.message).toMatch(/Nothing is committed/);
    expect(pack.suggestions.label).toMatch(/not approved work/);
  });
  it("commits only prioritised decisions; others are listed as not pursued; superseded ones never appear", async () => {
    const t = await open();
    await decide(t.store, owner, t.id, { outcome: "parked", rationale: "later" });
    await decide(t.store, owner, t.id, { outcome: "prioritised", rationale: "urgent", followup: true });
    const { pack } = buildPack({ now: NOW, brief, items: await t.store.listItems(), decisions: await t.store.listDecisions() });
    expect(pack.state).toBe("ready");
    expect(pack.committed).toHaveLength(1);
    expect(pack.committed[0]).toMatchObject({ theme: "Slow reviews", rationale: "urgent", decidedBy: "owner@team.test" });
    expect(pack.notPursued).toEqual([]);
    expect(pack.followups).toHaveLength(1);
    expect(pack.disclaimer).toMatch(/did not decide/);
  });
  it("says so when decisions exist but none was prioritised, and when there is no report", async () => {
    const t = await open();
    await decide(t.store, owner, t.id, { outcome: "rejected", rationale: "not us" });
    const items = await t.store.listItems(), decisions = await t.store.listDecisions();
    expect(buildPack({ now: NOW, brief, items, decisions }).pack.message).toMatch(/none was prioritised/);
    expect(buildPack({ now: NOW, brief: null, items, decisions }).pack.state).toBe("no_report");
  });
  it("freshness: stale when decisions change or a newer report exists", () => {
    expect(packFreshness(null, "d", "2026-10-09")).toBe("none");
    expect(packFreshness({ digest: "d", weekStart: "2026-10-09" }, "d", "2026-10-09")).toBe("current");
    expect(packFreshness({ digest: "d", weekStart: "2026-10-09" }, "e", "2026-10-09")).toBe("stale_decisions");
    expect(packFreshness({ digest: "d", weekStart: "2026-10-09" }, "d", "2026-10-16")).toBe("stale_report");
  });
});

describe("failure alerts", () => {
  const run = (o: Partial<AlertRun> = {}): AlertRun => ({ status: "failed", weekStart: "2026-10-09", trigger: "scheduled", email: "not_sent", sources: {}, codes: ["RUN_FAILED"], ...o });
  const f = () => { const calls: { key: string; body: { html: string; to: string[] } }[] = []; const fn = (async (_u: unknown, i: RequestInit) => { calls.push({ key: (i.headers as Record<string, string>)["idempotency-key"], body: JSON.parse(String(i.body)) }); return new Response("{}", { status: 200 }); }) as never; return { calls, fn }; };
  it("alerts only on scheduled problems: a failed run, a failed or unconfirmed email, every source down", () => {
    expect(alertFor(run())?.kind).toBe("run_failed");
    expect(alertFor(run({ status: "succeeded", email: "failed" }))?.kind).toBe("email_failed");
    expect(alertFor(run({ status: "partial", email: "unconfirmed" }))?.kind).toBe("email_unconfirmed");
    expect(alertFor(run({ status: "partial", email: "sent", sources: { hn: "error", reddit: "error" } }))?.kind).toBe("sources_down");
    expect(alertFor(run({ status: "partial", email: "sent", sources: { hn: "ok", reddit: "error" } }))).toBeNull();
    expect(alertFor(run({ status: "partial", email: "not_attempted", codes: ["CLASSIFY_NO_MODEL", "EMAIL_WITHHELD"] }))?.kind).toBe("email_withheld");
    expect(alertFor(run({ trigger: "backfill" }))).toBeNull();
    expect(alertFor(run({ status: "succeeded", email: "sent" }))).toBeNull();
  });
  it("sends one email to the approved recipient from the approved sender, and a repeat is a duplicate", async () => {
    const { store } = memoryTeamStore(); const x = f();
    expect(await sendFailureAlert(store, run(), "r1", { RESEND_API_KEY: "k", DIGEST_TO_EMAIL: "owner@team.test", APP_URL: "https://app.test" } as never, x.fn, NOW)).toBe("sent");
    expect(await sendFailureAlert(store, run(), "r2", { RESEND_API_KEY: "k", DIGEST_TO_EMAIL: "owner@team.test" } as never, x.fn, NOW)).toBe("duplicate");
    expect(x.calls).toHaveLength(1);
    expect(x.calls[0].body.to).toEqual(["owner@team.test"]);
    expect(x.calls[0].key).toBe("jarvis-alert-run_failed:2026-10-09");
  });
  it("is bounded per kind per day", async () => {
    const { store } = memoryTeamStore(); const x = f();
    const env = { RESEND_API_KEY: "k", DIGEST_TO_EMAIL: "o@t.test" } as never;
    const out: string[] = [];
    for (let i = 0; i < MAX_PER_DAY + 2; i++) out.push(await sendFailureAlert(store, run({ weekStart: `2026-10-${10 + i}` }), null, env, x.fn, new Date()));
    expect(out.filter((o) => o === "sent")).toHaveLength(MAX_PER_DAY);
    expect(out.filter((o) => o === "limited")).toHaveLength(2);
  });
  it("never throws, skips when email is not configured, and frees the claim when sending fails", async () => {
    const { store, state } = memoryTeamStore();
    expect(await sendFailureAlert(store, run(), null, {} as never, f().fn, NOW)).toBe("skipped");
    expect(await sendFailureAlert(store, run(), null, { RESEND_API_KEY: "k", DIGEST_TO_EMAIL: "o@t.test" } as never, (async () => new Response("no", { status: 500 })) as never, NOW)).toBe("failed");
    expect(state.alerts).toHaveLength(0);
    expect(await sendFailureAlert(store, run(), null, { RESEND_API_KEY: "k", DIGEST_TO_EMAIL: "o@t.test" } as never, (async () => { throw new Error("x"); }) as never, NOW)).toBe("failed");
  });
  it("the body carries only safe codes and escaped text", () => {
    const html = alertHtml(run({ codes: ["OK_CODE", "<b>bad</b>", "has space"], status: "<i>x" }), "Headline <b>", "https://app.test");
    expect(html).toContain("OK_CODE");
    expect(html).not.toContain("<b>bad");
    expect(html).not.toContain("has space");
    expect(html).not.toContain("<i>x");
    expect(html).toContain("https://app.test/status");
  });
});
