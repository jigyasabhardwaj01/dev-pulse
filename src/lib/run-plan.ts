export type Trigger = "scheduled" | "backfill";

export interface RunPlan {
  now: Date;
  trigger: Trigger;
  /** Only a scheduled run may email. Backfills never do. */
  allowEmail: boolean;
}

export interface RunPlanError {
  error: string;
  status: 400;
}

const IST_OFFSET_MS = 5.5 * 3_600_000;
/** Earliest backfill date accepted: far earlier than any data this app could hold, but rejects obvious typos. */
/** A run that started this recently and has not finished is considered in progress (a function lives at most 300 s). */
export const ACTIVE_RUN_WINDOW_MS = 6 * 60_000;

export const MIN_ASOF = "2020-01-01";

/** The calendar date (YYYY-MM-DD) it currently is in IST. */
export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * True only for a real calendar date written exactly as YYYY-MM-DD (4-digit year, 2-digit month and day).
 * Leap years are honoured: 2028-02-29 is valid, 2027-02-29 and 2026-02-30 are not.
 */
export function isRealCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * `?asOf=YYYY-MM-DD` is read as an IST calendar date (noon IST that day), so the chosen reporting period
 * is deterministic: the most recent Friday 00:00 IST at or before it.
 *
 * Rejected with a 400: a missing/blank/repeated parameter, anything that is not exactly YYYY-MM-DD, an impossible
 * date (Feb 30, month 13, non-leap Feb 29), a date after today in IST (its period would be incomplete or empty),
 * and a date before MIN_ASOF. Today's date is accepted. Valid historical backfills are unaffected.
 */
export function planRun(asOf: string | string[] | null, now: Date = new Date()): RunPlan | RunPlanError {
  if (asOf === null) return { now, trigger: "scheduled", allowEmail: true };
  if (Array.isArray(asOf)) return { error: "asOf must be given at most once", status: 400 };
  if (!isRealCalendarDate(asOf)) return { error: "asOf must be a real calendar date in YYYY-MM-DD format", status: 400 };
  if (asOf < MIN_ASOF) return { error: `asOf must be on or after ${MIN_ASOF}`, status: 400 };
  if (asOf > istToday(now)) return { error: "asOf cannot be in the future", status: 400 };
  return { now: new Date(`${asOf}T12:00:00+05:30`), trigger: "backfill", allowEmail: false };
}
