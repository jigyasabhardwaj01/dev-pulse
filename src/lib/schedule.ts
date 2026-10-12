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

/** Plain wording for a cron expression. Only the project's documented weekly schedule is translated; anything else is shown as written. */
export function describeCron(expr: string): string {
  return expr.trim() === "30 3 * * 5" ? "Fridays 09:00 IST (03:30 UTC); Vercel may start it up to an hour late" : `cron ${expr}`;
}

/**
 * The next time the documented weekly cron ("30 3 * * 5": Fridays 03:30 UTC) is due, strictly after `now`. Vercel may start it up to an
 * hour late, so this is the due time, not a promise of the start. Any other expression returns null rather than guessing.
 */
export function nextWeeklyRun(expr: string, now: Date): Date | null {
  if (expr.trim() !== "30 3 * * 5") return null;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 30, 0, 0));
  const ahead = (5 - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + ahead);
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}
