import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryTeamStore } from "./team-helpers";
import { VISITOR_COOKIE } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

const mem = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/team-store", async (orig) => ({ ...(await orig<typeof import("@/lib/team-store")>()), makeSupabaseTeamStore: () => mem.current }));
vi.mock("@/lib/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/store")>()),
  makeSupabaseStore: () => ({
    getActiveTopics: async () => [{ id: "t1" }],
    getBrief: async () => ({ analysis: { painPoints: [{ topic_id: "t1", theme: "Slow reviews", links: [], discussions: 3 }] } }),
    listReportPeriods: async () => [],
  }),
}));

import * as terms from "@/app/api/watchlist/terms/route";
import * as term from "@/app/api/watchlist/terms/[id]/route";
import * as sens from "@/app/api/watchlist/sensitivity/route";
import * as items from "@/app/api/review/items/route";
import * as state from "@/app/api/review/items/[id]/state/route";
import * as vote from "@/app/api/review/items/[id]/vote/route";
import * as decision from "@/app/api/review/items/[id]/decision/route";
import * as itemRoute from "@/app/api/review/items/[id]/route";
import * as analysisRoute from "@/app/api/analysis/route";

const ORIGIN = "https://app.test";
const env = { APP_URL: ORIGIN };
const V1 = "a1".repeat(12), V2 = "b2".repeat(12); // two different browsers
const req = (method: string, path: string, o: { who?: string; body?: unknown; origin?: string | null; ct?: string } = {}) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), "content-type": o.ct ?? "application/json", ...(o.who ? { cookie: `${VISITOR_COOKIE}=${o.who}` } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
let t: ReturnType<typeof memoryTeamStore>;

beforeEach(() => { resetRateLimits(); Object.assign(process.env, env); t = memoryTeamStore(); mem.current = t.store; });

describe("no login: every visitor can use every tool", () => {
  it("a first-time visitor (no cookie at all) can write, and is issued an anonymous id cookie", async () => {
    const r = await terms.POST(req("POST", "/api/watchlist/terms", { body: { topicId: "t1", term: "flaky tests", kind: "include" } }));
    expect(r.status).toBe(201);
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toMatch(/jarvis_visitor=[a-f0-9]{24}/); expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/SameSite=Lax/); expect(sc).toMatch(/Secure/);
    expect(t.state.changes[0].actor).toMatch(/^visitor-[a-f0-9]{24}$/);
  });
  it("a returning visitor keeps their id and is not issued a new cookie", async () => {
    const r = await terms.POST(req("POST", "/api/watchlist/terms", { who: V1, body: { topicId: "t1", term: "flaky tests", kind: "include" } }));
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(t.state.changes[0].actor).toBe(`visitor-${V1}`);
  });
  it("a malformed cookie is replaced with a fresh id, never trusted", async () => {
    const r = await terms.POST(new Request(`${ORIGIN}/api/watchlist/terms`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie: `${VISITOR_COOKIE}=../../admin` }, body: JSON.stringify({ topicId: "t1", term: "flaky tests", kind: "include" }) }));
    expect(r.status).toBe(201);
    expect(r.headers.get("set-cookie")).toMatch(/jarvis_visitor=[a-f0-9]{24}/);
    expect(t.state.changes[0].actor).not.toContain("admin");
  });
  it("every endpoint works for a visitor: watchlist, shortlist, withdraw, vote, decision, analysis (validation still applies)", async () => {
    expect((await sens.PUT(req("PUT", "/api/watchlist/sensitivity", { who: V1, body: { sensitivity: "strict" } }))).status).toBe(200);
    expect((await sens.PUT(req("PUT", "/api/watchlist/sensitivity", { who: V1, body: { sensitivity: "wild" } }))).status).toBe(400);
    const made = await items.POST(req("POST", "/api/review/items", { who: V1, body: { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: "why" } }));
    expect(made.status).toBe(201);
    const id = t.state.items[0].id;
    expect((await state.PUT(req("PUT", "/x", { who: V1, body: { state: "open_for_votes" } }), ctx(id))).status).toBe(200);
    expect((await vote.PUT(req("PUT", "/x", { who: V1, body: { choice: "prioritise" } }), ctx(id))).status).toBe(200);
    expect((await vote.PUT(req("PUT", "/x", { who: V2, body: { choice: "park" } }), ctx(id))).status).toBe(200);
    expect((await decision.POST(req("POST", "/x", { who: V2, body: { outcome: "prioritised", rationale: "ship it" } }), ctx(id))).status).toBe(201);
    expect((await decision.POST(req("POST", "/x", { who: V2, body: { outcome: "prioritised", rationale: " " } }), ctx(id))).status).toBe(400);
    expect((await analysisRoute.POST(req("POST", "/api/analysis", { who: V1, body: { weekStart: "bad" } }))).status).toBe(400);
  });
  it("one vote per browser: voting again changes it, and a different browser is a different voter", async () => {
    await items.POST(req("POST", "/api/review/items", { who: V1, body: { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: "why" } }));
    const id = t.state.items[0].id;
    await state.PUT(req("PUT", "/x", { who: V1, body: { state: "open_for_votes" } }), ctx(id));
    await vote.PUT(req("PUT", "/x", { who: V1, body: { choice: "park" } }), ctx(id));
    await vote.PUT(req("PUT", "/x", { who: V1, body: { choice: "prioritise" } }), ctx(id));
    await vote.PUT(req("PUT", "/x", { who: V2, body: { choice: "park" } }), ctx(id));
    expect(t.state.votes.map((v) => `${v.voter}:${v.choice}`).sort()).toEqual([`visitor-${V1}:prioritise`, `visitor-${V2}:park`]);
  });
  it("the actor is the visitor cookie, never a name in the request body", async () => {
    await items.POST(req("POST", "/api/review/items", { who: V1, body: { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: "why", created_by: "boss@x.test", role: "admin" } }));
    expect(t.state.items[0].created_by).toBe(`visitor-${V1}`);
    const id = t.state.items[0].id;
    await state.PUT(req("PUT", "/x", { who: V1, body: { state: "open_for_votes" } }), ctx(id));
    await vote.PUT(req("PUT", "/x", { who: V1, body: { choice: "park", voter: "someone-else" } }), ctx(id));
    expect(t.state.votes.map((v) => v.voter)).toEqual([`visitor-${V1}`]);
  });
  it("unshortlist works for the visitor who shortlisted it and records the withdrawal", async () => {
    await items.POST(req("POST", "/api/review/items", { who: V1, body: { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: "why" } }));
    const id = t.state.items[0].id;
    const r = await itemRoute.DELETE(req("DELETE", "/x", { who: V1 }), ctx(id));
    expect(r.status).toBe(200);
    expect(t.state.items[0].state).toBe("withdrawn");
  });
});

describe("what is still enforced without a login", () => {
  it("rejects a write from another origin, without an Origin, or as a form: nothing is written", async () => {
    for (const o of [{ origin: "https://evil.test" }, { origin: null }, { ct: "text/plain" }, { ct: "application/x-www-form-urlencoded" }]) {
      expect((await terms.POST(req("POST", "/api/watchlist/terms", { who: V1, body: { topicId: "t1", term: "x y", kind: "include" }, ...o }))).status).toBe(403);
    }
    expect((await items.POST(req("POST", "/api/review/items", { origin: "https://evil.test", body: { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: "why" } }))).status).toBe(403);
    expect(t.state.terms.length + t.state.changes.length + t.state.items.length).toBe(0);
  });
  it("answers 400 to invalid JSON and never caches", async () => {
    const r = await terms.POST(new Request(`${ORIGIN}/api/watchlist/terms`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{nope" }));
    expect(r.status).toBe(400);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("validation and conflicts still surface as 4xx with the reason, not as success", async () => {
    const body = { topicId: "t1", term: "flaky tests", kind: "include" };
    await terms.POST(req("POST", "/api/watchlist/terms", { who: V1, body }));
    const dup = await terms.POST(req("POST", "/api/watchlist/terms", { who: V1, body }));
    expect(dup.status).toBe(409); expect(((await dup.json()) as { error: string }).error).toMatch(/already/);
    expect((await terms.POST(req("POST", "/api/watchlist/terms", { who: V1, body: { topicId: "nope", term: "x y", kind: "include" } }))).status).toBe(404);
    expect((await items.POST(req("POST", "/api/review/items", { who: V1, body: { weekStart: "2026-10-09", topicId: "t1", theme: "Invented", reason: "why" } }))).status).toBe(404);
  });
  it("a term can be added then paused then removed through the handlers", async () => {
    const r = await terms.POST(req("POST", "/api/watchlist/terms", { who: V1, body: { topicId: "t1", term: "pr queue", kind: "include" } }));
    const id = ((await r.json()) as { term: { id: string } }).term.id;
    await terms.POST(req("POST", "/api/watchlist/terms", { who: V1, body: { topicId: "t1", term: "second term", kind: "include" } }));
    expect((await term.PATCH(req("PATCH", "/x", { who: V1, body: { status: "paused" } }), ctx(id))).status).toBe(200);
    expect((await term.DELETE(req("DELETE", "/x", { who: V1 }), ctx(id))).status).toBe(200);
    expect(t.state.terms.map((x) => x.term)).toEqual(["second term"]);
  });
  it("the removed sign-in endpoints are gone", async () => {
    await expect(import("@/app/api/auth/login/route" as string)).rejects.toThrow();
    await expect(import("@/app/api/auth/request/route" as string)).rejects.toThrow();
    await expect(import("@/app/api/auth/verify/route" as string)).rejects.toThrow();
  });
});

describe("abuse protection on a public site", () => {
  const post = (ip: string) => analysisRoute.POST(new Request(`${ORIGIN}/api/analysis`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ weekStart: "bad" }) }));
  it("the heavy derive endpoint allows a few calls per client per window, then answers 429 with Retry-After", async () => {
    for (let i = 0; i < 4; i++) expect((await post("203.0.113.9")).status).toBe(400); // reaches validation: allowed
    const blocked = await post("203.0.113.9");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toMatch(/Too many requests/);
  });
  it("another client is not affected", async () => {
    for (let i = 0; i < 5; i++) await post("203.0.113.9");
    expect((await post("198.51.100.4")).status).toBe(400);
  });
  it("ordinary writes are limited too (40 per minute per client)", async () => {
    let last = 0;
    for (let i = 0; i < 41; i++) last = (await sens.PUT(new Request(`${ORIGIN}/api/watchlist/sensitivity`, { method: "PUT", headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": "192.0.2.7" }, body: JSON.stringify({ sensitivity: "strict" }) }))).status;
    expect(last).toBe(429);
  });
  it("a refused request writes nothing", async () => {
    for (let i = 0; i < 5; i++) await post("203.0.113.9");
    expect(t.state.items.length + t.state.changes.length).toBe(0);
  });
});
