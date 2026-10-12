import { analysisFor } from "./analysis-source";
import { buildFridayBrief } from "./friday-brief";
import { sendBriefEmail } from "./email";
import { deliverOnce, type EmailArgs } from "./pipeline";
import type { ReportView } from "./report-model";
import { makeDiagnostics } from "./diagnostics";
import { isFrozen } from "./brief-policy";
import type { Store } from "./store";
import type { TeamStore } from "./team-store";
import { maskEmail } from "./friday-status";
import { formatPeriod } from "./view";

/*
 * The Email Summary button. It emails the latest SAVED report, exactly as saved (never regenerated), to the one configured recipient.
 *  - First delivery of a report goes through the same atomic claim the Friday job uses, and the report is marked "sent" only after
 *    the provider accepted it.
 *  - A report that was already emailed is sent again only when the person explicitly asks for a second copy. That copy has its own
 *    idempotency key, is labelled in the subject, and does not touch the report's delivery record.
 *  - Only the LATEST report can be sent: an old one can never go out by accident.
 */
export const RESEND_COOLDOWN_MS = 60_000;

export interface ManualSend { at: string; kind: "sent" | "resent" }
export interface Readiness {
  ready: boolean;
  /** Plain reason the button is disabled. */
  reason: string | null;
  weekStart: string | null;
  periodLabel: string | null;
  recipient: string | null;
  alreadySentAt: string | null;
  lastManual: ManualSend | null;
}

export function readiness(a: { report: ReportView | null; hasAnalysis: boolean; email: { key: boolean; recipient: string | null }; manual: ManualSend | null }): Readiness {
  const r = a.report;
  const recipient = maskEmail(a.email.recipient);
  const base = { weekStart: r?.weekStart ?? null, periodLabel: r?.periodLabel ?? null, recipient, alreadySentAt: r?.delivery.status === "sent" ? (r.delivery.sentAt ?? "") : null, lastManual: a.manual };
  const no = (reason: string): Readiness => ({ ready: false, reason, ...base });
  if (!r) return no("There is no saved report yet. Run Start Research first.");
  if (r.kind !== "ist") return no("The newest report is in an older format and cannot be emailed from here.");
  if (r.nav && r.nav.next !== null) return no("This is not the latest report. Only the latest report can be emailed from here.");
  if (r.usedFallback) return no("The saved summary was written from a template because the AI was unavailable, so it is not sent. Run Start Research once the AI is working.");
  if (!a.hasAnalysis) return no("This report has no problem analysis, so it has no evidence to email.");
  if (!a.email.key || !recipient) return no("No email recipient is configured. Add RESEND_API_KEY and DIGEST_TO_EMAIL in Vercel.");
  if (r.delivery.status === "sending") return no("This report is being emailed right now. Check again in a minute.");
  return { ready: true, reason: null, ...base };
}

export type SendResult = { ok: true; outcome: "sent" | "resent"; at: string; recipient: string } | { ok: false; status: number; code: string; error: string };
const fail = (status: number, code: string, error: string): SendResult => ({ ok: false, status, code, error });

export interface SendDeps { store: Store; team: Pick<TeamStore, "addEvent" | "getDerivedAnalysis" | "listManualEmailEvents">; env: NodeJS.ProcessEnv; actor: string; now?: Date; sleep?: (ms: number) => Promise<void> }

export async function sendSummary(body: { weekStart?: unknown; confirm?: unknown; resend?: unknown; nonce?: unknown }, d: SendDeps): Promise<SendResult> {
  const now = d.now ?? new Date();
  if (body.confirm !== true) return fail(400, "not_confirmed", "Please confirm before sending.");
  const weekStart = typeof body.weekStart === "string" ? body.weekStart : "";
  const nonce = typeof body.nonce === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(body.nonce) ? body.nonce : null;
  if (!d.env.RESEND_API_KEY || !d.env.DIGEST_TO_EMAIL) return fail(503, "not_configured", "No email recipient is configured, so nothing was sent.");

  const periods = await d.store.listReportPeriods(new Date(now.getTime() - 120 * 86_400_000));
  const latest = periods[0]?.week_start ?? null;
  if (!latest) return fail(409, "no_report", "There is no saved report to send.");
  if (weekStart !== latest) return fail(409, "not_latest", "Only the latest report can be sent from here. This one is not the latest, so nothing was sent.");

  const saved = await d.store.getBrief(latest);
  if (!saved) return fail(409, "no_report", "The saved report could not be found, so nothing was sent.");
  if (saved.usedFallback) return fail(409, "template_summary", "The saved summary is a template (the AI was unavailable), so it was not sent. Run Start Research first.");
  const a = await analysisFor(d.store, d.team, latest);
  if (a.kind === "none") return fail(409, "no_analysis", "This report has no problem analysis, so there is no evidence to email. Nothing was sent.");

  const args: EmailArgs = {
    weekStart: latest, version: saved.version, narrative: saved.narrative, points: saved.points, comparison: saved.coverage.comparison, coverage: saved.coverage.sources,
    brief: buildFridayBrief({ weekStart: latest, periodLabel: formatPeriod(latest), analysis: a.analysis, narrative: saved.narrative, usedFallback: saved.usedFallback }),
  };
  const recipient = maskEmail(d.env.DIGEST_TO_EMAIL) ?? "the configured recipient";
  const log = (action: string, extra: Record<string, unknown> = {}) => d.team.addEvent({ item_id: null, actor: d.actor, action, detail: { weekStart: latest, version: saved.version, ...extra } }).catch(() => undefined);

  if (saved.emailStatus === "sent") {
    if (body.resend !== true) return fail(409, "already_sent", "This report was already emailed. Nothing was sent. To send a second copy on purpose, confirm that you want it again.");
    if (!nonce) return fail(400, "bad_request", "The request was incomplete, so nothing was sent.");
    const recent = (await d.team.listManualEmailEvents(latest, 5)).find((e) => now.getTime() - new Date(e.at).getTime() < RESEND_COOLDOWN_MS);
    if (recent) return fail(429, "cooldown", "A copy was sent less than a minute ago. Nothing was sent again.");
    try {
      await sendBriefEmail(args, d.env, fetch, { resendNonce: nonce });
    } catch {
      return fail(502, "send_failed", "The email provider did not accept the message, so nothing was sent. Your report and its delivery record are unchanged. Try again in a few minutes.");
    }
    await log("email_resent_manual", { nonce });
    return { ok: true, outcome: "resent", at: now.toISOString(), recipient };
  }
  if (saved.emailStatus === "sending") return fail(409, "in_progress", "This report is being emailed right now. Nothing was sent again.");
  // first delivery: the same atomic claim, retries and "sent only after the provider accepted" rules as the Friday job
  const diag = makeDiagnostics(() => Date.now(), []);
  const out = await deliverOnce(d.store, (x) => sendBriefEmail(x, d.env), args, diag, d.sleep);
  if (out === "sent") { await log("email_sent_manual"); return { ok: true, outcome: "sent", at: now.toISOString(), recipient }; }
  if (out === "already_sent") return fail(409, "already_sent", "This report was already emailed. Nothing was sent.");
  if (out === "in_progress") return fail(409, "in_progress", "This report is being emailed right now. Nothing was sent again.");
  if (out === "unconfirmed") return fail(502, "unconfirmed", "The email provider did not confirm the send. The report is not marked as delivered. Check your inbox before trying again.");
  if (out === "skipped") return fail(503, "not_configured", "No email recipient is configured, so nothing was sent.");
  return fail(502, "send_failed", "The email provider did not accept the message. The report is not marked as delivered. Try again in a few minutes.");
}
