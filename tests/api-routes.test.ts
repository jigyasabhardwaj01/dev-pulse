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
import * as loginRoute from "@/app/api/auth/login/route";
import * as signout from "@/app/api/auth/signout/route";

const SECRET = "test-secret-with-more-than-16-chars";
const ORIGIN = "https://app.test";
const env = { OWNER_PASSCODE: "owner-pass-phrase-123", TEAM_PASSCODE: "team-pass-phrase-456", RESEND_API_KEY: "k", SESSION_SECRET: SECRET, DIGEST_TO_EMAIL: "owner@team.test", JARVIS_TEAM_EMAILS: "a@team.test", APP_URL: ORIGIN };
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

describe("passcode sign-in through the real route handlers", () => {
  const post = (body: unknown, o: { origin?: string | null; ct?: string } = {}) => loginRoute.POST(new Request(`${ORIGIN}/api/auth/login`, { method: "POST", headers: { ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), "content-type": o.ct ?? "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  it("a correct sign-in sets an httpOnly, SameSite, Secure session cookie that authorises exactly that person; sign-out clears it", async () => {
    const sent: unknown[] = []; const realFetch = globalThis.fetch;
    globalThis.fetch = (async (...a: unknown[]) => { sent.push(a); return new Response("{}"); }) as never;
    try {
      const r = await post({ email: "A@Team.test", passcode: "team-pass-phrase-456" });
      expect(r.status).toBe(200);
      expect(sent).toHaveLength(0); // no email of any kind
      const sc = r.headers.get("set-cookie")!;
      expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/SameSite=Lax/); expect(sc).toMatch(/Secure/);
      const session = /jarvis_session=([^;]+)/.exec(sc)![1];
      const call = (path: string, body: unknown) => new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie: `jarvis_session=${session}` }, body: JSON.stringify(body) });
      expect((await items.POST(call("/api/review/items", { weekStart: "2026-10-09", topicId: "t1", theme: "Slow reviews", reason: "why" }))).status).toBe(201);
      expect(t.state.items[0].created_by).toBe("a@team.test");
      expect((await terms.POST(call("/api/watchlist/terms", { topicId: "t1", term: "x y", kind: "include" }))).status).toBe(403); // member, not owner
      const out = await signout.POST(new Request(`${ORIGIN}/api/auth/signout`, { method: "POST", headers: { origin: ORIGIN } }));
      expect(out.headers.get("set-cookie")).toMatch(/jarvis_session=;.*Max-Age=0/);
      expect((await signout.POST(new Request(`${ORIGIN}/api/auth/signout`, { method: "POST", headers: { origin: "https://evil.test" } }))).headers.get("set-cookie")).toBeNull();
    } finally { globalThis.fetch = realFetch; }
  });
  it("the owner passcode gives the owner role", async () => {
    const r = await post({ email: "owner@team.test", passcode: "owner-pass-phrase-123" });
    const session = /jarvis_session=([^;]+)/.exec(r.headers.get("set-cookie")!)![1];
    const res = await terms.POST(new Request(`${ORIGIN}/api/watchlist/terms`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie: `jarvis_session=${session}` }, body: JSON.stringify({ topicId: "t1", term: "build", kind: "include" }) }));
    expect(res.status).toBe(201);
  });
  it("a wrong passcode is 401 with no cookie; cross-origin, non-JSON and malformed requests are refused", async () => {
    const bad = await post({ email: "a@team.test", passcode: "wrong-wrong-wrong" });
    expect(bad.status).toBe(401); expect(bad.headers.get("set-cookie")).toBeNull();
    expect((await post({ email: "a@team.test", passcode: "team-pass-phrase-456" }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await post({ email: "a@team.test", passcode: "team-pass-phrase-456" }, { origin: null })).status).toBe(403);
    expect((await post({ email: "a@team.test", passcode: "team-pass-phrase-456" }, { ct: "text/plain" })).status).toBe(403);
    expect((await post("{nope")).status).toBe(400);
  });
  it("sign-in is off (503) when not configured, and the old email endpoints no longer exist", async () => {
    const old = process.env.OWNER_PASSCODE; delete process.env.OWNER_PASSCODE;
    try { expect((await post({ email: "a@team.test", passcode: "team-pass-phrase-456" })).status).toBe(503); } finally { process.env.OWNER_PASSCODE = old; }
    await expect(import("@/app/api/auth/request/route" as string)).rejects.toThrow();
    await expect(import("@/app/api/auth/verify/route" as string)).rejects.toThrow();
  });
});
