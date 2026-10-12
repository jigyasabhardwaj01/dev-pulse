import { describe, expect, it, vi } from "vitest";
import { HttpError, getJson, parseRetryAfter, settleRequests, toResult, type RetryStats } from "@/lib/sources/http";

const res = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const noSleep = vi.fn(async (_ms: number) => {});
const URL = "https://api.example.test/x";
const run = (f: (u: string, i?: RequestInit) => Promise<Response>, stats?: RetryStats, over = {}) => getJson<{ ok: number }>(URL, f as never, {}, { sleep: noSleep, random: () => 0, stats, ...over });

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates, and rejects the rest", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("1.5")).toBe(1500);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:05 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(5000);
    expect(parseRetryAfter("Wed, 21 Oct 2020 07:28:05 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(0); // in the past
    for (const bad of [null, undefined, "", "   ", "soon", "-5x"]) expect(parseRetryAfter(bad as never)).toBeNull();
  });
});

describe("getJson retry policy", () => {
  it("returns the body on success without retrying or recording anything", async () => {
    const stats = { retries: 0, waitedMs: 0 };
    const f = vi.fn(async () => res({ ok: 1 }));
    expect(await run(f, stats)).toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(stats).toEqual({ retries: 0, waitedMs: 0 });
  });
  it.each([408, 425, 429, 500, 502, 503, 504])("retries a transient HTTP %i and records the retry", async (status) => {
    const stats = { retries: 0, waitedMs: 0 };
    let n = 0;
    const f = vi.fn(async () => (++n === 1 ? res({}, status) : res({ ok: 1 })));
    expect(await run(f, stats)).toEqual({ ok: 1 });
    expect(stats.retries).toBe(1);
    expect(stats.waitedMs).toBe(500);
  });
  it.each([400, 401, 404, 410, 422])("never retries a permanent HTTP %i", async (status) => {
    const f = vi.fn(async () => res({}, status));
    await expect(run(f)).rejects.toMatchObject({ name: "HttpError", status, message: `HTTP ${status} for api.example.test` });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("honours a short Retry-After (seconds), and records the wait", async () => {
    const stats = { retries: 0, waitedMs: 0 };
    let n = 0;
    const sleep = vi.fn(async (_ms: number) => {});
    const f = async () => (++n === 1 ? res({}, 429, { "retry-after": "2" }) : res({ ok: 1 }));
    await run(f, stats, { sleep });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(stats.waitedMs).toBe(2000);
  });
  it("does not sit through a long Retry-After: it fails at once and reports it", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const f = vi.fn(async () => res({}, 429, { "retry-after": "120" }));
    await expect(run(f, undefined, { sleep })).rejects.toMatchObject({ status: 429, retryAfterMs: 120_000 });
    expect(sleep).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("retries a 403 only when it advertises when to come back (GitHub's secondary limit)", async () => {
    let n = 0;
    const hinted = async () => (++n === 1 ? res({}, 403, { "retry-after": "1" }) : res({ ok: 1 }));
    expect(await run(hinted)).toEqual({ ok: 1 });
    const exhausted = vi.fn(async () => res({}, 403, { "x-ratelimit-remaining": "0" }));
    await expect(run(exhausted)).rejects.toMatchObject({ status: 403 });
    expect(exhausted).toHaveBeenCalledTimes(3); // advertised rate limit: bounded retries
    const plain = vi.fn(async () => res({}, 403));
    await expect(run(plain)).rejects.toMatchObject({ status: 403 });
    expect(plain).toHaveBeenCalledTimes(1); // a plain refusal is permanent
  });
  it("bounds the retries: one try plus two retries, then the failure is reported", async () => {
    const f = vi.fn(async () => res({}, 503));
    await expect(run(f)).rejects.toMatchObject({ status: 503 });
    expect(f).toHaveBeenCalledTimes(3);
    const g = vi.fn(async () => res({}, 503));
    await expect(run(g, undefined, { maxRetries: 0 })).rejects.toMatchObject({ status: 503 });
    expect(g).toHaveBeenCalledTimes(1);
  });
  it("backs off exponentially between attempts", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(run(async () => res({}, 500), undefined, { sleep })).rejects.toBeInstanceOf(HttpError);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });
  it("retries network errors and timeouts, then reports which it was", async () => {
    const net = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(run(net)).rejects.toMatchObject({ status: null, message: "request failed (network error) for api.example.test" });
    expect(net).toHaveBeenCalledTimes(3);
    const slow = vi.fn(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); });
    await expect(run(slow)).rejects.toMatchObject({ message: "request failed (timeout) for api.example.test" });
  });
  it("recovers from a transient network error", async () => {
    let n = 0;
    const stats = { retries: 0, waitedMs: 0 };
    expect(await run(async () => { if (++n === 1) throw new TypeError("x"); return res({ ok: 1 }); }, stats)).toEqual({ ok: 1 });
    expect(stats.retries).toBe(1);
  });
  it("never retries a malformed body, and says so", async () => {
    const f = vi.fn(async () => res("<html>not json</html>"));
    await expect(run(f)).rejects.toMatchObject({ message: "unexpected response (not JSON) for api.example.test" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("never puts the URL's query (which may carry a key) in an error message", async () => {
    const f = async () => res({}, 500);
    const e = (await getJson(`${URL}?key=SECRET123&q=x`, f as never, {}, { sleep: noSleep, maxRetries: 0 }).catch((x) => x)) as Error;
    expect(e.message).toBe("HTTP 500 for api.example.test");
    expect(e.message).not.toContain("SECRET123");
  });
});

describe("settleRequests / toResult", () => {
  it("keeps what succeeded, counts failures, and carries retry stats only when there were any", async () => {
    const s = await settleRequests<string>([async () => ["a"], async () => { throw new Error("HTTP 500 for x"); }]);
    expect(s).toMatchObject({ items: ["a"], requests: 2, failed: 1 });
    const post = (id: string) => ({ source: "hn" as const, source_id: id, topic_id: "t", title: "", body: "", url: null, author: null, posted_at: "2026-10-05T00:00:00Z", is_answered: null });
    expect(toResult({ items: [post("1")], requests: 1, failed: 0, errors: [] }, () => true, false)).not.toHaveProperty("retries");
    expect(toResult({ items: [], requests: 1, failed: 0, errors: [] }, () => true, false, { retries: 2, waitedMs: 1500 })).toMatchObject({ retries: 2, waitedMs: 1500 });
  });
});
