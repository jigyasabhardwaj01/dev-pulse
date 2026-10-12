/*
 * What the DEPLOYED configuration says about scheduled runs. The page imports vercel.json at build time, so this reports the
 * configuration this deployment was built with. It cannot see Vercel's dashboard, so it says "per deployed configuration".
 */
export interface CronEntry { path: string; schedule: string }
export type ScheduleState =
  | { state: "paused"; crons: [] }
  | { state: "configured"; crons: CronEntry[] }
  | { state: "unknown"; crons: null };

export function readSchedule(config: unknown): ScheduleState {
  const crons = (config as { crons?: unknown } | null | undefined)?.crons;
  if (!Array.isArray(crons)) return { state: "unknown", crons: null };
  if (crons.length === 0) return { state: "paused", crons: [] };
  const valid = crons.filter((c): c is CronEntry => typeof c?.path === "string" && typeof c?.schedule === "string");
  return valid.length === crons.length ? { state: "configured", crons: valid } : { state: "unknown", crons: null };
}

/** The only shape understood: "<minute> <hour> * * <weekday>" in UTC (Vercel cron is always UTC). Anything else is shown as written. */
function parseWeekly(expr: string): { minute: number; hour: number; weekday: number } | null {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(expr.trim());
  if (!m) return null;
  const minute = Number(m[1]), hour = Number(m[2]), weekday = Number(m[3]);
  return minute < 60 && hour < 24 ? { minute, hour, weekday } : null;
}
const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/** Plain wording for a weekly cron expression, with the IST equivalent (IST = UTC+5:30, no daylight saving). */
export function describeCron(expr: string): string {
  const w = parseWeekly(expr);
  if (!w) return `cron ${expr}`;
  const ist = (w.hour * 60 + w.minute + 330) % (24 * 60);
  const dayShift = w.hour * 60 + w.minute + 330 >= 24 * 60 ? 1 : 0;
  return `${DAYS[(w.weekday + dayShift) % 7]} ${hhmm(Math.floor(ist / 60), ist % 60)} IST (${hhmm(w.hour, w.minute)} UTC${dayShift ? ` ${DAYS[w.weekday]}` : ""}); Vercel may start it up to an hour late`;
}

/**
 * The next time a weekly cron is due, strictly after `now`. Vercel may start it up to an hour late, so this is the due time, not a
 * promise of the start. An expression that is not a plain weekly one returns null rather than guessing.
 */
export function nextWeeklyRun(expr: string, now: Date): Date | null {
  const w = parseWeekly(expr);
  if (!w) return null;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), w.hour, w.minute, 0, 0));
  d.setUTCDate(d.getUTCDate() + ((w.weekday - d.getUTCDay() + 7) % 7));
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}
