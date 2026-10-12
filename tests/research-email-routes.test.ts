import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./helpers";
import { memoryTeamStore } from "./team-helpers";
import { resetRateLimits } from "@/lib/rate-limit";

const m = vi.hoisted(() => ({ store: null as unknown, team: null as unknown, runs: [] as unknown[] | null, after: [] as (() => Promise<void>)[], digest: null as unknown, ai: true }));
vi.mock("next/server", async (o) => ({ ...(await o<typeof import("next/server")>()), after: (fn: () => Promise<void>) => { m.after.push(fn); } }));
vi.mock("@/lib/store", async (o) => ({ ...(await o<typeof import("@/lib/store")>()), makeSupabaseStore: () => m.store }));
vi.mock("@/lib/team-store", async (o) => ({ ...(await o<typeof import("@/lib/team-store")>()), makeSupabaseTeamStore: () => m.team }));
vi.mock("@/lib/data", async (o) => ({ ...(await o<typeof import("@/lib/data")>()), getRecentRuns: async () => m.runs }));
vi.mock("@/lib/run-deps", () => ({ productionRunDeps: () => ({ fetchers: {}, callModel: m.ai ? async () => "x" : null }) }));
vi.mock("@/lib/pipeline", async (o) => ({ ...(await o<typeof import("@/lib/pipeline")>()), runDigest: (...a: unknown[]) => (m.digest as (...x: unknown[]) => Promise<unknown>)(...a) }));

import * as start from "@/app/api/research/start/route";
import * as status from "@/app/api/research/status/route";
import * as mail from "@/app/api/email/summary/route";

const ORIGIN = "https://app.test";
const req = (path: string, o: { origin?: string | null; ip?: string; body?: unknown; method?: string } = {}) =>
  new Request(`${ORIGIN}${path}`, { method: o.method ?? "POST", headers: { ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), "content-type": "application/json", "x-forwarded-for": o.ip ?? "203.0.113.1" }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
const finished = (o: object = {}) => ({ weekStart: "2026-10-02", status: "succeeded", startedAt: "2026-10-01T00:00:00Z", finishedAt: "2026-10-01T00:02:00Z", stuck: false, diagnostics: [], ...o });

beforeEach(() => { resetRateLimits(); m.store = new MemoryStore(); m.team = memoryTeamStore().store; m.runs = []; m.after = []; m.ai = true; m.digest = vi.fn(async () => ({})); process.env.APP_URL = ORIGIN; });

describe("POST /api/research/start", () => {
  it("starts the workflow in the background as a MANUAL run that never emails, and answers at once", async () => {
    const r = await start.POST(req("/api/research/start"));
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ started: true, weekStart: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(m.digest).not.toHaveBeenCalled(); // not inside the request
    await m.after[0]();
    const arg = (m.digest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ trigger: "backfill", invokedBy: "manual" });
    expect(arg.sendEmail).toBeUndefined();
  });
  it("is refused without a same-origin JSON request, and nothing starts", async () => {
    for (const o of [{ origin: "https://evil.test" }, { origin: null }]) expect((await start.POST(req("/api/research/start", o))).status).toBe(403);
    expect(m.after).toHaveLength(0);
  });
  it("does not start while a run is active, with the reason, and a second press changes nothing", async () => {
    m.runs = [finished({ status: "running", finishedAt: null, startedAt: new Date().toISOString() })];
    const r = await start.POST(req("/api/research/start"));
    expect(r.status).toBe(409); expect((await r.json()).code).toBe("running");
    expect(m.after).toHaveLength(0);
  });
  it("does not start when the AI is not configured, or when run history cannot be read", async () => {
    m.ai = false;
    expect((await start.POST(req("/api/research/start"))).status).toBe(409);
    m.ai = true; m.runs = null;
    const r = await start.POST(req("/api/research/start"));
    expect(r.status).toBe(503); expect((await r.json()).code).toBe("no_history");
    expect(m.after).toHaveLength(0);
  });
  it("is rate limited per client", async () => {
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await start.POST(req("/api/research/start", { ip: "198.51.100.9" }))).status;
    expect(last).toBe(429);
  });
  it("a failing run in the background is contained: it does not crash the route", async () => {
    m.digest = vi.fn(async () => { throw new Error("boom"); });
    await start.POST(req("/api/research/start"));
    await expect(m.after[0]()).resolves.toBeUndefined();
  });
});

describe("GET /api/research/status", () => {
  it("reports the newest run in plain words, never an older run as the caller's", async () => {
    m.runs = [finished()];
    const old = await (await status.GET(req("/api/research/status?since=" + Date.now(), { method: "GET" }))).json();
    expect(old.state).toBe("starting");
    m.runs = [finished({ status: "running", finishedAt: null, startedAt: new Date().toISOString() })];
    expect((await (await status.GET(req("/api/research/status", { method: "GET" }))).json()).state).toBe("running");
  });
  it("says so when run history cannot be read, and ignores a malformed since", async () => {
    m.runs = null;
    expect((await status.GET(req("/api/research/status", { method: "GET" }))).status).toBe(503);
    m.runs = [];
    expect((await (await status.GET(req("/api/research/status?since=abc", { method: "GET" }))).json()).state).toBe("starting");
  });
  it("is rate limited", async () => {
    m.runs = [];
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await status.GET(req("/api/research/status", { method: "GET", ip: "192.0.2.8" }))).status;
    expect(last).toBe(429);
  });
});

describe("POST /api/email/summary", () => {
  it("is refused cross-origin, and without confirmation, and sends nothing", async () => {
    expect((await mail.POST(req("/api/email/summary", { origin: "https://evil.test", body: { confirm: true } }))).status).toBe(403);
    const r = await mail.POST(req("/api/email/summary", { body: { weekStart: "2026-10-02" } }));
    expect(r.status).toBe(400); expect((await r.json()).code).toBe("not_confirmed");
  });
  it("answers with the plain reason when there is no report", async () => {
    process.env.RESEND_API_KEY = "k"; process.env.DIGEST_TO_EMAIL = "a@b.co";
    const r = await mail.POST(req("/api/email/summary", { body: { weekStart: "2026-10-02", confirm: true } }));
    expect(r.status).toBe(409); expect((await r.json()).code).toBe("no_report");
    delete process.env.RESEND_API_KEY; delete process.env.DIGEST_TO_EMAIL;
  });
  it("is limited to three attempts per ten minutes per client", async () => {
    let last = 0;
    for (let i = 0; i < 4; i++) last = (await mail.POST(req("/api/email/summary", { ip: "198.51.100.77", body: { confirm: true } }))).status;
    expect(last).toBe(429);
  });
  it("never caches", async () => {
    expect((await mail.POST(req("/api/email/summary", { body: {} }))).headers.get("cache-control")).toBe("no-store");
  });
});
