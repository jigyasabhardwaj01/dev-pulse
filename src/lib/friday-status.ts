import type { ReportView, RunView } from "./report-model";
import { nextWeeklyRun, type ScheduleState } from "./schedule";
import { periodFor } from "./week";
import { formatPeriod } from "./view";

/*
 * The answers to "will my Friday summary arrive?". Everything is derived from the deployed schedule, the presence (never the value)
 * of the settings the run needs, and what past runs recorded. A configured schedule is NOT proof of delivery: the verdict says which
 * of the two it is. Pure, so every branch is tested.
 */
export interface Setup { schedule: ScheduleState; aiKey: boolean; emailKey: boolean; recipient: string | null; cronSecret: boolean }
export type Tone = "ok" | "warn" | "bad" | "neutral";

export interface FridayStatus {
  verdict: { tone: Tone; headline: string; detail: string };
  next: { when: Date | null; label: string; period: string | null; recipient: string };
  lastRun: { tone: Tone; headline: string; detail: string };
  lastReport: { tone: Tone; headline: string; detail: string };
  lastEmail: { tone: Tone; headline: string; detail: string };
  actions: string[];
  /** Has Vercel's own scheduler ever run the job and had it deliver? Until then the schedule is configured, not proven. */
  proven: boolean;
}

export const invokedBy = (run: RunView): "vercel-cron" | "manual" | null => {
  const d = run.diagnostics.find((x) => x.code === "RUN_INVOKED");
  const by = d?.detail?.by;
  return by === "vercel-cron" || by === "manual" ? by : null;
};

/** "jig***@pg27.mesaschool.co": the page is public, so the address is never shown in full. */
export function maskEmail(e: string | undefined | null): string | null {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec((e ?? "").trim());
  return m ? `${m[1].slice(0, 3)}***@${m[2]}` : null;
}

const IST = (d: Date) => `${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(",", "")} IST`;
const at = (iso: string | null | undefined) => (iso ? `${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)).replace(",", "")} IST` : "");

export function fridayStatus(a: { now: Date; setup: Setup; report: ReportView | null; runs: RunView[] | null }): FridayStatus {
  const { setup, report } = a;
  const runs = a.runs ?? [];
  const entry = setup.schedule.state === "configured" ? setup.schedule.crons.find((c) => c.path === "/api/cron/weekly-digest") : undefined;
  const when = entry ? nextWeeklyRun(entry.schedule, a.now) : null;
  const period = when ? formatPeriod(periodFor(when).weekStart) : null;
  const recipient = maskEmail(setup.recipient);

  const actions: string[] = [];
  if (!entry || !when) actions.push("The weekly schedule is not configured in this deployment. Redeploy with the schedule in vercel.json.");
  if (!setup.cronSecret) actions.push("Add CRON_SECRET in Vercel. Without it the scheduled job is refused and nothing runs.");
  if (!setup.emailKey || !recipient) actions.push("Add RESEND_API_KEY and DIGEST_TO_EMAIL (the recipient) in Vercel. Without them no email is sent.");
  if (!setup.aiKey) actions.push("Add OPENROUTER_API_KEY in Vercel. Without it the scheduled run still saves a report but withholds the email, because the AI summary is missing.");

  const last = runs[0] ?? null;
  const lastRun: FridayStatus["lastRun"] = !a.runs ? { tone: "neutral", headline: "Run history could not be read", detail: "Try again in a moment." }
    : !last ? { tone: "neutral", headline: "No run recorded yet", detail: "Nothing has run yet." }
      : last.status === "running" ? { tone: "neutral", headline: "A run is in progress", detail: `Started ${at(last.startedAt)}.` }
        : last.status === "failed" ? { tone: "bad", headline: "The last run failed", detail: `It ran ${at(last.startedAt)} and did not finish.` }
          : last.status === "partial" ? { tone: "warn", headline: "The last run finished with problems", detail: `It ran ${at(last.startedAt)}. Some sources or AI work were incomplete.` }
            : { tone: "ok", headline: "The last run finished", detail: `It ran ${at(last.startedAt)}${invokedBy(last) === "manual" ? " (started by a person, not the schedule)" : invokedBy(last) === "vercel-cron" ? " (started by the schedule)" : ""}.` };
  if (last && (last.status === "failed" || last.status === "partial")) actions.push("Open Settings & Diagnostics → Technical status to see which step failed. The next scheduled run retries automatically.");

  const lastReport: FridayStatus["lastReport"] = !report ? { tone: "neutral", headline: "No report saved yet", detail: "The first one is saved by the Friday run." }
    : { tone: "ok", headline: `Report for ${report.periodLabel}`, detail: `Saved ${at(report.generatedAt)} and available on the dashboard.` };

  const d = report?.delivery;
  const E = last?.emailStatus;
  const lastEmail: FridayStatus["lastEmail"] = !report ? { tone: "neutral", headline: "No email yet", detail: "There is no report to email." }
    : d?.status === "sent" ? { tone: "ok", headline: "Yes, this report was emailed", detail: `The email provider accepted it ${at(d.sentAt)}. Check spam or Promotions if you cannot find it.` }
      : d?.status === "failed" ? { tone: "warn", headline: "The email failed", detail: "Nothing was delivered. The next run retries it by itself." }
        : d?.status === "sending" ? { tone: "warn", headline: "The email is being sent", detail: "If this stays here, the next run will check it." }
          : d?.status === "unknown" ? { tone: "neutral", headline: "Not recorded", detail: "This older report did not record its delivery." }
            : { tone: "neutral", headline: "Not emailed yet", detail: "This report has not been emailed." };
  if (E === "unconfirmed") actions.push("The last email's outcome is unknown. Check your inbox first. JARVIS will not resend it automatically.");
  if (E === "failed") actions.push("The last email was rejected by the provider. Check that RESEND_API_KEY and the recipient are valid; the next run retries.");

  const proven = runs.some((r) => invokedBy(r) === "vercel-cron" && r.status === "succeeded" && (r.emailStatus === "sent" || r.emailStatus === "already_sent"));
  const blocked = !entry || !when || !setup.cronSecret || !setup.emailKey || !recipient || !setup.aiKey;
  const verdict: FridayStatus["verdict"] = blocked
    ? { tone: "bad", headline: "Not yet: something must be fixed first", detail: "See \"Action required\" below. Until it is fixed the Friday email will not arrive." }
    : proven
      ? { tone: "ok", headline: "Yes, it arrives automatically", detail: "Vercel's own schedule has already run the job and an email was delivered." }
      : { tone: "warn", headline: "Yes, it is scheduled, but not yet proven", detail: "The schedule and every setting it needs are in place. No run started by Vercel's schedule has been recorded yet, so delivery on a real Friday is not proven until the first one." };

  return {
    verdict, lastRun, lastReport, lastEmail, actions, proven,
    next: { when, label: when ? IST(when) : "Not scheduled", period, recipient: recipient ?? "Not configured" },
  };
}
