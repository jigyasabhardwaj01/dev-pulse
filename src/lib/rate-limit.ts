/*
 * Abuse protection for a site with no login. A sliding window per (bucket, client), kept in memory.
 * Honest limits: each serverless instance counts on its own, so this slows a script down rather than providing an exact global quota,
 * and the client is identified by the platform's forwarded address. The expensive work (collection, AI) is not reachable from the
 * browser at all: it runs only from the scheduled job, which needs a secret. These limits protect the database writes.
 */
const hits = new Map<string, number[]>();
const MAX_KEYS = 5000;

export interface Limit { name: string; max: number; windowMs: number }
export const WRITE_LIMIT: Limit = { name: "write", max: 40, windowMs: 60_000 };
export const HEAVY_LIMIT: Limit = { name: "heavy", max: 4, windowMs: 10 * 60_000 };
export const EMAIL_LIMIT: Limit = { name: "email", max: 3, windowMs: 10 * 60_000 };
export const STATUS_LIMIT: Limit = { name: "status", max: 120, windowMs: 60_000 };
export const READ_EXPORT_LIMIT: Limit = { name: "export", max: 20, windowMs: 60_000 };

/** The caller's address as forwarded by the hosting platform; "unknown" shares one bucket, which only makes the limit stricter. */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (fwd || req.headers.get("x-real-ip") || "unknown").slice(0, 64);
}

export function checkRate(limit: Limit, client: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
  const k = `${limit.name}|${client}`;
  const recent = (hits.get(k) ?? []).filter((t) => now - t < limit.windowMs);
  if (recent.length >= limit.max) {
    hits.set(k, recent);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + limit.windowMs - now) / 1000)) };
  }
  recent.push(now);
  hits.set(k, recent);
  if (hits.size > MAX_KEYS) for (const [key, v] of hits) if (!v.length || now - v[v.length - 1] > 10 * 60_000) hits.delete(key);
  return { ok: true };
}

export const resetRateLimits = () => hits.clear();

export function tooMany(retryAfterSec: number): Response {
  return new Response(JSON.stringify({ error: `Too many requests. Please wait ${retryAfterSec} seconds and try again.` }), {
    status: 429, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(retryAfterSec) },
  });
}
