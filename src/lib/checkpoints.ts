/*
 * Incremental collection. Three different facts are tracked per (source, topic) and must never be confused:
 *   last_attempt_at    - the last time a fetch was tried (success or not)
 *   last_success_at   - the last time every request succeeded (the data may still have been capped)
 *   covered_from .. committed_through - the range that has been fetched COMPLETELY (no failure, no cap) and durably stored
 * The committed range only ever grows from a complete fetch, and only after the data it covers was stored. A failed, partial,
 * capped or interrupted fetch leaves it untouched, so the next run starts from the same place and nothing is skipped.
 */
export interface Checkpoint {
  source: string;
  topic_id: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  covered_from: string | null;
  committed_through: string | null;
  last_status: "ok" | "partial" | "error" | null;
}

/** When resuming inside a covered range, step back this far so late-arriving or reordered results are caught. */
export const OVERLAP_MS = 2 * 86_400_000;
/**
 * A completed period may be skipped only if it was fetched at least this long AFTER the period closed, because providers index
 * and surface posts late. A fetch made earlier (such as the weekly run, a few hours after close) is never trusted as final, so a
 * rerun inside the first day still picks up late-arriving posts.
 */
export const LATE_GRACE_MS = 24 * 3_600_000;

export interface Window { start: Date; end: Date }
export type FetchPlan =
  | { action: "skip"; reason: string }
  | { action: "fetch"; window: Window; resumed: boolean };

const t = (iso: string | null) => (iso ? new Date(iso).getTime() : null);

export function emptyCheckpoint(source: string, topic_id: string): Checkpoint {
  return { source, topic_id, last_attempt_at: null, last_success_at: null, covered_from: null, committed_through: null, last_status: null };
}

/** What to fetch for `period`, given what is already durably covered. */
export function planFetch(cp: Checkpoint | undefined, period: Window): FetchPlan {
  const from = t(cp?.covered_from ?? null);
  const through = t(cp?.committed_through ?? null);
  const full: FetchPlan = { action: "fetch", window: { start: period.start, end: period.end }, resumed: false };
  if (!cp || from === null || through === null) return full;
  const ps = period.start.getTime(), pe = period.end.getTime();
  if (from <= ps && through >= pe) {
    const ok = t(cp.last_success_at);
    // Covered, but only trust that if the fetch happened after the period had closed and providers had time to index it.
    return ok !== null && ok >= pe + LATE_GRACE_MS ? { action: "skip", reason: "already collected completely" } : full;
  }
  if (from <= ps && through > ps && through < pe) {
    const start = Math.max(ps, through - OVERLAP_MS); // resume from the committed point, with an overlap
    return { action: "fetch", window: { start: new Date(start), end: period.end }, resumed: true };
  }
  return full;
}

export interface FetchOutcome { status: "ok" | "partial" | "error"; truncated: boolean }

/**
 * The checkpoint after an attempt. Call this only AFTER the fetched data has been stored successfully.
 * `window` is the window that was actually fetched.
 */
export function advance(cp: Checkpoint | undefined, source: string, topic_id: string, window: Window, outcome: FetchOutcome, now: Date): Checkpoint {
  const base = cp ?? emptyCheckpoint(source, topic_id);
  const next: Checkpoint = { ...base, last_attempt_at: now.toISOString(), last_status: outcome.status };
  if (outcome.status !== "ok") return next;                       // a failure or partial fetch: not even a success
  next.last_success_at = now.toISOString();
  if (outcome.truncated) return next;                              // succeeded but capped: more may exist, so nothing is committed
  const ws = window.start.getTime(), we = window.end.getTime();
  const from = t(base.covered_from), through = t(base.committed_through);
  if (from === null || through === null) {
    next.covered_from = window.start.toISOString(); next.committed_through = window.end.toISOString();
  } else if (ws <= through && we >= from) {                        // overlaps or touches the covered range: extend it
    next.covered_from = new Date(Math.min(from, ws)).toISOString();
    next.committed_through = new Date(Math.max(through, we)).toISOString();
  } else if (ws > through) {                                       // a later, disjoint window: the newer range replaces the older
    next.covered_from = window.start.toISOString(); next.committed_through = window.end.toISOString();
  }
  // an older disjoint window (a backfill) changes nothing: the committed range never regresses
  return next;
}

/** Does a fetch of this window cover data the checkpoint already marks as committed? Used to describe a resume. */
export const describeRange = (cp: Checkpoint | undefined): string =>
  cp?.covered_from && cp.committed_through ? `${cp.covered_from.slice(0, 10)} to ${cp.committed_through.slice(0, 10)}` : "nothing committed yet";
