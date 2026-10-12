import type { TeamStore } from "./team-store";
import { sanitizeError } from "./text";
import type { FetchLike } from "./types";

/*
 * Failure alerts. One email per distinct problem, never a flood: a run/week/kind is claimed once in alert_log (unique key), and
 * at most MAX_PER_DAY alerts of one kind go out in 24 hours. The body names the problem and links to Pipeline Health; it carries
 * only safe codes, never raw errors, URLs with tokens, or credentials. Uses the existing Resend configuration and approved recipient.
 */
export const MAX_PER_DAY = 3;
export type AlertKind = "run_failed" | "email_failed" | "email_unconfirmed" | "sources_down" | "email_withheld";

export interface AlertRun { status: string; weekStart: string; trigger: string; email: string; sources: Record<string, string | undefined>; codes: string[] }

export function alertFor(run: AlertRun): { kind: AlertKind; headline: string } | null {
  if (run.trigger !== "scheduled") return null; // backfills and manual runs are watched by a person
  if (run.codes.includes("EMAIL_WITHHELD")) return { kind: "email_withheld", headline: "The weekly report was saved but not emailed: the AI provider is not configured." };
  if (run.status === "failed") return { kind: "run_failed", headline: "The weekly run failed." };
  if (run.email === "failed") return { kind: "email_failed", headline: "The weekly report was saved but could not be emailed." };
  if (run.email === "unconfirmed") return { kind: "email_unconfirmed", headline: "The weekly email may or may not have been delivered; it was not retried, to avoid a duplicate." };
  const srcs = Object.values(run.sources).filter(Boolean);
  if (srcs.length && srcs.every((s) => s === "error")) return { kind: "sources_down", headline: "Every data source failed this week." };
  return null;
}

export function alertHtml(run: AlertRun, headline: string, appUrl: string | null): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const codes = run.codes.slice(0, 8).filter((c) => /^[A-Z0-9_]{2,40}$/.test(c));
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5"><h2 style="margin:0 0 6px">JARVIS needs attention</h2>
<p style="margin:0 0 6px">${esc(headline)}</p><p style="margin:0;color:#555">Report week: ${esc(run.weekStart)} · status: ${esc(run.status)} · email: ${esc(run.email)}</p>
${codes.length ? `<p style="margin:6px 0 0;color:#555">Codes: ${esc(codes.join(", "))}</p>` : ""}
${appUrl ? `<p style="margin-top:14px"><a href="${esc(appUrl)}/status">Open Pipeline Health →</a></p>` : ""}</div>`;
}

/** Never throws: an alert problem must not turn a finished run into a failed one. Returns what happened, for logs and tests. */
export async function sendFailureAlert(
  team: TeamStore, run: AlertRun, runId: string | null, env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch, now = new Date(),
): Promise<"none" | "sent" | "duplicate" | "limited" | "skipped" | "failed"> {
  try {
    const a = alertFor(run);
    if (!a) return "none";
    const key = env.RESEND_API_KEY, to = env.DIGEST_TO_EMAIL;
    if (!key || !to) return "skipped";
    const alertKey = `${a.kind}:${run.weekStart}`;
    if ((await team.countAlerts(a.kind, new Date(now.getTime() - 24 * 3_600_000))) >= MAX_PER_DAY) return "limited";
    if (!(await team.claimAlert(alertKey, a.kind, runId))) return "duplicate";
    try {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": `jarvis-alert-${alertKey}` },
        body: JSON.stringify({ from: "JARVIS <onboarding@resend.dev>", to: [to], subject: `JARVIS alert: ${a.headline}`.slice(0, 120), html: alertHtml(run, a.headline, (env.APP_URL || "").replace(/\/+$/, "") || null) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`resend http ${res.status}`);
      return "sent";
    } catch (e) {
      console.error("alert send failed:", sanitizeError(e));
      await team.releaseAlert(alertKey).catch(() => undefined); // free the claim so a later run can try again (still bounded per day)
      return "failed";
    }
  } catch (e) {
    console.error("alert failed:", sanitizeError(e));
    return "failed";
  }
}
