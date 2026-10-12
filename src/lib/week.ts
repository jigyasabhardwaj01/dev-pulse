import type { FetchWindow } from "./types";

const DAY = 86_400_000;

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Rolling 7-day buckets of whole UTC days ending with the day of `asOf`.
 * Every bucket has the same length, so week-over-week counts are comparable
 * even though the job runs on a Friday rather than at a calendar-week boundary.
 */
export function windowFor(asOf: Date): FetchWindow {
  const endMs = Math.floor(asOf.getTime() / DAY) * DAY + DAY;
  const startMs = endMs - 7 * DAY;
  return {
    start: new Date(startMs),
    end: new Date(endMs),
    weekStart: isoDate(startMs),
    prevWeekStart: isoDate(startMs - 7 * DAY),
  };
}

/** Window for a stored week_start (YYYY-MM-DD): 7 whole UTC days. */
export function windowForWeekStart(weekStart: string): { start: Date; end: Date } {
  const start = new Date(`${weekStart}T00:00:00Z`);
  return { start, end: new Date(start.getTime() + 7 * DAY) };
}
