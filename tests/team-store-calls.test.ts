import { describe, expect, it } from "vitest";
import { makeSupabaseTeamStore } from "@/lib/team-store";

type Call = { m: string; args: unknown[] };
type Reply = { data: unknown; error: null | { message: string; code?: string }; count?: number };
function fake(respond: (table: string, calls: Call[], n: number) => Reply) {
  const log: { table: string; calls: Call[] }[] = [];
  const rpcs: { fn: string; args: unknown }[] = [];
  const db = {
    rpc: async (fn: string, args: unknown) => { rpcs.push({ fn, args }); return { data: 42, error: null }; },
    from(table: string) {
      const calls: Call[] = []; log.push({ table, calls }); const n = log.length;
      const proxy: unknown = new Proxy({}, { get(_t, p: string) {
        if (p === "then") return (res: (v: Reply) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(respond(table, calls, n)).then(res, rej);
        return (...args: unknown[]) => { calls.push({ m: p, args }); return proxy; };
      } });
      return proxy;
    },
  };
  return { store: makeSupabaseTeamStore(db as never), log, rpcs };
}
const ok = (data: unknown, count?: number): Reply => ({ data, error: null, count });
const has = (calls: Call[], m: string, ...args: unknown[]) => calls.some((c) => c.m === m && JSON.stringify(c.args) === JSON.stringify(args));

describe("team store query shapes", () => {
  it("a decision goes through the transactional function, never as separate writes", async () => {
    const { store, log, rpcs } = fake(() => ok([]));
    const id = await store.recordDecision({ item_id: "i", outcome: "parked", decided_by: "o@x.test", rationale: "r", evidence: { a: 1 }, vote_snapshot: { prioritise: 1, park: 0, total: 1 }, followup: true });
    expect(id).toBe(42);
    expect(rpcs).toEqual([{ fn: "record_review_decision", args: { p_item: "i", p_outcome: "parked", p_by: "o@x.test", p_rationale: "r", p_evidence: { a: 1 }, p_votes: { prioritise: 1, park: 0, total: 1 }, p_followup: true } }]);
    expect(log).toHaveLength(0);
  });
  it("a duplicate alert key is reported as a duplicate, other errors are thrown", async () => {
    expect(await fake(() => ({ data: null, error: { message: "dup", code: "23505" } })).store.claimAlert("k", "run_failed", null)).toBe(false);
    expect(await fake(() => ok(null)).store.claimAlert("k", "run_failed", null)).toBe(true);
    await expect(fake(() => ({ data: null, error: { message: "down" } })).store.claimAlert("k", "run_failed", null)).rejects.toThrow(/claim alert/);
  });
  it("a repeated shortlist falls back to the existing (topic, theme) row instead of failing", async () => {
    const existing = { id: "i1", topic_id: "t1", theme: "Slow" };
    const { store } = fake((_t, _c, n) => (n === 1 ? { data: null, error: { message: "dup", code: "23505" } } : ok(existing)));
    expect(await store.createItem({ topic_id: "t1", theme: "Slow", reason: "r", first_week: "2026-10-09", created_by: "a@x.test" })).toEqual({ item: existing, created: false });
  });
  it("a vote is an upsert keyed by (item, voter): one vote per person", async () => {
    const { store, log } = fake(() => ok(null));
    await store.upsertVote("i1", "a@x.test", "park");
    const up = log[0].calls.find((c) => c.m === "upsert")!;
    expect(up.args[1]).toEqual({ onConflict: "item_id,voter" });
    expect(up.args[0]).toMatchObject({ item_id: "i1", voter: "a@x.test", choice: "park" });
  });
  it("counts alerts per kind since a time, and a failure to count is an error, not zero", async () => {
    const { store, log } = fake(() => ok(null, 2));
    expect(await store.countAlerts("run_failed", new Date("2026-10-15T00:00:00Z"))).toBe(2);
    expect(has(log[0].calls, "eq", "kind", "run_failed")).toBe(true);
    await expect(fake(() => ({ data: null, error: { message: "down" } })).store.countAlerts("k", new Date())).rejects.toThrow();
  });
  it("a duplicate watch term is reported in words", async () => {
    await expect(fake(() => ({ data: null, error: { message: "dup", code: "23505" } })).store.addTerm({ topic_id: "t", term: "x y", kind: "include", applies_to: null })).rejects.toThrow(/already exists/);
  });
});
