import { describe, expect, it } from "vitest";
import { EMAIL_KEY_SAFE_MS, EMAIL_LEASE_MS, makeSupabaseStore } from "@/lib/store";
import { geminiFromEnv } from "@/lib/gemini";
import type { BriefDraft } from "@/lib/brief-policy";

/**
 * The Supabase store cannot be run without a database, so these tests record the exact query each method builds and
 * check its shape: filters, ordering, paging, payload columns, and error handling. They prove the CALLS are right; they
 * do not prove database behaviour (that is covered by the SQL dry-run).
 */
type Call = { m: string; args: unknown[] };
type Reply = { data: unknown; error: null | { message: string } };

function fake(respond: (table: string, calls: Call[], n: number) => Reply) {
  const log: { table: string; calls: Call[] }[] = [];
  const db = {
    from(table: string) {
      const calls: Call[] = [];
      log.push({ table, calls });
      const n = log.length;
      const proxy: unknown = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") return (res: (v: Reply) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(respond(table, calls, n)).then(res, rej);
          return (...args: unknown[]) => { calls.push({ m: prop, args }); return proxy; };
        },
      });
      return proxy;
    },
  };
  return { store: makeSupabaseStore(db as never), log };
}
const ok = (data: unknown): Reply => ({ data, error: null });
const err = (message: string): Reply => ({ data: null, error: { message } });
const has = (calls: Call[], m: string, ...args: unknown[]) => calls.some((c) => c.m === m && JSON.stringify(c.args) === JSON.stringify(args));
const names = (calls: Call[]) => calls.map((c) => c.m);
const rows = (n: number, extra: object = {}) => Array.from({ length: n }, (_, i) => ({ id: `id${i}`, source: "hn", ...extra }));
const D = new Date("2026-10-01T18:30:00Z"), E = new Date("2026-10-08T18:30:00Z");
const draft: BriefDraft = { narrative: "N.", points: [], coverage: { sources: {}, comparison: { state: "no_prior", reasons: [] } }, pendingCount: 0, usedFallback: false };

describe("store: deterministic ordering and pagination", () => {
  it("orders topics by created_at then id, active only", async () => {
    const { store, log } = fake(() => ok([]));
    await store.getActiveTopics();
    const c = log[0].calls;
    expect(has(c, "eq", "active", true)).toBe(true);
    expect(c.filter((x) => x.m === "order").map((x) => x.args[0])).toEqual(["created_at", "id"]);
  });
  it("pages with a UNIQUE tiebreak (posted_at, then id) so equal timestamps cannot skip or repeat rows", async () => {
    const { store, log } = fake(() => ok([]));
    await store.getUnclassifiedPosts(D, E);
    await store.getClassifiedPosts(D, E);
    await store.getSourceCounts(D, E);
    for (const { calls } of log) expect(calls.filter((x) => x.m === "order").map((x) => x.args[0])).toEqual(["posted_at", "id"]);
  });
  it("bounds every period query by [start, end) exactly", async () => {
    const { store, log } = fake(() => ok([]));
    await store.getUnclassifiedPosts(D, E);
    expect(has(log[0].calls, "gte", "posted_at", D.toISOString())).toBe(true);
    expect(has(log[0].calls, "lt", "posted_at", E.toISOString())).toBe(true);
  });
  it("fetches the next page only when a page is exactly full (1000), and merges the pages", async () => {
    const { store, log } = fake((_t, _c, n) => ok(n === 1 ? rows(1000) : rows(3)));
    const all = await store.getUnclassifiedPosts(D, E);
    expect(all).toHaveLength(1003);
    expect(log.map((l) => l.calls.find((c) => c.m === "range")!.args)).toEqual([[0, 999], [1000, 1999]]);
  });
  it("a page of 999 rows is the last page; exactly 1000 then 0 takes two requests", async () => {
    const a = fake(() => ok(rows(999)));
    expect(await a.store.getClassifiedPosts(D, E)).toHaveLength(999);
    expect(a.log).toHaveLength(1);
    const b = fake((_t, _c, n) => ok(n === 1 ? rows(1000) : []));
    expect(await b.store.getClassifiedPosts(D, E)).toHaveLength(1000);
    expect(b.log).toHaveLength(2);
  });
  it("counts posts per source across pages", async () => {
    const { store } = fake((_t, _c, n) => ok(n === 1 ? rows(1000, { source: "hn" }) : rows(5, { source: "github" })));
    expect(await store.getSourceCounts(D, E)).toEqual({ hn: 1000, github: 5 });
  });
});

describe("store: writes are shaped to be idempotent and safe", () => {
  it("inserts posts in chunks of 200, ignoring duplicates on (source, source_id)", async () => {
    const { store, log } = fake(() => ok([]));
    await store.insertPosts(rows(450) as never);
    expect(log).toHaveLength(3);
    for (const { table, calls } of log) {
      expect(table).toBe("raw_posts");
      const up = calls.find((c) => c.m === "upsert")!;
      expect(up.args[1]).toEqual({ onConflict: "source,source_id", ignoreDuplicates: true });
    }
  });
  it("de-duplicates per source in chunks of 200", async () => {
    const posts = [...rows(250, { source: "hn" }).map((r, i) => ({ source: "hn", source_id: `h${i}` })), { source: "github", source_id: "g1" }];
    const { store, log } = fake(() => ok([]));
    await store.getExistingKeys(posts);
    expect(log).toHaveLength(3); // hn x2 chunks + github x1
    expect(log.every((l) => has(l.calls, "eq", "source", l.calls.find((c) => c.m === "eq")!.args[1]))).toBe(true);
  });
  it("saves each classification only where theme is still null, never overwriting a stored result", async () => {
    const { store, log } = fake(() => ok([]));
    await store.saveClassifications(Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, theme: "T", sentiment: "negative" as const, unresolved: true })));
    expect(log).toHaveLength(60);
    for (const { calls } of log) {
      expect(names(calls)).toContain("update");
      expect(has(calls, "is", "theme", null)).toBe(true);
      expect(Object.keys(calls.find((c) => c.m === "update")!.args[0] as object).sort()).toEqual(["classified_at", "sentiment", "theme", "unresolved"]);
    }
  });
  it("aggregates upsert on (week_start, topic_id, theme); an empty set writes nothing", async () => {
    const { store, log } = fake(() => ok([]));
    await store.saveAggregates("2026-10-02", []);
    expect(log).toHaveLength(0);
    await store.saveAggregates("2026-10-02", [{ topic_id: "t", theme: "x", count: 2, unresolved: 1 }]);
    expect(log[0].calls.find((c) => c.m === "upsert")!.args[1]).toEqual({ onConflict: "week_start,topic_id,theme" });
  });
});

describe("store: saved report is compare-and-set and never touches delivery columns", () => {
  const EMAIL_COLS = ["email_status", "email_claimed_at", "email_sent_at", "email_error", "emailed_version", "email_message_id"];
  it("create = insert-if-absent; reports whether this writer won", async () => {
    const won = fake(() => ok([{ version: 1 }]));
    expect(await won.store.saveBrief("2026-10-02", draft, null)).toEqual({ saved: true, version: 1 });
    const lost = fake(() => ok([]));
    expect(await lost.store.saveBrief("2026-10-02", draft, null)).toEqual({ saved: false, version: 0 });
    const up = won.log[0].calls.find((c) => c.m === "upsert")!;
    expect(up.args[1]).toEqual({ onConflict: "week_start", ignoreDuplicates: true });
    for (const col of EMAIL_COLS) expect(Object.keys(up.args[0] as object)).not.toContain(col);
  });
  it("replace = update at the expected version, only while undelivered, bumping the version", async () => {
    const { store, log } = fake(() => ok([{ version: 3 }]));
    expect(await store.saveBrief("2026-10-02", draft, 2)).toEqual({ saved: true, version: 3 });
    const c = log[0].calls;
    expect(has(c, "eq", "week_start", "2026-10-02")).toBe(true);
    expect(has(c, "eq", "version", 2)).toBe(true);
    expect(has(c, "or", "email_status.is.null,email_status.eq.failed")).toBe(true);
    const payload = c.find((x) => x.m === "update")!.args[0] as Record<string, unknown>;
    expect(payload.version).toBe(3);
    for (const col of EMAIL_COLS) expect(Object.keys(payload)).not.toContain(col); // delivery metadata is preserved
  });
  it("a replace that matches no row (stale version, or delivered) reports saved=false", async () => {
    const { store } = fake(() => ok([]));
    expect(await store.saveBrief("2026-10-02", draft, 2)).toEqual({ saved: false, version: 2 });
  });
  it("reads the saved report into the shape the pipeline uses", async () => {
    const { store } = fake(() => ok({ week_start: "2026-10-02", narrative: "N", top_pain_points: [], coverage: draft.coverage, version: 4, pending_count: 1, used_fallback: true, email_status: "failed", emailed_version: null, created_at: "t" }));
    expect(await store.getBrief("2026-10-02")).toMatchObject({ version: 4, pendingCount: 1, usedFallback: true, emailStatus: "failed", points: [] });
  });
  it("returns null when there is no saved report", async () => {
    expect(await fake(() => ok(null)).store.getBrief("x")).toBeNull();
  });
});

describe("store: the email claim", () => {
  it("is ONE conditional update: claimable = never sent, failed, or a lease older than 15 minutes", async () => {
    const before = Date.now();
    const { store, log } = fake(() => ok([{ week_start: "2026-10-02" }]));
    expect(await store.claimEmail("2026-10-02")).toBe("claimed");
    expect(log).toHaveLength(1); // a single statement: no read-then-write gap
    const c = log[0].calls;
    expect(has(c, "eq", "week_start", "2026-10-02")).toBe(true);
    const upd = c.find((x) => x.m === "update")!.args[0] as Record<string, unknown>;
    expect(upd).toMatchObject({ email_status: "sending", email_error: null });
    const orArg = c.find((x) => x.m === "or")!.args[0] as string;
    const m = /^email_status\.is\.null,email_status\.eq\.failed,and\(email_status\.eq\.sending,email_claimed_at\.lt\.([^,)]+),email_claimed_at\.gt\.([^)]+)\)$/.exec(orArg);
    expect(m, orArg).not.toBeNull();
    const staleBefore = new Date(m![1]).getTime();
    expect(Math.abs(staleBefore - (before - EMAIL_LEASE_MS))).toBeLessThan(5_000);
    // a claim older than the provider's key window is NOT retakeable
    expect(Math.abs(new Date(m![2]).getTime() - (before - EMAIL_KEY_SAFE_MS))).toBeLessThan(5_000);
    expect(orArg).not.toMatch(/sent/); // a 'sent' row can never match
    expect(names(c)).toContain("select"); // RETURNING, so the caller knows whether it won
  });
  it("explains why a claim was not won", async () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const mk = (status: string | null | "none", claimedAt: string | null = null) => fake((_t, _c, n) => (n === 1 ? ok([]) : ok(status === "none" ? null : { email_status: status, email_claimed_at: claimedAt }))).store.claimEmail("w");
    expect(await mk("sent")).toBe("already_sent");
    expect(await mk("sending", ago(60_000))).toBe("in_progress");
    expect(await mk("sending", ago(EMAIL_KEY_SAFE_MS + 60_000))).toBe("unconfirmed"); // too old to retry safely
    expect(await mk("sending", null)).toBe("unconfirmed");
    expect(await mk("none")).toBe("no_brief");
  });
  it("marks sent only from 'sending', recording the version and message id", async () => {
    const { store, log } = fake(() => ok([{ week_start: "2026-10-02" }]));
    await store.markEmailSent("2026-10-02", 3, "msg_1");
    const c = log[0].calls;
    expect(has(c, "eq", "email_status", "sending")).toBe(true);
    expect(c.find((x) => x.m === "update")!.args[0]).toMatchObject({ email_status: "sent", emailed_version: 3, email_message_id: "msg_1", email_error: null });
  });
  it("marking sent throws when no 'sending' row matched, so a lost claim never looks like success", async () => {
    const { store } = fake(() => ok([]));
    await expect(store.markEmailSent("w", 1, "m")).rejects.toThrow(/no row/);
  });
  it("failure and release also apply only while 'sending'; failure text is redacted", async () => {
    const { store, log } = fake(() => ok([]));
    await store.markEmailFailed("w", "boom https://api.resend.com/emails?key=SECRET123 Bearer tok.en");
    await store.releaseEmailClaim("w");
    for (const { calls } of log) expect(has(calls, "eq", "email_status", "sending")).toBe(true);
    const stored = JSON.stringify(log[0].calls.find((c) => c.m === "update")!.args[0]);
    expect(stored).not.toMatch(/SECRET123|tok\.en/);
  });
});

describe("store: run health and error handling", () => {
  it("finishRun stamps finished_at and redacts the error; recordSourceFetches([]) does nothing", async () => {
    const { store, log } = fake(() => ok([]));
    await store.finishRun("r1", { status: "failed", error: "x key=ABC123 y" });
    const payload = log[0].calls.find((c) => c.m === "update")!.args[0] as Record<string, unknown>;
    expect(payload.status).toBe("failed");
    expect(typeof payload.finished_at).toBe("string");
    expect(String(payload.error)).not.toContain("ABC123");
    await store.recordSourceFetches("r1", []);
    expect(log).toHaveLength(1);
  });
  it("turns a database error into a thrown, labelled error", async () => {
    const { store } = fake(() => err("connection refused"));
    await expect(store.getActiveTopics()).rejects.toThrow("supabase topics: connection refused");
    await expect(store.claimEmail("w")).rejects.toThrow(/claim email/);
    await expect(store.saveBrief("w", draft, null)).rejects.toThrow(/create brief/);
    await expect(store.getUnclassifiedPosts(D, E)).rejects.toThrow(/unclassified posts/);
  });
  it("treats empty results as empty, not as errors", async () => {
    const { store } = fake(() => ok(null as never));
    expect(await store.getReportPeriod("w")).toBeNull();
    const empty = fake(() => ok([]));
    expect(await empty.store.listReportPeriods(D)).toEqual([]);
    expect(await empty.store.getAggregates("w")).toEqual([]);
  });
});

describe("Gemini model guard: every AI task must use a Flash model", () => {
  const env = (model?: string, key = "k") => ({ GEMINI_API_KEY: key, ...(model ? { GEMINI_MODEL: model } : {}) }) as unknown as NodeJS.ProcessEnv;
  it("accepts Flash ids (any version, any case) and nothing else", () => {
    for (const m of ["gemini-3.8-flash", "gemini-3.5-flash-lite", "Gemini-2.5-FLASH"]) expect(() => geminiFromEnv(env(m))).not.toThrow();
    for (const m of ["gemini-3.1-pro", "claude-opus-5-5", "gpt-5", "gemini-ultra"]) expect(() => geminiFromEnv(env(m))).toThrow(/not a Gemini Flash model/);
  });
  it("requires both the key and the model from the environment (no hard-coded default)", () => {
    expect(() => geminiFromEnv(env("gemini-3.8-flash", ""))).toThrow(/GEMINI_API_KEY/);
    expect(() => geminiFromEnv(env(undefined))).toThrow(/GEMINI_MODEL is not set/);
  });
});
