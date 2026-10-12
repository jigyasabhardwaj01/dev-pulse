import type { FetchWindow } from "./types";

const DAY = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000; // IST is UTC+05:30 all year (no DST)

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Reporting period = the seven complete IST calendar days Friday 00:00:00.000 IST through
 * Thursday 23:59:59.999 IST, ending at the most recent Friday 00:00 IST at or before `asOf`.
 * A Friday-morning run therefore never includes the still-incomplete current Friday.
 * `end` is exclusive, so Thursday 23:59:59.999 IST belongs to the period and Friday 00:00:00.000 IST does not.
 *
 * The period key (`weekStart`) is the IST calendar date of the first day, which is always a Friday.
 */
export function periodFor(asOf: Date): FetchWindow {
  const istMs = asOf.getTime() + IST_OFFSET_MS; // wall-clock IST, read via the UTC getters
  const istDayStart = Math.floor(istMs / DAY) * DAY;
  const dow = new Date(istDayStart).getUTCDay(); // 0 = Sunday ... 5 = Friday
  const daysSinceFriday = (dow - 5 + 7) % 7;
  const endIst = istDayStart - daysSinceFriday * DAY;
  const startIst = endIst - 7 * DAY;
  const endMs = endIst - IST_OFFSET_MS;
  const startMs = startIst - IST_OFFSET_MS;
  return {
    start: new Date(startMs),
    end: new Date(endMs),
    weekStart: isoDate(startIst),
    prevWeekStart: isoDate(startIst - 7 * DAY),
    prevStart: new Date(startMs - 7 * DAY),
  };
}

/** Window for a stored legacy week_start (UTC-midnight convention used before the IST periods). */
export function legacyWindowForWeekStart(weekStart: string): { start: Date; end: Date } {
  const start = new Date(`${weekStart}T00:00:00Z`);
  return { start, end: new Date(start.getTime() + 7 * DAY) };
}
