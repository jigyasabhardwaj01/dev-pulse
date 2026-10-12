import type { FetchLike } from "../types";

export async function getJson<T>(url: string, fetchImpl: FetchLike = fetch): Promise<T> {
  const res = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "dev-pulse/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
  return (await res.json()) as T;
}

/** Runs all requests; tolerates partial failure, throws only if every one failed. */
export async function settleAll<T>(tasks: (() => Promise<T[]>)[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks.map((t) => t()));
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (tasks.length > 0 && failed.length === tasks.length) throw failed[0].reason;
  return ok;
}
