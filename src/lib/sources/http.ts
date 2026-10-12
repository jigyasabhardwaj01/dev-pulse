import type { FetchLike, FetchResult, FetchedPost } from "../types";
import { sanitizeError } from "../text";

export async function getJson<T>(url: string, fetchImpl: FetchLike = fetch, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "dev-pulse/1.0", ...headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
  return (await res.json()) as T;
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

export function toResult(s: Settled<FetchedPost>, keep: (p: FetchedPost) => boolean, truncated: boolean): FetchResult {
  return { posts: s.items.filter(keep), requests: s.requests, failed: s.failed, errors: s.errors, truncated };
}
