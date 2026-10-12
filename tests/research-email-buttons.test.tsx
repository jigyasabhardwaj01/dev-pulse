import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { researchGate, researchResult, RESEARCH_COOLDOWN_MS } from "@/lib/research";
import { readiness, sendSummary, RESEND_COOLDOWN_MS, type SendDeps } from "@/lib/email-summary";
import { runDigest } from "@/lib/pipeline";
import { sendBriefEmail } from "@/lib/email";
import { MemoryStore, post } from "./helpers";
import { memoryTeamStore } from "./team-helpers";
import ActionBar from "@/components/ActionBar";
import { FIRST_WEEK_SENTENCE, NOT_COMPARED_SENTENCE } from "@/lib/brief";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/" }));

/* ------------------------------------------------------------------ Start Research: rules */
const NOW = new Date("2026-10-12T18:00:00Z"); // Monday: period 2026-10-02
const run = (o: object = {}): any => ({ id: "r", weekStart: "2026-10-02", status: "succeeded", startedAt: "2026-10-12T10:00:00Z", finishedAt: "2026-10-12T10:02:00Z", stuck: false, classified: 5, unclassified: 0, newPosts: 5, usedFallback: false, emailStatus: null, sources: [{ source: "hn", status: "ok" }, { source: "github", status: "ok" }], diagnostics: [{ code: "REPORT_SAVED", detail: { action: "create", version: 1 } }], ...o });
const cron = (o: object = {}) => run({ diagnostics: [{ code: "RUN_INVOKED", detail: { by: "vercel-cron" } }, { code: "REPORT_SAVED", detail: { action: "create", version: 1 } }], ...o });
const gate = (o: Partial<Parameters<typeof researchGate>[0]> = {}) => researchGate({ now: NOW, aiConfigured: true, hasActive: false, runs: [], ...o });

describe("Start Research: duplicate and safety rules", () => {
  it("allows a run when nothing blocks it, for the period the Friday job would cover", () => {
    expect(gate()).toEqual({ ok: true, weekStart: "2026-10-02" });
  });
  it("refuses without the AI configured, saying what to add", () => {
    expect(gate({ aiConfigured: false })).toMatchObject({ ok: false, status: 409, code: "no_ai", message: expect.stringContaining("OPENROUTER_API_KEY") });
  });
  it("refuses while a run is active, from the database lock or from a recorded running run, but not for a run that is stuck", () => {
    expect(gate({ hasActive: true })).toMatchObject({ ok: false, code: "running", status: 409 });
    expect(gate({ runs: [run({ status: "running", finishedAt: null })] })).toMatchObject({ code: "running" });
    expect(gate({ runs: [run({ status: "running", finishedAt: null, stuck: true, startedAt: "2026-10-12T01:00:00Z" })] }).ok).toBe(true);
  });
  it("refuses when Friday's automatic run already completed that period, but a person's earlier manual run does not count as Friday's", () => {
    expect(gate({ runs: [cron({ finishedAt: "2026-10-09T01:00:00Z" })] })).toMatchObject({ ok: false, code: "friday_done", status: 409 });
    expect(gate({ runs: [run({ finishedAt: "2026-10-09T01:00:00Z", diagnostics: [{ code: "RUN_INVOKED", detail: { by: "manual" } }] })] }).ok).toBe(true);
    expect(gate({ runs: [cron({ status: "partial", finishedAt: "2026-10-09T01:00:00Z" })] }).ok).toBe(true); // Friday's run did not complete: the fallback is allowed
    expect(gate({ runs: [cron({ weekStart: "2026-09-25", finishedAt: "2026-10-02T01:00:00Z" })] }).ok).toBe(true); // an earlier period's run is irrelevant
  });
  it("applies a cooldown after a run finished, counting down the wait, then allows it again", () => {
    const fin = new Date(NOW.getTime() - 3 * 60_000).toISOString();
    expect(gate({ runs: [run({ finishedAt: fin })] })).toMatchObject({ ok: false, code: "cooldown", status: 429, message: expect.stringMatching(/about 7 more minutes/) });
    expect(gate({ runs: [run({ finishedAt: new Date(NOW.getTime() - RESEARCH_COOLDOWN_MS - 1000).toISOString() })] }).ok).toBe(true);
  });
  it("checks the AI first, then a running run, then Friday's completion, then the cooldown", () => {
    expect(gate({ aiConfigured: false, hasActive: true })).toMatchObject({ code: "no_ai" });
    expect(gate({ hasActive: true, runs: [cron()] })).toMatchObject({ code: "running" });
  });
});

describe("Start Research: what the person is told", () => {
  it("is 'starting' until a run newer than the click exists, so an older run is never shown as theirs", () => {
    expect(researchResult(null, 1).state).toBe("starting");
    expect(researchResult(run({ startedAt: "2026-10-12T10:00:00Z" }), Date.parse("2026-10-12T17:00:00Z")).state).toBe("starting");
  });
  it("is 'running' while the run is recorded as running", () => {
    expect(researchResult(run({ status: "running", finishedAt: null }), null).state).toBe("running");
  });
  it("success only when sources, the AI step, the AI summary and the report save all worked", () => {
    const r = researchResult(run(), null);
    expect(r).toMatchObject({ state: "success", headline: "Research finished" });
    expect(r.lines.map((l) => l.headline)).toEqual(expect.arrayContaining(["A new weekly report was saved"]));
  });
  it("never success when the AI summary fell back to a template, when classification is waiting, when a source failed, or when the report save is unconfirmed", () => {
    for (const o of [{ usedFallback: true }, { unclassified: 3 }, { sources: [{ source: "hn", status: "error" }, { source: "github", status: "ok" }] }, { sources: [{ source: "hn", status: "partial" }] }, { diagnostics: [] }, { status: "partial" }]) {
      expect(researchResult(run(o), null).state).toBe("problems");
    }
  });
  it("a failed run is a failure that says nothing was changed and what to do", () => {
    const r = researchResult(run({ status: "failed" }), null);
    expect(r.state).toBe("failed"); expect(r.lines[0].detail).toMatch(/untouched/); expect(r.todo).toMatch(/Technical status/);
  });
  it("a run with nothing new is a success that says the AI had nothing to do and the delivered report was kept", () => {
    const r = researchResult(run({ classified: 0, newPosts: 0, diagnostics: [{ code: "REPORT_SAVED", detail: { action: "keep", version: 1 } }] }), null);
    expect(r.state).toBe("success");
    expect(r.lines.map((l) => l.headline)).toEqual(expect.arrayContaining(["Nothing new needed AI analysis", "The saved report was kept as it is"]));
  });
});

/* ------------------------------------------------------------------ Email Summary */
const WEEK = "2026-10-02";
const SEND_NOW = new Date("2026-10-09T05:00:00Z");
const ENV = { RESEND_API_KEY: "re_test", DIGEST_TO_EMAIL: "me@team.test", APP_URL: "https://app.test" } as unknown as NodeJS.ProcessEnv;
const model = (async (prompt: string) => {
  if (prompt.includes("intro line")) {
    if (prompt.includes(FIRST_WEEK_SENTENCE)) return `${FIRST_WEEK_SENTENCE} Slow reviews led the week.`;
    if (prompt.includes(NOT_COMPARED_SENTENCE)) return `${NOT_COMPARED_SENTENCE} Slow reviews led the week.`;
    return "Slow reviews led the week. Nothing else stands out.";
  }
  const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
  return JSON.stringify(Array.from({ length: n }, (_, index) => ({ index, relevant: true, theme: "Slow reviews", problem: "Reviews take days.", kind: "existing_problem", resolution: "open", confidence: 0.85, excerpt: "code review", reason: "r", sentiment: "negative" })));
});
const hn = async () => [1, 2, 3].map((i) => post({ source_id: `h${i}`, posted_at: `2026-10-0${2 + i}T10:00:00Z`, title: `code review takes days on team number ${i}`, url: `https://news.test/${i}`, author: `a${i}` }));

async function world(over: { callModel?: typeof model | null } = {}) {
  const store = new MemoryStore();
  await runDigest({ store, now: new Date("2026-10-09T03:30:00Z"), callModel: over.callModel === undefined ? model : over.callModel, fetchers: { hn }, sleep: async () => {} }); // saves the report, sends nothing
  // MemoryStore reports are listed through report_periods; mirror what the pipeline wrote
  const team = memoryTeamStore();
  const calls: { headers: Record<string, string>; body: { to: string[]; subject: string; html: string } }[] = [];
  let mode: "ok" | "reject" | "boom" | "unavailable" = "ok";
  const fetchStub = vi.fn(async (_u: string, init?: RequestInit) => {
    calls.push({ headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
    if (mode === "reject") return new Response("bad", { status: 422 });
    if (mode === "unavailable") return new Response("down", { status: 503 });
    if (mode === "boom") throw new TypeError("network");
    return new Response(JSON.stringify({ id: `msg_${calls.length}` }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchStub);
  const deps = (o: Partial<SendDeps> = {}): SendDeps => ({ store, team: team.store, env: ENV, actor: "visitor-aaaaaaaaaaaaaaaaaaaaaaaa", now: SEND_NOW, sleep: async () => {}, ...o });
  return { store, team, calls, deps, setMode: (m: typeof mode) => { mode = m; } };
}
const OK = { weekStart: WEEK, confirm: true, nonce: "11111111-2222" };

describe("Email Summary: first delivery of the latest saved report", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  it("sends the saved report once, to the configured recipient only, and records it as sent only after the provider accepted", async () => {
    const w = await world();
    expect(w.store.emails.get(WEEK)?.status ?? null).toBeNull();
    const r = await sendSummary(OK, w.deps());
    expect(r).toMatchObject({ ok: true, outcome: "sent", recipient: expect.stringContaining("***@team.test") });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].body.to).toEqual(["me@team.test"]);
    expect(w.calls[0].body.subject).toBe(`JARVIS: developer pain points, week of ${WEEK}`);
    expect(w.calls[0].headers["idempotency-key"]).toBe(`dev-pulse-brief-${WEEK}-v1`);
    expect(w.calls[0].body.html).toContain("Slow reviews"); expect(w.calls[0].body.html).toContain("https://news.test/"); expect(w.calls[0].body.html).toContain("Suggestions for discussion");
    expect(w.store.emails.get(WEEK)?.status).toBe("sent");
    expect((await w.team.store.listManualEmailEvents(WEEK, 5))[0].action).toBe("email_sent_manual");
  });
  it("a second press does not send again and says the report was already emailed", async () => {
    const w = await world();
    await sendSummary(OK, w.deps());
    const again = await sendSummary(OK, w.deps());
    expect(again).toMatchObject({ ok: false, status: 409, code: "already_sent" });
    expect(w.calls).toHaveLength(1);
  });
  it("two simultaneous presses send exactly one email", async () => {
    const w = await world();
    const rs = await Promise.all([sendSummary(OK, w.deps()), sendSummary(OK, w.deps())]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(w.calls).toHaveLength(1);
  });
  it("a provider rejection is reported, nothing is marked delivered, and the report stays sendable", async () => {
    const w = await world(); w.setMode("reject");
    const r = await sendSummary(OK, w.deps());
    expect(r).toMatchObject({ ok: false, status: 502, code: "send_failed" });
    expect(w.store.emails.get(WEEK)?.status).toBe("failed");
    expect((await w.team.store.listManualEmailEvents(WEEK, 5))).toEqual([]);
    w.setMode("ok");
    expect(await sendSummary(OK, w.deps())).toMatchObject({ ok: true });
  });
  it("a provider outage or network failure is never shown as delivered and is never marked sent", async () => {
    for (const m of ["unavailable", "boom"] as const) {
      const w = await world(); w.setMode(m);
      const r = await sendSummary(OK, w.deps());
      expect(r).toMatchObject({ ok: false, code: "unconfirmed" });
      expect(w.store.emails.get(WEEK)?.status).not.toBe("sent");
    }
  });
  it("requires confirmation and refuses anything that is not the latest saved report", async () => {
    const w = await world();
    expect(await sendSummary({ ...OK, confirm: undefined }, w.deps())).toMatchObject({ ok: false, status: 400, code: "not_confirmed" });
    expect(await sendSummary({ ...OK, confirm: "yes" }, w.deps())).toMatchObject({ status: 400 });
    expect(await sendSummary({ ...OK, weekStart: "2026-09-25" }, w.deps())).toMatchObject({ ok: false, status: 409, code: "not_latest" });
    expect(await sendSummary({ ...OK, weekStart: undefined }, w.deps())).toMatchObject({ code: "not_latest" });
    expect(w.calls).toHaveLength(0);
  });
  it("does not send a template-only report, a report with no analysis, or when email is not configured", async () => {
    const t = await world({ callModel: null });
    expect(await sendSummary(OK, t.deps())).toMatchObject({ ok: false, code: "template_summary" });
    const w = await world();
    expect(await sendSummary(OK, w.deps({ env: { RESEND_API_KEY: "k" } as unknown as NodeJS.ProcessEnv }))).toMatchObject({ ok: false, status: 503, code: "not_configured" });
    expect(await sendSummary(OK, w.deps({ env: { DIGEST_TO_EMAIL: "a@b.c" } as unknown as NodeJS.ProcessEnv }))).toMatchObject({ code: "not_configured" });
    const saved = (await w.store.getBrief(WEEK))!; (w.store.briefs.get(WEEK) as any).analysis = undefined; void saved;
    expect(await sendSummary(OK, w.deps())).toMatchObject({ ok: false, code: "no_analysis" });
    expect(t.calls.length + w.calls.length).toBe(0);
  });
  it("an empty store has nothing to send", async () => {
    const w = await world(); w.store.reports.clear();
    expect(await sendSummary(OK, w.deps())).toMatchObject({ ok: false, code: "no_report" });
  });
  it("refuses while another send holds the claim", async () => {
    const w = await world();
    await w.store.claimEmail(WEEK);
    expect(await sendSummary(OK, w.deps())).toMatchObject({ ok: false, code: "in_progress" });
    expect(w.calls).toHaveLength(0);
  });
});

describe("Email Summary: an intentional second copy", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  const delivered = async () => { const w = await world(); await sendSummary(OK, w.deps()); w.calls.length = 0; return w; };
  it("needs the explicit resend flag, otherwise nothing is sent", async () => {
    const w = await delivered();
    expect(await sendSummary({ ...OK, nonce: "22222222-3333" }, w.deps({ now: new Date(Date.now() + 5 * 60_000) }))).toMatchObject({ ok: false, code: "already_sent" });
    expect(w.calls).toHaveLength(0);
  });
  it("sends a labelled copy with its OWN idempotency key and leaves the report's delivery record exactly as it was", async () => {
    const w = await delivered();
    const before = JSON.stringify(w.store.emails.get(WEEK));
    const r = await sendSummary({ ...OK, resend: true, nonce: "22222222-3333" }, w.deps({ now: new Date(Date.now() + 5 * 60_000) }));
    expect(r).toMatchObject({ ok: true, outcome: "resent" });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].headers["idempotency-key"]).toBe(`dev-pulse-brief-${WEEK}-v1-resend-22222222-3333`);
    expect(w.calls[0].headers["idempotency-key"]).not.toBe(`dev-pulse-brief-${WEEK}-v1`);
    expect(w.calls[0].body.subject).toContain("(copy sent again on request)");
    expect(JSON.stringify(w.store.emails.get(WEEK))).toBe(before);
    expect((await w.team.store.listManualEmailEvents(WEEK, 5))[0].action).toBe("email_resent_manual");
  });
  it("a resend needs a valid request id, and a double click within a minute is blocked", async () => {
    const w = await delivered();
    const later = new Date(Date.now() + 5 * 60_000);
    for (const nonce of [undefined, "", "short", "has space in it!!", "x".repeat(80)]) expect(await sendSummary({ ...OK, resend: true, nonce }, w.deps({ now: later }))).toMatchObject({ ok: false, status: 400 });
    expect(await sendSummary({ ...OK, resend: true, nonce: "33333333-4444" }, w.deps({ now: later }))).toMatchObject({ ok: true });
    // the audit event is stamped with real time; the cooldown compares against it
    expect(await sendSummary({ ...OK, resend: true, nonce: "44444444-5555" }, w.deps({ now: new Date(Date.now() + 1000) }))).toMatchObject({ ok: false, status: 429, code: "cooldown" });
    expect(await sendSummary({ ...OK, resend: true, nonce: "55555555-6666" }, w.deps({ now: new Date(Date.now() + RESEND_COOLDOWN_MS + 5000) }))).toMatchObject({ ok: true });
    expect(w.calls).toHaveLength(2);
  });
  it("a rejected second copy is reported as not sent and changes nothing", async () => {
    const w = await delivered(); w.setMode("reject");
    const r = await sendSummary({ ...OK, resend: true, nonce: "22222222-3333" }, w.deps({ now: new Date(Date.now() + 5 * 60_000) }));
    expect(r).toMatchObject({ ok: false, status: 502, code: "send_failed" });
    expect(w.store.emails.get(WEEK)?.status).toBe("sent");
    expect(await w.team.store.listManualEmailEvents(WEEK, 5)).toHaveLength(1); // only the first send's record
  });
  it("sendBriefEmail keeps the real key and subject unless a resend nonce is given", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "m" }), { status: 200 }));
    await sendBriefEmail({ weekStart: WEEK, version: 3, narrative: "x", points: [] }, ENV, f as never);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe(`dev-pulse-brief-${WEEK}-v3`);
    expect(JSON.parse(String(init.body)).subject).toBe(`JARVIS: developer pain points, week of ${WEEK}`);
  });
});

describe("Email Summary: when the button is enabled", () => {
  const rep = (o: object = {}): any => ({ weekStart: WEEK, periodLabel: "Fri 2 Oct – Thu 8 Oct 2026 (IST)", kind: "ist", usedFallback: false, delivery: { status: "not_sent", sentAt: null }, nav: { prev: null, next: null }, ...o });
  const rd = (o: Partial<Parameters<typeof readiness>[0]> = {}) => readiness({ report: rep(), hasAnalysis: true, email: { key: true, recipient: "jigyasa@pg27.mesaschool.co" }, manual: null, ...o });
  it("is ready for a valid latest report and shows the recipient masked", () => {
    expect(rd()).toMatchObject({ ready: true, reason: null, recipient: "jig***@pg27.mesaschool.co", alreadySentAt: null });
  });
  it("is disabled, with a plain reason, for each invalid state", () => {
    const cases: [Partial<Parameters<typeof readiness>[0]>, RegExp][] = [
      [{ report: null }, /no saved report/], [{ report: rep({ kind: "legacy" }) }, /older format/], [{ report: rep({ usedFallback: true }) }, /template/], [{ hasAnalysis: false }, /no problem analysis/],
      [{ email: { key: false, recipient: "a@b.co" } }, /No email recipient/], [{ email: { key: true, recipient: null } }, /No email recipient/], [{ email: { key: true, recipient: "bad" } }, /No email recipient/],
      [{ report: rep({ delivery: { status: "sending" } }) }, /being emailed right now/], [{ report: rep({ nav: { prev: null, next: "2026-10-09" } }) }, /not the latest/],
    ];
    for (const [o, re] of cases) { const x = rd(o); expect(x.ready).toBe(false); expect(x.reason).toMatch(re); }
  });
  it("an already-delivered report is still sendable, but flagged so the page asks for the second-copy confirmation", () => {
    expect(rd({ report: rep({ delivery: { status: "sent", sentAt: "2026-10-09T01:00:00Z" } }) })).toMatchObject({ ready: true, alreadySentAt: "2026-10-09T01:00:00Z" });
  });
});

/* ------------------------------------------------------------------ the buttons as rendered */
describe("the two buttons on the page", () => {
  const email = (o: object = {}): any => ({ ready: true, reason: null, weekStart: WEEK, periodLabel: "Fri 2 Oct – Thu 8 Oct 2026 (IST)", recipient: "jig***@pg27.mesaschool.co", alreadySentAt: null, lastManual: null, ...o });
  const html = (research = { blocked: null as string | null, running: false }, e = email()) => renderToStaticMarkup(<ActionBar research={research} email={e} />);
  it("shows both buttons with plain explanations and the recipient, and no confirmation until asked", () => {
    const o = html();
    expect(o.indexOf("Start Research")).toBeLessThan(o.indexOf("Email Summary"));
    expect(o).toContain("It does not send any email"); expect(o).toContain("jig***@pg27.mesaschool.co"); expect(o).toContain("You will be asked to confirm");
    expect(o).not.toContain("Confirm sending the email");
    expect(o).not.toMatch(/<button[^>]*disabled/);
  });
  it("disables Start Research with the reason when blocked, and while a run is in progress", () => {
    expect(html({ blocked: "Research is already running.", running: false })).toMatch(/<button[^>]*disabled[^>]*>Start Research/);
    const busy = html({ blocked: null, running: true });
    expect(busy).toContain("Research is running"); expect(busy).toMatch(/<button[^>]*disabled/);
  });
  it("disables Email Summary with the reason when there is no valid report", () => {
    const o = html(undefined, email({ ready: false, reason: "There is no saved report yet. Run Start Research first." }));
    expect(o).toMatch(/<button[^>]*disabled[^>]*>Email Summary/); expect(o).toContain("Run Start Research first");
  });
  it("tells the person when a copy was last sent from the button", () => {
    expect(html(undefined, email({ lastManual: { at: "2026-10-12T10:00:00Z", kind: "resent" } }))).toContain("a second copy");
  });
});
