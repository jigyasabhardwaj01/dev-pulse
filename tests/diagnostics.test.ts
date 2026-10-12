import { describe, expect, it, vi } from "vitest";
import { coarseReason, makeDiagnostics, parseDiagnostics, REMEDY } from "@/lib/diagnostics";
import { runDigest, type Deps } from "@/lib/pipeline";
import { EmailSendError } from "@/lib/email";
import { NOT_COMPARED_SENTENCE, FIRST_WEEK_SENTENCE } from "@/lib/brief";
import { makeSupabaseStore } from "@/lib/store";
import type { FetchResult } from "@/lib/types";
import { MemoryStore, post } from "./helpers";

const NOW = new Date("2026-10-09T03:30:00Z");
const WEEK = "2026-10-02";
const classifier = () => async (prompt: string) => {
  if (prompt.includes("intro line")) {
    if (prompt.includes(FIRST_WEEK_SENTENCE)) return `${FIRST_WEEK_SENTENCE} Slow reviews led the week.`;
    if (prompt.includes(NOT_COMPARED_SENTENCE)) return `${NOT_COMPARED_SENTENCE} Slow reviews led the week.`;
    return "Slow reviews led the week. Nothing else stands out.";
  }
  const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
  return JSON.stringify(Array.from({ length: n }, (_, index) => ({ index, theme: "False positives", sentiment: "negative", unresolved: true })));
};
const hn = (...ids: string[]) => async () => ids.map((id) => post({ source_id: id }));
const res = (over: Partial<FetchResult> = {}): FetchResult => ({ posts: [], requests: 3, failed: 0, errors: [], truncated: false, ...over });
const base = (store: MemoryStore, over: Partial<Deps> = {}): Deps => ({ store, now: NOW, callModel: classifier(), fetchers: { hn: hn("a") }, sleep: async () => {}, ...over });
const sent = () => vi.fn(async () => ({ status: "sent" as const, messageId: "m1" }));
const codes = (s: { diagnostics: { code: string }[] }) => s.diagnostics.map((d) => d.code);
const find = (s: { diagnostics: { code: string }[] }, code: string) => s.diagnostics.find((d) => d.code === code) as never as { code: string; severity: string; stage: string; message: string; source?: string; detail?: Record<string, unknown>; remedy?: string; at: string };

describe("parseDiagnostics", () => {
  const good = { code: "SOURCE_FAILED", severity: "error", stage: "collect", message: "Reddit failed.", at: "2026-10-12T10:00:00Z", source: "reddit", remedy: "Retry.", detail: { requests: 3, failed: 3 } };
  it("reads well-formed diagnostics", () => {
    const { items, legacyCount } = parseDiagnostics([good]);
    expect(legacyCount).toBe(0);
    expect(items[0]).toMatchObject({ code: "SOURCE_FAILED", severity: "error", stage: "collect", source: "reddit", detail: { requests: 3, failed: 3 } });
  });
  it("counts plain strings and malformed objects as legacy, and never shows them", () => {
    const { items, legacyCount } = parseDiagnostics(["hn fetch failed: HTTP 500 for hn.algolia.com", { code: 1 }, null, 7, { ...good, severity: "fatal" }, { ...good, stage: "nope" }, { ...good, at: 5 }]);
    expect(items).toEqual([]);
    expect(legacyCount).toBe(7);
  });
  it("returns nothing for a missing or non-array value", () => {
    for (const v of [null, undefined, {}, "x", 5]) expect(parseDiagnostics(v)).toEqual({ items: [], legacyCount: 0 });
  });
  it("re-sanitises stored text and limits what a stored object can inject", () => {
    const { items } = parseDiagnostics([{ ...good, code: "bad code!<script>", message: "fail at https://db.secret.supabase.co/x?apikey=ABCDEF Bearer tok.en", detail: { a: 1, b: { nested: "x" }, c: "y".repeat(500), d: undefined, e: true, f: null } }]);
    expect(items[0].code).toBe("bad_code__script_");
    expect(items[0].message).not.toMatch(/ABCDEF|tok\.en|https:\/\//);
    expect(items[0].detail).toEqual({ a: 1, c: "y".repeat(80), e: true, f: null }); // nested objects are dropped, strings capped
  });
  it("keeps at most 8 detail entries", () => {
    const detail = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(parseDiagnostics([{ ...good, detail }]).items[0].detail!).length).toBe(8);
  });
});

describe("coarseReason / makeDiagnostics", () => {
  it("reduces raw errors to fixed phrases", () => {
    const cases: [string, string][] = [["HTTP 429 for www.reddit.com", "Rate limited by the source"], ["request failed (timeout) for x", "Timed out"], ["HTTP 403 for x", "Access refused by the source"], ["HTTP 503 for x", "Source service error"], ["request failed (network error) for x", "Network problem"], ["constraint violated", "Source did not return usable data"]];
    for (const [raw, out] of cases) expect(coarseReason(raw)).toBe(out);
    expect(coarseReason(null)).toBeNull();
    expect(coarseReason("")).toBeNull();
  });
  it("adds a remedy by code, a timestamp, and mirrors a plain warning unless told not to", () => {
    const warnings: string[] = [];
    const d = makeDiagnostics(() => Date.parse("2026-10-12T10:00:00Z"), warnings);
    d.add({ code: "SOURCE_FAILED", severity: "error", stage: "collect", message: "m" });
    d.add({ code: "SOURCE_CAPPED", severity: "info", stage: "collect", message: "c" }, null);
    d.add({ code: "X", severity: "info", stage: "run", message: "x" }, "legacy text");
    expect(warnings).toEqual(["m", "legacy text"]);
    expect(d.items[0]).toMatchObject({ remedy: REMEDY.SOURCE_FAILED, at: "2026-10-12T10:00:00.000Z" });
    expect(d.items[2].remedy).toBeUndefined();
  });
  it("every stable code the pipeline can emit as a problem has a remedy", () => {
    for (const code of ["SOURCE_FAILED", "SOURCE_PARTIAL", "SOURCE_RATE_LIMITED", "SOURCE_AUTH", "CLASSIFY_NO_MODEL", "CLASSIFY_ABORTED", "CLASSIFY_PENDING", "SUMMARY_FALLBACK", "EMAIL_UNCONFIRMED", "EMAIL_STATE_CHECK_FAILED", "EMAIL_FAILED", "EMAIL_OUTCOME_UNKNOWN", "EMAIL_BRIEF_MISSING", "EMAIL_MARK_SENT_FAILED", "RUN_FAILED", "RUN_BUDGET", "MONITORING_FAILED"]) expect(REMEDY[code], code).toBeTruthy();
  });
});

describe("the pipeline records structured diagnostics", () => {
  it("a clean run records the save and the email acceptance, nothing alarming, and stores exactly what it returns", async () => {
    const store = new MemoryStore();
    const s = await runDigest(base(store, { sendEmail: sent() }));
    expect(codes(s)).toEqual(expect.arrayContaining(["REPORT_SAVED", "EMAIL_SUBMITTED"]));
    expect(s.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    expect(find(s, "REPORT_SAVED")).toMatchObject({ stage: "persist", detail: { action: "create", version: 1 } });
    expect(find(s, "EMAIL_SUBMITTED").message).toContain("Inbox delivery is not observable");
    expect(store.runs[0].finish?.diagnostics).toEqual(s.diagnostics);
    expect(s.warnings).toEqual([]); // info diagnostics do not pollute the plain warning list
  });
  it("a total source failure is SOURCE_FAILED (error) with a safe message, while the raw error stays only in the plain warning", async () => {
    const s = await runDigest(base(new MemoryStore(), { fetchers: { hn: hn("a"), reddit: async () => { throw new Error("boom at https://db.secret.supabase.co/x?apikey=SECRETKEY1"); } } }));
    const d = find(s, "SOURCE_FAILED");
    expect(d).toMatchObject({ severity: "error", stage: "collect", source: "reddit" });
    expect(JSON.stringify(s.diagnostics)).not.toMatch(/SECRETKEY1|supabase/);
    expect(s.warnings.join()).toContain("reddit fetch failed");
    expect(s.status).toBe("partial");
  });
  it("a rate-limited partial collection is SOURCE_RATE_LIMITED (warning), and rejected credentials are SOURCE_AUTH", async () => {
    const limited = await runDigest(base(new MemoryStore(), { fetchers: { hn: hn("a"), reddit: async () => res({ requests: 3, failed: 1, errors: ["HTTP 429 for www.reddit.com"], posts: [post({ source: "reddit", source_id: "r1" })] }) } }));
    expect(find(limited, "SOURCE_RATE_LIMITED")).toMatchObject({ severity: "warning", source: "reddit", detail: { requests: 3, failed: 1 } });
    const auth = await runDigest(base(new MemoryStore(), { fetchers: { hn: hn("a"), reddit: async () => res({ requests: 1, failed: 1, errors: ["Reddit rejected the API credentials (HTTP 401) for www.reddit.com"] }) } }));
    expect(find(auth, "SOURCE_AUTH")).toMatchObject({ severity: "error" });
    expect(find(auth, "SOURCE_AUTH").message).toContain("credentials were rejected");
    expect(find(auth, "SOURCE_AUTH").remedy).toContain("API credentials");
  });
  it("a partial failure that is not a rate limit is SOURCE_PARTIAL", async () => {
    const s = await runDigest(base(new MemoryStore(), { fetchers: { hn: async () => res({ requests: 10, failed: 2, errors: ["HTTP 500 for hn.algolia.com"], posts: [post({ source_id: "a" })] }) } }));
    expect(find(s, "SOURCE_PARTIAL")).toMatchObject({ severity: "warning", source: "hn" });
  });
  it("page caps become ONE diagnostic per source, not one per topic", async () => {
    const store = new MemoryStore();
    store.topics = [...store.topics, { ...store.topics[0], id: "topic-2", name: "Second", created_at: "2026-10-01T00:00:00Z" }];
    const s = await runDigest(base(store, { fetchers: { hn: async () => res({ truncated: true, posts: [] }) } }));
    const caps = s.diagnostics.filter((d) => d.code === "SOURCE_CAPPED");
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ severity: "info", source: "hn", detail: { topics: 2, capped: 2 } });
  });
  it("retries and rate-limit waiting are recorded per source", async () => {
    const retried = await runDigest(base(new MemoryStore(), { fetchers: { hn: async () => res({ retries: 2, waitedMs: 1500 }) } }));
    expect(find(retried, "SOURCE_RETRIED")).toMatchObject({ severity: "info", source: "hn", detail: { retries: 2, waitedMs: 1500 } });
    const throttled = await runDigest(base(new MemoryStore(), { fetchers: { reddit: async () => res({ waitedMs: 58_000 }) } }));
    expect(find(throttled, "SOURCE_THROTTLED").message).toContain("waited 58 s");
    expect(codes(throttled)).not.toContain("SOURCE_RETRIED");
  });
  it("no Gemini key: classification is skipped with an error diagnostic and the summary falls back to a template", async () => {
    const s = await runDigest(base(new MemoryStore(), { callModel: null }));
    expect(find(s, "CLASSIFY_NO_MODEL")).toMatchObject({ severity: "error", stage: "classify", detail: { waiting: 1 } });
    expect(find(s, "SUMMARY_FALLBACK")).toMatchObject({ severity: "warning", stage: "summary" });
    expect(s.warnings.join()).toContain("GEMINI not configured");
  });
  it("posts left unclassified are reported as CLASSIFY_PENDING with the counts", async () => {
    const s = await runDigest(base(new MemoryStore(), { callModel: async (p) => (p.includes("intro line") ? "Slow reviews led the week. Nothing else." : "[]") }));
    expect(find(s, "CLASSIFY_PENDING")).toMatchObject({ severity: "warning", detail: { pending: 1, backlogRemaining: 0 } });
  });
  it("a failure while saving a classification batch is reported as CLASSIFY_WARNING, the post stays pending, and the run carries on", async () => {
    const store = new MemoryStore();
    store.fail.saveClassifications = new Error("db down");
    const s = await runDigest(base(store));
    expect(find(s, "CLASSIFY_WARNING")).toMatchObject({ severity: "warning", stage: "classify" });
    expect(find(s, "CLASSIFY_PENDING")).toMatchObject({ detail: { pending: 1 } });
    expect(find(s, "REPORT_SAVED")).toBeTruthy();
    expect(JSON.stringify(s.diagnostics)).not.toContain("db down");
  });
  it("a failed run records RUN_FAILED, stores the diagnostics, and still throws the original error", async () => {
    const store = new MemoryStore();
    store.fail.saveBrief = new Error("db write failed");
    await expect(runDigest(base(store))).rejects.toThrow("db write failed");
    const f = store.runs[0].finish!;
    expect(f.status).toBe("failed");
    expect(f.diagnostics!.map((d) => d.code)).toContain("RUN_FAILED");
    expect(f.diagnostics!.map((d) => d.code)).not.toContain("REPORT_SAVED"); // nothing claims a save that did not happen
  });
  it("a monitoring write failure is MONITORING_FAILED and never fails the run", async () => {
    const store = new MemoryStore();
    store.fail.recordSourceFetches = new Error("db blip");
    const s = await runDigest(base(store));
    expect(find(s, "MONITORING_FAILED")).toMatchObject({ severity: "warning" });
    expect(s.status).not.toBe("failed");
  });
  it("a report that is frozen is recorded as 'kept', never as created", async () => {
    const store = new MemoryStore();
    await runDigest(base(store, { sendEmail: sent() }));
    const again = await runDigest(base(store, { sendEmail: sent() }));
    expect(find(again, "REPORT_SAVED").detail).toMatchObject({ action: "keep", version: 1 });
    expect(find(again, "EMAIL_ALREADY_SENT")).toMatchObject({ severity: "info", stage: "email" });
    expect(codes(again)).not.toContain("EMAIL_SUBMITTED");
  });
});

describe("email diagnostics", () => {
  it("a definite rejection is EMAIL_FAILED (warning)", async () => {
    const s = await runDigest(base(new MemoryStore(), { sendEmail: vi.fn().mockRejectedValue(new EmailSendError("resend http 422: bad", true)) }));
    expect(find(s, "EMAIL_FAILED")).toMatchObject({ severity: "warning", stage: "email" });
  });
  it("an unknown outcome after retries is EMAIL_OUTCOME_UNKNOWN (error) with the attempt count, and the run is partial", async () => {
    const s = await runDigest(base(new MemoryStore(), { sendEmail: vi.fn().mockRejectedValue(new EmailSendError("resend http 503: down", false)) }));
    expect(find(s, "EMAIL_OUTCOME_UNKNOWN")).toMatchObject({ severity: "error", detail: { attempts: 3 } });
    expect(s.status).toBe("partial");
  });
  it("a stale unconfirmed claim is EMAIL_UNCONFIRMED (error)", async () => {
    const store = new MemoryStore();
    await runDigest(base(store));
    store.emails.set(WEEK, { status: "sending", claimedAt: Date.now() - 30 * 3_600_000 });
    const s = await runDigest(base(store, { sendEmail: sent() }));
    expect(find(s, "EMAIL_UNCONFIRMED")).toMatchObject({ severity: "error" });
    expect(s.email).toBe("unconfirmed");
  });
  it("an unreadable delivery state is EMAIL_STATE_CHECK_FAILED, and nothing is sent", async () => {
    const store = new MemoryStore();
    store.fail.claimEmail = new Error("db down");
    const send = sent();
    const s = await runDigest(base(store, { sendEmail: send }));
    expect(find(s, "EMAIL_STATE_CHECK_FAILED")).toMatchObject({ severity: "error" });
    expect(send).not.toHaveBeenCalled();
  });
  it("a failed 'sent' mark is EMAIL_MARK_SENT_FAILED with the attempt count", async () => {
    const store = new MemoryStore();
    store.fail.markEmailSent = new Error("db blip");
    const s = await runDigest(base(store, { sendEmail: sent() }));
    expect(find(s, "EMAIL_MARK_SENT_FAILED")).toMatchObject({ severity: "warning", detail: { attempts: 3 } });
  });
  it("no diagnostic message ever carries a raw error, URL, key or token", async () => {
    const leak = "https://db.secret.supabase.co/rest?apikey=LEAK123 Bearer LEAK.TOKEN";
    const store = new MemoryStore();
    store.fail.markEmailSent = new Error(leak);
    const s = await runDigest(base(store, { fetchers: { hn: hn("a"), reddit: async () => { throw new Error(leak); } }, sendEmail: vi.fn().mockRejectedValueOnce(new EmailSendError(leak, true)).mockResolvedValue({ status: "sent" as const }) }));
    const text = JSON.stringify(s.diagnostics);
    for (const bad of ["LEAK123", "LEAK.TOKEN", "supabase", "https://"]) expect(text).not.toContain(bad);
  });
});

describe("storing diagnostics (call shape)", () => {
  const fake = () => {
    const calls: { m: string; args: unknown[] }[][] = [];
    const db = { from: () => { const c: { m: string; args: unknown[] }[] = []; calls.push(c); const p: unknown = new Proxy(() => {}, { get: (_t, m) => (m === "then" ? (r: (x: unknown) => void) => r({ data: [], error: null }) : (...args: unknown[]) => { c.push({ m: String(m), args }); return p; }) }); return p; } };
    return { store: makeSupabaseStore(db as never), calls };
  };
  it("writes structured diagnostics into the existing warnings column, falling back to plain strings", async () => {
    const { store, calls } = fake();
    const diags = [{ code: "REPORT_SAVED", severity: "info", stage: "persist", message: "m", at: "2026-10-12T10:00:00Z" }] as never;
    await store.finishRun("r1", { status: "succeeded", warnings: ["old"], diagnostics: diags });
    await store.finishRun("r2", { status: "partial", warnings: ["old"] });
    await store.finishRun("r3", { status: "failed", diagnostics: [] });
    const upd = (i: number) => calls[i].find((c) => c.m === "update")!.args[0] as Record<string, unknown>;
    expect(upd(0).warnings).toEqual(diags);
    expect(upd(1).warnings).toEqual(["old"]);
    expect(upd(2).warnings).toEqual([]);
    for (let i = 0; i < 3; i++) expect(upd(i)).not.toHaveProperty("diagnostics"); // there is no such column
  });
  it("the in-progress check is a bounded, indexed-shape query: this period, status running, started recently", async () => {
    const { store, calls } = fake();
    expect(await store.hasActiveRun("2026-10-02", 360_000)).toBe(false);
    const c = calls[0];
    expect(c.find((x) => x.m === "eq" && x.args[0] === "week_start")!.args[1]).toBe("2026-10-02");
    expect(c.some((x) => x.m === "eq" && x.args[0] === "status" && x.args[1] === "running")).toBe(true);
    expect(c.some((x) => x.m === "gte" && x.args[0] === "started_at")).toBe(true);
  });
});
