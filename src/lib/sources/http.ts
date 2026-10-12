import type { FetchLike, FetchResult, FetchedPost } from "../types";
import { sanitizeError } from "../text";

/** An HTTP-level failure. The message keeps the long-standing "HTTP <status> for <host>" form that error categorisation relies on. */
export class HttpError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = "HttpError";
  }
}

export interface RetryStats { retries: number; waitedMs: number }
export interface GetOptions {
  stats?: RetryStats;
  /** Injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Extra attempts after the first. Default 2. */
  maxRetries?: number;
  /** Longest single wait we will sit through; a provider asking for more is treated as a failure. Default 8 s. */
  maxWaitMs?: number;
  timeoutMs?: number;
  random?: () => number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `Retry-After` is seconds or an HTTP date. Returns milliseconds, or null when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const when = Date.parse(value);
  return Number.isNaN(when) ? null : Math.max(0, when - nowMs);
}

/**
 * GET and parse JSON, with a BOUNDED retry for transient trouble only: timeouts, network errors, 408/425/429/5xx, and a 403 that
 * advertises when to come back (GitHub's secondary rate limit). The provider's `Retry-After` is honoured when it is short enough;
 * otherwise the failure is reported at once instead of sleeping through the function's budget. Permanent errors (400, 401, 404,
 * a 403 without a retry hint) and malformed bodies are never retried.
 */
export async function getJson<T>(url: string, fetchImpl: FetchLike = fetch, headers: Record<string, string> = {}, opts: GetOptions = {}): Promise<T> {
  const { stats, sleep = realSleep, maxRetries = 2, maxWaitMs = 8_000, timeoutMs = 15_000, random = Math.random } = opts;
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "dev-pulse/1.0", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
      if (attempt < maxRetries) { const w = 500 * 2 ** attempt + Math.floor(random() * 200); await sleep(w); if (stats) { stats.retries++; stats.waitedMs += w; } continue; }
      throw new HttpError(`request failed (${timedOut ? "timeout" : "network error"}) for ${host}`, null);
    }
    if (res.ok) {
      try { return (await res.json()) as T; } catch { throw new HttpError(`unexpected response (not JSON) for ${host}`, res.status); }
    }
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
    const advertised403 = res.status === 403 && (retryAfter !== null || res.headers.get("x-ratelimit-remaining") === "0");
    const retryable = RETRYABLE.has(res.status) || advertised403;
    const wait = retryAfter ?? 500 * 2 ** attempt + Math.floor(random() * 200);
    if (retryable && attempt < maxRetries && wait <= maxWaitMs) {
      await sleep(wait);
      if (stats) { stats.retries++; stats.waitedMs += wait; }
      continue;
    }
    throw new HttpError(`HTTP ${res.status} for ${host}`, res.status, retryAfter);
  }
}

export interface Settled<T> { items: T[]; requests: number; failed: number; errors: string[] }

/**
 * Runs every request. Partial failure keeps what succeeded; the counts let the caller tell
 * "every request failed" from "requests succeeded and found nothing".
 */
export async function settleRequests<T>(tasks: (() => Promise<T[]>)[]): Promise<Settled<T>> {
  const results = await Promise.allSettled(tasks.map((t) => t()));
  const items = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const errors = [...new Set(results.flatMap((r) => (r.status === "rejected" ? [sanitizeError(r.reason)] : [])))];
  return { items, requests: tasks.length, failed: results.filter((r) => r.status === "rejected").length, errors };
}

export function toResult(s: Settled<FetchedPost>, keep: (p: FetchedPost) => boolean, truncated: boolean, stats?: RetryStats): FetchResult {
  return {
    posts: s.items.filter(keep), requests: s.requests, failed: s.failed, errors: s.errors, truncated,
    ...(stats && (stats.retries > 0 || stats.waitedMs > 0) ? { retries: stats.retries, waitedMs: stats.waitedMs } : {}),
  };
}
