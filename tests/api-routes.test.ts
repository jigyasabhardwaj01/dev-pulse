import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryTeamStore } from "./team-helpers";
import { SESSION_COOKIE, sessionToken } from "@/lib/auth";

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
import * as pack from "@/app/api/pack/route";
import * as verify from "@/app/api/auth/verify/route";

const SECRET = "test-secret-with-more-than-16-chars";
const ORIGIN = "https://app.test";
const env = { SESSION_SECRET: SECRET, DIGEST_TO_EMAIL: "owner@team.test", JARVIS_TEAM_EMAILS: "a@team.test", APP_URL: ORIGIN };
const cookie = (email: string) => `${SESSION_COOKIE}=${sessionToken(email, SECRET, Date.now())}`;
const req = (method: string, path: string, o: { who?: string; body?: unknown; origin?: string | null; ct?: string } = {}) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), "content-type": o.ct ?? "application/json", ...(o.who ? { cookie: cookie(o.who) } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
let t: ReturnType<typeof memoryTeamStore>;

beforeEach(() => { Object.assign(process.env, env); t = memoryTeamStore(); mem.current = t.store; });

describe("no unauthenticated write, whatever the endpoint", () => {
  const calls: [string, () => Promise<Response>][] = [
    ["POST terms", () => terms.POST(req("POST", "/api/watchlist/terms", { body: { topicId: "t1", term: "x y", kind: "include" } }))],
    ["PATCH term", () => term.PATCH(req("PATCH", "/api/watchlist/terms/x", { body: { status: "paused" } }), ctx("x"))],
    ["DELETE term", () => term.DELETE(req("DELETE", "/api/watchlist/terms/x"), ctx("x"))],
    ["PUT sensitivity", () => sens.PUT(req("PUT", "/api/watchlist/sensitivity", { body: { sensitivity: "strict" } }))],
    ["POST item", () => items.POST(req("POST", "/api/review/items", { body: {} }))],
    ["PUT state", () => state.PUT(req("PUT", "/api/x", { body: { state: "open_for_votes" } }), ctx("x"))],
    ["PUT vote", () => vote.PUT(req("PUT", "/api/x", { body: { choice: "park" } }), ctx("x"))],
    ["DELETE vote", () => vote.DELETE(req("DELETE", "/api/x"), ctx("x"))],
    ["POST decision", () => decision.POST(req("POST", "/api/x", { body: { outcome: "parked", rationale: "r" } }), ctx("x"))],
    ["POST pack", () => pack.POST(req("POST", "/api/pack"))],
  ];
  for (const [name, call] of calls) it(`${name}: 401 with no session, and nothing is written`, async () => {
    const r = await call();
    expect(r.status).toBe(401);
    expect(t.state.terms.length + t.state.items.length + t.state.votes.length + t.state.decisions.length + t.state.packs.length + t.state.changes.length).toBe(0);
  });
  it("a forged cookie is no session", async () => {
    const r = await terms.POST(new Request(`${ORIGIN}/api/watchlist/terms`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie: `${SESSION_COOKIE}=${Buffer.from(JSON.stringify({ k: "s", e: "owner@team.test", x: 9e9 })).toString("base64url")}.AAAA` }, body: "{}" }));
    expect(r.status).toBe(401);
  });
});

describe("cross-site and malformed requests", () => {
  it("rejects a write from another origin or without an Origin or as a form, even with a valid session", async () => {
    for (const o of [{ origin: "https://evil.test" }, { origin: null }, { ct: "text/plain" }]) {
      expect((await terms.POST(req("POST", "/api/watchlist/terms", { who: "owner@team.test", body: { topicId: "t1", term: "x y", kind: "include" }, ...o }))).status).toBe(403);
    }
    expect(t.state.terms).toHaveLength(0);
  });
  it("answers 400 to invalid JSON", async () => {
    const r = await terms.POST(new Request(`${ORIGIN}/api/watchlist/terms`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie: cookie("owner@team.test") }, body: "{nope" }));
    expect(r.status).toBe(400);
  });
  it("never caches", async () => {
    expect((await pack.POST(req("POST", "/api/pack"))).headers.get("cache-control")).toBe("no-store");
  });
});

describe("roles are enforced on the server", () => {
  it("a member gets 403 on every owner endpoint and the data does not change", async () => {
    const who = "a@team.test";
    expect((await terms.POST(req("POST", "/api/watchlist/terms", { who, body: { topicId: "t1", term: "x y", kind: "include" } }))).status).toBe(403);
    expect((await sens.PUT(req("PUT", "/api/watchlist/sensitivity", { who, body: { sensitivity: "strict" } }))).status).toBe(403);
    expect((await pack.POST(req("POST", "/api/pack", { who }))).status).toBe(403);
    expect((await state.PUT(req("PUT", "/api/x", { who, body: { state: "open_for_votes" } }), ctx("x"))).status).toBe(403);
    expect((await decision.POST(req("POST", "/api/x", { who, body: { outcome: "prioritised", rationale: "r" } }), ctx("x"))).status).toBe(403);
    expect(t.state.terms.length + t.state.changes.length + t.state.packs.length + t.state.decisions.length).toBe(0);
    expect(t.state.sensitivity).toBe("balanced");
  });
  it("someone off the roster, even with a validly signed cookie, is not signed in", async () => {
    expect((await items.POST(req("POST", "/api/review/items", { who: "stranger@x.test", body: {} }))).status).toBe(401);
  });
  it("a role or voter claimed in the request body is ignored: the signed-in person is the actor", async () => {
    const made = await items.POST(req("POST", "/api/review/items", { who: "a@team.test", body: { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: "why", role: "owner", created_by: "owner@team.test" } }));
    expect(made.status).toBe(201);
    const id = t.state.items[0].id;
    expect(t.state.items[0].created_by).toBe("a@team.test");
    expect((await state.PUT(req("PUT", "/api/x", { who: "owner@team.test", body: { state: "open_for_votes" } }), ctx(id))).status).toBe(200);
    expect((await vote.PUT(req("PUT", "/api/x", { who: "a@team.test", body: { choice: "park", voter: "owner@team.test", role: "owner" } }), ctx(id))).status).toBe(200);
    expect(t.state.votes.map((v) => v.voter)).toEqual(["a@team.test"]);
    expect((await decision.POST(req("POST", "/api/x", { who: "a@team.test", body: { outcome: "prioritised", rationale: "r", role: "owner", decided_by: "owner@team.test" } }), ctx(id))).status).toBe(403);
  });
});

describe("the owner's happy path through the real handlers", () => {
  it("shortlist → open votes → vote → decide → pack, each step recorded", async () => {
    const owner = "owner@team.test";
    expect((await items.POST(req("POST", "/api/review/items", { who: "a@team.test", body: { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: "why" } }))).status).toBe(201);
    expect((await items.POST(req("POST", "/api/review/items", { who: "a@team.test", body: { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: "why" } }))).status).toBe(200); // repeat: no duplicate
    expect(t.state.items).toHaveLength(1);
    const id = t.state.items[0].id;
    await state.PUT(req("PUT", "/x", { who: owner, body: { state: "open_for_votes" } }), ctx(id));
    await vote.PUT(req("PUT", "/x", { who: "a@team.test", body: { choice: "prioritise" } }), ctx(id));
    const d = await decision.POST(req("POST", "/x", { who: owner, body: { outcome: "prioritised", rationale: "ship it" } }), ctx(id));
    expect(d.status).toBe(201);
    expect(t.state.items[0].state).toBe("prioritised");
    const p = await pack.POST(req("POST", "/api/pack", { who: owner }));
    expect(p.status).toBe(201);
    expect(t.state.packs).toHaveLength(1);
    expect(t.state.events.map((e) => e.action)).toEqual(expect.arrayContaining(["shortlisted", "state_changed", "voted", "decision_recorded"]));
  });
  it("a watchlist term is added with a 201 and the response carries warnings", async () => {
    const r = await terms.POST(req("POST", "/api/watchlist/terms", { who: "owner@team.test", body: { topicId: "t1", term: "build", kind: "include" } }));
    expect(r.status).toBe(201);
    expect(((await r.json()) as { warnings: string[] }).warnings.length).toBeGreaterThan(0);
  });
  it("conflicts surface as 409 with the reason, not as success", async () => {
    const body = { topicId: "t1", term: "flaky tests", kind: "include" };
    await terms.POST(req("POST", "/api/watchlist/terms", { who: "owner@team.test", body }));
    const r = await terms.POST(req("POST", "/api/watchlist/terms", { who: "owner@team.test", body }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/already/);
  });
});

describe("sign-in confirmation endpoint", () => {
  it("does not accept GET (a mail scanner cannot use the link up)", () => {
    expect((verify as Record<string, unknown>).GET).toBeUndefined();
  });
  it("rejects a cross-origin post and an invalid token without setting a cookie", async () => {
    const mk = (origin: string, token: string) => { const f = new FormData(); f.set("token", token); return new Request(`${ORIGIN}/api/auth/verify`, { method: "POST", headers: { origin }, body: f }); };
    const a = await verify.POST(mk("https://evil.test", "x"));
    const b = await verify.POST(mk(ORIGIN, "x.y"));
    for (const r of [a, b]) { expect(r.status).toBe(303); expect(r.headers.get("set-cookie")).toBeNull(); expect(r.headers.get("location")).toContain("/signin?error="); }
  });
  it("a valid single-use link sets an httpOnly session cookie and redirects to /review; replay fails", async () => {
    const { linkToken, newNonce } = await import("@/lib/auth");
    const nonce = newNonce();
    await t.store.createToken(nonce, "a@team.test", new Date(Date.now() + 600_000));
    const token = linkToken("a@team.test", nonce, SECRET, Date.now());
    const mk = () => { const f = new FormData(); f.set("token", token); return new Request(`${ORIGIN}/api/auth/verify`, { method: "POST", headers: { origin: ORIGIN }, body: f }); };
    const ok = await verify.POST(mk());
    expect(ok.headers.get("location")).toBe(`${ORIGIN}/review`);
    const sc = ok.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/SameSite=Lax/); expect(sc).toMatch(/Secure/);
    expect((await verify.POST(mk())).headers.get("set-cookie")).toBeNull();
  });
});
